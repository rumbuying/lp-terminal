import {
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getSqrtRatioAtTick,
  previewDeposit,
} from './clmath'

/** which token of the pair an amount belongs to */
export type Side = 0 | 1

/** a two-token deposit, in raw units */
export type Pair = { amount0: bigint; amount1: bigint }

/** stands in for "this side does not bind here" (see clmath's own use of it) */
const UNBOUNDED = 1n << 224n

/** a liquidity big enough that flooring the amounts it buys is lost in the noise */
const REFERENCE_L = 1n << 96n

/** frozen: it is returned by reference, and a caller mutating it would poison
    every later "nothing to deposit" answer in the process */
const EMPTY: Pair = Object.freeze({ amount0: 0n, amount1: 0n })

/**
 * Which tokens a band takes at this price. Mirrors previewDeposit's branches,
 * boundary for boundary: a band whose upper edge is AT the price is token1-only
 * (the price has already left it), and one whose lower edge is at the price is
 * token0-only.
 */
export function sidesForBand(
  sqrtP: bigint,
  tickLower: number,
  tickUpper: number,
): { needs0: boolean; needs1: boolean } {
  return {
    needs0: sqrtP < getSqrtRatioAtTick(tickUpper),
    needs1: sqrtP > getSqrtRatioAtTick(tickLower),
  }
}

/**
 * What a deposit is worth, priced in token1 at spot and carried in Q64 — that
 * is, token1 units scaled by 2^64.
 *
 * The pool itself is the exchange rate, so this needs no oracle and no USD,
 * which matters: it is the quantity a band change has to conserve, and the
 * dollar feed is allowed to be missing.
 *
 * The scaling is not decoration. Raw token amounts are decimal-scaled, so a
 * pool pairing 18 decimals against 6 can price a whole atom of token0 at well
 * under one atom of token1; unscaled, a small deposit weighs zero and moving
 * the band would silently empty both boxes. Only the RATIO of two of these is
 * ever used, so the scale divides out.
 */
export function valueInSide1X64(pair: Pair, sqrtP: bigint): bigint {
  return (pair.amount1 << 64n) + ((pair.amount0 * sqrtP * sqrtP) >> 128n)
}

/**
 * The pair a band demands, given how much of ONE token goes in. This is what
 * typing does: the box under the cursor is the size, and its partner follows.
 *
 * Typing into a side the band does not take moves the amount across at spot,
 * rather than leaving it to sit on a token that cannot be deposited.
 */
export function pairFrom(
  sqrtP: bigint,
  tickLower: number,
  tickUpper: number,
  amount: bigint,
  side: Side,
): Pair {
  const preview = previewDeposit(sqrtP, tickLower, tickUpper, amount, side === 0)
  if (preview) return { amount0: preview.amount0, amount1: preview.amount1 }
  return refitToBand(
    side === 0 ? { amount0: amount, amount1: 0n } : { amount0: 0n, amount1: amount },
    sqrtP,
    tickLower,
    tickUpper,
  )
}

/**
 * Carry a deposit onto a band that has just moved, holding its VALUE still.
 *
 * The obvious rule — freeze the number that was typed and re-derive the other —
 * is the one every AMM front end uses, and dragging a band under it is
 * violent. Widening a ±10% band to ±80% with 100 USDT pinned took a measured
 * $200 position to $1,814, because a fixed amount of one token buys wildly
 * different amounts of the other as the band's shape changes. Worse, a band
 * dragged PAST the price leaves the pinned side unusable: the deposit strands
 * on a token the band cannot mint from, liquidity comes out zero, and the mint
 * reverts after the reader has already paid for an approval.
 *
 * Holding the deposit's worth still instead makes a drag mean exactly one
 * thing — the same money, split differently — which is the reading the
 * composition line under the chart already invites. Size is then a decision
 * made by typing, and shape a decision made by dragging, and neither overwrites
 * the other.
 *
 * Amounts are linear in liquidity, so one reference liquidity prices the whole
 * band and the answer is a single scaling.
 */
export function refitToBand(
  prev: Pair,
  sqrtP: bigint,
  tickLower: number,
  tickUpper: number,
): Pair {
  const target = valueInSide1X64(prev, sqrtP)
  if (target <= 0n) return EMPTY
  const sqrtA = getSqrtRatioAtTick(tickLower)
  const sqrtB = getSqrtRatioAtTick(tickUpper)
  const reference = getAmountsForLiquidity(sqrtP, sqrtA, sqrtB, REFERENCE_L)
  const unit = valueInSide1X64(reference, sqrtP)
  if (unit <= 0n) return EMPTY
  return getAmountsForLiquidity(sqrtP, sqrtA, sqrtB, (REFERENCE_L * target) / unit)
}

/**
 * The largest position these balances can fund on this band.
 *
 * Sizing one side to its whole balance and deriving the other is what a MAX
 * button used to do, and it lands over the other balance far more often than
 * not — the deposit is then unmintable and nothing on screen says by how much
 * to come down. Both sides bind the same liquidity, so ask each balance what
 * liquidity it can pay for and take the smaller: the amounts that fall out of
 * it are, by construction, within both balances.
 *
 * Only a balance the band can actually spend binds it. A balance not yet read
 * is unread rather than zero, and a token the band does not take is not a
 * budget at all — size a token1-only band off the token0 balance and the answer
 * is an offer to deposit a token the wallet has never been asked about.
 */
export function largestFundable(
  sqrtP: bigint,
  tickLower: number,
  tickUpper: number,
  bal0: bigint | undefined,
  bal1: bigint | undefined,
): Pair {
  const { needs0, needs1 } = sidesForBand(sqrtP, tickLower, tickUpper)
  const budget0 = needs0 ? bal0 : undefined
  const budget1 = needs1 ? bal1 : undefined
  // Only one budget: nothing to compare, and no liquidity worth pricing to
  // find that out. Whichever one exists is the whole answer.
  if (budget1 === undefined)
    return budget0 === undefined ? EMPTY : pairFrom(sqrtP, tickLower, tickUpper, budget0, 0)
  if (budget0 === undefined) return pairFrom(sqrtP, tickLower, tickUpper, budget1, 1)
  const sqrtA = getSqrtRatioAtTick(tickLower)
  const sqrtB = getSqrtRatioAtTick(tickUpper)
  const l0 = getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, budget0, UNBOUNDED)
  const l1 = getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, UNBOUNDED, budget1)
  // The scarcer side goes in WHOLE and the other is derived from it. Reading
  // both amounts back out of the liquidity they fund would floor twice and put
  // `2.999999999999999999` in the box of a wallet holding exactly 3.
  return l0 <= l1
    ? pairFrom(sqrtP, tickLower, tickUpper, budget0, 0)
    : pairFrom(sqrtP, tickLower, tickUpper, budget1, 1)
}

/** what this pair actually mints — zero is a deposit that would revert */
export function pairLiquidity(
  sqrtP: bigint,
  tickLower: number,
  tickUpper: number,
  amount0: bigint,
  amount1: bigint,
): bigint {
  return getLiquidityForAmounts(
    sqrtP,
    getSqrtRatioAtTick(tickLower),
    getSqrtRatioAtTick(tickUpper),
    amount0,
    amount1,
  )
}
