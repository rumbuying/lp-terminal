import type { StrategyConfig } from './types'

/**
 * Cycle-count safety caps: the daily rebalance ceiling and the consecutive
 * lower-break ceiling. Both live in the runner's precheck (defense in depth),
 * are mirrored read-only by the monitor to avoid planning jobs that can only
 * fail, and are surfaced through the guard report so a parked strategy shows
 * which cap is saturated and when it releases.
 */

/** A completed cycle, newest first, as the counters consume them. */
export type CompletedCycleRef = { triggerSide: string | null; completedAt: number }

/** Default decay window for the lower-break streak: 24 hours. */
export const DEFAULT_LOWER_BREAK_WINDOW_MINUTES = 1440

export function lowerBreakWindowSeconds(safeguards: StrategyConfig['safeguards']): number {
  const minutes = safeguards.lowerBreakWindowMinutes ?? DEFAULT_LOWER_BREAK_WINDOW_MINUTES
  return Math.max(60, Math.floor(minutes * 60))
}

/**
 * Trailing streak of lower-side recenter cycles that all completed inside the
 * rolling window. A streak older than the window decays to zero.
 *
 * Without the window the cap can deadlock: the count only resets when a
 * non-lower cycle completes, but while price stays below the range every
 * plannable cycle IS a lower recenter — and the cap blocks exactly those, so a
 * position could sit out of range forever (observed in production 2026-09-19).
 * With the window the cap degrades into a bounded rate limit: at most
 * `threshold` lower recenters per window, then it releases itself.
 */
export function countConsecutiveLowerBreaks(cycles: readonly CompletedCycleRef[], args: { now: number; windowSeconds: number }): number {
  const cutoff = args.now - args.windowSeconds
  let count = 0
  for (const cycle of cycles) {
    if (cycle.triggerSide !== 'lower') break
    if (cycle.completedAt < cutoff) break
    count += 1
  }
  return count
}

/**
 * When the streak currently blocks (count >= threshold), the epoch second at
 * which enough of it leaves the window for the cap to release. The j-th cycle
 * to age out is the j-th oldest counted one, so the release happens when the
 * `threshold`-th newest streak entry exits the window. Undefined once the
 * streak no longer blocks.
 */
export function consecutiveLowerBreakResetAt(cycles: readonly CompletedCycleRef[], args: {
  now: number
  windowSeconds: number
  threshold: number
}): number | undefined {
  if (args.threshold <= 0) return undefined
  const count = countConsecutiveLowerBreaks(cycles, args)
  if (count < args.threshold) return undefined
  const releasing = cycles[args.threshold - 1]
  if (!releasing || releasing.triggerSide !== 'lower') return undefined
  return releasing.completedAt + args.windowSeconds
}

/** Start of the next UTC day: when the daily rebalance counter resets. */
export function nextUtcDayStart(now: number): number {
  return Math.floor(now / 86_400) * 86_400 + 86_400
}
