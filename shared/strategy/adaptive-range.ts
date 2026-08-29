import { tickDistanceBps } from './market-guard'

export type AdaptiveRangeInput = {
  enabled: boolean
  now: number
  positionStartedAt: number
  previousScale: number
  targetSeconds: number
  maxMultiplier: number
  recoveryDecay: number
  /** A rapid crossing may widen only when the adaptive economics gate allows it. */
  allowWiden?: boolean
}

export type AdaptiveRangeStability = {
  stable: boolean
  stayedInRange: boolean
  volatilityBps: number
}

const rounded = (value: number) => Math.round(value * 1_000_000) / 1_000_000

/**
 * First-passage time under diffusion grows approximately with width squared.
 * A position that touches too quickly therefore widens by sqrt(target/actual)
 * only when its economics justify it; otherwise it keeps the existing width.
 * Positions that survive the target shed excess width gradually.
 */
export function nextAdaptiveRangeScale(input: AdaptiveRangeInput): number {
  if (!input.enabled) return 1
  const previous = Math.min(Math.max(input.previousScale, 1), input.maxMultiplier)
  const age = Math.max(1, input.now - input.positionStartedAt)
  if (age < input.targetSeconds) {
    if (input.allowWiden === false) return previous
    return rounded(Math.min(input.maxMultiplier, previous * Math.sqrt(input.targetSeconds / age)))
  }
  return rounded(Math.max(1, 1 + (previous - 1) * input.recoveryDecay))
}

/** Fast crossings are widened only when the overall strategy is losing and the last cycle did not pay for itself. */
export function shouldWidenAdaptiveRange(input: {
  pnlQuoteRaw: bigint | null | undefined
  lastNetFeesQuoteRaw: bigint | null | undefined
  lastCycleCostQuoteRaw: bigint | null | undefined
}): boolean {
  if (input.pnlQuoteRaw === null || input.pnlQuoteRaw === undefined || input.pnlQuoteRaw >= 0n) return false
  if (input.lastNetFeesQuoteRaw === null || input.lastNetFeesQuoteRaw === undefined) return false
  const cost = input.lastCycleCostQuoteRaw ?? 0n
  return input.lastNetFeesQuoteRaw < cost
}

/** Timed range contraction is permitted only after recovery and sufficient current fee coverage. */
export function shouldContractAdaptiveRange(input: {
  pnlQuoteRaw: bigint | null | undefined
  currentFeesQuoteRaw: bigint | null | undefined
  priorCycleCostQuoteRaw: bigint | null | undefined
  feeCoverageMultiplier: number
}): boolean {
  if (input.pnlQuoteRaw === null || input.pnlQuoteRaw === undefined || input.pnlQuoteRaw < 0n) return false
  if (input.currentFeesQuoteRaw === null || input.currentFeesQuoteRaw === undefined) return false
  const cost = input.priorCycleCostQuoteRaw ?? 0n
  if (cost <= 0n) return false
  const required = BigInt(Math.ceil(input.feeCoverageMultiplier * 1_000_000))
  return input.currentFeesQuoteRaw * 1_000_000n >= cost * required
}

/** A wide position may contract only after its complete lookback stayed calm and in range. */
export function evaluateAdaptiveRangeStability(input: {
  minTick: number
  maxTick: number
  tickLower: number
  tickUpper: number
  maxVolatilityBps: number
}): AdaptiveRangeStability {
  const stayedInRange = input.minTick >= input.tickLower && input.maxTick < input.tickUpper
  const volatilityBps = tickDistanceBps(input.minTick, input.maxTick)
  return {
    stable: stayedInRange && volatilityBps <= input.maxVolatilityBps,
    stayedInRange,
    volatilityBps,
  }
}

export function scaledRangePcts(lowerPct: number, upperPct: number, scale: number) {
  const safeScale = Number.isFinite(scale) && scale >= 1 ? scale : 1
  return {
    // quoteRangeToTicks requires a positive lower price, so never allow 100%.
    lowerPct: Math.min(99 - 1e-9, lowerPct * safeScale),
    upperPct: Math.min(500, upperPct * safeScale),
  }
}
