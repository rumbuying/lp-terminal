type SlippageTone = 'green' | 'amber' | 'red'
export const SLIPPAGE_CHOICES = [50, 100, 300] as const
export type SlippageBps = (typeof SLIPPAGE_CHOICES)[number]
export type AutoSlippage = { bps: number; tone: SlippageTone }

// bounds for ANY slippage value — auto-derived, preset, or hand-typed
export const MIN_SLIPPAGE_BPS = 10 // 0.1% floor
export const MAX_SLIPPAGE_BPS = 5000 // 50% fat-finger ceiling

/** clamp + round an arbitrary bps into the allowed slippage band */
export function clampSlippageBps(bps: number): number {
  if (!Number.isFinite(bps)) return MIN_SLIPPAGE_BPS
  return Math.min(MAX_SLIPPAGE_BPS, Math.max(MIN_SLIPPAGE_BPS, Math.round(bps)))
}

/** a user-typed percent ("2.5") → clamped bps, or null when not a positive number */
export function slippagePctToBps(pct: string): number | null {
  const n = Number(pct.trim())
  if (!Number.isFinite(n) || n <= 0) return null
  return clampSlippageBps(Math.round(n * 100))
}

/** shared warning tone for any slippage magnitude */
export function slippageTone(bps: number): SlippageTone {
  if (bps <= 100) return 'green'
  if (bps <= 300) return 'amber'
  return 'red'
}

// Past this width the tolerance is the whole risk. At 10% a fill can land a
// tenth below the number on screen and still settle, and between the button and
// the wallet nothing asks again — the tolerance is already inside the calldata
// by then. So the button asks, in a press of its own that names the percentage.
//
// Strictly greater: 10% chosen deliberately is a number the user typed, and a
// preset that lands exactly on the line was still a choice made at the editor.
export const CONFIRM_SLIPPAGE_BPS = 1000 // 10%

/** does this tolerance have to be confirmed a second time before it is signed? */
export function needsSlippageConfirm(bps: number | undefined): boolean {
  return bps !== undefined && bps > CONFIRM_SLIPPAGE_BPS
}

// past this measured impact AUTO refuses to guess: the trade is eating so much
// of the pool that a derived tolerance is meaningless (it balloons toward the
// 50% ceiling), so the user must set the number by hand — same forced-choice
// path as an unavailable impact probe.
export const AUTO_IMPACT_LIMIT_BPS = 1000 // 10%

/** AUTO floor after a slippage-caused halt: 1.5× the tolerance that just
 *  failed, rounded up to 0.1% — re-offering the number that failed would just
 *  fail again, while an unbounded jump would be a blank check */
export function retrySlippage(failedBps: number): number {
  return clampSlippageBps(Math.ceil((failedBps * 1.5) / 10) * 10)
}

/**
 * Quote-derived AUTO policy for MARKET + ZAP: the tolerance absorbs price drift
 * between quote and execution. Cover the quote's measured impact, plus the
 * pool's fee tier as a volatility prior (1% tiers exist because their pairs
 * move between blocks; 0.05% tiers barely do — the fee itself is already paid
 * inside the quote, it is NOT a cost here), plus a 0.3% pad — or half the
 * impact when that is larger. Rounded up to 0.1%, no fixed ceiling inside the
 * sane range. Returns null past AUTO_IMPACT_LIMIT_BPS so the caller forces an
 * explicit choice. Override anytime via a preset or typed value.
 */
export function autoSlippage(impactBps: number, poolFeeBps: number): AutoSlippage | null {
  const safe = Number.isFinite(impactBps) && impactBps > 0 ? impactBps : 0
  if (safe > AUTO_IMPACT_LIMIT_BPS) return null
  const fee = Number.isFinite(poolFeeBps) && poolFeeBps > 0 ? poolFeeBps : 0
  const raw = safe + fee + Math.max(30, safe * 0.5) // impact + pool fee + max(0.3%, half the impact)
  const bps = clampSlippageBps(Math.ceil(raw / 10) * 10)
  return { bps, tone: slippageTone(bps) }
}

/**
 * A quote's baseline-relative execution cost in bps. `netOut` is what the user
 * actually receives; `midOut` is the same-block fee-free executable-probe
 * secant scaled to this size. Their gap includes full-trade depth beyond the
 * probe, pool fees, modeled transfer taxes and the terminal fee without asking
 * clients to sum components (or double-count them). It is not a zero-size-mid
 * decomposition because the probe retains its own depth move.
 *
 * Every row on screen divides by the SAME `midOut`, whichever quote source
 * produced it, so the ordering matches delivered output by construction and the
 * cost can never contradict the "behind best" chip beside it. Scoring each row
 * against its own probe did exactly that: measured on-chain, the solver
 * delivered +26.66 bps more CASHCAT than the best direct route while its card
 * read 0.55% against that row's 0.30%, ranking the two backwards.
 *
 * A missing baseline, or one below the delivered output because the quotes are
 * out of sync, makes the cost unavailable.
 */
export function allInCostBps(netOut: bigint, midOut: bigint | null): number | null {
  if (midOut === null) return null
  if (netOut > midOut) return null
  return Number(((midOut - netOut) * 10_000n + midOut / 2n) / midOut) // nearest, not floor
}
