export type DataFreshness = 'fresh' | 'stale' | 'unavailable'

/** Classify an observation without turning a missing or future timestamp into
 * usable data. `updatedAt` is seconds; TTL is milliseconds to match TUNE. */
export function dataFreshness(
  updatedAt: number | null | undefined,
  ttlMs: number,
  timestamp = Math.floor(Date.now() / 1_000),
): DataFreshness {
  if (!Number.isFinite(updatedAt) || !updatedAt || updatedAt <= 0 || updatedAt > timestamp) return 'unavailable'
  return timestamp - updatedAt <= ttlMs / 1_000 ? 'fresh' : 'stale'
}

export const freshEnough = (
  updatedAt: number | null | undefined,
  ttlMs: number,
  timestamp?: number,
): boolean => dataFreshness(updatedAt, ttlMs, timestamp) === 'fresh'
