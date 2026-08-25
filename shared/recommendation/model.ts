import { parseUnits } from 'viem'
import { quoteRangeToTicks, rangeSide } from '../strategy/range'
import { getLiquidityForAmounts, getSqrtRatioAtTick, tickToPrice } from '../../src/lib/clmath'
import type {
  LookbackWindow,
  RecommendationCandidate,
  RecommendationCostProfile,
  RecommendationItem,
  RecommendationMode,
  RecommendationRisk,
  RecommendationTickSample,
  WindowDecision,
} from './types'

export const RECOMMENDATION_MODEL_VERSION = 'lp-rec-v2' as const
export const RECOMMENDATION_BANDS = [1, 2, 3, 5, 8, 10] as const
const HOUR = 3_600
const DAY = 86_400
const VALIDATION_STEP = HOUR
const EPS = 1e-9

const finite = (value: number | null | undefined): value is number => value != null && Number.isFinite(value)
const median = (values: number[]): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const quantile = (values: number[], q: number): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))
  return sorted[index]
}

const historyRate = (candidate: RecommendationCandidate, seconds: number, now: number): number | null => {
  const values = candidate.marketHistory
    .filter((row) => row.ts >= now - seconds && row.ts <= now && finite(row.vol1hUsd))
    .map((row) => row.vol1hUsd!)
  return values.length >= Math.max(3, Math.floor(seconds / HOUR / 3)) ? median(values) : null
}

function futureOneHour(history: RecommendationCandidate['marketHistory'], index: number) {
  const target = history[index].ts + HOUR
  for (let i = index + 1; i < history.length; i++) {
    if (history[i].ts >= target - 600 && history[i].ts <= target + 600 && finite(history[i].vol1hUsd)) return history[i].vol1hUsd!
    if (history[i].ts > target + 600) break
  }
  return null
}

function historicalRate(history: RecommendationCandidate['marketHistory'], index: number, seconds: number): number | null {
  const end = history[index].ts
  const start = end - seconds
  const values: number[] = []
  let firstTs = end
  for (let i = index; i >= 0; i--) {
    const row = history[i]
    if (row.ts < start) break
    if (finite(row.vol1hUsd)) {
      values.push(row.vol1hUsd)
      firstTs = row.ts
    }
  }
  return values.length >= 12 && end - firstTs >= seconds * 0.8 ? median(values) : null
}

function validationHistory(history: RecommendationCandidate['marketHistory']) {
  const sorted = [...history].sort((a, b) => a.ts - b.ts)
  const rows: RecommendationCandidate['marketHistory'] = []
  let next = -Infinity
  for (const row of sorted) {
    if (row.ts < next) continue
    rows.push(row)
    next = row.ts + VALIDATION_STEP - 600
  }
  return rows
}

function sustainableRate(current: Partial<Record<LookbackWindow, number>>): number {
  const longRates = [current.h6, current.h24, current.d3, current.d7].filter(finite)
  if (!longRates.length) return current.h1 ?? 0
  // Lower quartile keeps one temporarily quiet window from zeroing the model,
  // while preventing a hot hour or hot six-hour block from being projected as
  // the next full day.
  return quantile(longRates, 0.25)
}

/** Pick the horizon with the best recent out-of-sample one-hour forecast. */
export function chooseLookback(candidate: RecommendationCandidate, now: number): WindowDecision | null {
  const current: Partial<Record<LookbackWindow, number>> = {}
  if (finite(candidate.vol1hUsd)) current.h1 = candidate.vol1hUsd
  if (finite(candidate.vol6hUsd)) current.h6 = candidate.vol6hUsd / 6
  if (finite(candidate.vol24hUsd)) current.h24 = candidate.vol24hUsd / 24
  const d3 = historyRate(candidate, 3 * DAY, now)
  const d7 = historyRate(candidate, 7 * DAY, now)
  if (d3 !== null) current.d3 = d3
  if (d7 !== null) current.d7 = d7
  if (!Object.keys(current).length) return null

  const history = validationHistory(candidate.marketHistory)
  const span = history.length > 1 ? history.at(-1)!.ts - history[0].ts : 0
  const losses: Partial<Record<LookbackWindow, number[]>> = {}
  if (span >= 7 * DAY - HOUR) {
    for (let i = 0; i < history.length; i++) {
      const actual = futureOneHour(history, i)
      if (actual === null) continue
      const row = history[i]
      const forecasts: Partial<Record<LookbackWindow, number>> = {}
      if (finite(row.vol1hUsd)) forecasts.h1 = row.vol1hUsd
      if (finite(row.vol6hUsd)) forecasts.h6 = row.vol6hUsd / 6
      if (finite(row.vol24hUsd)) forecasts.h24 = row.vol24hUsd / 24
      const prior3d = historicalRate(history, i, 3 * DAY)
      const prior7d = historicalRate(history, i, 7 * DAY)
      if (prior3d !== null) forecasts.d3 = prior3d
      if (prior7d !== null) forecasts.d7 = prior7d
      for (const [window, forecast] of Object.entries(forecasts) as [LookbackWindow, number][]) {
        ;(losses[window] ??= []).push(Math.abs(forecast - actual) / Math.max(actual, 1))
      }
    }
  }
  const errors: Partial<Record<LookbackWindow, number>> = {}
  for (const [window, values] of Object.entries(losses) as [LookbackWindow, number[]][])
    if (values.length >= 12) errors[window] = median(values)
  const r1 = current.h1
  const r6 = current.h6
  const r24 = current.h24
  const shortSpike = finite(r1) && (
    (finite(r24) && r1 > r24 * 2)
    || (finite(r6) && r1 > r6 * 1.5)
  )
  const slowing = finite(r1) && finite(r6) && finite(r24) && r1 < r24 * 0.5 && r6 < r24 * 0.75
  const robustHourly = sustainableRate(current)
  const validated = (Object.keys(errors) as LookbackWindow[])
    .filter((window) => finite(current[window]) && !(shortSpike && window === 'h1'))
  if (validated.length) {
    const window = validated.sort((a, b) => errors[a]! - errors[b]!)[0]
    const currentRate = current[window]!
    const hourlyVolumeUsd = Math.max(0, Math.min(currentRate, robustHourly || currentRate, slowing && finite(r1) ? r1 : Infinity))
    return {
      window,
      hourlyVolumeUsd,
      confidence: Math.max(0.45, Math.min(shortSpike ? 0.7 : 0.95, 1 / (1 + errors[window]!))),
      reason: shortSpike ? 'short_spike' : slowing ? 'slowing' : 'walk_forward',
      errors,
    }
  }

  if (finite(r1) && finite(r6) && finite(r24)) {
    if (shortSpike)
      return { window: 'h24', hourlyVolumeUsd: Math.min(r24, robustHourly || r24), confidence: 0.48, reason: 'short_spike', errors }
    if (slowing)
      return { window: 'h1', hourlyVolumeUsd: r1, confidence: 0.52, reason: 'slowing', errors }
    const spread = Math.max(r1, r6, r24) / Math.max(Math.min(r1, r6, r24), 1)
    return { window: 'h6', hourlyVolumeUsd: Math.min(r6, robustHourly || r6), confidence: spread <= 1.5 ? 0.62 : 0.54, reason: spread <= 1.5 ? 'stable_intraday' : 'bootstrap_6h', errors }
  }
  if (finite(r6)) return { window: 'h6', hourlyVolumeUsd: r6, confidence: 0.42, reason: 'bootstrap_6h', errors }
  if (finite(r24)) return { window: 'h24', hourlyVolumeUsd: r24, confidence: 0.28, reason: 'h24_fallback', errors }
  return { window: 'h1', hourlyVolumeUsd: r1!, confidence: 0.25, reason: 'h24_fallback', errors }
}

function rangeAt(candidate: RecommendationCandidate, centerTick: number, pct: number) {
  const rawCenter = tickToPrice(centerTick, candidate.decimals0, candidate.decimals1)
  const center = candidate.token0IsRisk ? rawCenter : 1 / rawCenter
  return quoteRangeToTicks({
    centerQuotePerRisk: center,
    lowerPct: pct,
    upperPct: pct,
    currentTick: centerTick,
    tickSpacing: candidate.tickSpacing,
    token0IsRisk: candidate.token0IsRisk,
    token0Decimals: candidate.decimals0,
    token1Decimals: candidate.decimals1,
  })
}

export function replayRange(candidate: RecommendationCandidate, pct: number, samples: RecommendationTickSample[]) {
  const rows = [...samples].sort((a, b) => a.ts - b.ts)
  if (!rows.length) {
    const range = rangeAt(candidate, candidate.tick, pct)
    return { reopens: 0, coverageHours: 0, range, downsideRatios: [] as number[], hodlRelativeRatios: [] as number[] }
  }
  const firstTick = rows[0].tick
  let centerTick = rows[0].tick
  let range = rangeAt(candidate, centerTick, pct)
  let reopens = 0
  let principalRatio = 1
  const downsideRatios: number[] = []
  const hodlRelativeRatios: number[] = []
  for (const row of rows) {
    const priceRatio = Math.pow(1.0001, row.tick - centerTick)
    const lo = Math.pow(1.0001, range.tickLower - centerTick)
    const hi = Math.pow(1.0001, range.tickUpper - centerTick)
    const startX = 1 - 1 / Math.sqrt(hi)
    const startY = 1 - Math.sqrt(lo)
    let x: number, y: number
    if (priceRatio <= lo) { x = 1 / Math.sqrt(lo) - 1 / Math.sqrt(hi); y = 0 }
    else if (priceRatio >= hi) { x = 0; y = Math.sqrt(hi) - Math.sqrt(lo) }
    else { x = 1 / Math.sqrt(priceRatio) - 1 / Math.sqrt(hi); y = Math.sqrt(priceRatio) - Math.sqrt(lo) }
    const value = candidate.token0IsRisk ? priceRatio * x + y : x + y / priceRatio
    const valueRatio = value / Math.max(startX + startY, EPS)
    const lpRatio = principalRatio * valueRatio
    const riskPriceRatio = candidate.token0IsRisk
      ? Math.pow(1.0001, row.tick - firstTick)
      : Math.pow(1.0001, firstTick - row.tick)
    const hodlRatio = (1 + riskPriceRatio) / 2
    downsideRatios.push(lpRatio - 1)
    hodlRelativeRatios.push(lpRatio / Math.max(hodlRatio, EPS) - 1)
    if (rangeSide(row.tick, range.tickLower, range.tickUpper) !== 'in') {
      principalRatio *= valueRatio
      centerTick = row.tick
      range = rangeAt(candidate, centerTick, pct)
      reopens++
    }
  }
  const coverageHours = rows.length > 1 ? (rows.at(-1)!.ts - rows[0].ts) / HOUR : 0
  const scale = coverageHours > 0 ? 24 / coverageHours : 1
  return { reopens: reopens * scale, coverageHours, range: rangeAt(candidate, candidate.tick, pct), downsideRatios, hodlRelativeRatios }
}

function reflectedPath(samples: RecommendationTickSample[]): RecommendationTickSample[] {
  if (!samples.length) return []
  const origin = samples[0].tick
  return samples.map((row) => ({
    ts: row.ts,
    tick: Math.max(-887_000, Math.min(887_000, origin - (row.tick - origin))),
  }))
}

/**
 * Evaluate many historical entry times plus the reflected price path. The
 * reflection is deliberately not a forecast: it is a stress case that stops a
 * recent one-way rally from looking safe merely because its reversal has not
 * happened yet. Each path contributes its worst USD drawdown or relative-HODL
 * shortfall, whichever is worse.
 */
function riskPathRatios(candidate: RecommendationCandidate, pct: number, samples: RecommendationTickSample[]): number[] {
  const rows = [...samples].sort((a, b) => a.ts - b.ts)
  if (rows.length < 2) return []
  const paths: RecommendationTickSample[][] = []
  let nextStart = rows[0].ts
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].ts < nextStart) continue
    const end = rows[i].ts + DAY
    const path: RecommendationTickSample[] = []
    for (let j = i; j < rows.length && rows[j].ts <= end; j++) path.push(rows[j])
    if (path.length > 1 && path.at(-1)!.ts - path[0].ts >= 20 * HOUR) paths.push(path)
    nextStart = rows[i].ts + 6 * HOUR
  }
  const recent = rows.filter((row) => row.ts >= rows.at(-1)!.ts - DAY)
  if (recent.length > 1 && recent.at(-1)!.ts - recent[0].ts >= 20 * HOUR) paths.push(recent)

  const ratios: number[] = []
  for (const path of paths) {
    for (const scenario of [path, reflectedPath(path)]) {
      const replay = replayRange(candidate, pct, scenario)
      ratios.push(Math.min(0, ...replay.downsideRatios, ...replay.hodlRelativeRatios))
    }
  }
  return ratios
}

function rawAmount(human: number, decimals: number): bigint {
  const digits = Math.min(12, decimals)
  return parseUnits(Math.max(0, human).toFixed(digits), decimals)
}

function userLiquidity(candidate: RecommendationCandidate, capitalUsd: number, range: ReturnType<typeof rangeAt>): bigint {
  if (!finite(candidate.token0Usd) || !finite(candidate.token1Usd) || candidate.token0Usd <= 0 || candidate.token1Usd <= 0) return 0n
  const amount0 = rawAmount(capitalUsd / 2 / candidate.token0Usd, candidate.decimals0)
  const amount1 = rawAmount(capitalUsd / 2 / candidate.token1Usd, candidate.decimals1)
  return getLiquidityForAmounts(
    BigInt(candidate.sqrtPriceX96),
    getSqrtRatioAtTick(range.tickLower),
    getSqrtRatioAtTick(range.tickUpper),
    amount0,
    amount1,
  )
}

function cvar95(values: number[], capitalUsd: number): number {
  if (!values.length) return 0
  const losses = values.map((value) => Math.min(0, value * capitalUsd)).sort((a, b) => a - b)
  const tail = losses.slice(0, Math.max(1, Math.ceil(losses.length * 0.05)))
  return tail.reduce((sum, value) => sum + value, 0) / tail.length
}

const riskWeight: Record<RecommendationRisk, number> = { conservative: 1, balanced: 0.5, aggressive: 0.2 }
const maxDailyReopens: Record<RecommendationRisk, number> = { conservative: 2, balanced: 6, aggressive: 12 }

export function scoreCandidate(args: {
  candidate: RecommendationCandidate
  capitalUsd: number
  mode: RecommendationMode
  risk: RecommendationRisk
  cost: RecommendationCostProfile
  now: number
}): RecommendationItem[] {
  const { candidate, capitalUsd, mode, risk, cost, now } = args
  if (candidate.tvlUsd < 10_000 || capitalUsd > candidate.tvlUsd * 0.02 || (candidate.vol24hUsd ?? 0) < 10_000 || now - candidate.statsUpdatedAt > 600 || now - candidate.stateUpdatedAt > 600) return []
  if (mode === 'rewards' && (candidate.protocol !== 'up33' || !candidate.gaugeAlive || candidate.periodFinish <= now || !candidate.upUsd)) return []
  const lookback = chooseLookback(candidate, now)
  if (!lookback) return []
  const recentTicks = candidate.tickHistory.filter((row) => row.ts >= now - DAY)
  return RECOMMENDATION_BANDS.map((pct) => {
    const replay = replayRange(candidate, pct, recentTicks)
    const range = replay.range
    const liquidity = userLiquidity(candidate, capitalUsd, range)
    const active = Number(BigInt(candidate.liquidity))
    const staked = Number(BigInt(candidate.stakedLiquidity))
    const yours = Number(liquidity)
    const executionDowntime = Math.min(0.5, replay.reopens * cost.cycleSeconds / DAY)
    const inRangeRatio = Math.max(0, 1 - executionDowntime)
    const feeShare = active + yours > 0 ? yours / (active + yours) : 0
    const rewardShare = staked + yours > 0 ? yours / (staked + yours) : 0
    const keep = 1 - candidate.unstakedFeePpm / 1_000_000
    const grossFeeUsd = mode === 'fees'
      ? lookback.hourlyVolumeUsd * 24 * candidate.feePpm / 1_000_000 * keep * feeShare * inRangeRatio
      : 0
    const rewardUsd = mode === 'rewards'
      ? Number(BigInt(candidate.rewardRate)) / 1e18 * Math.min(DAY, candidate.periodFinish - now) * candidate.upUsd! * rewardShare * inRangeRatio
      : 0
    const gasUsd = replay.reopens * cost.gasUsdPerCycle
    const executionUsd = replay.reopens * capitalUsd * cost.executionBpsPerCycle / 10_000
    const netUsd = grossFeeUsd + rewardUsd - gasUsd - executionUsd
    const tail = cvar95(riskPathRatios(candidate, pct, candidate.tickHistory.filter((row) => row.ts >= now - 7 * DAY)), capitalUsd)
    const riskAdjustedNetUsd = netUsd - riskWeight[risk] * Math.abs(tail)
    const coverageRatio = tail < 0 ? netUsd / Math.abs(tail) : null
    const tickConfidence = Math.min(1, replay.coverageHours / 24)
    const costConfidence = Math.min(1, cost.sampleCycles / 20)
    const marketConfidence = [candidate.vol1hUsd, candidate.vol6hUsd, candidate.vol24hUsd].filter(finite).length / 3
    const confidenceScore = Math.max(0, Math.min(1, 0.45 * tickConfidence + 0.25 * lookback.confidence + 0.2 * costConfidence + 0.1 * marketConfidence))
    const rawCenter = tickToPrice(candidate.tick, candidate.decimals0, candidate.decimals1)
    const actualCenter = candidate.token0IsRisk ? rawCenter : 1 / rawCenter
    const warnings = [
      ...(replay.coverageHours < 23 ? ['tick_history_incomplete'] : []),
      ...(lookback.reason === 'short_spike' ? ['short_volume_spike'] : []),
      ...(lookback.reason === 'slowing' ? ['volume_slowing'] : []),
      ...(cost.source === 'default' ? ['cost_default'] : []),
      ...(mode === 'rewards' ? ['reward_committed_until_period_finish'] : []),
    ]
    const gateReasons = [
      ...(replay.reopens > maxDailyReopens[risk] ? ['excessive_reopens' as const] : []),
      ...(replay.coverageHours < 20 ? ['insufficient_tick_history' as const] : []),
      ...(riskAdjustedNetUsd <= 0 ? ['non_positive_risk_adjusted_net' as const] : []),
      ...(!candidate.hasStableQuote ? ['unanchored_quote_risk' as const] : []),
    ]
    return {
      rank: 0,
      pool: candidate.pool,
      protocol: candidate.protocol,
      pair: `${candidate.symbol0}/${candidate.symbol1}`,
      mode,
      lookback,
      range: {
        lowerPct: pct,
        upperPct: pct,
        tickLower: range.tickLower,
        tickUpper: range.tickUpper,
        actualLowerPct: Math.max(0, (1 - range.actualQuoteLower / actualCenter) * 100),
        actualUpperPct: Math.max(0, (range.actualQuoteUpper / actualCenter - 1) * 100),
      },
      projection24h: {
        grossFeeUsd,
        rewardUsd,
        gasUsd,
        executionUsd,
        netUsd,
        riskAdjustedNetUsd,
        reopens: replay.reopens,
        inRangePct: inRangeRatio * 100,
        cvar95Usd: tail,
        coverageRatio,
      },
      confidence: { level: confidenceScore >= 0.75 ? 'high' : confidenceScore >= 0.5 ? 'medium' : 'low', score: confidenceScore },
      market: {
        tvlUsd: candidate.tvlUsd,
        vol1hUsd: candidate.vol1hUsd,
        vol6hUsd: candidate.vol6hUsd,
        vol24hUsd: candidate.vol24hUsd,
        feePpm: candidate.feePpm,
        statsUpdatedAt: candidate.statsUpdatedAt,
        tickCoverageHours: replay.coverageHours,
      },
      cost,
      gateReasons,
      warnings,
    } satisfies RecommendationItem
  })
}

export function rankRecommendations(items: RecommendationItem[]): { observed: RecommendationItem[]; items: RecommendationItem[] } {
  const bestByPool = new Map<string, RecommendationItem>()
  const bestEligibleByPool = new Map<string, RecommendationItem>()
  for (const item of items) {
    const key = item.pool.toLowerCase()
    const prior = bestByPool.get(key)
    if (!prior || item.projection24h.riskAdjustedNetUsd > prior.projection24h.riskAdjustedNetUsd) bestByPool.set(key, item)
    if (item.gateReasons.length || item.confidence.level === 'low' || item.projection24h.netUsd <= 0 || item.projection24h.riskAdjustedNetUsd <= 0) continue
    const priorEligible = bestEligibleByPool.get(key)
    if (!priorEligible || item.projection24h.riskAdjustedNetUsd > priorEligible.projection24h.riskAdjustedNetUsd)
      bestEligibleByPool.set(key, item)
  }
  const observed = [...bestByPool.values()].sort((a, b) => b.projection24h.riskAdjustedNetUsd - a.projection24h.riskAdjustedNetUsd)
    .map((item, index) => ({ ...item, rank: index + 1 }))
  const recommended = [...bestEligibleByPool.values()]
    .sort((a, b) => b.projection24h.riskAdjustedNetUsd - a.projection24h.riskAdjustedNetUsd)
    .map((item, index) => ({ ...item, rank: index + 1 }))
  return { observed, items: recommended }
}
