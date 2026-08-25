import { parseUnits, type Address } from 'viem'
import { getAmountsForLiquidity, getSqrtRatioAtTick } from '../src/lib/clmath'
import { makeRebalancePlan } from '../shared/strategy/planner'
import { rangeSide } from '../shared/strategy/range'
import type { StrategyConfig } from '../shared/strategy/types'
import { readAllowance, publicClient, readCollectableFees, readPoolState, readStrategySnapshot, readTokenBalances } from './chain'
import { EXECUTOR } from './config'
import { ADDR, UNI } from '../src/config/addresses'
import { gatedKyberTx, quoteKyber } from './kyber'
import { quoteRewardToQuote } from './reward'
import { allocateSwapOutput, planCycleSwaps } from './rebalance'
import { freshRange, quoteTurnover, riskAssetPct, swapImpactBps } from './risk'
import { collectCall, decreaseCall, mintCall, unstakeCall } from './steps'
import { assertWalletAllocations, strategyAllocationComponents, strategyAllocations, walletAllocationTokens } from './store'

const low = (value: string) => value.toLowerCase()

/**
 * Read-only, live-chain readiness proof for one complete executor cycle.
 * It validates every transaction input that can be built before the first
 * state-changing transaction; post-decrease calls remain receipt-gated by the
 * runner because simulating them against pre-decrease state would be false.
 */
export async function preflightStrategy(config: StrategyConfig, options: { rangeScale?: number } = {}) {
  const snapshot = await readStrategySnapshot(config)
  const pool = await readPoolState(config)
  const observedSide = rangeSide(snapshot.tick, snapshot.tickLower, snapshot.tickUpper)
  const triggerSide = observedSide === 'in' ? 'manual' : observedSide
  const rangeScale = options.rangeScale ?? 1
  const plan = makeRebalancePlan({ config, snapshot, triggerSide, rangeScale })
  const range = freshRange(config, snapshot, pool.tick, triggerSide, rangeScale)
  const trackedTokens = [...new Set([...walletAllocationTokens(config.execution.walletId!), low(snapshot.token0), low(snapshot.token1)])] as Address[]
  const [balances, collectableFees, gasPrice, nativeBalance, npmAllowance0, npmAllowance1, routerAllowance0, routerAllowance1, nativeAllowance0, nativeAllowance1, uniAllowance0, uniAllowance1] = await Promise.all([
    readTokenBalances(config.owner, trackedTokens),
    readCollectableFees(config),
    publicClient.getGasPrice(),
    publicClient.getBalance({ address: config.owner }),
    readAllowance(snapshot.token0, config.owner, config.positionManager),
    readAllowance(snapshot.token1, config.owner, config.positionManager),
    readAllowance(snapshot.token0, config.owner, EXECUTOR.kyberRouter),
    readAllowance(snapshot.token1, config.owner, EXECUTOR.kyberRouter),
    readAllowance(snapshot.token0, config.owner, ADDR.CL_SWAP_ROUTER),
    readAllowance(snapshot.token1, config.owner, ADDR.CL_SWAP_ROUTER),
    readAllowance(snapshot.token0, config.owner, UNI.V3_SWAP_ROUTER),
    readAllowance(snapshot.token1, config.owner, UNI.V3_SWAP_ROUTER),
  ])
  assertWalletAllocations(config.execution.walletId!, balances)
  const prior = strategyAllocations(config.id)
  const priorComponents = strategyAllocationComponents(config.id)
  const priorPrincipal = Object.fromEntries(Object.entries(priorComponents).map(([token, component]) => [token, component.principal]))
  const priorHeld = Object.fromEntries(Object.entries(priorComponents).map(([token, component]) => [token, component.heldFee]))
  const nativeReserve = (gasPrice * 5_000_000n * BigInt(Math.ceil(config.execution.gasReserveMultiplier * 100))) / 100n
  if (nativeBalance < nativeReserve) throw new Error('E_GAS_LIMIT')
  if (config.execution.maxGasPriceWei && gasPrice > BigInt(config.execution.maxGasPriceWei)) throw new Error('E_GAS_PRICE_LIMIT')
  if (!config.execution.dryRun && !config.execution.maxDailyTurnoverQuote) throw new Error('E_DAILY_LIMIT_REQUIRED')
  if (!config.execution.dryRun && !config.execution.maxGasPriceWei && !config.execution.maxGasQuotePerTx) throw new Error('E_GAS_LIMIT_REQUIRED')

  const decrease = decreaseCall(config, snapshot)
  const collect = collectCall(config, snapshot.tokenId)
  const [decreaseGas, collectGas] = config.staking?.enabled
    ? await Promise.all([
      (() => { const call = unstakeCall(config.staking!.gauge!, snapshot.tokenId); return publicClient.estimateGas({ account: config.owner, to: call.to, data: call.data, value: call.value }) })(),
      Promise.resolve(0n),
    ])
    : await Promise.all([
      publicClient.estimateGas({ account: config.owner, to: decrease.to, data: decrease.data, value: decrease.value }),
      publicClient.estimateGas({ account: config.owner, to: collect.to, data: collect.data, value: collect.value }),
    ])
  const principal = getAmountsForLiquidity(
    BigInt(snapshot.sqrtPriceX96),
    getSqrtRatioAtTick(snapshot.tickLower),
    getSqrtRatioAtTick(snapshot.tickUpper),
    BigInt(snapshot.liquidity),
  )
  const funds = {
    principal0: principal.amount0,
    principal1: principal.amount1,
    fee0: collectableFees.amount0,
    fee1: collectableFees.amount1,
  }

  const routes: { source: 'kyber' | 'solver' | 'up33_cl' | 'univ3'; tokenIn: Address; tokenOut: Address; amountIn: string; quotedOut: string; minOut: string; impactBps: string }[] = []
  let rewardTurnover = 0n
  let rewardSettlement = 0n
  let rewardRouteCount = 0
  // Starting an in-range strategy only enables monitoring. Do not make that
  // safe, transaction-free action depend on a route that will be repriced
  // later, when the position actually leaves its range.
  if (observedSide !== 'in' && config.staking?.enabled && BigInt(snapshot.rewardOwed ?? '0') > 0n) {
    const rewardAmount = BigInt(snapshot.rewardOwed!)
    const reward = await quoteRewardToQuote(rewardAmount, config.quoteToken)
    const wethGate = await gatedKyberTx({ routeSummary: reward.weth.routeSummary, tokenIn: ADDR.UP, tokenOut: ADDR.WETH, sender: config.owner, recipient: config.owner, amountIn: rewardAmount, slippageBps: config.safeguards.maxSlippageBps, nativeIn: false })
    routes.push({ source: reward.weth.routeSummary.executorSource ?? 'kyber', tokenIn: ADDR.UP, tokenOut: ADDR.WETH, amountIn: rewardAmount.toString(), quotedOut: reward.weth.routeSummary.amountOut, minOut: wethGate.minOut.toString(), impactBps: '0' })
    if (reward.quote) {
      const quoteGate = await gatedKyberTx({ routeSummary: reward.quote.routeSummary, tokenIn: ADDR.WETH, tokenOut: config.quoteToken, sender: config.owner, recipient: config.owner, amountIn: reward.wethAmountOut, slippageBps: config.safeguards.maxSlippageBps, nativeIn: false })
      routes.push({ source: reward.quote.routeSummary.executorSource ?? 'kyber', tokenIn: ADDR.WETH, tokenOut: config.quoteToken, amountIn: reward.wethAmountOut.toString(), quotedOut: reward.quote.routeSummary.amountOut, minOut: quoteGate.minOut.toString(), impactBps: '0' })
    }
    rewardSettlement = reward.amountOut
    rewardTurnover = reward.amountOut * (reward.quote ? 2n : 1n)
    rewardRouteCount = reward.quote ? 2 : 1
  }
  let projected0 = funds.principal0
  let projected1 = funds.principal1
  if (observedSide === 'in') {
    // No rebalance is queued. Future reward and principal routes are checked
    // by the monitor/runner against fresh balances and prices at trigger time.
  } else if (plan.action === 'hold_quote') {
    const riskIs0 = low(config.riskToken) === low(snapshot.token0)
    const riskAmount = (riskIs0 ? funds.principal0 + funds.fee0 : funds.principal1 + funds.fee1) + (prior[low(config.riskToken)] ?? 0n)
    projected0 = riskIs0 ? 0n : funds.principal0 + funds.fee0 + (prior[low(snapshot.token0)] ?? 0n)
    projected1 = riskIs0 ? funds.principal1 + funds.fee1 + (prior[low(snapshot.token1)] ?? 0n) : 0n
    if (riskAmount > 0n) {
      const quote = await quoteKyber(config.riskToken, config.quoteToken, riskAmount, { protocol: config.protocol, tickSpacing: snapshot.tickSpacing, feePpm: snapshot.feePpm })
      const gate = await gatedKyberTx({ routeSummary: quote.routeSummary, tokenIn: config.riskToken, tokenOut: config.quoteToken, sender: config.owner, recipient: config.owner, amountIn: riskAmount, slippageBps: config.safeguards.maxSlippageBps, nativeIn: false })
      const impact = swapImpactBps(riskAmount, BigInt(quote.routeSummary.amountOut), config.riskToken, config.quoteToken, snapshot, pool.sqrtPriceX96)
      if (config.safeguards.enabled && config.safeguards.maxSwapImpactBps !== undefined && impact > BigInt(Math.floor(config.safeguards.maxSwapImpactBps))) throw new Error('E_SWAP_IMPACT')
      if (riskIs0) projected1 += BigInt(quote.routeSummary.amountOut)
      else projected0 += BigInt(quote.routeSummary.amountOut)
      routes.push({ source: quote.routeSummary.executorSource ?? 'kyber', tokenIn: config.riskToken, tokenOut: config.quoteToken, amountIn: riskAmount.toString(), quotedOut: quote.routeSummary.amountOut, minOut: gate.minOut.toString(), impactBps: impact.toString() })
    }
  } else {
    const deployableFunds = {
      ...funds,
      principal0: funds.principal0 + (priorPrincipal[low(snapshot.token0)] ?? 0n) + (config.fees.handling === 'reinvest' && low(snapshot.token0) === low(config.quoteToken) ? rewardSettlement : 0n),
      principal1: funds.principal1 + (priorPrincipal[low(snapshot.token1)] ?? 0n) + (config.fees.handling === 'reinvest' && low(snapshot.token1) === low(config.quoteToken) ? rewardSettlement : 0n),
    }
    const cycle = await planCycleSwaps({
      config,
      snapshot,
      sqrtPriceX96: pool.sqrtPriceX96,
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      funds: deployableFunds,
      quote: async (tokenIn, tokenOut, amountIn) => {
        const quote = await quoteKyber(tokenIn, tokenOut, amountIn, { protocol: config.protocol, tickSpacing: snapshot.tickSpacing, feePpm: snapshot.feePpm })
        return { amountOut: BigInt(quote.routeSummary.amountOut), routeSummary: quote.routeSummary }
      },
    })
    projected0 = cycle.lp0
    projected1 = cycle.lp1
    let projectedTotal0 = cycle.lp0 + cycle.held0 + (priorHeld[low(snapshot.token0)] ?? 0n)
    let projectedTotal1 = cycle.lp1 + cycle.held1 + (priorHeld[low(snapshot.token1)] ?? 0n)
    if (config.fees.handling !== 'reinvest' && low(snapshot.token0) === low(config.quoteToken)) projectedTotal0 += rewardSettlement
    if (config.fees.handling !== 'reinvest' && low(snapshot.token1) === low(config.quoteToken)) projectedTotal1 += rewardSettlement
    for (const intent of cycle.swaps) {
      const gate = await gatedKyberTx({ routeSummary: intent.routeSummary, tokenIn: intent.tokenIn, tokenOut: intent.tokenOut, sender: config.owner, recipient: config.owner, amountIn: intent.amountIn, slippageBps: config.safeguards.maxSlippageBps, nativeIn: false })
      const impact = swapImpactBps(intent.amountIn, intent.quotedOut, intent.tokenIn, intent.tokenOut, snapshot, pool.sqrtPriceX96)
      if (config.safeguards.enabled && config.safeguards.maxSwapImpactBps !== undefined && impact > BigInt(Math.floor(config.safeguards.maxSwapImpactBps))) throw new Error('E_SWAP_IMPACT')
      const split = allocateSwapOutput(intent, intent.quotedOut)
      if (low(intent.tokenIn) === low(snapshot.token0)) {
        projected0 -= intent.principalIn
        projected1 += split.principalOut
        projectedTotal0 -= intent.amountIn
        projectedTotal1 += intent.quotedOut
      } else {
        projected1 -= intent.principalIn
        projected0 += split.principalOut
        projectedTotal1 -= intent.amountIn
        projectedTotal0 += intent.quotedOut
      }
      routes.push({ source: intent.routeSummary.executorSource ?? 'kyber', tokenIn: intent.tokenIn, tokenOut: intent.tokenOut, amountIn: intent.amountIn.toString(), quotedOut: intent.quotedOut.toString(), minOut: gate.minOut.toString(), impactBps: impact.toString() })
    }
    if (config.safeguards.enabled && config.safeguards.maxRiskAssetPct !== undefined && riskAssetPct(projectedTotal0, projectedTotal1, config, snapshot, pool.sqrtPriceX96) > config.safeguards.maxRiskAssetPct)
      throw new Error('E_RISK_LIMIT')
    // Calldata/math validation only. A truthful mint eth_estimateGas becomes
    // possible only after principal has actually reached the wallet.
    mintCall({ config, snapshot, tickLower: range.tickLower, tickUpper: range.tickUpper, amount0Desired: projected0, amount1Desired: projected1, feePpm: pool.feePpm, sqrtPriceX96: pool.sqrtPriceX96 })
  }

  let projectedTurnover = rewardTurnover
  for (const route of routes.slice(rewardRouteCount)) projectedTurnover += quoteTurnover(BigInt(route.amountIn), route.tokenIn, config, snapshot, pool.sqrtPriceX96)
  const positionValueQuoteRaw =
    quoteTurnover(principal.amount0, snapshot.token0, config, snapshot, pool.sqrtPriceX96) +
    quoteTurnover(principal.amount1, snapshot.token1, config, snapshot, pool.sqrtPriceX96)
  const quoteDecimals = low(config.quoteToken) === low(snapshot.token0) ? snapshot.token0Decimals : snapshot.token1Decimals
  if (config.execution.maxDailyTurnoverQuote) {
    if (projectedTurnover > parseUnits(config.execution.maxDailyTurnoverQuote, quoteDecimals)) throw new Error('E_DAILY_LIMIT')
  }
  const projectedTurnoverWithHeadroom = projectedTurnover === 0n ? 0n : (projectedTurnover * 105n + 99n) / 100n
  return {
    ready: true,
    checkedAt: Math.floor(Date.now() / 1000),
    blockNumber: snapshot.blockNumber,
    plan,
    position: { tokenId: snapshot.tokenId, owner: snapshot.owner, liquidity: snapshot.liquidity, observedSide },
    range: { tickLower: range.tickLower, tickUpper: range.tickUpper },
    gas: { gasPriceWei: gasPrice.toString(), nativeBalanceWei: nativeBalance.toString(), requiredReserveWei: nativeReserve.toString(), decreaseEstimate: decreaseGas.toString(), collectEstimate: collectGas.toString() },
    allowances: { npm0: npmAllowance0.toString(), npm1: npmAllowance1.toString(), kyber0: routerAllowance0.toString(), kyber1: routerAllowance1.toString(), native0: nativeAllowance0.toString(), native1: nativeAllowance1.toString(), uni0: uniAllowance0.toString(), uni1: uniAllowance1.toString() },
    expected: { principal0: principal.amount0.toString(), principal1: principal.amount1.toString(), owed0: collectableFees.amount0.toString(), owed1: collectableFees.amount1.toString(), projected0: projected0.toString(), projected1: projected1.toString(), projectedTurnoverQuoteRaw: projectedTurnover.toString(), projectedTurnoverWithHeadroomQuoteRaw: projectedTurnoverWithHeadroom.toString(), positionValueQuoteRaw: positionValueQuoteRaw.toString(), quoteDecimals },
    routes,
    limitations: [
      'mint gas is estimated immediately before sending, after actual collect/swap receipts establish wallet balances',
      ...(config.staking?.enabled ? ['decrease/collect are estimated only after gauge withdrawal; reward sale uses the UP amount proven by the withdrawal receipt'] : []),
    ],
  }
}
