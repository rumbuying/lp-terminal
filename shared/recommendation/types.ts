export type RecommendationMode = 'fees' | 'rewards'
export type RecommendationRisk = 'conservative' | 'balanced' | 'aggressive'
export type LookbackWindow = 'h1' | 'h6' | 'h24' | 'd3' | 'd7'
export type RecommendationGateReason =
  | 'excessive_reopens'
  | 'insufficient_tick_history'
  | 'non_positive_risk_adjusted_net'
  | 'unanchored_quote_risk'

export type RecommendationMarketSnapshot = {
  ts: number
  vol1hUsd: number | null
  vol6hUsd: number | null
  vol24hUsd: number | null
}

export type RecommendationTickSample = { ts: number; tick: number }

export type RecommendationCandidate = {
  pool: string
  protocol: 'up33' | 'univ3'
  token0: string
  token1: string
  symbol0: string
  symbol1: string
  decimals0: number
  decimals1: number
  token0Usd: number | null
  token1Usd: number | null
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
  marketHistory: RecommendationMarketSnapshot[]
  tickHistory: RecommendationTickSample[]
}

export type RecommendationCostProfile = {
  protocol: 'up33' | 'univ3'
  gasUsdPerCycle: number
  executionBpsPerCycle: number
  cycleSeconds: number
  sampleCycles: number
  source: 'pool' | 'protocol' | 'default'
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
  netUsd: number
  riskAdjustedNetUsd: number
  reopens: number
  inRangePct: number
  cvar95Usd: number
  coverageRatio: number | null
}

export type RecommendationItem = {
  rank: number
  pool: string
  protocol: 'up33' | 'univ3'
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
  }
  cost: RecommendationCostProfile
  /** Hard opening gates. Non-empty items remain visible as observations only. */
  gateReasons: RecommendationGateReason[]
  warnings: string[]
}

export type RecommendationResponse = {
  modelVersion: 'lp-rec-v2'
  generatedAt: number
  marketAsOf: number
  capitalUsd: number
  mode: RecommendationMode
  risk: RecommendationRisk
  observed: RecommendationItem[]
  items: RecommendationItem[]
}
