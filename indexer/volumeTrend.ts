// Volume-trend math — the pure half of docs/VOLUME-TREND-PRD.zh-CN.md §5.1/§8.
// No I/O, no config, no clock: everything is a function of the series passed
// in, so the classification the rank snapshot serves is exactly what the unit
// tests proved (same discipline as poolRank.ts's dailySigma/coverageOf).
//
// The one rule the whole module rests on (PRD §7.2): daily series are
// INDEPENDENT day buckets — subgraph poolDayData, GT OHLCV closes, v4 days,
// or own pool_market_snapshots aggregated at the UTC day cut. Rolling-window
// stats snapshots (vol24h etc.) must never be fed to these functions; the
// overlap autocorrelation would smear every slope and delay every cliff.
//
// Classification (PRD §8.2, short-circuit order):
//   unknown → collapsing → fading → new_hot → rising → stable
// `new_hot` sits BEFORE `rising`: the volume conditions are identical, only
// daysActive routes a young pool away from the verified "rising" badge (PRD
// decision 1). Conversion to rising is automatic — daysActive only ever grows.

/** The five display classes plus the explicit-missing one. */
export type TrendClass = 'rising' | 'new_hot' | 'stable' | 'fading' | 'collapsing' | 'unknown'

/**
 * All classification cut-offs in one place (PRD §8.4): tuning happens here and
 * in the PRD table, nowhere else.
 */
export const TREND_THRESHOLDS = {
  /** vsBaseline below this is a cliff — the APR-hallucination window opens. */
  collapseRatio: 0.35,
  /** vsBaseline below this on fadeDays consecutive days is fading. */
  fadeRatio: 0.6,
  fadeDays: 2,
  /** 7d log-slope weekly growth (%) a rise must clear. */
  riseSlope7dPct: 20,
  /** vsBaseline a rise must clear. */
  riseVsBaseline: 1.2,
  /** consecutive same-direction days a rise must show. */
  riseConsecutiveDays: 3,
  /** ±5% daily tolerance before a day counts as up/down. */
  dayStepUp: 1.05,
  dayStepDown: 0.95,
  /** vsBaseline inside [lo, hi] is stable. */
  stableLo: 0.8,
  stableHi: 1.2,
  /** A pool younger than this that meets the rise conditions is new_hot. */
  newHotAgeDays: 7,
  /** Fewer valid days than this → unknown; the series cannot carry a trend. */
  minDailySamples: 5,
  /** 7d-mean daily volume below this is dust (matches poolRank's line). */
  minBaselineDailyUsd: 50,
  /** days below this fraction of the window peak are dust for the slope
   * regression — a near-zero artifact day would dominate a log fit */
  slopeDustFractionOfPeak: 0.005,
  /** Length of the dailyVol echo the UI sparklines draw. */
  echoDays: 14,
} as const

export type VolumeTrend = {
  class: TrendClass
  /** latest full-day volume ÷ prior-7-full-day mean; null when unknown */
  vsBaseline: number | null
  /** 7-day log(volume) OLS weekly growth, %; null when samples are short */
  slope7dPct: number | null
  consecutiveRiseDays: number | null
  consecutiveFallDays: number | null
  /** new_hot only: days left until daysActive reaches the verified age */
  daysToVerified: number | null
  /** 0–1: series length × (new_hot youth penalty) */
  confidence: number
  /** the echoed daily window the UI draws (oldest→newest; null = missing day) */
  dailyVol: (number | null)[]
  daysSampled: number
}

const finitePos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

const clean = (daily: readonly (number | null)[]): number[] =>
  daily.filter(finitePos)

/**
 * OLS slope of log(volume) over the last ≤7 valid days, ×7 → weekly % growth.
 * Null when fewer than 5 valid days: five points is the minimum that can tell
 * a ramp from a wiggle (PRD FR-CALC-1). Days below 0.1% of the window's peak
 * are dropped first — a near-zero artifact day (an indexer gap, a pre-listing
 * whisper of flow) dominates a log regression otherwise and turns the slope
 * into an astronomical lie.
 */
export function logSlope7dPct(daily: readonly (number | null)[]): number | null {
  const vals = clean(daily)
  if (!vals.length) return null
  const peak = Math.max(...vals)
  const meaningful = vals.filter((v) => v >= peak * TREND_THRESHOLDS.slopeDustFractionOfPeak)
  if (meaningful.length < TREND_THRESHOLDS.minDailySamples) return null
  const window = meaningful.slice(-7)
  const n = window.length
  if (n < TREND_THRESHOLDS.minDailySamples) return null
  const xs = window.map((_, i) => i)
  const ys = window.map((v) => Math.log(v))
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my)
    den += (xs[i] - mx) ** 2
  }
  if (!(den > 0)) return null
  const slopePerDay = num / den
  const pct = (Math.exp(slopePerDay * 7) - 1) * 100
  return Number.isFinite(pct) ? pct : null
}

/** Days counted back from the end with volume ≥ prev × 1.05; null when <2 days. */
export function consecutiveRiseDays(daily: readonly (number | null)[]): number | null {
  return runLength(daily, (curr, prev) => curr / prev >= TREND_THRESHOLDS.dayStepUp)
}

/** Days counted back from the end with volume ≤ prev × 0.95; null when <2 days. */
export function consecutiveFallDays(daily: readonly (number | null)[]): number | null {
  return runLength(daily, (curr, prev) => curr / prev <= TREND_THRESHOLDS.dayStepDown)
}

function runLength(daily: readonly (number | null)[], dayMatches: (curr: number, prev: number) => boolean): number | null {
  let run = 0
  for (let i = daily.length - 1; i > 0; i--) {
    const curr = daily[i]
    const prev = daily[i - 1]
    if (!finitePos(curr) || !finitePos(prev)) break
    if (dayMatches(curr, prev)) run++
    else break
  }
  return daily.length >= 2 ? run : null
}

/**
 * Each valid day's volume ÷ the mean of up to 7 valid days strictly before it.
 * The fading test reads this from the end: `fadeDays` consecutive entries under
 * the fade ratio. Trailing baselines (not one fixed baseline) keep a pool that
 * DOUBLED and then halved from reading as "fading" — it is merely back home.
 */
export function trailingBaselineRatios(daily: readonly (number | null)[]): (number | null)[] {
  const out: (number | null)[] = daily.map(() => null)
  for (let i = 1; i < daily.length; i++) {
    const v = daily[i]
    if (!finitePos(v)) continue
    const prior: number[] = []
    for (let j = i - 1; j >= 0 && prior.length < 7; j--) {
      const p = daily[j]
      if (finitePos(p)) prior.push(p)
    }
    if (prior.length < 3) continue
    const mean = prior.reduce((a, b) => a + b, 0) / prior.length
    if (mean > 0) out[i] = v / mean
  }
  return out
}

export type ClassifyInput = {
  /**
   * INDEPENDENT daily volumes, oldest→newest, FULL days only (a partial
   * current day must be stripped by the caller — PRD §7.2).
   */
  dailyVol: readonly (number | null)[]
  /** true when the pool passed the rank's structural gates (dust, σ) — the
   * badge may carry entry semantics only then (PRD §9.1); the class itself is
   * computed either way, gating is the UI's concern. */
  rankQualified?: boolean
  /** lower bound on pool age in days (series span); null → never new_hot */
  ageDaysLowerBound?: number | null
}

/**
 * The PRD §8.2 short-circuit. Everything missing stays explicit: `unknown`
 * with null numbers — never a fabricated `stable`.
 */
export function classifyVolumeTrend(input: ClassifyInput): VolumeTrend {
  const { dailyVol } = input
  const vals = clean(dailyVol)
  const echo = echoWindow(dailyVol)
  const daysSampled = vals.length
  const empty: VolumeTrend = {
    class: 'unknown',
    vsBaseline: null,
    slope7dPct: null,
    consecutiveRiseDays: null,
    consecutiveFallDays: null,
    daysToVerified: null,
    confidence: 0,
    dailyVol: echo,
    daysSampled,
  }
  if (daysSampled < TREND_THRESHOLDS.minDailySamples) return empty

  // vsBaseline: latest full day ÷ mean of the ≤7 full days before it.
  const prior = vals.slice(0, -1).slice(-7)
  if (prior.length < 3) return empty
  const baseline = prior.reduce((a, b) => a + b, 0) / prior.length
  if (!(baseline >= TREND_THRESHOLDS.minBaselineDailyUsd)) return empty
  const latest = vals[vals.length - 1]
  const vsBaseline = latest / baseline
  if (!Number.isFinite(vsBaseline)) return empty

  const slope7dPct = logSlope7dPct(dailyVol)
  const riseDays = consecutiveRiseDays(dailyVol)
  const fallDays = consecutiveFallDays(dailyVol)

  let klass: TrendClass
  if (vsBaseline < TREND_THRESHOLDS.collapseRatio) {
    klass = 'collapsing'
  } else {
    const ratios = trailingBaselineRatios(dailyVol)
    let faded = 0
    for (let i = ratios.length - 1; i >= 0 && ratios[i] !== null; i--) {
      if ((ratios[i] as number) < TREND_THRESHOLDS.fadeRatio) faded++
      else break
    }
    if (faded >= TREND_THRESHOLDS.fadeDays) {
      klass = 'fading'
    } else {
      const rises =
        slope7dPct !== null &&
        slope7dPct > TREND_THRESHOLDS.riseSlope7dPct &&
        vsBaseline > TREND_THRESHOLDS.riseVsBaseline &&
        riseDays !== null &&
        riseDays >= TREND_THRESHOLDS.riseConsecutiveDays
      const age = input.ageDaysLowerBound ?? null
      if (rises) klass = age !== null && age < TREND_THRESHOLDS.newHotAgeDays ? 'new_hot' : 'rising'
      else if (vsBaseline >= TREND_THRESHOLDS.stableLo && vsBaseline <= TREND_THRESHOLDS.stableHi) klass = 'stable'
      else klass = 'stable' // explicit PRD fallback: strong-but-short moves read as stable
    }
  }

  const confidence = confidenceOf(daysSampled, klass, input.ageDaysLowerBound ?? null)
  return {
    class: klass,
    vsBaseline,
    slope7dPct,
    consecutiveRiseDays: riseDays,
    consecutiveFallDays: fallDays,
    daysToVerified:
      klass === 'new_hot' && input.ageDaysLowerBound != null
        ? Math.max(0, TREND_THRESHOLDS.newHotAgeDays - input.ageDaysLowerBound)
        : null,
    confidence,
    dailyVol: echo,
    daysSampled,
  }
}

function echoWindow(daily: readonly (number | null)[]): (number | null)[] {
  return daily.slice(-TREND_THRESHOLDS.echoDays).map((v) => (finitePos(v) ? v : null))
}

function confidenceOf(daysSampled: number, klass: TrendClass, ageDays: number | null): number {
  // Series length: full credit at ≥14 valid days, linear below.
  let c = Math.min(1, daysSampled / 14)
  if (klass === 'new_hot' && ageDays !== null) c *= Math.min(1, ageDays / TREND_THRESHOLDS.newHotAgeDays)
  return Math.round(Math.min(1, Math.max(0, c)) * 100) / 100
}

/** Trend-sort weight (PRD FR-UI-2): higher sorts first, ties broken by vsBaseline. */
export const trendSortWeight: Record<TrendClass, number> = {
  rising: 5,
  new_hot: 4,
  stable: 3,
  fading: 2,
  collapsing: 1,
  unknown: 0,
}

// ── pair share & migration math (PRD §5.1 FR-CALC-2/3, §8.3) ───────────────

export const MIGRATION_THRESHOLDS = {
  /** Window the event looks across (valid days; shorter series degrade). */
  windowDays: 7,
  /** The loser held at least this share at window start… */
  fromShareStart: 0.5,
  /** …and at most this at window end. */
  fromShareEnd: 0.3,
  /** The winner gained at least this many share points. */
  toShareGain: 0.2,
  /** Pair total may not have dropped more than this, or it is retreat. */
  pairTotalMaxDrop: 0.3,
  /** Fewer valid days in the window than this → no event. */
  minWindowDays: 3,
} as const

export type MigrationEvent = {
  fromPool: string
  toPool: string
  fromShareStart: number
  fromShareEnd: number
  toShareStart: number
  toShareEnd: number
  windowDays: number
  /** Σ over the window of the winner's share gain × that day's pair volume. */
  magnitudeUsd: number
  /** index of the window's first day in the caller's days array */
  windowStartIndex: number
}

/**
 * One event per call, by design: the PRD's threshold pair (a ≥50% holder
 * bleeding to ≤30% while someone gains ≥20pp) describes THE handover of a
 * pair. Multiple simultaneous handovers would mean the thresholds are wrong,
 * not that the UI needs a list.
 */
export function detectMigrationEvent(input: {
  pairTotal: readonly (number | null)[]
  shares: Readonly<Record<string, readonly (number | null)[]>>
  now: number
}): MigrationEvent | null {
  const ids = Object.keys(input.shares)
  if (ids.length < 2) return null
  const n = input.pairTotal.length
  if (n < MIGRATION_THRESHOLDS.minWindowDays) return null
  const startIdx = Math.max(0, n - MIGRATION_THRESHOLDS.windowDays)
  const windowDays = n - startIdx
  if (windowDays < MIGRATION_THRESHOLDS.minWindowDays) return null

  const at = (series: readonly (number | null)[], i: number): number | null =>
    i < series.length && finitePos(series[i]) ? (series[i] as number) : null

  const startTotal = at(input.pairTotal, startIdx)
  const endTotal = at(input.pairTotal, n - 1)
  if (startTotal === null || endTotal === null || !(startTotal > 0)) return null
  if ((endTotal - startTotal) / startTotal < -MIGRATION_THRESHOLDS.pairTotalMaxDrop) return null

  let from: { id: string; start: number; end: number } | null = null
  let to: { id: string; start: number; end: number; gain: number } | null = null
  for (const id of ids) {
    const s = input.shares[id]
    const start = at(s, startIdx)
    const end = at(s, n - 1)
    if (start === null || end === null) continue
    if (start >= MIGRATION_THRESHOLDS.fromShareStart && end <= MIGRATION_THRESHOLDS.fromShareEnd) {
      if (from === null || start > from.start) from = { id, start, end }
    }
    const gain = end - start
    if (gain >= MIGRATION_THRESHOLDS.toShareGain) {
      if (to === null || gain > to.gain) to = { id, start, end, gain }
    }
  }
  if (!from || !to || from.id === to.id) return null

  let magnitudeUsd = 0
  for (let i = startIdx + 1; i < n; i++) {
    const total = at(input.pairTotal, i)
    const share = at(input.shares[to.id], i)
    if (total === null || share === null) continue
    magnitudeUsd += Math.max(0, share - to.start) * total
  }

  return {
    fromPool: from.id,
    toPool: to.id,
    fromShareStart: from.start,
    fromShareEnd: from.end,
    toShareStart: to.start,
    toShareEnd: to.end,
    windowDays,
    magnitudeUsd,
    windowStartIndex: startIdx,
  }
}

export type PairDiagnosisKind = 'migration' | 'retreat' | 'expansion_shift' | 'both_rising' | 'unknown'

export const DIAGNOSIS_THRESHOLDS = {
  /** pair total fell more than this over the window */
  retreatPairDrop: 0.3,
  /** pair total rose more than this over the window */
  expansionPairGain: 0.2,
  /** focus pool lost at least this many share points */
  focusShareLoss: 0.05,
  /** the strongest peer gained at least this many share points */
  peerShareGain: 0.1,
  /** the focus pool "held" unless it lost more than this */
  holdTolerance: 0.05,
} as const

/**
 * Which story is this pair telling over the recent window (PRD §3.1)? The
 * caller supplies window aggregates; the v2 blind-spot caveat (§9.4) is added
 * by the caller — this function stays pure math.
 */
export function diagnosePair(input: {
  pairTotalStart: number | null
  pairTotalEnd: number | null
  focusShareStart: number | null
  focusShareEnd: number | null
  bestPeerShareGain: number | null
}): { kind: PairDiagnosisKind } {
  const { pairTotalStart, pairTotalEnd, focusShareStart, focusShareEnd, bestPeerShareGain } = input
  if (
    !finitePos(pairTotalStart) || !finitePos(pairTotalEnd) ||
    focusShareStart === null || !Number.isFinite(focusShareStart) ||
    focusShareEnd === null || !Number.isFinite(focusShareEnd) ||
    !(pairTotalStart > 0)
  )
    return { kind: 'unknown' }

  const pairChange = (pairTotalEnd - pairTotalStart) / pairTotalStart
  const focusChange = focusShareEnd - focusShareStart
  const peerGain = bestPeerShareGain ?? 0

  // Order follows the PRD §3.1 table: the pair-total move is the primary
  // discriminator, so a STRONG rise must be read as expansion/both-rising
  // before the share handover can claim "migration".
  if (pairChange < -DIAGNOSIS_THRESHOLDS.retreatPairDrop && focusChange >= -DIAGNOSIS_THRESHOLDS.holdTolerance)
    return { kind: 'retreat' }
  if (pairChange >= DIAGNOSIS_THRESHOLDS.expansionPairGain)
    return { kind: focusChange <= -DIAGNOSIS_THRESHOLDS.focusShareLoss ? 'expansion_shift' : 'both_rising' }
  // The share handover only reads as migration while the pair total holds —
  // the same −30% guard the event detector applies (PRD §8.3). A collapsing
  // total WITH a falling share is neither story; unknown is the honest call.
  if (pairChange >= -DIAGNOSIS_THRESHOLDS.retreatPairDrop && focusChange <= -DIAGNOSIS_THRESHOLDS.focusShareLoss && peerGain >= DIAGNOSIS_THRESHOLDS.peerShareGain)
    return { kind: 'migration' }
  return { kind: 'unknown' }
}

/**
 * Share series per pool, day-aligned: share[i] = vols[p][i] / Σ_p vols[p][i].
 * A day where NO pool has a number yields null for everyone; a day where SOME
 * pools are missing computes shares over what is priced (the caller reports
 * usdCoverage separately — PRD §9.6).
 */
export function pairShares(vols: readonly (readonly (number | null)[])[]): (number | null)[][] {
  const n = Math.max(0, ...vols.map((v) => v.length))
  const out: (number | null)[][] = vols.map(() => Array<number | null>(n).fill(null))
  for (let i = 0; i < n; i++) {
    let total = 0
    for (const series of vols) {
      const v = series[i]
      if (finitePos(v)) total += v
    }
    if (!(total > 0)) continue
    for (let p = 0; p < vols.length; p++) {
      const v = vols[p][i]
      if (finitePos(v)) out[p][i] = v / total
    }
  }
  return out
}

/** Day-aligned pair totals: Σ over pools of that day's volume; null when nobody reported. */
export function pairTotals(vols: readonly (readonly (number | null)[])[]): (number | null)[] {
  const n = Math.max(0, ...vols.map((v) => v.length))
  const out: (number | null)[] = Array(n).fill(null)
  for (let i = 0; i < n; i++) {
    let total = 0
    let any = false
    for (const series of vols) {
      const v = series[i]
      if (finitePos(v)) {
        total += v
        any = true
      }
    }
    if (any) out[i] = total
  }
  return out
}
