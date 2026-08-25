import { ADDR } from '../src/config/addresses'
import { rankRecommendations, scoreCandidate } from '../shared/recommendation/model'
import type { RecommendationCandidate, RecommendationCostProfile, RecommendationItem, RecommendationMode } from '../shared/recommendation/types'

const base = (process.env.RECOMMENDATION_INDEXER_BASE ?? 'https://lp.coinfetcher.xyz').replace(/\/+$/, '')
const capitalUsd = Number(process.env.RECOMMENDATION_CAPITAL_USD ?? 1_000)
const risk = (process.env.RECOMMENDATION_RISK ?? 'balanced') as 'conservative' | 'balanced' | 'aggressive'
const mode = (process.env.RECOMMENDATION_MODE ?? 'fees') as RecommendationMode
const candidateLimit = Math.min(80, Math.max(1, Number(process.env.RECOMMENDATION_CANDIDATE_LIMIT ?? 30)))
const usdg = ADDR.USDG.toLowerCase()

const fallbackCosts: Record<'univ3' | 'up33', RecommendationCostProfile> = {
  univ3: { protocol: 'univ3', gasUsdPerCycle: 0.061, executionBpsPerCycle: 14, cycleSeconds: 17, sampleCycles: 20, source: 'protocol' },
  up33: { protocol: 'up33', gasUsdPerCycle: 0.08, executionBpsPerCycle: 15, cycleSeconds: 25, sampleCycles: 0, source: 'default' },
}

const response = await fetch(`${base}/api/recommendation-candidates?limit=${candidateLimit}&min_tvl=10000&min_volume=10000`)
if (!response.ok) throw new Error(`candidate API returned ${response.status}`)
const body = await response.json() as { ready: boolean; candidates: (RecommendationCandidate & { hasStableQuote?: boolean })[] }
if (!body.ready) throw new Error('candidate API is not ready')

const candidates: RecommendationCandidate[] = body.candidates.map((candidate) => ({
  ...candidate,
  // Backward compatibility lets this audit a production v1 indexer before the
  // v2 candidate payload is deployed.
  hasStableQuote: candidate.hasStableQuote
    ?? (candidate.token0.toLowerCase() === usdg || candidate.token1.toLowerCase() === usdg),
}))
const now = Math.floor(Date.now() / 1_000)
const scored = candidates.flatMap((candidate) => scoreCandidate({
  candidate,
  capitalUsd,
  mode,
  risk,
  cost: fallbackCosts[candidate.protocol],
  now,
}))
const ranked = rankRecommendations(scored)
const summary = (item: RecommendationItem) => ({
  pair: item.pair,
  pool: item.pool,
  rangePct: item.range.lowerPct,
  window: item.lookback.window,
  windowReason: item.lookback.reason,
  forecastHourlyVolumeUsd: Math.round(item.lookback.hourlyVolumeUsd),
  net24hUsd: Number(item.projection24h.netUsd.toFixed(2)),
  riskAdjustedNet24hUsd: Number(item.projection24h.riskAdjustedNetUsd.toFixed(2)),
  cvar95Usd: Number(item.projection24h.cvar95Usd.toFixed(2)),
  reopens24h: Number(item.projection24h.reopens.toFixed(1)),
  confidence: Number(item.confidence.score.toFixed(2)),
  gateReasons: item.gateReasons,
})

console.log(JSON.stringify({
  candidateCount: candidates.length,
  mode,
  scoredBandCount: scored.length,
  freshestStatsAgeSeconds: candidates.length ? now - Math.max(...candidates.map((candidate) => candidate.statsUpdatedAt)) : null,
  freshestStateAgeSeconds: candidates.length ? now - Math.max(...candidates.map((candidate) => candidate.stateUpdatedAt)) : null,
  recommendedCount: ranked.items.length,
  recommended: ranked.items.slice(0, 10).map(summary),
  topObservations: ranked.observed.slice(0, 10).map(summary),
}, null, 2))
