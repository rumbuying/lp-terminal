// Read-only CASHCAT recovery diagnostics. Never signs; only reads chain state
// and asks the aggregator for quotes. Run inside a CHAIN=robinhood release:
//   LP_EXECUTOR_CHAIN_ID=4663 LP_EXECUTOR_RPC=<url> LP_EXECUTOR_DATA_DIR=/tmp/lp-diag \
//   node_modules/.bin/tsx scripts/cashcat-recovery-diag.ts
import { formatUnits } from 'viem'
import { publicClient, readPoolState, readTokenBalances } from '../executor/chain'
import { quoteKyber } from '../executor/kyber'
import { convertPoolAmount, swapImpactBps } from '../executor/risk'
import type { StrategyConfig, StrategyPositionSnapshot } from '../shared/strategy/types'

const config = {
  id: 'strategy-f9bca7c5-9783-4aa1-b757-2b22bc09d536',
  owner: '0x2Bb53df69EFA1b967660F2780DDcF6f76F90ae78',
  protocol: 'univ3',
  pool: '0xd42A491087a15E5afd51FEb3606066Cc152d2b09',
  positionManager: '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3',
  riskToken: '0x020bfC650A365f8BB26819deAAbF3E21291018b4',
  quoteToken: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
} as unknown as StrategyConfig

const low = (v: string) => v.toLowerCase()

const snapshot = {
  token0: config.riskToken,
  token1: config.quoteToken,
  token0Decimals: 18,
  token1Decimals: 18,
  tickSpacing: 60,
  feePpm: 3000,
} as unknown as StrategyPositionSnapshot

const main = async () => {
  const [balances, pool] = await Promise.all([
    readTokenBalances(config.owner, [config.riskToken, config.quoteToken]),
    readPoolState(config),
  ])
  const cashcat = balances[low(config.riskToken)]
  const quote = balances[low(config.quoteToken)]
  console.log('pool tick', pool.tick, 'sqrtPriceX96', pool.sqrtPriceX96.toString(), 'feePpm', pool.feePpm)
  console.log('wallet CASHCAT', formatUnits(cashcat, 18), 'quote', formatUnits(quote, 18))
  const spotOut = convertPoolAmount(cashcat, config.riskToken, config.quoteToken, snapshot, pool.sqrtPriceX96)
  console.log('pool-spot value of full CASHCAT (quote units):', formatUnits(spotOut, 18))
  for (const fraction of [1n, 2n, 4n]) {
    const amountIn = cashcat / fraction
    if (amountIn === 0n) continue
    try {
      const route = await quoteKyber(config.riskToken, config.quoteToken, amountIn)
      const quotedOut = BigInt(route.routeSummary.amountOut)
      const impact = swapImpactBps(amountIn, quotedOut, config.riskToken, config.quoteToken, snapshot, pool.sqrtPriceX96)
      console.log(`quote full/${fraction}: in ${formatUnits(amountIn, 18)} CASHCAT -> out ${formatUnits(quotedOut, 18)} quote, impact ${impact} bps, hops ${route.routeSummary.route?.length ?? 'n/a'}`)
    } catch (error) {
      console.log(`quote full/${fraction} FAILED:`, error instanceof Error ? error.message.slice(0, 200) : error)
    }
  }
  const native = await publicClient.getBalance({ address: config.owner })
  console.log('native balance (wei):', native.toString())
  const position = await publicClient.readContract({ address: config.positionManager, abi: await import('../src/abi').then((m) => m.clPmAbi), functionName: 'positions', args: [1138831n] }).then((r) => r as readonly unknown[]).catch(() => undefined)
  console.log('position 1138831 liquidity:', position ? (position[7] as bigint).toString() : 'N/A (burned or unreadable)')
  process.exit(0)
}

main().catch((error) => { console.error(error); process.exit(1) })
