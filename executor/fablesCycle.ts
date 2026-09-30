import { decodeEventLog, zeroAddress, type Address, type TransactionReceipt } from 'viem'
import { fablesHookAbi } from '../src/abi/fables'
import { sqrtPriceToPrice } from '../src/lib/clmath'
import { quoteRangeToTicks } from '../shared/strategy/range'
import { targetUnits } from '../shared/strategy/rebalance'
import type { FablesStrategyConfig } from '../shared/strategy/types'
import type { FablesPosition } from '../src/lib/fables'

export type FablesAmounts = { amount0: bigint; amount1: bigint }

/** Current pool spot value split for the proposed range, in basis points. */
export function fablesTargetValueBps(units: FablesAmounts, sqrtPriceX96: bigint): { token0: number; token1: number } {
  if (units.amount0 <= 0n || units.amount1 <= 0n || sqrtPriceX96 <= 0n)
    throw new Error('E_FABLES_TARGET_RATIO')
  const value0 = units.amount0 * sqrtPriceX96 * sqrtPriceX96
  const value1 = units.amount1 * (1n << 192n)
  const token0 = Number(value0 * 10_000n / (value0 + value1))
  return { token0, token1: 10_000 - token0 }
}

export function allocateFablesFees(funds: FablesAmounts, fees: FablesAmounts,
  handling: FablesStrategyConfig['fees']['handling']): { lp: FablesAmounts; held: FablesAmounts } {
  if (handling === 'reinvest') return { lp: funds, held: { amount0: 0n, amount1: 0n } }
  const held = {
    amount0: fees.amount0 < funds.amount0 ? fees.amount0 : funds.amount0,
    amount1: fees.amount1 < funds.amount1 ? fees.amount1 : funds.amount1,
  }
  return { lp: { amount0: funds.amount0 - held.amount0, amount1: funds.amount1 - held.amount1 }, held }
}

/** Only wallet balance gained after exit belongs to this rebalance cycle. */
export function cycleOwnedAmounts(args: {
  currency0: Address; currency1: Address
  baseline: FablesAmounts; current: FablesAmounts
}): FablesAmounts {
  const delta0 = args.current.amount0 - args.baseline.amount0
  const delta1 = args.current.amount1 - args.baseline.amount1
  const native0 = args.currency0.toLowerCase() === zeroAddress
  const native1 = args.currency1.toLowerCase() === zeroAddress
  if ((!native0 && delta0 < 0n) || (!native1 && delta1 < 0n))
    throw new Error('E_FABLES_WALLET_BALANCE_FELL')
  return { amount0: delta0 < 0n ? 0n : delta0, amount1: delta1 < 0n ? 0n : delta1 }
}

/**
 * Deployable funds for a rebalance cycle: the wallet balance above the native
 * gas reserve. Sweeping the whole surplus — not just the post-exit delta —
 * matters because deposit remainders and retained fees otherwise strand in
 * the wallet forever (2026-09-30 review: a third of a live strategy's capital
 * sat idle while the position kept shrinking). The native gas reserve and the
 * current cycle's retained fees (subtracted by the callers) stay untouched.
 */
export function cycleSpendableAmounts(args: {
  currency0: Address; currency1: Address
  current: FablesAmounts; nativeGasReserve: bigint
}): FablesAmounts {
  if (args.nativeGasReserve < 0n) throw new Error('E_FABLES_GAS_RESERVE')
  const aboveReserve = (amount: bigint) =>
    amount > args.nativeGasReserve ? amount - args.nativeGasReserve : 0n
  return {
    amount0: args.currency0.toLowerCase() === zeroAddress
      ? aboveReserve(args.current.amount0) : args.current.amount0,
    amount1: args.currency1.toLowerCase() === zeroAddress
      ? aboveReserve(args.current.amount1) : args.current.amount1,
  }
}

/** Fee event amounts are net tokens paid to the wallet, never a future swap-fee prediction. */
export function claimedFablesFees(receipt: TransactionReceipt, hook: Address, owner: Address, rangeId: bigint): FablesAmounts {
  let amount0 = 0n
  let amount1 = 0n
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== hook.toLowerCase()) continue
    try {
      const event = decodeEventLog({ abi: fablesHookAbi, data: log.data, topics: log.topics })
      if (event.eventName !== 'FeesClaimed' || event.args.owner.toLowerCase() !== owner.toLowerCase()
        || event.args.rangeId !== rangeId) continue
      amount0 += event.args.amount0
      amount1 += event.args.amount1
    } catch { /* unrelated hook event */ }
  }
  return { amount0, amount1 }
}

export function mintedFablesShares(receipt: TransactionReceipt, hook: Address, owner: Address, rangeId: bigint): bigint {
  let shares = 0n
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== hook.toLowerCase()) continue
    try {
      const event = decodeEventLog({ abi: fablesHookAbi, data: log.data, topics: log.topics })
      if (event.eventName !== 'Transfer' || event.args.from.toLowerCase() !== zeroAddress
        || event.args.to.toLowerCase() !== owner.toLowerCase() || event.args.id !== rangeId) continue
      shares += event.args.amount
    } catch { /* unrelated hook event */ }
  }
  return shares
}

export function freshFablesRange(config: FablesStrategyConfig, position: FablesPosition,
  decimals0: number, decimals1: number) {
  const token0IsRisk = position.pool.key.currency0.toLowerCase() === config.riskToken.toLowerCase()
  if (!(token0IsRisk || position.pool.key.currency1.toLowerCase() === config.riskToken.toLowerCase()))
    throw new Error('E_FABLES_TOKENS')
  const price01 = sqrtPriceToPrice(position.sqrtPriceX96, decimals0, decimals1)
  const quotePerRisk = token0IsRisk ? price01 : 1 / price01
  const range = quoteRangeToTicks({ centerQuotePerRisk: quotePerRisk,
    lowerPct: config.range.lowerPct, upperPct: config.range.upperPct,
    currentTick: position.tick, tickSpacing: position.pool.key.tickSpacing,
    token0IsRisk, token0Decimals: decimals0, token1Decimals: decimals1 })
  const units = targetUnits(position.sqrtPriceX96, range.tickLower, range.tickUpper)
  return { ...range, units }
}

/** Compare the executable route with the live pool price, independent of dynamic LP fee forecasts. */
export function fablesSwapImpactBps(args: {
  amountIn: bigint; quotedOut: bigint; tokenIn: Address; currency0: Address
  sqrtPriceX96: bigint
}): bigint {
  if (args.amountIn <= 0n || args.quotedOut <= 0n || args.sqrtPriceX96 <= 0n)
    throw new Error('E_FABLES_SWAP_QUOTE')
  const priceX192 = args.sqrtPriceX96 * args.sqrtPriceX96
  const q192 = 1n << 192n
  const spotOut = args.tokenIn.toLowerCase() === args.currency0.toLowerCase()
    ? args.amountIn * priceX192 / q192
    : args.amountIn * q192 / priceX192
  if (spotOut <= 0n) throw new Error('E_FABLES_SWAP_SPOT')
  return args.quotedOut >= spotOut ? 0n : (spotOut - args.quotedOut) * 10_000n / spotOut
}
