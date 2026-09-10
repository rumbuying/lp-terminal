export type RecommendationMode = 'fees' | 'rewards'
export type RecommendationRisk = 'conservative' | 'balanced' | 'aggressive'
export type RecommendationProtocol = 'up33' | 'univ3' | 'pancakeswap-v3' | 'univ4'
export type LookbackWindow = 'h1' | 'h6' | 'h24' | 'd3' | 'd7'
export type RecommendationGateReason =
  | 'excessive_reopens'
  | 'insufficient_tick_history'
  | 'insufficient_risk_history'
  | 'insufficient_market_history'
  | 'non_positive_risk_adjusted_net'
  | 'unanchored_quote_risk'
  | 'pool_below_lvr_floor'
  | 'lvr_unavailable'
  | 'cost_unavailable'

export type RecommendationMarketSnapshot = {
  ts: number
  vol1hUsd: number | null
  vol6hUsd: number | null
  vol24hUsd: number | null
  /** Point-in-time active liquidity at the sampled tick. This is not a
   * distribution of initialized liquidity across ticks. */
  activeLiquidity?: string | null
  tick?: number | null
  source?: string | null
}

/** The pool's day-level volume-trend class from the rank snapshot (PRD FR-REC-1). */
export type CandidateVolumeTrend = {
  class: 'rising' | 'new_hot' | 'stable' | 'fading' | 'collapsing' | 'unknown'
  vsBaseline: number | null
  slope7dPct: number | null
}

export type RecommendationTickSample = { ts: number; tick: number; blockNumber?: string }

export type RecommendationHistoryCoverage = {
  windowSeconds: number
  coveredSeconds: number
  ratio: number
  sampleCount: number
  firstAt: number | null
  lastAt: number | null
  maxGapSeconds: number | null
}

export type RecommendationCandidate = {
  pool: string
  poolId?: string
  hooks?: string
  protocol: RecommendationProtocol
  token0: string
  token1: string
  symbol0: string
  symbol1: string
  decimals0: number
  decimals1: number
  token0Usd: number | null
  token1Usd: number | null
  token0PriceUpdatedAt?: number | null
  token1PriceUpdatedAt?: number | null
  token0PriceStatus?: 'fresh' | 'stale' | 'unavailable'
  token1PriceStatus?: 'fresh' | 'stale' | 'unavailable'
  /** true when token0 is the volatile/risk asset and token1 is the quote asset */
  token0IsRisk: boolean
  /** true when one side is the USDG anchor, allowing portfolio risk in USD terms */
  hasStableQuote: boolean
  feePpm: number
  unstakedFeePpm: number
  tickSpacing: number
  tick: number
  sqrtPriceX96: string
  liquidity: string
  stakedLiquidity: string
  tvlUsd: number
  vol1hUsd: number | null
  vol6hUsd: number | null
  vol24hUsd: number | null
  statsUpdatedAt: number
  stateUpdatedAt: number
  gaugeAlive: boolean
  rewardRate: string
  periodFinish: number
  upUsd: number | null
  upPriceUpdatedAt?: number | null
  upPriceStatus?: 'fresh' | 'stale' | 'unavailable'
  marketHistory: RecommendationMarketSnapshot[]
  tickHistory: RecommendationTickSample[]
  /** present only while the indexer's rank snapshot is fresh */
  poolRank?: RecommendationRankPrior
  /** the rank snapshot's volume-trend class — same freshness gate as poolRank */
  volumeTrend?: CandidateVolumeTrend
  /** true when the pool entered the universe only through the rank table's
   * coverage seeds (docs: the candidate universe's second entry) */
  rankSeeded?: boolean
}

export type RecommendationCostProfile = {
  protocol: RecommendationProtocol
  gasUsdPerCycle: number
  executionBpsPerCycle: number
  cycleSeconds: number
  sampleCycles: number
  source: 'pool' | 'protocol' | 'unavailable'
}

/**
 * The indexer's pool-rank prior for this pool, attached by the candidates
 * endpoint only while the snapshot is fresh. It is the POOL-level truth the
 * 24h projection cannot see: the LVR coverage floor, the volatility the range
 * must survive, and the 7-day volume baseline that tempers a short spike.
 */
export type RecommendationRankPrior = {
  /** snapshot generation time (seconds); stale priors are never attached */
  generatedAt: number
  /** feeApr ÷ (σ_annual²/8); below 1 a passive LP loses to a hedged rebalancer */
  coverage: number
  sigmaDaily: number
  sigmaAnnual: number
  /** 7-day-mean gross fee APR the rank table measured */
  feeApr7d: number
  /** 7-day-mean daily volume in USD — the stability baseline */
  volDayUsd: number
  /** staked-side emission APR at the post-cap gauge rate; null when ungauged */
  emitApr: number | null
}

export type WindowDecision = {
  window: LookbackWindow
  hourlyVolumeUsd: number
  confidence: number
  reason: 'walk_forward' | 'stable_intraday' | 'short_spike' | 'slowing' | 'bootstrap_6h' | 'h24_fallback'
  errors: Partial<Record<LookbackWindow, number>>
}

export type RecommendationProjection = {
  grossFeeUsd: number
  rewardUsd: number
  gasUsd: number
  executionUsd: number
  entryCostUsd: number
  incomeRetentionUsd: number
  expectedLvrUsd: number | null
  netUsd: number
  riskAdjustedNetUsd: number
  reopens: number
  /** Share of the observed path for which this band could earn fees, after
   * subtracting measured recenter downtime. It is not in-band swap volume. */
  feeExposurePct: number
  /** Rolling pool volume multiplied by feeExposurePct. This remains a proxy
   * until swap-level volume-at-tick history is available. */
  modeledVolumeInRangeUsd: number
  /** Tail mean of LP-vs-HODL outcomes across historical and reflected paths. */
  historicalIlTailUsd: number
  /** Tail mean of LP position value vs its value at each replay start. */
  inventoryDrawdownTailUsd: number
  coverageRatio: number | null
}

export type RecommendationItem = {
  rank: number
  pool: string
  poolId?: string
  hooks?: string
  protocol: RecommendationProtocol
  pair: string
  mode: RecommendationMode
  lookback: WindowDecision
  range: {
    lowerPct: number
    upperPct: number
    tickLower: number
    tickUpper: number
    actualLowerPct: number
    actualUpperPct: number
  }
  projection24h: RecommendationProjection
  confidence: { level: 'low' | 'medium' | 'high'; score: number }
  market: {
    tvlUsd: number
    vol1hUsd: number | null
    vol6hUsd: number | null
    vol24hUsd: number | null
    feePpm: number
    statsUpdatedAt: number
    tickCoverageHours: number
    tickCoverage: RecommendationHistoryCoverage
    riskTickCoverage: RecommendationHistoryCoverage
    marketCoverage: RecommendationHistoryCoverage
    activeLiquidityBasis: 'historical_active_liquidity' | 'spot_active_liquidity'
    historicalActiveLiquidity: string | null
    activeLiquidityCoverageRatio: number
    tickLiquidityDistribution: 'unavailable'
    volumeDistribution: 'unavailable'
  }
  cost: RecommendationCostProfile
  /** Hard opening gates. Non-empty items remain visible as observations only. */
  gateReasons: RecommendationGateReason[]
  warnings: string[]
  /** the pool-rank prior this projection was scored against, when fresh */
  poolRank?: RecommendationRankPrior
  /** the scored trend class (FR-UI-5) — rides along for the card's heat line */
  volumeTrend?: CandidateVolumeTrend
}

export type RecommendationResponse = {
  modelVersion: 'lp-rec-v5'
  generatedAt: number
  marketAsOf: number
  marketFreshness: {
    status: 'fresh' | 'stale' | 'unavailable'
    observedAt: number | null
    ttlSeconds: number
  }
  capitalUsd: number
  mode: RecommendationMode
  risk: RecommendationRisk
  observed: RecommendationItem[]
  items: RecommendationItem[]
}
