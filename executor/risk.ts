import type { Address } from 'viem'
import { fixedTickRange, quoteRangeToTicks } from '../shared/strategy/range'
import type { StrategyConfig, StrategyPositionSnapshot, TriggerSide } from '../shared/strategy/types'
import { tickToPrice } from '../src/lib/clmath'
import { scaledRangePcts } from '../shared/strategy/adaptive-range'

const Q192 = 1n << 192n
const low = (value: string) => value.toLowerCase()

export function freshRange(config: StrategyConfig, snapshot: StrategyPositionSnapshot, tick: number, side?: TriggerSide, rangeScale = 1) {
  if (config.range.mode === 'fixed_ticks') return fixedTickRange(config.range.tickLower, config.range.tickUpper, snapshot.tickSpacing)
  const token0IsRisk = low(snapshot.token0) === low(config.riskToken)
  const token1Per0 = tickToPrice(tick, snapshot.token0Decimals, snapshot.token1Decimals)
  const policy = side === 'lower' ? config.boundary.lower : side === 'upper' ? config.boundary.upper : undefined
  const baseLowerPct = policy?.action === 'skew_recenter' ? config.range.defensiveLowerPct ?? config.range.lowerPct : config.range.lowerPct
  const baseUpperPct = policy?.action === 'skew_recenter' ? config.range.defensiveUpperPct ?? config.range.upperPct : config.range.upperPct
  const { lowerPct, upperPct } = scaledRangePcts(baseLowerPct, baseUpperPct, rangeScale)
  return quoteRangeToTicks({
    centerQuotePerRisk: token0IsRisk ? token1Per0 : 1 / token1Per0,
    lowerPct,
    upperPct,
    currentTick: tick,
    tickSpacing: snapshot.tickSpacing,
    token0IsRisk,
    token0Decimals: snapshot.token0Decimals,
    token1Decimals: snapshot.token1Decimals,
  })
}

export function convertPoolAmount(amount: bigint, tokenIn: Address, tokenOut: Address, snapshot: StrategyPositionSnapshot, sqrtPriceX96: bigint): bigint {
  const in0 = low(tokenIn) === low(snapshot.token0)
  const out0 = low(tokenOut) === low(snapshot.token0)
  if (in0 === out0 || (low(tokenIn) !== low(snapshot.token0) && low(tokenIn) !== low(snapshot.token1)) || (low(tokenOut) !== low(snapshot.token0) && low(tokenOut) !== low(snapshot.token1)))
    throw new Error('E_POOL_IDENTITY')
  const squared = sqrtPriceX96 * sqrtPriceX96
  return in0 ? (amount * squared) / Q192 : (amount * Q192) / squared
}

export function quoteTurnover(amount: bigint, token: Address, config: StrategyConfig, snapshot: StrategyPositionSnapshot, sqrtPriceX96: bigint): bigint {
  if (low(token) === low(config.quoteToken)) return amount
  if (low(token) !== low(config.riskToken)) throw new Error('E_POOL_IDENTITY')
  return convertPoolAmount(amount, token, config.quoteToken, snapshot, sqrtPriceX96)
}

export function swapImpactBps(amountIn: bigint, quotedOut: bigint, tokenIn: Address, tokenOut: Address, snapshot: StrategyPositionSnapshot, sqrtPriceX96: bigint): bigint {
  const spotOut = convertPoolAmount(amountIn, tokenIn, tokenOut, snapshot, sqrtPriceX96)
  if (spotOut === 0n || quotedOut >= spotOut) return 0n
  return ((spotOut - quotedOut) * 10_000n) / spotOut
}

export function riskAssetPct(amount0: bigint, amount1: bigint, config: StrategyConfig, snapshot: StrategyPositionSnapshot, sqrtPriceX96: bigint): number {
  const riskRaw = low(config.riskToken) === low(snapshot.token0) ? amount0 : amount1
  const quoteRaw = low(config.quoteToken) === low(snapshot.token0) ? amount0 : amount1
  const riskQuote = quoteTurnover(riskRaw, config.riskToken, config, snapshot, sqrtPriceX96)
  const total = riskQuote + quoteRaw
  if (total === 0n) return 0
  return Number((riskQuote * 1_000_000n) / total) / 10_000
}
