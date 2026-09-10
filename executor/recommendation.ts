import { rankRecommendations, RECOMMENDATION_MODEL_VERSION, scoreCandidate } from '../shared/recommendation/model'
import type {
  RecommendationCandidate,
  RecommendationCostProfile,
  RecommendationMode,
  RecommendationResponse,
  RecommendationRisk,
  RecommendationTickSample,
  RecommendationProtocol,
} from '../shared/recommendation/types'
import { EXECUTOR } from './config'
import { archivedAccountingPerformance, cachedStrategyPerformance } from './performance'
import { db, listArchivedStrategies, listStrategies } from './store'

type Performance = Awaited<ReturnType<typeof cachedStrategyPerformance>>
export type CostSamples = { gas: number[]; executionBps: number[]; duration: number[]; cycles: number }
type CostCache = { expiresAt: number; byPool: Map<string, RecommendationCostProfile>; byProtocol: Map<string, RecommendationCostProfile> }
const resultCache = new Map<string, { expiresAt: number; value: RecommendationResponse }>()
let costCache: CostCache | undefined
const CACHE_MS = 5 * 60_000
const COST_CACHE_MS = 15 * 60_000

const median = (values: number[]): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const amount = (raw: string | null | undefined, decimals: number) => raw == null ? null : Number(BigInt(raw)) / 10 ** decimals

export function addRecommendationCostSamples(target: CostSamples, performance: Performance) {
  if (!performance.quote || !performance.summary || !performance.cycles) return
  for (const cycle of performance.cycles) {
    const gasUsd = amount(cycle.gasCostUsdgRaw, EXECUTOR.network.settlementDecimals)
    const execution = amount(cycle.executionCostQuoteRaw, performance.quote.decimals)
    const capital = amount(cycle.capitalQuoteRaw, performance.quote.decimals)
    const duration = cycle.completedAt && cycle.completedAt >= cycle.startedAt ? cycle.completedAt - cycle.startedAt : null
    const complete = cycle.gasStableValuationComplete && gasUsd != null && gasUsd >= 0
      && execution != null && execution >= 0 && capital != null && capital > 0 && duration != null
    if (!complete) continue
    target.gas.push(gasUsd)
    // Both numerator and denominator are in the same cycle-local quote unit;
    // the USD mark cancels. Never normalize against a strategy-wide baseline.
    target.executionBps.push(execution / capital * 10_000)
    target.duration.push(duration)
    target.cycles++
  }
}

const identityOf = (candidate: Pick<RecommendationCandidate, 'pool' | 'poolId'>) =>
  (candidate.poolId ?? candidate.pool).toLowerCase()

export function recommendationCostProfile(protocol: RecommendationProtocol, samples: CostSamples, source: RecommendationCostProfile['source']): RecommendationCostProfile {
  const available = samples.cycles > 0 && samples.gas.length > 0 && samples.executionBps.length > 0 && samples.duration.length > 0
  return {
    protocol,
    gasUsdPerCycle: available ? median(samples.gas) : 0,
    executionBpsPerCycle: available ? median(samples.executionBps) : 0,
    cycleSeconds: available ? Math.max(10, median(samples.duration)) : 0,
    sampleCycles: available ? samples.cycles : 0,
    source: available ? source : 'unavailable',
  }
}

async function costProfiles(candidates: RecommendationCandidate[]): Promise<CostCache> {
  if (costCache && costCache.expiresAt > Date.now()) return costCache
  const active = listStrategies()
  const archived = listArchivedStrategies()
  const performances = await Promise.all([
    ...active.map(async (row) => {
      try { return { config: row.config, performance: await cachedStrategyPerformance(row.config, row.state) } }
      catch { return null }
    }),
    ...archived.map(async (row) => {
      try { return { config: row.config, performance: row.performance as Performance ?? await archivedAccountingPerformance(row.config, row.archivedAt) } }
      catch { return null }
    }),
  ])
  const pools = new Map<string, CostSamples>()
  const protocols = new Map<string, CostSamples>()
  for (const entry of performances) {
    if (!entry?.performance.quote) continue
    const protocol = entry.config.protocol
    const poolKey = (entry.config.poolId ?? entry.config.pool).toLowerCase()
    const poolSamples = pools.get(poolKey) ?? { gas: [], executionBps: [], duration: [], cycles: 0 }
    const protocolSamples = protocols.get(protocol) ?? { gas: [], executionBps: [], duration: [], cycles: 0 }
    addRecommendationCostSamples(poolSamples, entry.performance)
    addRecommendationCostSamples(protocolSamples, entry.performance)
    pools.set(poolKey, poolSamples)
    protocols.set(protocol, protocolSamples)
  }
  const byProtocol = new Map<string, RecommendationCostProfile>()
  const activeProtocols = [...new Set(candidates.map((candidate) => candidate.protocol))]
  for (const protocol of activeProtocols)
    byProtocol.set(protocol, recommendationCostProfile(protocol, protocols.get(protocol) ?? { gas: [], executionBps: [], duration: [], cycles: 0 }, 'protocol'))
  const byPool = new Map<string, RecommendationCostProfile>()
  for (const [pool, samples] of pools) {
    const protocol = candidates.find((candidate) => identityOf(candidate) === pool)?.protocol
    if (protocol && samples.cycles >= 5) byPool.set(pool, recommendationCostProfile(protocol, samples, 'pool'))
  }
  costCache = { expiresAt: Date.now() + COST_CACHE_MS, byPool, byProtocol }
  return costCache
}

/** Reuse the executor's 10-second active-strategy samples before indexer history matures. */
function mergeExecutorTicks(candidates: RecommendationCandidate[]) {
  const strategyPools = new Map((db.prepare("SELECT id,lower(COALESCE(json_extract(config_json,'$.poolId'),json_extract(config_json,'$.pool'))) AS pool FROM strategies").all() as { id: string; pool: string }[]).map((row) => [row.id, row.pool]))
  const byPool = new Map<string, RecommendationTickSample[]>()
  for (const row of db.prepare('SELECT strategy_id,ts,tick FROM price_samples ORDER BY ts').all() as { strategy_id: string; ts: number; tick: number }[]) {
    const pool = strategyPools.get(row.strategy_id)
    if (pool) (byPool.get(pool) ?? byPool.set(pool, []).get(pool)!).push({ ts: row.ts, tick: row.tick })
  }
  for (const candidate of candidates) {
    const merged = new Map(candidate.tickHistory.map((row) => [row.ts, row]))
    for (const row of byPool.get(identityOf(candidate)) ?? []) merged.set(row.ts, row)
    candidate.tickHistory = [...merged.values()].sort((a, b) => a.ts - b.ts)
  }
}

export function assertFreshRecommendationMarket(
  value: { status?: string; observedAt?: number | null; ttlSeconds?: number } | undefined,
  timestamp = Math.floor(Date.now() / 1000),
): { observedAt: number; ttlSeconds: number } {
  const observedAt = Number(value?.observedAt)
  const ttlSeconds = Number(value?.ttlSeconds)
  if (value?.status !== 'fresh' || !Number.isFinite(observedAt) || !Number.isFinite(ttlSeconds)
    || observedAt <= 0 || ttlSeconds <= 0 || observedAt > timestamp || timestamp - observedAt > ttlSeconds)
    throw new Error('recommendation market data is stale or unavailable')
  return { observedAt, ttlSeconds }
}

export async function recommendations(args: { capitalUsd: number; mode: RecommendationMode; risk: RecommendationRisk; limit: number }): Promise<RecommendationResponse> {
  const key = JSON.stringify(args)
  const existing = resultCache.get(key)
  if (existing && existing.expiresAt > Date.now()) return existing.value
  const response = await fetch(`${EXECUTOR.indexerBase}/api/recommendation-candidates?limit=80&min_tvl=10000&min_volume=10000`)
  if (!response.ok) throw new Error(`recommendation indexer unavailable (${response.status})`)
  const body = await response.json() as {
    ready: boolean
    asof: number
    freshness?: { status?: string; observedAt?: number | null; ttlSeconds?: number }
    candidates: RecommendationCandidate[]
  }
  if (!body.ready || !Array.isArray(body.candidates)) throw new Error('recommendation market history is warming up')
  const now = Math.floor(Date.now() / 1000)
  const { observedAt, ttlSeconds } = assertFreshRecommendationMarket(body.freshness, now)
  const candidates = body.candidates.filter((candidate) =>
    candidate.token0PriceStatus === 'fresh' && candidate.token1PriceStatus === 'fresh')
  mergeExecutorTicks(candidates)
  const costs = await costProfiles(candidates)
  const scored = candidates.flatMap((candidate) => scoreCandidate({
    candidate,
    capitalUsd: args.capitalUsd,
    mode: args.mode,
    risk: args.risk,
    cost: costs.byPool.get(identityOf(candidate)) ?? costs.byProtocol.get(candidate.protocol) ?? recommendationCostProfile(candidate.protocol, { gas: [], executionBps: [], duration: [], cycles: 0 }, 'unavailable'),
    now,
  }))
  const ranked = rankRecommendations(scored)
  const value: RecommendationResponse = {
    modelVersion: RECOMMENDATION_MODEL_VERSION,
    generatedAt: now,
    marketAsOf: observedAt,
    marketFreshness: {
      status: 'fresh',
      observedAt,
      ttlSeconds,
    },
    capitalUsd: args.capitalUsd,
    mode: args.mode,
    risk: args.risk,
    observed: ranked.observed.slice(0, Math.max(args.limit, 10)),
    items: ranked.items.slice(0, args.limit),
  }
  resultCache.set(key, {
    expiresAt: Math.min(Date.now() + CACHE_MS, (observedAt + ttlSeconds) * 1_000),
    value,
  })
  return value
}
