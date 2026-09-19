// Emerging replay engine — pure half (docs/EMERGING-POOL-LP-PRD.zh-CN.md
// §7.1, EMG-C00). Reconstructs a CL pool's tick state from its event history
// and attributes fees to a virtual position, span by span, at protocol
// integer precision.
//
// The swap-step math is a direct BigInt port of Uniswap v3-core's
// SqrtPriceMath + SwapMath (PRD appendix C): every division's rounding
// direction matches the core (roundUp for input-side deltas and
// sqrt-from-amount0, roundDown for outputs and fee shares). TickPrice math is
// shared with the validated src/lib/clmath.ts — never re-derived here.
//
// Integrity contract (§7.1): after each Swap event the reconstructed
// (sqrtPrice, tick, liquidity) MUST equal the event's own end-state figures —
// the event is the chain's word. A mismatch means the history is incomplete
// (a missed Mint/Burn), and the caller must mark the replay unsupported
// rather than trust the fee numbers.
import { getSqrtRatioAtTick, getAmountsForLiquidity } from '../src/lib/clmath'

const FEE_DENOMINATOR = 1_000_000n
export const Q96 = 1n << 96n

export function mulDivRoundingUp(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b + d - 1n) / d
}

/** v3-core SqrtPriceMath.getAmount0Delta (sorted inputs, rounding per core). */
export function amount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA]
  if (liquidity === 0n || sqrtA === sqrtB) return 0n
  const numerator1 = liquidity << 96n
  const numerator2 = sqrtB - sqrtA
  if (roundUp) return divUp(mulDivRoundingUp(numerator1, numerator2, sqrtB), sqrtA)
  return (numerator1 * numerator2) / sqrtB / sqrtA
}

function divUp(a: bigint, d: bigint): bigint {
  return (a + d - 1n) / d
}

/** v3-core SqrtPriceMath.getAmount1Delta (sorted inputs, rounding per core). */
export function amount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA]
  const diff = sqrtB - sqrtA
  return roundUp ? mulDivRoundingUp(liquidity, diff, Q96) : (liquidity * diff) / Q96
}

/** v3-core SqrtPriceMath.getNextSqrtPriceFromAmount0RoundingUp. */
export function nextSqrtFromAmount0(sqrtP: bigint, liquidity: bigint, amount: bigint, add: boolean): bigint {
  const numerator1 = liquidity << 96n
  const prod0 = amount * sqrtP
  const denominator = add ? numerator1 + prod0 : numerator1 - prod0
  if (denominator <= 0n) throw new Error('nextSqrtFromAmount0: non-positive denominator')
  return mulDivRoundingUp(numerator1, sqrtP, denominator)
}

/** v3-core SqrtPriceMath.getNextSqrtPriceFromAmount1RoundingDown. */
export function nextSqrtFromAmount1(sqrtP: bigint, liquidity: bigint, amount: bigint, add: boolean): bigint {
  const amountX96 = amount << 96n
  return add ? sqrtP + amountX96 / liquidity : sqrtP - amountX96 / liquidity
}

export type SwapStep = {
  sqrtNext: bigint
  amountIn: bigint   // input EXCLUDING fee
  amountOut: bigint
  feeAmount: bigint
}

/** v3-core SwapMath.computeSwapStep, exact. */
export function computeSwapStep(
  sqrtCurrent: bigint,
  sqrtTarget: bigint,
  liquidity: bigint,
  amountRemaining: bigint,
  feePpm: number,
): SwapStep {
  const zeroForOne = sqrtCurrent >= sqrtTarget
  const fee = BigInt(feePpm)
  const feeAmount = mulDivRoundingUp(amountRemaining, fee, FEE_DENOMINATOR)
  const amountRemainingLessFee = amountRemaining - feeAmount

  let sqrtNext: bigint
  let amountIn: bigint
  let amountOut: bigint
  if (zeroForOne) {
    const amount0Remaining = amount0Delta(sqrtTarget, sqrtCurrent, liquidity, false)
    if (amountRemainingLessFee >= amount0Remaining && amount0Remaining > 0n) {
      sqrtNext = sqrtTarget
      amountIn = amount0Delta(sqrtTarget, sqrtCurrent, liquidity, true)
      amountOut = amount1Delta(sqrtTarget, sqrtCurrent, liquidity, false)
    } else {
      sqrtNext = nextSqrtFromAmount0(sqrtCurrent, liquidity, amountRemainingLessFee, false)
      amountIn = amount0Delta(sqrtNext, sqrtCurrent, liquidity, true)
      amountOut = amount1Delta(sqrtNext, sqrtCurrent, liquidity, false)
    }
  } else {
    const amount1Remaining = amount1Delta(sqrtCurrent, sqrtTarget, liquidity, false)
    if (amountRemainingLessFee >= amount1Remaining && amount1Remaining > 0n) {
      sqrtNext = sqrtTarget
      amountIn = amount1Delta(sqrtCurrent, sqrtTarget, liquidity, true)
      amountOut = amount0Delta(sqrtCurrent, sqrtTarget, liquidity, false)
    } else {
      sqrtNext = nextSqrtFromAmount1(sqrtCurrent, liquidity, amountRemainingLessFee, true)
      amountIn = amount1Delta(sqrtCurrent, sqrtNext, liquidity, true)
      amountOut = amount0Delta(sqrtCurrent, sqrtNext, liquidity, false)
    }
  }
  const cappedFee = amountRemaining < amountIn + feeAmount ? amountRemaining - amountIn : feeAmount
  return { sqrtNext, amountIn, amountOut, feeAmount: cappedFee < 0n ? 0n : cappedFee }
}

// --- tick state and the virtual position ---

export type TickMap = Map<number, bigint> // tick → liquidityNet

/** Nearest initialized tick strictly below/above `from` (crossing walk). */
export function nextInitializedTick(ticks: TickMap, from: number, zeroForOne: boolean): number | null {
  let best: number | null = null
  for (const t of ticks.keys()) {
    if (zeroForOne ? t >= from : t <= from) continue
    if (ticks.get(t) === 0n) continue
    if (best === null) { best = t; continue }
    if (zeroForOne ? t > best : t < best) best = t
  }
  return best
}

export type VirtualPosition = {
  tickLower: number
  tickUpper: number
  liquidity: bigint
  entered: boolean
  owed0: bigint
  owed1: bigint
}

export type ReplayState = {
  sqrtP: bigint
  tick: number
  liquidity: bigint // pool ACTIVE liquidity
  ticks: TickMap
  position: VirtualPosition
  swaps: number
}

export function initState(): ReplayState {
  return {
    sqrtP: 0n, tick: 0, liquidity: 0n, ticks: new Map(),
    position: { tickLower: 0, tickUpper: 0, liquidity: 0n, entered: false, owed0: 0n, owed1: 0n },
    swaps: 0,
  }
}

export function applyMint(s: ReplayState, tickLower: number, tickUpper: number, amount: bigint): void {
  s.ticks.set(tickLower, (s.ticks.get(tickLower) ?? 0n) + amount)
  s.ticks.set(tickUpper, (s.ticks.get(tickUpper) ?? 0n) - amount)
  const sqrtA = getSqrtRatioAtTick(tickLower)
  const sqrtB = getSqrtRatioAtTick(tickUpper)
  if (s.sqrtP >= sqrtA && s.sqrtP < sqrtB) s.liquidity += amount
}

export function applyBurn(s: ReplayState, tickLower: number, tickUpper: number, amount: bigint): void {
  s.ticks.set(tickLower, (s.ticks.get(tickLower) ?? 0n) - amount)
  s.ticks.set(tickUpper, (s.ticks.get(tickUpper) ?? 0n) + amount)
  const sqrtA = getSqrtRatioAtTick(tickLower)
  const sqrtB = getSqrtRatioAtTick(tickUpper)
  if (s.sqrtP >= sqrtA && s.sqrtP < sqrtB) s.liquidity -= amount
}

/** Enter the virtual position. SHADOW liquidity never touches the tick map —
 *  the chain's own active L must stay exactly what its events say, so the
 *  per-swap integrity check can prove the reconstruction. The position's L
 *  enters only the fee-share denominator (§7.1 计入新增自身 L). */
export function enterPosition(s: ReplayState, tickLower: number, tickUpper: number, liquidity: bigint): void {
  if (s.position.entered) throw new Error('position already entered')
  s.position = { tickLower, tickUpper, liquidity, entered: true, owed0: 0n, owed1: 0n }
}

export function exitPosition(s: ReplayState): { amount0: bigint; amount1: bigint; fee0: bigint; fee1: bigint } {
  const p = s.position
  if (!p.entered) throw new Error('position not entered')
  const { amount0, amount1 } = getAmountsForLiquidity(s.sqrtP, getSqrtRatioAtTick(p.tickLower), getSqrtRatioAtTick(p.tickUpper), p.liquidity)
  applyBurn(s, p.tickLower, p.tickUpper, p.liquidity)
  s.position = { ...p, liquidity: 0n, entered: false }
  return { amount0, amount1, fee0: p.owed0, fee1: p.owed1 }
}

/**
 * Apply one v3 Swap event. `amount0/amount1` are the event's signed figures —
 * the positive side is the exact input (fee-bearing); the negative side is
 * the exact output. The walk reconstructs the crossed spans from the tick
 * map, so the fee split per span uses the ACTIVE liquidity the chain had
 * there — including the virtual position's own liquidity, per §7.1.
 */
export function applySwap(
  s: ReplayState,
  ev: { amount0: string; amount1: string; sqrtPriceX96: string; liquidity: string; tick: number },
  feePpm: number,
): { fee0: bigint; fee1: bigint; reconstructedLiquidity: bigint } {
  const a0 = BigInt(ev.amount0)
  const a1 = BigInt(ev.amount1)
  const zeroForOne = a0 > 0n
  let remaining = zeroForOne ? a0 : a1
  let fee0 = 0n
  let fee1 = 0n
  let reconstructedLiquidity = s.liquidity

  // Bootstrap (no observed price yet) or zero-liquidity pool: no walk is
  // possible or meaningful — adopt the event's end-state verbatim. Fees from
  // before the first observed swap are unattributable, and that honesty is
  // the point (§3.2).
  if (s.sqrtP === 0n || s.liquidity === 0n) {
    s.sqrtP = BigInt(ev.sqrtPriceX96)
    s.tick = ev.tick
    s.liquidity = BigInt(ev.liquidity)
    s.swaps++
    return { fee0, fee1, reconstructedLiquidity: BigInt(ev.liquidity) }
  }

  let guard = 0
  while (remaining > 0n) {
    if (++guard > 10_000) throw new Error('swap walk exceeded 10k spans')
    const spanLiquidity = s.liquidity
    if (spanLiquidity === 0n) {
      // A zero-liquidity region cannot price a move — the walk stops and the
      // event's end-state is adopted; the residual is unattributable.
      break
    }
    const targetTick = nextInitializedTick(s.ticks, s.tick, zeroForOne)
    if (targetTick === null) {
      // No further initialized tick: consume everything in one final step to
      // the event's own end price (the chain's word bounds the walk).
      const sqrtTarget = BigInt(ev.sqrtPriceX96)
      const step = computeSwapStep(s.sqrtP, sqrtTarget, spanLiquidity, remaining, feePpm)
      creditPosition(s, s.sqrtP, step.sqrtNext, spanLiquidity, step.feeAmount)
      fee0 += zeroForOne ? step.feeAmount : 0n
      fee1 += zeroForOne ? 0n : step.feeAmount
      s.sqrtP = step.sqrtNext
      s.tick = ev.tick
      remaining = 0n
      break
    }
    const sqrtTarget = getSqrtRatioAtTick(targetTick)
    const step = computeSwapStep(s.sqrtP, sqrtTarget, spanLiquidity, remaining, feePpm)
    creditPosition(s, s.sqrtP, step.sqrtNext, spanLiquidity, step.feeAmount)
    fee0 += zeroForOne ? step.feeAmount : 0n
    fee1 += zeroForOne ? 0n : step.feeAmount
    s.sqrtP = step.sqrtNext
    remaining -= step.amountIn + step.feeAmount
    if (remaining < 0n) throw new Error('swap walk overshot the input')
    // Crossed into the target tick?
    if (s.sqrtP === sqrtTarget) {
      const net = s.ticks.get(targetTick) ?? 0n
      reconstructedLiquidity += zeroForOne ? -net : net
      s.liquidity += zeroForOne ? -net : net
      s.tick = zeroForOne ? targetTick - 1 : targetTick
    }
  }
  // The reconstruction must agree with the chain's own end-state liquidity —
  // the driver compares `reconstructedLiquidity` against `ev.liquidity`.
  s.sqrtP = BigInt(ev.sqrtPriceX96)
  s.tick = ev.tick
  s.liquidity = BigInt(ev.liquidity)
  s.swaps++
  return { fee0, fee1, reconstructedLiquidity }
}

/** The position earns its pro-rata share of each span's fee, its OWN
 *  liquidity included in the denominator (§7.1's 计入新增自身 L). The span
 *  must lie FULLY inside the position's range: the chain's walk stops at the
 *  chain's own ticks, but the shadow boundaries are not on the tick map, so
 *  a chain span may straddle the shadow range — a straddling span pays the
 *  position nothing (its L is not active across the whole span). */
function creditPosition(s: ReplayState, sqrtFrom: bigint, sqrtTo: bigint, spanLiquidity: bigint, feeAmount: bigint): void {
  const p = s.position
  if (!p.entered || p.liquidity === 0n || feeAmount === 0n) return
  const sqrtA = getSqrtRatioAtTick(p.tickLower)
  const sqrtB = getSqrtRatioAtTick(p.tickUpper)
  const hi = sqrtFrom > sqrtTo ? sqrtFrom : sqrtTo
  const lo = sqrtFrom > sqrtTo ? sqrtTo : sqrtFrom
  if (lo < sqrtA || hi > sqrtB) return
  const total = spanLiquidity + p.liquidity
  const zeroForOne = sqrtFrom >= sqrtTo
  if (zeroForOne) {
    p.owed0 += (feeAmount * p.liquidity) / total
  } else {
    p.owed1 += (feeAmount * p.liquidity) / total
  }
}

/** Reconcile the reconstructed state against a v3 pool's observed amounts. */
export function positionAmounts(s: ReplayState): { amount0: bigint; amount1: bigint } {
  const p = s.position
  return getAmountsForLiquidity(s.sqrtP, getSqrtRatioAtTick(p.tickLower), getSqrtRatioAtTick(p.tickUpper), p.liquidity)
}
