import { alignTick, priceToTick, tickToPrice } from '../../src/lib/clmath'
import { MAX_TICK, MIN_TICK } from '../../src/lib/clmath'

export type TickRangeInput = {
  centerQuotePerRisk: number
  lowerPct: number
  upperPct: number
  currentTick: number
  tickSpacing: number
  token0IsRisk: boolean
  token0Decimals: number
  token1Decimals: number
}

export type TickRange = {
  tickLower: number
  tickUpper: number
  quoteLower: number
  quoteUpper: number
  actualQuoteLower: number
  actualQuoteUpper: number
}

const validPrice = (p: number, name: string) => {
  if (!Number.isFinite(p) || p <= 0) throw new Error(`${name} must be positive`)
}

/**
 * Converts quote/risk boundaries into token1/token0 ticks. The orientation
 * conversion is intentionally isolated: all strategy callers work in the
 * human-friendly quote-per-risk direction.
 */
export function quoteRangeToTicks(input: TickRangeInput): TickRange {
  validPrice(input.centerQuotePerRisk, 'center price')
  if (!(input.lowerPct > 0 && input.lowerPct < 100 && input.upperPct > 0)) throw new Error('invalid range percent')
  if (!Number.isInteger(input.tickSpacing) || input.tickSpacing <= 0) throw new Error('invalid tick spacing')
  const quoteLower = input.centerQuotePerRisk * (1 - input.lowerPct / 100)
  const quoteUpper = input.centerQuotePerRisk * (1 + input.upperPct / 100)
  const rawLower = input.token0IsRisk ? quoteLower : 1 / quoteUpper
  const rawUpper = input.token0IsRisk ? quoteUpper : 1 / quoteLower
  let tickLower = alignTick(priceToTick(rawLower, input.token0Decimals, input.token1Decimals), input.tickSpacing, 'floor')
  let tickUpper = alignTick(priceToTick(rawUpper, input.token0Decimals, input.token1Decimals), input.tickSpacing, 'ceil')
  if (tickLower >= input.currentTick) tickLower = alignTick(input.currentTick - input.tickSpacing, input.tickSpacing, 'floor')
  if (tickUpper <= input.currentTick) tickUpper = alignTick(input.currentTick + input.tickSpacing, input.tickSpacing, 'ceil')
  if (tickLower >= tickUpper) throw new Error('range collapsed after tick alignment')
  const rawActualLower = tickToPrice(tickLower, input.token0Decimals, input.token1Decimals)
  const rawActualUpper = tickToPrice(tickUpper, input.token0Decimals, input.token1Decimals)
  return {
    tickLower,
    tickUpper,
    quoteLower,
    quoteUpper,
    actualQuoteLower: input.token0IsRisk ? rawActualLower : 1 / rawActualUpper,
    actualQuoteUpper: input.token0IsRisk ? rawActualUpper : 1 / rawActualLower,
  }
}

export function rangeSide(tick: number, tickLower: number, tickUpper: number): 'in' | 'lower' | 'upper' {
  if (tick < tickLower) return 'lower'
  if (tick >= tickUpper) return 'upper'
  return 'in'
}

/** Validate an exact protocol tick range without silently changing user input. */
export function fixedTickRange(tickLower: number | undefined, tickUpper: number | undefined, tickSpacing: number) {
  if (!Number.isInteger(tickLower) || !Number.isInteger(tickUpper)) throw new Error('fixed tick range requires integer ticks')
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) throw new Error('invalid tick spacing')
  const lower = tickLower as number
  const upper = tickUpper as number
  if (lower < MIN_TICK || upper > MAX_TICK || lower >= upper) throw new Error('invalid fixed tick range')
  if (lower % tickSpacing !== 0 || upper % tickSpacing !== 0) throw new Error('fixed ticks must align to pool tick spacing')
  return { tickLower: lower, tickUpper: upper }
}
