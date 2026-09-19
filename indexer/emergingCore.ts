// Pure half of the emerging discovery ledger (PRD §3/§4.1): identity math,
// age transitions and the admission queue. No I/O, no clock, no config —
// every function takes what it needs, so the tests below pin exactly what
// runs in production (the volumeTrend.ts discipline).
import type {
  EmergingObservationReason,
  EmergingObservationState,
  EmergingPoolKey,
  EmergingVenue,
} from '../shared/emerging/types'

const VENUES: EmergingVenue[] = ['up33-cl', 'univ3', 'univ4']
const HEX40 = /^0x[0-9a-f]{40}$/
const HEX32 = /^0x[0-9a-f]{64}$/

export type IdentityInput = {
  chainId: number
  venue: EmergingVenue
  canonicalId: string
}

/** True when the canonical id matches its venue's shape (§3.1: a PoolId is
 *  never mistaken for an address, and every id is lowercase). */
export function isValidCanonicalId(venue: EmergingVenue, canonicalId: string): boolean {
  return venue === 'univ4' ? HEX32.test(canonicalId) : HEX40.test(canonicalId)
}

export function formatEmergingPoolKey({ chainId, venue, canonicalId }: IdentityInput): EmergingPoolKey | null {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return null
  if (!VENUES.includes(venue)) return null
  const id = canonicalId.toLowerCase()
  if (!isValidCanonicalId(venue, id)) return null
  return `${chainId}:${venue}:${id}`
}

export type ParsedPoolKey = IdentityInput

export function parseEmergingPoolKey(poolKey: EmergingPoolKey): ParsedPoolKey | null {
  const parts = poolKey.split(':')
  if (parts.length !== 3) return null
  const [chainIdText, venue, canonicalId] = parts
  const chainId = Number(chainIdText)
  const key = formatEmergingPoolKey({ chainId, venue: venue as EmergingVenue, canonicalId })
  return key === poolKey ? { chainId, venue: venue as EmergingVenue, canonicalId } : null
}

/**
 * Young cutoff by block height. `blockTimeSec` is the measured chain pace —
 * an ESTIMATE by construction, so a pool near the boundary may straddle a
 * sweep; the next sweep's timestamp work corrects it. Callers must confirm
 * age with real timestamps before anything downstream (§3.1: gating uses
 * timestamps, this only bounds RPC work).
 */
export function youngCutoffBlock(headBlock: number, maxAgeDays: number, blockTimeSec: number): number {
  return headBlock - Math.ceil((maxAgeDays * 86_400) / blockTimeSec)
}

export type LedgerRow = {
  poolKey: EmergingPoolKey
  state: EmergingObservationState
  reason: EmergingObservationReason
  poolCreatedAt: number | null
  tokenCreatedAt: number | null
  /** null = not pinned; while pinned, admission can never evict (§4.1). */
  pinnedUntil: number | null
  admittedRank: number | null
}

/**
 * Age transition for one row (§3.1): a pool is young while EITHER its pool
 * birth or its token birth is inside the window. NULL birth timestamps can
 * never prove youth — unknown age does not pass (§3.1), but it also does not
 * age out on a guess: it stays until a timestamp lands, so a missed block
 * read degrades to slower admission rather than silent eviction.
 */
export function ageTransition(
  row: Pick<LedgerRow, 'poolCreatedAt' | 'tokenCreatedAt'>,
  nowSec: number,
  maxAgeDays: number,
): 'young' | 'aged' | 'unknown' {
  const cutoff = nowSec - maxAgeDays * 86_400
  const births = [row.poolCreatedAt, row.tokenCreatedAt].filter((t): t is number => typeof t === 'number')
  if (!births.length) return 'unknown'
  return births.some((t) => t > cutoff) ? 'young' : 'aged'
}

export type AdmissionPlan = {
  admit: EmergingPoolKey[]
  defer: EmergingPoolKey[]
  ageOut: EmergingPoolKey[]
  /** Tracking count after the plan, including pins — the capacity metric. */
  capacity: number
}

/**
 * The §4.1 admission queue: stable order (firstSeenAt, then poolKey), a hard
 * detail-collection cap, FIFO backfill from the deferred queue as tracked
 * rows age out, and pins that survive both directions. Rows already past the
 * window age out regardless of capacity; aging out NEVER drops the row — the
 * ledger keeps it and its history (§4.3).
 */
export function planAdmission(args: {
  rows: Array<LedgerRow & { firstSeenAt: number }>
  nowSec: number
  maxAgeDays: number
  capacity: number
}): AdmissionPlan {
  const { rows, nowSec, maxAgeDays, capacity } = args
  const ageOut: EmergingPoolKey[] = []
  const young: Array<LedgerRow & { firstSeenAt: number }> = []
  for (const row of rows) {
    const age = ageTransition(row, nowSec, maxAgeDays)
    if (age === 'aged') {
      ageOut.push(row.poolKey)
    } else {
      // Unknown age stays in the young set — it cannot prove age either way.
      young.push(row)
    }
  }
  const pinned = young.filter((r) => r.pinnedUntil !== null && r.pinnedUntil > nowSec)
  const free = Math.max(0, capacity - pinned.length)

  const tracking = young.filter(
    (r) => (r.pinnedUntil !== null && r.pinnedUntil > nowSec) || r.admittedRank !== null,
  )
  const unpinnedTracked = tracking
    .filter((r) => !(r.pinnedUntil !== null && r.pinnedUntil > nowSec))
    .sort((a, b) => (a.admittedRank ?? 0) - (b.admittedRank ?? 0))

  const waiting = young
    .filter((r) => r.admittedRank === null && !(r.pinnedUntil !== null && r.pinnedUntil > nowSec))
    .sort((a, b) => a.firstSeenAt - b.firstSeenAt || (a.poolKey < b.poolKey ? -1 : a.poolKey > b.poolKey ? 1 : 0))

  const keep = Math.min(unpinnedTracked.length, free)
  const kept = unpinnedTracked.slice(0, keep)
  const admit = waiting.slice(0, Math.max(0, free - keep)).map((r) => r.poolKey)
  const deferredKeys = new Set(waiting.slice(admit.length).map((r) => r.poolKey))
  // Evicted-from-tracking rows (capacity shrank or pins grew) rejoin the
  // deferred queue at the BACK — no priority jump for former insiders.
  for (const r of unpinnedTracked.slice(keep)) deferredKeys.add(r.poolKey)

  return {
    admit,
    defer: [...deferredKeys],
    ageOut,
    capacity: pinned.length + kept.length + admit.length,
  }
}
