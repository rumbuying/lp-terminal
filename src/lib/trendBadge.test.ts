import assert from 'node:assert/strict'
import test from 'node:test'
import { sparklineBars, trendBadgeColor, trendGlyph, trendSubline } from './trendBadge'
import type { VolumeTrend } from '../hooks/usePoolRank'

const trend = (over: Partial<VolumeTrend> = {}): VolumeTrend => ({
  class: 'stable',
  vsBaseline: null,
  slope7dPct: null,
  consecutiveRiseDays: null,
  consecutiveFallDays: null,
  daysToVerified: null,
  confidence: 0.8,
  dailyVol: [],
  daysSampled: 10,
  ...over,
})

test('badge colors map the five classes and unknown has no color', () => {
  assert.equal(trendBadgeColor.rising, 'green')
  assert.equal(trendBadgeColor.new_hot, 'cyan')
  assert.equal(trendBadgeColor.stable, '')
  assert.equal(trendBadgeColor.fading, 'amber')
  assert.equal(trendBadgeColor.collapsing, 'red')
  assert.equal(trendBadgeColor.unknown, '')
  assert.equal(trendGlyph.unknown, '—')
})

test('subline joins the numbers it has and omits the ones it does not', () => {
  assert.equal(trendSubline(trend({ slope7dPct: 38.4, vsBaseline: 1.38 })), '+38%/周 · vs7d ×1.38')
  assert.equal(trendSubline(trend({ slope7dPct: -55 })), '-55%/周')
  assert.equal(trendSubline(trend({ slope7dPct: null, vsBaseline: 0.4 })), 'vs7d ×0.40')
  assert.equal(trendSubline(trend()), '')
})

test('sparkline bars scale to the max, skip missing days, and stay on the baseline', () => {
  const bars = sparklineBars([1, null, 2, 4], 40, 10)
  assert.equal(bars.length, 3, 'the missing day is a gap, not a zero')
  const tallest = bars[2]
  assert.equal(tallest.h, 8, 'the max bar fills height−2')
  assert.equal(tallest.y + tallest.h, 10, 'bars sit on the bottom baseline')
  assert.ok(bars[0].h < tallest.h)
})

test('sparkline handles degenerate inputs without throwing', () => {
  assert.deepEqual(sparklineBars([], 40, 10), [])
  assert.deepEqual(sparklineBars([null, null], 40, 10), [])
  assert.deepEqual(sparklineBars([5], 0, 10), [])
})
