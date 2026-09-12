// Read-only CASHCAT recovery diagnostics, v2: replicates the exact recovery
// planning path (freshRange + planCycleSwaps + swap-impact guard) for the
// quarantined job, using its persisted plan snapshot and funds context.
// Run inside a CHAIN=robinhood release:
//   CHAIN=robinhood LP_EXECUTOR_CHAIN_ID=4663 LP_EXECUTOR_RPC=<url> \
//   LP_EXECUTOR_DATA_DIR=/tmp/lp-diag node_modules/.bin/tsx scripts/cashcat-recovery-diag.ts
import { DatabaseSync } from 'node:sqlite'
import { formatUnits } from 'viem'
import { publicClient, readPoolState, readTokenBalances } from '../executor/chain'
import { quoteKyber } from '../executor/kyber'
import { freshRange } from '../executor/risk'
import type { TriggerSide } from '../shared/strategy/types'
import { planCycleSwaps, type CycleFunds } from '../executor/rebalance'
import { swapImpactBps } from '../executor/risk'
import type { StrategyConfig, StrategyPositionSnapshot } from '../shared/strategy/types'

const JOB_ID = 'plan-dabe630b72aef9f8'
const STRATEGY_ID = 'strategy-f9bca7c5-9783-4aa1-b757-2b22bc09d536'

const main = async () => {
  const state = new DatabaseSync('/opt/lp-terminal-executor/data/state.db', { readOnly: true })
  const job = state.prepare('SELECT plan_json FROM jobs WHERE id=?').get(JOB_ID) as { plan_json: string }
  const plan = JSON.parse(job.plan_json) as { snapshot: StrategyPositionSnapshot; triggerSide?: string; rangeScale?: number }
  const strategy = state.prepare('SELECT config_json FROM strategies WHERE id=?').get(STRATEGY_ID) as { config_json: string }
  const config = JSON.parse(strategy.config_json) as StrategyConfig
  const fundsRow = state.prepare("SELECT value_json FROM job_context WHERE job_id=? AND context_key='funds'").get(JOB_ID) as { value_json: string } | undefined
  const stored = fundsRow ? JSON.parse(fundsRow.value_json) as Record<string, string> : undefined
  const snapshot = plan.snapshot

  const [balances, pool] = await Promise.all([
    readTokenBalances(config.owner, [snapshot.token0, snapshot.token1]),
    readPoolState(config),
  ])
  console.log('plan side', plan.triggerSide, 'rangeScale', plan.rangeScale, '| snapshot tick', snapshot.tick, 'sqrtPrice', BigInt(snapshot.sqrtPriceX96).toString())
  console.log('pool now: tick', pool.tick, 'sqrtPriceX96', pool.sqrtPriceX96.toString())
  console.log('wallet token0', formatUnits(balances[snapshot.token0.toLowerCase()], snapshot.token0Decimals), 'token1', formatUnits(balances[snapshot.token1.toLowerCase()], snapshot.token1Decimals))
  if (stored) console.log('persisted funds:', JSON.stringify(stored))

  const funds: CycleFunds = stored
    ? { principal0: BigInt(stored.principal0), principal1: BigInt(stored.principal1), fee0: BigInt(stored.fee0), fee1: BigInt(stored.fee1) }
    : { principal0: balances[snapshot.token0.toLowerCase()], principal1: balances[snapshot.token1.toLowerCase()], fee0: 0n, fee1: 0n }

  const range = freshRange(config, snapshot, pool.tick, (plan.triggerSide as TriggerSide | undefined), plan.rangeScale ?? 1)
  console.log('fresh range: tickLower', range.tickLower, 'tickUpper', range.tickUpper)

  const cycle = await planCycleSwaps({
    config, snapshot, sqrtPriceX96: pool.sqrtPriceX96, tickLower: range.tickLower, tickUpper: range.tickUpper, funds,
    quote: async (tokenIn, tokenOut, amountIn) => {
      const route = await quoteKyber(tokenIn, tokenOut, amountIn, { protocol: config.protocol, tickSpacing: snapshot.tickSpacing, feePpm: snapshot.feePpm })
      return { amountOut: BigInt(route.routeSummary.amountOut), routeSummary: route.routeSummary }
    },
  })
  for (const intent of cycle.swaps) {
    const impact = swapImpactBps(intent.amountIn, intent.quotedOut, intent.tokenIn, intent.tokenOut, snapshot, pool.sqrtPriceX96)
    console.log(`intent ${intent.purpose}: ${formatUnits(intent.amountIn, intent.tokenIn.toLowerCase() === snapshot.token0.toLowerCase() ? snapshot.token0Decimals : snapshot.token1Decimals)} ${intent.tokenIn} -> ${formatUnits(intent.quotedOut, intent.tokenOut.toLowerCase() === snapshot.token1.toLowerCase() ? snapshot.token1Decimals : snapshot.token0Decimals)} ${intent.tokenOut} | impact ${impact} bps (guard ${config.safeguards.maxSwapImpactBps})`)
    if (impact > BigInt(Math.floor(config.safeguards.maxSwapImpactBps ?? 150))) console.log('  ^ THIS LEG TRIPS E_SWAP_IMPACT')
  }
  if (cycle.swaps.length === 0) console.log('no swaps planned')
  process.exit(0)
}

main().catch((error) => { console.error(error); process.exit(1) })
