import type { StrategyConfig } from '../shared/strategy/types'
import { rankRecommendations, RECOMMENDATION_MODEL_VERSION, scoreCandidate } from '../shared/recommendation/model'
import type {
  RecommendationCandidate,
  RecommendationCostProfile,
  RecommendationMode,
  RecommendationResponse,
  RecommendationRisk,
  RecommendationTickSample,
} from '../shared/recommendation/types'
import { ADDR } from '../src/config/addresses'
import { EXECUTOR } from './config'
import { archivedAccountingPerformance, cachedStrategyPerformance } from './performance'
import { db, listArchivedStrategies, listStrategies } from './store'

type Performance = Awaited<ReturnType<typeof cachedStrategyPerformance>>
type CostSamples = { gas: number[]; executionBps: number[]; duration: number[]; cycles: number }
type CostCache = { expiresAt: number; byPool: Map<string, RecommendationCostProfile>; byProtocol: Map<string, RecommendationCostProfile> }
const resultCache = new Map<string, { expiresAt: number; value: RecommendationResponse }>()
let costCache: CostCache | undefined
const CACHE_MS = 5 * 60_000
const COST_CACHE_MS = 15 * 60_000

const median = (values: number[], fallback: number): number => {
  if (!values.length) return fallback
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const amount = (raw: string | null | undefined, decimals: number) => raw == null ? null : Number(BigInt(raw)) / 10 ** decimals

async function tokenUsd(address: string, candidates: RecommendationCandidate[]): Promise<number | null> {
  if (address.toLowerCase() === ADDR.USDG.toLowerCase()) return 1
  for (const candidate of candidates) {
    if (candidate.token0.toLowerCase() === address.toLowerCase() && candidate.token0Usd) return candidate.token0Usd
    if (candidate.token1.toLowerCase() === address.toLowerCase() && candidate.token1Usd) return candidate.token1Usd
  }
  try {
    const response = await fetch(`${EXECUTOR.indexerBase}/api/tokens?q=${encodeURIComponent(address)}`)
    if (!response.ok) return null
    const body = await response.json() as { tokens?: { price_usd?: number; priceUsd?: number }[] }
    const price = body.tokens?.[0]?.price_usd ?? body.tokens?.[0]?.priceUsd
    return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null
  } catch { return null }
}

function addSamples(target: CostSamples, performance: Performance, config: StrategyConfig, quoteUsd: number) {
  if (!performance.quote || !performance.summary || !performance.cycles) return
  const baseline = amount(performance.summary.baselineValueQuoteRaw, performance.quote.decimals)
  const baselineUsd = baseline && baseline > 0 ? baseline * quoteUsd : null
  for (const cycle of performance.cycles) {
    const gas = amount(cycle.gasCostQuoteRaw, performance.quote.decimals)
    const execution = amount(cycle.executionCostQuoteRaw, performance.quote.decimals)
    if (gas != null && gas >= 0) target.gas.push(gas * quoteUsd)
    if (execution != null && execution >= 0 && baselineUsd) target.executionBps.push(execution * quoteUsd / baselineUsd * 10_000)
    if (cycle.completedAt && cycle.completedAt >= cycle.startedAt) target.duration.push(cycle.completedAt - cycle.startedAt)
    target.cycles++
  }
}

function profile(protocol: 'up33' | 'univ3', samples: CostSamples, source: RecommendationCostProfile['source']): RecommendationCostProfile {
  return {
    protocol,
    gasUsdPerCycle: median(samples.gas, 0.05),
    executionBpsPerCycle: median(samples.executionBps, 10),
    cycleSeconds: Math.max(10, median(samples.duration, 45)),
    sampleCycles: samples.cycles,
    source,
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
    if (!entry?.performance.quote || !['up33', 'univ3'].includes(entry.config.protocol)) continue
    const usd = await tokenUsd(entry.performance.quote.address, candidates)
    if (!usd) continue
    const protocol = entry.config.protocol
    const poolKey = entry.config.pool.toLowerCase()
    const poolSamples = pools.get(poolKey) ?? { gas: [], executionBps: [], duration: [], cycles: 0 }
    const protocolSamples = protocols.get(protocol) ?? { gas: [], executionBps: [], duration: [], cycles: 0 }
    addSamples(poolSamples, entry.performance, entry.config, usd)
    addSamples(protocolSamples, entry.performance, entry.config, usd)
    pools.set(poolKey, poolSamples)
    protocols.set(protocol, protocolSamples)
  }
  const byProtocol = new Map<string, RecommendationCostProfile>()
  for (const protocol of ['up33', 'univ3'] as const)
    byProtocol.set(protocol, profile(protocol, protocols.get(protocol) ?? { gas: [], executionBps: [], duration: [], cycles: 0 }, protocols.has(protocol) ? 'protocol' : 'default'))
  const byPool = new Map<string, RecommendationCostProfile>()
  for (const [pool, samples] of pools) {
    const protocol = candidates.find((candidate) => candidate.pool.toLowerCase() === pool)?.protocol
    if (protocol && samples.cycles >= 5) byPool.set(pool, profile(protocol, samples, 'pool'))
  }
  costCache = { expiresAt: Date.now() + COST_CACHE_MS, byPool, byProtocol }
  return costCache
}

/** Reuse the executor's 10-second active-strategy samples before indexer history matures. */
function mergeExecutorTicks(candidates: RecommendationCandidate[]) {
  const strategyPools = new Map((db.prepare("SELECT id,lower(json_extract(config_json,'$.pool')) AS pool FROM strategies").all() as { id: string; pool: string }[]).map((row) => [row.id, row.pool]))
  const byPool = new Map<string, RecommendationTickSample[]>()
  for (const row of db.prepare('SELECT strategy_id,ts,tick FROM price_samples ORDER BY ts').all() as { strategy_id: string; ts: number; tick: number }[]) {
    const pool = strategyPools.get(row.strategy_id)
    if (pool) (byPool.get(pool) ?? byPool.set(pool, []).get(pool)!).push({ ts: row.ts, tick: row.tick })
  }
  for (const candidate of candidates) {
    const merged = new Map(candidate.tickHistory.map((row) => [row.ts, row]))
    for (const row of byPool.get(candidate.pool.toLowerCase()) ?? []) merged.set(row.ts, row)
    candidate.tickHistory = [...merged.values()].sort((a, b) => a.ts - b.ts)
  }
}

export async function recommendations(args: { capitalUsd: number; mode: RecommendationMode; risk: RecommendationRisk; limit: number }): Promise<RecommendationResponse> {
  const key = JSON.stringify(args)
  const existing = resultCache.get(key)
  if (existing && existing.expiresAt > Date.now()) return existing.value
  const response = await fetch(`${EXECUTOR.indexerBase}/api/recommendation-candidates?limit=80&min_tvl=10000&min_volume=10000`)
  if (!response.ok) throw new Error(`recommendation indexer unavailable (${response.status})`)
  const body = await response.json() as { ready: boolean; asof: number; candidates: RecommendationCandidate[] }
  if (!body.ready || !Array.isArray(body.candidates)) throw new Error('recommendation market history is warming up')
  mergeExecutorTicks(body.candidates)
  const costs = await costProfiles(body.candidates)
  const now = Math.floor(Date.now() / 1000)
  const scored = body.candidates.flatMap((candidate) => scoreCandidate({
    candidate,
    capitalUsd: args.capitalUsd,
    mode: args.mode,
    risk: args.risk,
    cost: costs.byPool.get(candidate.pool.toLowerCase()) ?? costs.byProtocol.get(candidate.protocol) ?? profile(candidate.protocol, { gas: [], executionBps: [], duration: [], cycles: 0 }, 'default'),
    now,
  }))
  const ranked = rankRecommendations(scored)
  const value: RecommendationResponse = {
    modelVersion: RECOMMENDATION_MODEL_VERSION,
    generatedAt: now,
    marketAsOf: body.asof,
    capitalUsd: args.capitalUsd,
    mode: args.mode,
    risk: args.risk,
    observed: ranked.observed.slice(0, Math.max(args.limit, 10)),
    items: ranked.items.slice(0, args.limit),
  }
  resultCache.set(key, { expiresAt: Date.now() + CACHE_MS, value })
  return value
}
