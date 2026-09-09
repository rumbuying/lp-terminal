import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyVolumeTrend,
  consecutiveFallDays,
  consecutiveRiseDays,
  dailyFromMidnightBounds,
  detectMigrationEvent,
  diagnosePair,
  logSlope7dPct,
  pairShares,
  pairTotals,
  trailingBaselineRatios,
  trendSortWeight,
  type VolumeTrend,
} from './volumeTrend'

const ramp = (days: number, start: number, growth: number): (number | null)[] =>
  Array.from({ length: days }, (_, i) => start * growth ** i)

const flat = (days: number, v: number): (number | null)[] => Array.from({ length: days }, () => v)

test('rising: sustained multi-day ramp with enough age', () => {
  const t = classifyVolumeTrend({ dailyVol: ramp(14, 1000, 1.2), ageDaysLowerBound: 30 })
  assert.equal(t.class, 'rising')
  assert.ok((t.vsBaseline ?? 0) > 1.2)
  assert.ok((t.slope7dPct ?? 0) > 20)
  assert.equal(t.daysToVerified, null)
  assert.equal(t.consecutiveRiseDays, 13)
  assert.ok(t.confidence >= 0.99)
})

test('new_hot: identical ramp but under the verified age — never rising', () => {
  const t = classifyVolumeTrend({ dailyVol: ramp(7, 1000, 1.25), ageDaysLowerBound: 4 })
  assert.equal(t.class, 'new_hot')
  assert.equal(t.daysToVerified, 3)
  assert.ok(t.confidence < 0.99, 'youth must discount confidence')
})

test('collapsing: one cliff day below the ratio, everything else flat', () => {
  const t = classifyVolumeTrend({ dailyVol: [...flat(9, 5000), 1000], ageDaysLowerBound: 60 })
  assert.equal(t.class, 'collapsing')
  assert.ok((t.vsBaseline ?? 1) < 0.35)
})

test('fading: fadeDays consecutive days under the trailing ratio', () => {
  const t = classifyVolumeTrend({ dailyVol: [...flat(8, 5000), 2500, 2500], ageDaysLowerBound: 60 })
  assert.equal(t.class, 'fading')
})

test('double-then-halve reads stable, not fading (trailing baseline, not fixed)', () => {
  const t = classifyVolumeTrend({ dailyVol: [...flat(8, 1000), 2000, 2000, 1000, 1000], ageDaysLowerBound: 60 })
  assert.equal(t.class, 'stable')
})

test('one quiet day is not fading yet', () => {
  const t = classifyVolumeTrend({ dailyVol: [...flat(9, 5000), 2500], ageDaysLowerBound: 60 })
  assert.equal(t.class, 'stable')
})

test('big one-day jump without a slope reads stable (explicit fallback)', () => {
  const t = classifyVolumeTrend({ dailyVol: [...flat(9, 4000), 6000], ageDaysLowerBound: 60 })
  assert.equal(t.class, 'stable')
  assert.ok((t.vsBaseline ?? 0) > 1.2)
})

test('unknown: short series, dust baseline, and the null numbers stay null', () => {
  const short = classifyVolumeTrend({ dailyVol: [100, 120, null, 130, 140] })
  assert.equal(short.class, 'unknown')
  assert.equal(short.vsBaseline, null)
  assert.equal(short.slope7dPct, null)

  const dust = classifyVolumeTrend({ dailyVol: flat(10, 30) })
  assert.equal(dust.class, 'unknown')

  const sparse = classifyVolumeTrend({ dailyVol: [1000, null, null, null, null, 2000, null, null, null, 3000] })
  assert.equal(sparse.class, 'unknown')
})

test('dailyVol echo caps at 14 entries and preserves missing days', () => {
  const series: (number | null)[] = []
  for (let i = 0; i < 20; i++) series.push(i === 10 ? null : 1000 + i)
  const t = classifyVolumeTrend({ dailyVol: series })
  assert.equal(t.dailyVol.length, 14, 'echo is the LAST 14 entries')
  assert.equal(t.dailyVol[0], 1006, 'echo starts at index 6 of 20')
  assert.equal(t.dailyVol[4], null, 'the missing day stays missing inside the echo')
  assert.equal(t.daysSampled, 19)
})

test('logSlope7dPct: null under 5 valid days, positive on a ramp', () => {
  assert.equal(logSlope7dPct([100, 110, null, 120]), null)
  assert.ok((logSlope7dPct(ramp(7, 1000, 1.2)) ?? 0) > 100)
})

test('consecutiveRiseDays honours the ±5% tolerance', () => {
  assert.equal(consecutiveRiseDays([1000, 1060, 1120, 1180]), 3, '6% steps are rises')
  assert.equal(consecutiveRiseDays([1000, 1030, 1080]), 0, '3% steps are neutral, not rises')
  assert.equal(consecutiveRiseDays([1000, 1030, 900, 1140]), 1)
  assert.equal(consecutiveRiseDays([1000]), null)
})

test('consecutive runs break at missing days, not across them', () => {
  assert.equal(consecutiveRiseDays([1000, null, 1500, 1600]), 1, 'the null gap ends the run')
  assert.equal(consecutiveFallDays([4000, null, 3000, 2500]), 1)
})

test('consecutiveFallDays counts real drops only', () => {
  assert.equal(consecutiveFallDays([1000, 950, 900, 850]), 3, '5% drops are falls')
  assert.equal(consecutiveFallDays([1000, 990]), 0, 'a 1% dip is neutral, not a fall')
  assert.equal(consecutiveFallDays([1000, 1100, 1045]), 1, 'a rise then a 5% fall')
})

test('logSlope7dPct drops dust days instead of regressing through them', () => {
  // a $3 artifact day followed by a real ramp: the raw log slope is astronomic
  const dusty = [3, ...ramp(6, 1000, 1.2)]
  const slope = logSlope7dPct(dusty)
  assert.ok(slope !== null && slope < 1000, `slope must stay sane, got ${slope}`)
  assert.equal(logSlope7dPct([3, 3, 3, 3, 3, 3, 1000, 1200]), null, 'too few meaningful days after the dust cut')
})

test('trailingBaselineRatios needs 3 prior days before it says anything', () => {
  const ratios = trailingBaselineRatios([1000, 1000, 1000, 1000])
  assert.deepEqual(ratios, [null, null, null, 1])
})

test('pairShares and pairTotals: unpriced days stay null, partial days share what is priced', () => {
  const shares = pairShares([[1000, null, 3000], [3000, 1000, null]])
  assert.ok(Math.abs(shares[0][0]! - 0.25) < 1e-9)
  assert.ok(Math.abs(shares[1][0]! - 0.75) < 1e-9)
  assert.equal(shares[0][1], null)
  assert.ok(Math.abs(shares[1][1]! - 1) < 1e-9)
  assert.ok(Math.abs(shares[0][2]! - 1) < 1e-9)
  assert.equal(shares[1][2], null)
  assert.deepEqual(pairTotals([[1000, null, 3000], [3000, 1000, null]]), [4000, 1000, 3000])
})

const MIGRATION_SHARES = {
  A: [0.8, 0.8, 0.8, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.25],
  B: [0.05, 0.05, 0.05, 0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.6],
  C: [0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15],
}

test('migration event: dominant holder bleeds to a gaining peer over a stable pair', () => {
  const e = detectMigrationEvent({ pairTotal: flat(10, 100_000), shares: MIGRATION_SHARES, now: 0 })
  assert.ok(e, 'event must fire')
  assert.equal(e!.fromPool, 'A')
  assert.equal(e!.toPool, 'B')
  assert.ok(Math.abs(e!.fromShareStart - 0.8) < 1e-9)
  assert.ok(Math.abs(e!.fromShareEnd - 0.25) < 1e-9)
  assert.equal(e!.windowDays, 7)
  // winner share above its window-start 0.05, summed over days 4..9 × 100k
  assert.ok(Math.abs(e!.magnitudeUsd - 205_000) < 1e-6)
  assert.equal(e!.windowStartIndex, 3)
})

test('migration event does not fire when the pair total itself collapses (retreat, not migration)', () => {
  const declining = Array.from({ length: 10 }, (_, i) => 100_000 - i * 6_000)
  const e = detectMigrationEvent({ pairTotal: declining, shares: MIGRATION_SHARES, now: 0 })
  assert.equal(e, null)
})

test('migration event does not fire on a window too short to mean anything', () => {
  const e = detectMigrationEvent({
    pairTotal: [100_000, 100_000],
    shares: { A: [0.8, 0.2], B: [0.2, 0.8] },
    now: 0,
  })
  assert.equal(e, null)
})

test('diagnosePair: all four kinds and the unknown', () => {
  assert.equal(
    diagnosePair({ pairTotalStart: 100_000, pairTotalEnd: 95_000, focusShareStart: 0.8, focusShareEnd: 0.3, bestPeerShareGain: 0.55 }).kind,
    'migration',
  )
  assert.equal(
    diagnosePair({ pairTotalStart: 100_000, pairTotalEnd: 60_000, focusShareStart: 0.5, focusShareEnd: 0.5, bestPeerShareGain: 0.02 }).kind,
    'retreat',
  )
  assert.equal(
    diagnosePair({ pairTotalStart: 100_000, pairTotalEnd: 130_000, focusShareStart: 0.5, focusShareEnd: 0.35, bestPeerShareGain: 0.2 }).kind,
    'expansion_shift',
  )
  assert.equal(
    diagnosePair({ pairTotalStart: 100_000, pairTotalEnd: 130_000, focusShareStart: 0.5, focusShareEnd: 0.52, bestPeerShareGain: 0.1 }).kind,
    'both_rising',
  )
  assert.equal(
    diagnosePair({ pairTotalStart: null, pairTotalEnd: 95_000, focusShareStart: 0.8, focusShareEnd: 0.3, bestPeerShareGain: 0.55 }).kind,
    'unknown',
  )
})

test('dailyFromMidnightBounds: consecutive midnight vol24h differences are the days between them', () => {
  const DAY = 86_400
  const d0 = 50_000 * DAY
  const bounds = [
    { day: d0, vol24h: 100 },
    { day: d0 + DAY, vol24h: 250 },
    { day: d0 + 2 * DAY, vol24h: 250 },
    { day: d0 + 3 * DAY, vol24h: 400 },
  ]
  const out = dailyFromMidnightBounds(bounds)
  // day0: 250-100=150 · day1: 250-250=0 (a real zero-volume day, kept) · day2: 400-250=150
  assert.deepEqual(out, [
    { day: d0, vol: 150 },
    { day: d0 + DAY, vol: 0 },
    { day: d0 + 2 * DAY, vol: 150 },
  ])
})

test('dailyFromMidnightBounds: a missing boundary nulls its day, a revision nulls the day after', () => {
  const DAY = 86_400
  const d0 = 50_000 * DAY
  // boundary for day2 missing → day1 cannot be computed (its end bound is gone)
  const gap = dailyFromMidnightBounds([
    { day: d0, vol24h: 100 },
    { day: d0 + DAY, vol24h: 250 },
    { day: d0 + 3 * DAY, vol24h: 400 },
  ])
  assert.deepEqual(gap, [{ day: d0, vol: 150 }], 'the day after the gap is unverifiable and stays null')
  // a negative difference is a source revision: drop that day, keep going
  const revised = dailyFromMidnightBounds([
    { day: d0, vol24h: 100 },
    { day: d0 + DAY, vol24h: 90 },
    { day: d0 + 2 * DAY, vol24h: 200 },
  ])
  assert.deepEqual(revised, [{ day: d0 + DAY, vol: 110 }])
})

test('trend sort weight ranks verified rising above new_hot above stable', () => {  assert.ok(trendSortWeight.rising > trendSortWeight.new_hot)
  assert.ok(trendSortWeight.new_hot > trendSortWeight.stable)
  assert.ok(trendSortWeight.stable > trendSortWeight.fading)
  assert.ok(trendSortWeight.fading > trendSortWeight.collapsing)
  assert.ok(trendSortWeight.collapsing > trendSortWeight.unknown)
})

test('a gap day conservatively downgrades a run-based rise, slope still sane', () => {
  const base = ramp(12, 1000, 1.15)
  const a: VolumeTrend = classifyVolumeTrend({ dailyVol: base, ageDaysLowerBound: 30 })
  const gapped = classifyVolumeTrend({ dailyVol: [...base.slice(0, -2), null, base[base.length - 1]], ageDaysLowerBound: 30 })
  assert.equal(a.class, 'rising')
  assert.ok(
    gapped.class === 'rising' || gapped.class === 'stable',
    'a gap may conservatively downgrade rising to stable, never to a decline',
  )
  assert.ok(gapped.slope7dPct !== null, 'the slope survives the gap')
  assert.ok((gapped.slope7dPct ?? 0) > TREND_RISE_MIN, 'and still reads as a ramp')
})

const TREND_RISE_MIN = 20
