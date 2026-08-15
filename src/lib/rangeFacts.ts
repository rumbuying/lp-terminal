/**
 * What a band means, before any money is in it.
 *
 * A depth chart says where a band SITS. These two facts say what it DOES, and
 * both are size-independent — they follow from the two bounds and the current
 * price alone, so they are readable the moment a preset chip is clicked and long
 * before an amount is typed. Today the same information only surfaces
 * downstream, in a fee APR that needs a deposit to exist first.
 *
 * Everything here is a float display helper. The prices coming in are already
 * decimals-adjusted (`tickToPrice`), which is fine: both formulas are invariant
 * under a uniform rescale of (pa, p, pb), so the decimals cancel.
 */

/** value split of a position across its two tokens, in fractions that sum to 1 */
export type ValueMix = { v0: number; v1: number }

// The two boundary terms both formulas are built from. An unbounded end
// contributes nothing to either — √0 = 0, and p/√∞ = 0 — and a full range
// arrives here as a tick price that has under- or overflowed the double, so the
// finite check is what turns those back into the exact limits.
function sqrtLower(pLo: number): number {
  return pLo > 0 && Number.isFinite(pLo) ? Math.sqrt(pLo) : 0
}
function priceOverSqrtUpper(p: number, pHi: number): number {
  return pHi > 0 && Number.isFinite(pHi) ? p / Math.sqrt(pHi) : 0
}

/**
 * Liquidity per dollar against a full range — the reason to narrow at all.
 *
 * A position of value V over [pa, pb] holds L = V / (2√p − √pa − p/√pb), and a
 * full range holds V / 2√p, so the ratio of the two is how many times harder the
 * same dollar works while price is inside. It is also exactly the ratio of fees
 * earned, since fees accrue per unit of active liquidity.
 *
 * For small symmetric bands this lands on 2/x for ±x, which is where the
 * familiar figures come from: ±0.5% ≈ 400×, ±1% ≈ 200×, ±10% ≈ 20.4×.
 *
 * Price is clamped into the band before the formula runs. A band the price has
 * not reached yet — the one-sided ABOVE/BELOW modes — would otherwise report a
 * concentration for a position earning nothing; clamped, it reports the
 * concentration it will have the moment price arrives, which is the number
 * someone placing that band is actually choosing.
 */
export function concentration(pLo: number, pCur: number, pHi: number): number | null {
  if (!(pCur > 0) || !Number.isFinite(pCur)) return null
  if (!(pHi > pLo)) return null
  const p = Math.min(Math.max(pCur, pLo), pHi)
  const full = 2 * Math.sqrt(p)
  const banded = full - sqrtLower(pLo) - priceOverSqrtUpper(p, pHi)
  if (!(banded > 0)) return null
  return full / banded
}

/**
 * How the position's value divides between the two tokens right now.
 *
 * amount0·p = L(√p − p/√pb) and amount1 = L(√p − √pa), both in token1 terms, so
 * L drops out and the answer holds for any deposit size. This is the split a zap
 * has to swap its way to, and at the bounds it degenerates the way the band
 * does: all of token0 at or below the lower bound, all of token1 at or above the
 * upper one.
 */
export function valueMix(pLo: number, pCur: number, pHi: number): ValueMix | null {
  if (!(pCur > 0) || !Number.isFinite(pCur)) return null
  if (!(pHi > pLo)) return null
  if (pCur <= pLo) return { v0: 1, v1: 0 }
  if (pCur >= pHi) return { v0: 0, v1: 1 }
  const rp = Math.sqrt(pCur)
  const a0 = rp - priceOverSqrtUpper(pCur, pHi)
  const a1 = rp - sqrtLower(pLo)
  const tot = a0 + a1
  if (!(tot > 0)) return null
  return { v0: a0 / tot, v1: a1 / tot }
}
