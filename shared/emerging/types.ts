// Emerging-pool pipeline — serializable contracts shared between indexer,
// executor and frontend (docs/EMERGING-POOL-LP-PRD.zh-CN.md §3, §8.1).
//
// Types only: per the implementation spec's dependency rules, this module
// carries no logic and no I/O — every consumer (including the browser bundle)
// may import it. Field semantics live in the PRD; the invariants most easy to
// violate across processes are restated next to the fields that need them.

/** Venue set is fixed by §2: home CL, official v3, official v4 — nothing else. */
export type EmergingVenue = 'up33-cl' | 'univ3' | 'univ4'

/**
 * `chainId:venue:canonicalId` (§3.1). canonicalId is the lowercase pool
 * ADDRESS for v3/UP33 and the lowercase bytes32 PoolId for v4 — a PoolId is
 * never cast to an address, and callers must go through formatEmergingPoolKey
 * / parseEmergingPoolKey rather than string-concatenating.
 */
export type EmergingPoolKey = string

/**
 * Observation lifecycle (§3.3). `queued → backfilling → tracking` is the
 * detailed-collection path; `capacity_deferred` is a REASON, not a terminal
 * state — a deferred pool stays `queued` with that reason until capacity
 * frees up. `aged_out` is terminal for collection but rows persist.
 */
export type EmergingObservationState =
  | 'discovered'
  | 'queued'
  | 'backfilling'
  | 'tracking'
  | 'aged_out'

export type EmergingObservationReason =
  | 'capacity_deferred'
  | 'data_gap'
  | 'reorg_repair'
  | 'age_exceeded'
  | 'quiet_demoted'
  | null

/**
 * Signal lifecycle (§3.3). The wording contract is deliberate:
 * `watch_candidate` reads “观察条件满足” in every UI — never “安全”, “买入”,
 * or anything that implies a signature is appropriate.
 */
export type EmergingSignalState =
  | 'observing'
  | 'blocked'
  | 'watch_candidate'
  | 'invalidated'

/** The four ages of §3.1. Unknown is NULL; no field is ever backfilled
 *  from another. Age gating may only use poolCreatedAt/tokenCreatedAt. */
export type EmergingAges = {
  poolCreatedAt: number | null
  tokenCreatedAt: number | null
  launchAt: number | null
  firstSeenAt: number
}

export type EmergingIdentity = {
  poolKey: EmergingPoolKey
  venue: EmergingVenue
  canonicalId: string
  token0: string | null
  token1: string | null
  /** The provably-new token, when the venue can prove one (§3.1) — not “token1 by default”. */
  baseToken: string | null
  /** True when the non-base side is the chain's audited USDG (§3.1). */
  quoteIsUsdg: boolean
} & EmergingAges

/** §8.1 minimal read contract. canCreateStrategy is a compile-time constant
 *  false for the whole observe/signal/backtest lifetime of the pipeline. */
export type EmergingPoolView = {
  schemaVersion: 1
  poolKey: EmergingPoolKey
  researchProfileHash: string | null
  venue: EmergingVenue
  baseToken: string | null
  /** Resolved symbol from the indexer's token metadata; null = not yet named. */
  baseTokenSymbol?: string | null
  quoteToken: string | null
  /** Both sides verbatim — the page shows the PAIR, not just the proven base. */
  token0: string | null
  token1: string | null
  token0Symbol?: string | null
  token1Symbol?: string | null
  /** canonicalId exposed for identification (address, or bytes32 PoolId). */
  poolId: string
  /** Canonical swap/v4raw events observed in the trailing hour (null = unknown). */
  trades1h?: number | null
  /** v4: chain-derived TVL; v3/UP33: GT reserve figure. null = not listed yet. */
  liquidityUsd?: number | null
  /** Base-token USD price from the pricing graph (null until credible depth). */
  priceUsd?: number | null
  /** price × TOTAL supply — FDV-shaped by construction (§5.2), labeled in UI. */
  marketCapUsd?: number | null
  totalSupply?: string | null
  poolCreatedAt: number | null
  tokenCreatedAt: number | null
  observation: { state: EmergingObservationState; reasons: EmergingObservationReason[]; pinnedUntil: number | null }
  dataQuality: {
    status: 'complete' | 'partial' | 'stale' | 'unsupported'
    completeThroughTs: number | null
    missingStreams: string[]
  }
  gates: Record<
    string,
    { status: 'pass' | 'fail' | 'unknown'; reason: string; evidenceId: string | null; availableAt: number | null; expiresAt: number | null }
  >
  behaviorRisk: 'low_observed' | 'suspect' | 'unknown'
  signal: { id: string | null; state: EmergingSignalState; decisionAt: number | null }
  observedNetFeeYield6h: number | null
  thresholdVersion: string
  policyVersion: string
  canCreateStrategy: false
}
