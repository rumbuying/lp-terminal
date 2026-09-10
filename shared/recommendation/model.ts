import { parseUnits } from 'viem'
import { quoteRangeToTicks, rangeSide } from '../strategy/range'
import { getLiquidityForAmounts, getSqrtRatioAtTick, tickToPrice } from '../../src/lib/clmath'
import type {
  LookbackWindow,
  RecommendationCandidate,
  RecommendationCostProfile,
  RecommendationHistoryCoverage,
  RecommendationItem,
  RecommendationMode,
  RecommendationRankPrior,
  RecommendationRisk,
  RecommendationTickSample,
  WindowDecision,
} from './types'
import { INCOME_RETENTION_BPS, INCOME_RETENTION_THRESHOLD_USD } from '../strategy/income-retention'

export const RECOMMENDATION_MODEL_VERSION = 'lp-rec-v5' as const
export const RECOMMENDATION_BANDS = [1, 2, 3, 5, 8, 10] as const
/**
 * How the indexer's pool-rank table enters the projection, in one sentence:
 * the rank answers whether the POOL pays its volatility at all, and these
 * thresholds decide what that answer does to a 24h position recommendation.
 *
 * LVR_FLOOR — below coverage 1 a passive in-range LP cannot beat a hedged
 * rebalancer before costs, whatever the band (see indexer/poolRank.ts). That
 * is a property of the pool over the rank's ~45-day window, not of this 24h
 * projection, so it hard-gates only the conservative profile and warns
 * elsewhere: a short-window edge can exist, but a capital-preservation user
 * should never be shown one that sits below the long-run floor.
 *
 * VOLUME_BASELINE_MULTIPLE — the walk-forward lookback is responsive by
 * design; the rank's 7-day mean volume is the stability baseline. A projection
 * running several multiples above the baseline is priced off a spike.
 */
export const LVR_FLOOR = 1
export const VOLUME_BASELINE_MULTIPLE = 3
/** The two emission readings (live gauge vs rank's post-cap snapshot) disagree past this ratio. */
const REWARDS_APR_DIVERGENCE = 2
/** Below this the emission reconciliation is noise around zero, not a signal. */
const MIN_RECONCILED_EMIT_APR = 0.005
const HOUR = 3_600
const DAY = 86_400
const YEAR_DAYS = 365
const VALIDATION_STEP = HOUR
const EPS = 1e-9
const RECENT_TICK_BUCKET = 300
const RISK_TICK_BUCKET = 1_800
const MARKET_BUCKET = HOUR

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
  const validationCoverage = historyCoverage(history, now - 7 * DAY, now, MARKET_BUCKET)
  const losses: Partial<Record<LookbackWindow, number[]>> = {}
  if (span >= 7 * DAY - HOUR && validationCoverage.ratio >= 0.7
    && (validationCoverage.maxGapSeconds ?? Infinity) <= 6 * HOUR) {
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
    return {
      reopens: 0, coverageHours: 0, observedTimeInRangeRatio: 0, range,
      downsideRatios: [] as number[], hodlRelativeRatios: [] as number[],
    }
  }
  const firstTick = rows[0].tick
  let centerTick = rows[0].tick
  let range = rangeAt(candidate, centerTick, pct)
  let reopens = 0
  let principalRatio = 1
  const downsideRatios: number[] = []
  const hodlRelativeRatios: number[] = []
  let observedSeconds = 0
  let inRangeSeconds = 0
  let previousTs = rows[0].ts
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
    const side = rangeSide(row.tick, range.tickLower, range.tickUpper)
    const elapsed = Math.max(0, Math.min(RECENT_TICK_BUCKET, row.ts - previousTs))
    observedSeconds += elapsed
    if (side === 'in') inRangeSeconds += elapsed
    previousTs = row.ts
    if (side !== 'in') {
      principalRatio *= valueRatio
      centerTick = row.tick
      range = rangeAt(candidate, centerTick, pct)
      reopens++
    }
  }
  const coverageHours = observedSeconds / HOUR
  const scale = coverageHours > 0 ? 24 / coverageHours : 1
  return {
    reopens: reopens * scale,
    coverageHours,
    observedTimeInRangeRatio: observedSeconds > 0 ? inRangeSeconds / observedSeconds : 0,
    range: rangeAt(candidate, candidate.tick, pct),
    downsideRatios,
    hodlRelativeRatios,
  }
}

/** Fixed-window bucket coverage. Unlike first-to-last span, this does not turn
 * a pair of observations separated by a day-long outage into 24h of evidence. */
export function historyCoverage<T extends { ts: number }>(
  samples: readonly T[],
  start: number,
  end: number,
  bucketSeconds: number,
): RecommendationHistoryCoverage {
  const windowSeconds = Math.max(0, end - start)
  const rows = [...samples]
    .filter((row) => Number.isFinite(row.ts) && row.ts >= start && row.ts <= end)
    .sort((a, b) => a.ts - b.ts)
  const unique = new Set(rows.map((row) => Math.min(
    Math.max(0, Math.floor((row.ts - start) / bucketSeconds)),
    Math.max(0, Math.ceil(windowSeconds / bucketSeconds) - 1),
  )))
  const coveredSeconds = Math.min(windowSeconds, unique.size * bucketSeconds)
  if (!rows.length) return {
    windowSeconds, coveredSeconds: 0, ratio: 0, sampleCount: 0,
    firstAt: null, lastAt: null, maxGapSeconds: null,
  }
  let maxGapSeconds = Math.max(0, rows[0].ts - start, end - rows.at(-1)!.ts)
  for (let index = 1; index < rows.length; index++)
    maxGapSeconds = Math.max(maxGapSeconds, rows[index].ts - rows[index - 1].ts)
  return {
    windowSeconds,
    coveredSeconds,
    ratio: windowSeconds > 0 ? coveredSeconds / windowSeconds : 0,
    sampleCount: rows.length,
    firstAt: rows[0].ts,
    lastAt: rows.at(-1)!.ts,
    maxGapSeconds,
  }
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
 * happened yet. Inventory drawdown and LP-vs-HODL IL remain separate series.
 */
function riskPathRatios(candidate: RecommendationCandidate, pct: number, samples: RecommendationTickSample[]): {
  inventoryDrawdownRatios: number[]
  ilRatios: number[]
} {
  const rows = [...samples].sort((a, b) => a.ts - b.ts)
  if (rows.length < 2) return { inventoryDrawdownRatios: [], ilRatios: [] }
  const paths: RecommendationTickSample[][] = []
  const completeDay = (path: RecommendationTickSample[]) => {
    if (path.length < 2) return false
    const start = path[0].ts
    const coverage = historyCoverage(path, start, start + DAY, RISK_TICK_BUCKET)
    return coverage.ratio >= 0.75 && (coverage.maxGapSeconds ?? Infinity) <= HOUR
  }
  let nextStart = rows[0].ts
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].ts < nextStart) continue
    const end = rows[i].ts + DAY
    const path: RecommendationTickSample[] = []
    for (let j = i; j < rows.length && rows[j].ts <= end; j++) path.push(rows[j])
    if (completeDay(path)) paths.push(path)
    nextStart = rows[i].ts + 6 * HOUR
  }
  const recent = rows.filter((row) => row.ts >= rows.at(-1)!.ts - DAY)
  if (completeDay(recent)) paths.push(recent)

  const inventoryDrawdownRatios: number[] = []
  const ilRatios: number[] = []
  for (const path of paths) {
    for (const scenario of [path, reflectedPath(path)]) {
      const replay = replayRange(candidate, pct, scenario)
      inventoryDrawdownRatios.push(Math.min(0, ...replay.downsideRatios))
      ilRatios.push(Math.min(0, ...replay.hodlRelativeRatios))
    }
  }
  return { inventoryDrawdownRatios, ilRatios }
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

function worstFivePercentMean(values: number[], capitalUsd: number): number {
  if (!values.length) return 0
  const losses = values.map((value) => Math.min(0, value * capitalUsd)).sort((a, b) => a - b)
  const tail = losses.slice(0, Math.max(1, Math.ceil(losses.length * 0.05)))
  return tail.reduce((sum, value) => sum + value, 0) / tail.length
}

const riskWeight: Record<RecommendationRisk, number> = { conservative: 1, balanced: 0.5, aggressive: 0.2 }
const maxDailyReopens: Record<RecommendationRisk, number> = { conservative: 2, balanced: 6, aggressive: 12 }

/** The indexer drops stale priors before serving; this guard is for payloads
 * that crossed HTTP — a malformed prior must never poison scoring. */
function validRankPrior(prior: RecommendationCandidate['poolRank']): RecommendationRankPrior | null {
  if (!prior) return null
  const finitePrior = finite(prior.generatedAt) && finite(prior.coverage) && finite(prior.sigmaDaily)
    && finite(prior.sigmaAnnual) && finite(prior.feeApr7d) && finite(prior.volDayUsd)
    && (prior.emitApr === null || finite(prior.emitApr))
  return finitePrior && prior.coverage > 0 ? prior : null
}

/** Pool-average emission APR implied by the LIVE gauge state — the same
 * quantity the rank table measures from its post-cap rewardRate snapshot, so
 * a large divergence means one of the two readings is wrong (epoch boundary,
 * UP price mark, cap change). */
function liveEmitApr(candidate: RecommendationCandidate): number | null {
  const up = candidate.upUsd
  const liquidity = Number(BigInt(candidate.liquidity))
  const staked = Number(BigInt(candidate.stakedLiquidity))
  if (!up || !(liquidity > 0) || !(staked > 0)) return null
  const stakedTvlUsd = candidate.tvlUsd * staked / liquidity
  if (!(stakedTvlUsd > 0)) return null
  const emissionUsdPerDay = Number(BigInt(candidate.rewardRate)) / 1e18 * DAY * up
  return emissionUsdPerDay * YEAR_DAYS / stakedTvlUsd
}

function emitAprMismatch(candidate: RecommendationCandidate, prior: RecommendationRankPrior): boolean {
  if (prior.emitApr === null || prior.emitApr < MIN_RECONCILED_EMIT_APR) return false
  const live = liveEmitApr(candidate)
  if (live === null) return false
  return live > prior.emitApr * REWARDS_APR_DIVERGENCE || prior.emitApr > live * REWARDS_APR_DIVERGENCE
}

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
  const prior = validRankPrior(candidate.poolRank)
  const belowLvrFloor = prior !== null && prior.coverage < LVR_FLOOR
  const aboveBaseline = prior !== null && prior.volDayUsd > 0
    && lookback.hourlyVolumeUsd * 24 > prior.volDayUsd * VOLUME_BASELINE_MULTIPLE
  const emitMismatch = mode === 'rewards' && prior !== null && emitAprMismatch(candidate, prior)
  const recentTicks = candidate.tickHistory.filter((row) => row.ts >= now - DAY)
  const tickCoverage = historyCoverage(recentTicks, now - DAY, now, RECENT_TICK_BUCKET)
  const marketCoverage = historyCoverage(candidate.marketHistory, now - 7 * DAY, now, MARKET_BUCKET)
  const historicalActiveLiquidity = candidate.marketHistory
    .filter((row) => row.ts >= now - DAY && row.ts <= now && row.activeLiquidity != null)
    .map((row) => {
      try { return BigInt(row.activeLiquidity!) } catch { return null }
    })
    .filter((value): value is bigint => value !== null && value > 0n)
    .sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
  const activeMiddle = Math.floor(historicalActiveLiquidity.length / 2)
  const historicalActiveMedianRaw = historicalActiveLiquidity.length
    ? historicalActiveLiquidity.length % 2
      ? historicalActiveLiquidity[activeMiddle]
      : (historicalActiveLiquidity[activeMiddle - 1] + historicalActiveLiquidity[activeMiddle]) / 2n
    : null
  const historicalActiveMedian = historicalActiveMedianRaw === null ? 0 : Number(historicalActiveMedianRaw)
  const recentMarketRows = candidate.marketHistory.filter((row) => row.ts >= now - DAY && row.ts <= now)
  const activeLiquidityCoverageRatio = recentMarketRows.length
    ? historicalActiveLiquidity.length / recentMarketRows.length
    : 0
  const riskTicks = candidate.tickHistory.filter((row) => row.ts >= now - 7 * DAY)
  const riskCoverage = historyCoverage(riskTicks, now - 7 * DAY, now, RISK_TICK_BUCKET)
  return RECOMMENDATION_BANDS.map((pct) => {
    const replay = replayRange(candidate, pct, recentTicks)
    const range = replay.range
    const liquidity = userLiquidity(candidate, capitalUsd, range)
    const spotActive = Number(BigInt(candidate.liquidity))
    // A historical active-liquidity median prevents a momentary spot trough
    // from inflating fee share. It is still not tick-liquidity distribution.
    const active = historicalActiveMedian > 0 ? Math.max(spotActive, historicalActiveMedian) : spotActive
    const staked = Number(BigInt(candidate.stakedLiquidity))
    const yours = Number(liquidity)
    const executionDowntime = Math.min(0.5, replay.reopens * cost.cycleSeconds / DAY)
    const uptimeRatio = Math.max(0, 1 - executionDowntime)
    const feeExposureRatio = replay.observedTimeInRangeRatio * uptimeRatio
    const feeShare = active + yours > 0 ? yours / (active + yours) : 0
    const rewardShare = staked + yours > 0 ? yours / (staked + yours) : 0
    const keep = 1 - candidate.unstakedFeePpm / 1_000_000
    const modeledVolumeInRangeUsd = lookback.hourlyVolumeUsd * 24 * feeExposureRatio
    const modeledFeeUsd = modeledVolumeInRangeUsd * candidate.feePpm / 1_000_000 * keep * feeShare
    const grossFeeUsd = mode === 'fees' ? modeledFeeUsd : 0
    // Gauge emissions follow staked liquidity. An out-of-range position stops
    // earning swap fees, but remains staked; only execution downtime applies.
    const rewardUsd = mode === 'rewards'
      ? Number(BigInt(candidate.rewardRate)) / 1e18 * Math.min(DAY, candidate.periodFinish - now) * candidate.upUsd! * rewardShare * uptimeRatio
      : 0
    // One opening is always required before any replayed recenter. Charging
    // only `reopens` made a quiet 24h path appear free to enter.
    const projectedCycles = replay.reopens + 1
    const gasUsd = projectedCycles * cost.gasUsdPerCycle
    const executionUsd = projectedCycles * capitalUsd * cost.executionBpsPerCycle / 10_000
    const entryCostUsd = cost.gasUsdPerCycle + capitalUsd * cost.executionBpsPerCycle / 10_000
    const projectedIncomeUsd = grossFeeUsd + rewardUsd
    const incomeRetentionUsd = projectedIncomeUsd > INCOME_RETENTION_THRESHOLD_USD
      ? projectedIncomeUsd * INCOME_RETENTION_BPS / 10_000
      : 0
    // Rank coverage = fee income / expected LVR. Applying the same pool prior
    // to the position's modeled fee share gives a range-specific expected LVR.
    const expectedLvrUsd = prior ? modeledFeeUsd / prior.coverage : null
    const netUsd = projectedIncomeUsd - incomeRetentionUsd - gasUsd - executionUsd - (expectedLvrUsd ?? 0)
    const pathRisks = riskPathRatios(candidate, pct, riskTicks)
    const historicalIlTailUsd = worstFivePercentMean(pathRisks.ilRatios, capitalUsd)
    const inventoryDrawdownTailUsd = worstFivePercentMean(pathRisks.inventoryDrawdownRatios, capitalUsd)
    const worstTailUsd = Math.min(historicalIlTailUsd, inventoryDrawdownTailUsd)
    const riskAdjustedNetUsd = netUsd - riskWeight[risk] * Math.abs(worstTailUsd)
    const coverageRatio = worstTailUsd < 0 ? netUsd / Math.abs(worstTailUsd) : null
    const tickConfidence = tickCoverage.ratio
    const costConfidence = Math.min(1, cost.sampleCycles / 20)
    const marketConfidence = [candidate.vol1hUsd, candidate.vol6hUsd, candidate.vol24hUsd].filter(finite).length / 3
    const operationalConfidence = 0.45 * tickConfidence + 0.2 * lookback.confidence
      + 0.2 * costConfidence + 0.15 * marketConfidence
    // Current operating evidence and historical maturity are deliberately
    // separate: a fresh day cannot masquerade as a validated 7-day strategy.
    const historyMaturity = 0.45 + 0.35 * riskCoverage.ratio + 0.2 * marketCoverage.ratio
    let confidenceScore = Math.max(0, Math.min(1, operationalConfidence * historyMaturity))
    // FR-REC-2: the day-level trend tempers the projection the same way the
    // rank's baseline tempers the hourly one. A fading/cliffing pool caps the
    // displayed confidence. A rise can nudge confidence only after the local
    // recommendation histories pass their opening gates.
    const trendClass = candidate.volumeTrend?.class ?? null
    const volumeFading = trendClass === 'fading' || trendClass === 'collapsing'
    const volumeRising = trendClass === 'rising' && lookback.reason !== 'short_spike'
    const trendEvidenceReady = riskCoverage.ratio >= 0.7
      && (riskCoverage.maxGapSeconds ?? Infinity) <= 6 * HOUR
      && marketCoverage.ratio >= 0.5
      && (marketCoverage.maxGapSeconds ?? Infinity) <= 12 * HOUR
    if (volumeFading) confidenceScore = Math.min(confidenceScore, 0.5)
    else if (volumeRising && trendEvidenceReady) confidenceScore = Math.min(1, confidenceScore + 0.05)
    const rawCenter = tickToPrice(candidate.tick, candidate.decimals0, candidate.decimals1)
    const actualCenter = candidate.token0IsRisk ? rawCenter : 1 / rawCenter
    const warnings = [
      ...(tickCoverage.ratio < 0.9 || (tickCoverage.maxGapSeconds ?? Infinity) > 30 * 60 ? ['tick_history_incomplete'] : []),
      ...(riskCoverage.ratio < 0.8 || (riskCoverage.maxGapSeconds ?? Infinity) > 3 * HOUR ? ['risk_history_incomplete'] : []),
      ...(marketCoverage.ratio < 0.8 ? ['market_history_incomplete'] : []),
      'volume_distribution_unavailable',
      'tick_liquidity_distribution_unavailable',
      ...(lookback.reason === 'short_spike' ? ['short_volume_spike'] : []),
      ...(lookback.reason === 'slowing' ? ['volume_slowing'] : []),
      ...(cost.source === 'unavailable' ? ['cost_unavailable'] : []),
      ...(mode === 'rewards' ? ['reward_committed_until_period_finish'] : []),
      // The rank prior never silently disappears: below the floor on a
      // non-conservative profile it must stay visible as a warning, and a
      // spike-priced projection advertises its own fragility.
      ...(belowLvrFloor && risk !== 'conservative' ? ['below_lvr_floor'] : []),
      ...(aboveBaseline ? ['volume_above_baseline'] : []),
      ...(emitMismatch ? ['emit_apr_divergence'] : []),
      ...(volumeFading ? ['volume_fading'] : []),
    ]
    const gateReasons = [
      ...(replay.reopens > maxDailyReopens[risk] ? ['excessive_reopens' as const] : []),
      ...(tickCoverage.ratio < 0.8 || (tickCoverage.maxGapSeconds ?? Infinity) > 30 * 60 ? ['insufficient_tick_history' as const] : []),
      ...(riskCoverage.ratio < 0.7 || (riskCoverage.maxGapSeconds ?? Infinity) > 6 * HOUR ? ['insufficient_risk_history' as const] : []),
      ...(marketCoverage.ratio < 0.5 || (marketCoverage.maxGapSeconds ?? Infinity) > 12 * HOUR ? ['insufficient_market_history' as const] : []),
      ...(riskAdjustedNetUsd <= 0 ? ['non_positive_risk_adjusted_net' as const] : []),
      ...(!candidate.hasStableQuote ? ['unanchored_quote_risk' as const] : []),
      ...(belowLvrFloor && risk === 'conservative' ? ['pool_below_lvr_floor' as const] : []),
      ...(!prior ? ['lvr_unavailable' as const] : []),
      ...(cost.source === 'unavailable' ? ['cost_unavailable' as const] : []),
    ]
    return {
      rank: 0,
      pool: candidate.pool,
      ...(candidate.poolId ? { poolId: candidate.poolId } : {}),
      ...(candidate.hooks ? { hooks: candidate.hooks } : {}),
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
        entryCostUsd,
        incomeRetentionUsd,
        expectedLvrUsd,
        netUsd,
        riskAdjustedNetUsd,
        reopens: replay.reopens,
        feeExposurePct: feeExposureRatio * 100,
        modeledVolumeInRangeUsd,
        historicalIlTailUsd,
        inventoryDrawdownTailUsd,
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
        tickCoverageHours: tickCoverage.coveredSeconds / HOUR,
        tickCoverage,
        riskTickCoverage: riskCoverage,
        marketCoverage,
        activeLiquidityBasis: historicalActiveMedian > 0 ? 'historical_active_liquidity' : 'spot_active_liquidity',
        historicalActiveLiquidity: historicalActiveMedianRaw?.toString() ?? null,
        activeLiquidityCoverageRatio,
        tickLiquidityDistribution: 'unavailable',
        volumeDistribution: 'unavailable',
      },
      cost,
      gateReasons,
      warnings,
      ...(prior ? { poolRank: prior } : {}),
      ...(candidate.volumeTrend ? { volumeTrend: candidate.volumeTrend } : {}),
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
