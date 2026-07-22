// WHAT'S NEW freshness. The header dot is a pure function of the clock and the
// catalog — there is no "seen" state and nothing in localStorage: an entry
// lights the dot while it is younger than FRESH_MS and goes quiet on its own.
import { CHANGELOG, type NewsEntry } from '../content/changelog'

/** how long a shipped entry stays new (user's rule: two days) */
export const FRESH_MS = 2 * 24 * 60 * 60 * 1000

/** epoch ms for an entry's ship date — NaN if the catalog date is malformed */
export function entryTime(date: string): number {
  return Date.parse(date + 'T00:00:00Z')
}

/**
 * A malformed date parses to NaN and every comparison against NaN is false, so
 * a typo costs the dot rather than crashing the header; news.test.ts pins the
 * catalog's dates so that can't go unnoticed. A future date reads as fresh.
 */
export function isFresh(e: NewsEntry, now: number): boolean {
  return now - entryTime(e.date) < FRESH_MS
}

export function freshCount(now: number, entries: NewsEntry[] = CHANGELOG): number {
  return entries.filter((e) => isFresh(e, now)).length
}
