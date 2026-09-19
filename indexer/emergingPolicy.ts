// Emerging policy: research thresholds, the template registry and the
// pre-registered research profiles (docs/EMERGING-POOL-LP-PRD.zh-CN.md §5.1,
// §6.1, EMG-B01).
//
// Three load-bearing rules live here:
//  1. EMERGING_THRESHOLDS is the SINGLE source of research thresholds — pure
//     functions read it, tests pin it, and relaxing a value requires a new
//     experiment version (§6.1: 放宽参数需新实验版本). Engineering knobs stay
//     in config.ts's EMERGING_TUNE.
//  2. The template registry is DEFAULT-DENY (§5.1: 默认没有批准的新币/hook/
//     locker；"待审"不会 pass). An unreviewed token is unknown, never pass;
//     the empty registry below is the shipped state — entries land only with
//     human review artifacts (bytecode, deployment proof, source/review),
//     which is exactly what §5.1 demands and what no code path can synthesize.
//  3. Signals bind to a researchProfileHash (§5.3): a pass at one size never
//     licenses another. One profile is pre-registered — the 100 USDG paper
//     size — and nothing else.
import { CHAIN } from './config'

// --- §6.1 research thresholds (研究初值，非安全证明) ---
export const EMERGING_THRESHOLDS = {
  /** Observation window for pool age; candidacy re-verifies TOKEN age. */
  emergingMaxAgeDays: 7,
  /** §5.2 tracked_inventory_reduced: residual share / stable window / big-flow cap.
   *  Time base is unix SECONDS (§3.2) — the stable window is 6h = 21600s. */
  actorResidualMaxPct: 0.005, // 0.5% of the denominator
  actorStableHours: 6 * 3_600, // named for the PRD's 6h; stored in seconds
  actorFlowMaxPctPerHour: 0.001, // 0.1% per hour from one related source
  /** G05 concentration: non-system top-10 share, STRICTLY below. */
  maxTop10Pct: 0.3,
  /** G04 protected depth (evidence feed not built — gates stay unknown). */
  lpMinLockDays: 30,
  minProtectedActiveShare: 0.8,
  minProtectedDepthQuote: 10_000,
  protectedImpactPct: 0.05,
  /** G07 exit depth at the proposed size. */
  maxExitImpactPct: 0.02,
  /** G08 sell evidence. */
  minSellActors: 3,
  minSellTrades: 5,
  /** §5.4 behavior risk. */
  maxUnknownActorVolume: 0.2,
  maxActorVolumeShare: 0.3,
  maxSingleTradeShare: 0.2,
  maxRoundTripShare: 0.5,
  roundTripWindowSec: 600,
  roundTripSizeTolerance: 0.1,
  /** §5.4 external reconciliation. */
  reconciliationTolerance: 0.5,
  /** §6.2 retention (12 complete hours after reductionConfirmedAt). */
  persistenceHours: 12,
  retentionRatioMin: 0.5,
  collapseRatio: 0.35,
  quietVolumeQuotePerHour: 100, // USDG, every hour of the retention window
  /** §6.2 stabilization on 5-minute closes. */
  priceBarMinutes: 5,
  stabilizationHours: 6,
  sigmaRatioMax: 0.8,
  reboundMin: 0.05,
  reboundSigmaMultiplier: 2,
  minReturnSamplesPerWindow: 24,
  /** §6.1 freshness floors. */
  sourceStaleSeconds: 180,
  permissionStaleSeconds: 300,
  /** Quiet-demotion (变更记录 2026-09-19): a tracked pool with ZERO observed
   *  swaps this long after admission yields its slot — demoted, not deleted;
   *  the ledger keeps it and it rejoins the queue behind fresh discoveries. */
  quietDemoteSeconds: 6 * 3_600,
} as const

export type EmergingThresholds = typeof EMERGING_THRESHOLDS

// --- §5.1 template registry (DEFAULT-DENY) ---

export type TokenTemplate = {
  /** The reviewed contract shapes this entry certifies. */
  fixedSupply: true
  noTax: true
  noRebase: true
  noBlacklist: true
  noPause: true
  /** No owner/minter path may grant any of the above later. */
  permissionsRenounced: true
  /** Human review trace — who reviewed what, when. Never synthesized. */
  review: { reviewer: string; artifact: string; reviewedAt: number }
}

export type EmergingPolicy = {
  policyVersion: number
  chainId: number
  /** Venues whose trade/liquidity semantics an adapter has proven (§5.1). */
  venues: Array<'univ3' | 'up33-cl' | 'univ4'>
  /** First phase: hookless v4 pools only (§5.3 G03). */
  allowV4Hooks: false
  /** Audited quote tokens with their own trust model (§5.3 G01/G02). */
  approvedQuotes: Array<{ address: string; note: string }>
  /** Reviewed base-token templates, keyed lowercase. EMPTY = default deny. */
  tokens: Record<string, TokenTemplate>
}

/**
 * The shipped policy: nothing approved. USDG is the only approved quote (the
 * chain's own audit anchor — see chains/robinhood.ts), every base-token slot
 * is empty, and v4 hooks are disallowed outright. `policyVersion` bumps ONLY
 * with a reviewed change; gates embed the version they ran under.
 */
export const EMERGING_POLICY: EmergingPolicy = {
  policyVersion: 1,
  chainId: CHAIN.id,
  venues: ['univ3', 'up33-cl', 'univ4'],
  allowV4Hooks: false,
  approvedQuotes: [
    { address: CHAIN.addr.STABLE.toLowerCase(), note: 'USDG — the chain\u2019s audited stable, per chain config' },
  ],
  tokens: {},
}

export function policyTemplate(token: string): TokenTemplate | null {
  return EMERGING_POLICY.tokens[token.toLowerCase()] ?? null
}

export function isApprovedQuote(token: string): boolean {
  const t = token.toLowerCase()
  return EMERGING_POLICY.approvedQuotes.some((q) => q.address === t)
}

// --- §5.3 research profiles ---

export type ResearchProfile = {
  profileHash: string
  /** Paper entry size in USDG — gates G07/G08 bind their depth checks to it. */
  entrySizeUsdg: number
  note: string
}

/**
 * The single pre-registered research profile (§5.3): 100 USDG paper size.
 * Gates G07/G08 and every signal carry this hash; a pass at this size says
 * nothing at any other size, and the registry deliberately has no other.
 */
export const RESEARCH_PROFILES: Record<string, ResearchProfile> = {
  'research-100usdg-v1': {
    profileHash: 'research-100usdg-v1',
    entrySizeUsdg: 100,
    note: 'Pre-registered 100 USDG paper research size (PRD §5.3)',
  },
}

export function researchProfile(hash: string | null): ResearchProfile | null {
  if (hash === null) return null
  return RESEARCH_PROFILES[hash] ?? null
}

export const DEFAULT_PROFILE_HASH = 'research-100usdg-v1'
