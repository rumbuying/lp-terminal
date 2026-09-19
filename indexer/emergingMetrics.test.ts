import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assessBehavior,
  assessRetention,
  assessStabilization,
  roundTripShare,
  type BehaviorTrade,
  type PriceBar,
} from './emergingMetrics'
import { EMERGING_THRESHOLDS as T } from './emergingPolicy'

const trade = (n: number, over: Partial<BehaviorTrade> = {}): BehaviorTrade => ({
  ts: 1_000_000 + n * 1_000,
  volumeQuote: 100n,
  direction: 'buy',
  actor: `0x${(n + 1).toString(16).padStart(40, '0')}`,
  ...over,
})

test('behavior: healthy dispersed flow is low_observed — “未发现指定异常”, nothing more', () => {
  // 12 distinct actors, one trade each; no direction flips, no whale prints.
  const trades = Array.from({ length: 12 }, (_, i) => trade(i, { direction: i % 2 === 0 ? 'buy' : 'sell' }))
  const a = assessBehavior({ trades, hasDataGap: false })
  assert.equal(a.class, 'low_observed')
  assert.equal(a.uniqueActors, 12)
  assert.ok(a.maxActorVolumeShare <= T.maxActorVolumeShare)
  assert.ok(a.roundTripShare === 0, 'no same-actor reversals exist')
})

test('behavior: one dominant actor over 30% of volume → suspect', () => {
  const trades = Array.from({ length: 10 }, (_, i) => trade(i))
  trades[0].volumeQuote = 400n // 400 / 1300 > 30%
  const a = assessBehavior({ trades, hasDataGap: false })
  assert.equal(a.class, 'suspect')
  assert.ok(a.reasons.some((x) => x.startsWith('actor_share')))
})

test('behavior: a single trade over 20% of volume → suspect', () => {
  const trades = Array.from({ length: 10 }, (_, i) => trade(i))
  trades[3].volumeQuote = 300n // 300/1200 = 25% single print
  const a = assessBehavior({ trades, hasDataGap: false })
  assert.equal(a.class, 'suspect')
  assert.ok(a.reasons.some((x) => x.startsWith('single_trade')))
})

test('behavior: unresolved (router-only) volume over 20% → unknown, not a verdict', () => {
  const trades = Array.from({ length: 10 }, (_, i) => trade(i, { actor: i < 3 ? null : `0x${i}` }))
  const a = assessBehavior({ trades, hasDataGap: false })
  assert.equal(a.class, 'unknown')
  assert.ok(a.reasons.some((x) => x.startsWith('unknown_volume')))
})

test('behavior: a data gap forces unknown even over pristine flow (§3.2)', () => {
  const trades = Array.from({ length: 10 }, (_, i) => trade(i))
  const a = assessBehavior({ trades, hasDataGap: true })
  assert.equal(a.class, 'unknown')
  assert.ok(a.reasons.includes('data_gap'))
})

test('round-trip: same-actor reverse inside 10min and ±10% pairs once, first-come-first-served', () => {
  const actor = '0xabc'
  const trades: BehaviorTrade[] = [
    { ts: 0, volumeQuote: 1000n, direction: 'buy', actor },
    { ts: 60_000, volumeQuote: 950n, direction: 'sell', actor }, // pairs with #0
    { ts: 120_000, volumeQuote: 940n, direction: 'buy', actor },  // no partner left
  ]
  const share = roundTripShare(trades.map((t) => ({ ...t })))
  // Paired volume = min(1000,950)=950 of total 2890.
  assert.ok(Math.abs(share - 950 / 2890) < 1e-9)
})

test('round-trip: reverse outside the window or beyond ±10% never pairs', () => {
  const actor = '0xabc'
  const late = roundTripShare([
    { ts: 0, volumeQuote: 1000n, direction: 'buy', actor },
    { ts: 601_000, volumeQuote: 1000n, direction: 'sell', actor },
  ])
  assert.equal(late, 0)
  const skewed = roundTripShare([
    { ts: 0, volumeQuote: 1000n, direction: 'buy', actor },
    { ts: 60_000, volumeQuote: 1200n, direction: 'sell', actor }, // 20% > tolerance
  ])
  assert.equal(skewed, 0)
})

test('retention: flat 12h over the quiet floor passes; decay to 0.4 fails; collapse fails', () => {
  const flat = Array(12).fill(500)
  assert.equal(assessRetention(flat, T.quietVolumeQuotePerHour).pass, true)

  const decaying = [800, 800, 800, 800, 800, 800, 700, 600, 500, 400, 350, 320]
  // B ≈ 514, A = 800 → B/A ≈ 0.64 ✓; V=320, M≈627 → V/M ≈ 0.51 ✓
  assert.equal(assessRetention(decaying, T.quietVolumeQuotePerHour).pass, true)

  const cliff = Array(11).fill(500).concat([150])
  const a = assessRetention(cliff, T.quietVolumeQuotePerHour)
  assert.equal(a.pass, false, 'V/M = 0.3 < 0.35 — the APR-hallucination guard')
  assert.ok(a.reasons.includes('V/M<0.35'))
})

test('retention: a quiet-floor violation and a short window each block, with reasons', () => {
  const withDeadHour = Array(12).fill(500)
  withDeadHour[7] = 50
  const a = assessRetention(withDeadHour, T.quietVolumeQuotePerHour)
  assert.equal(a.pass, false)
  assert.ok(a.reasons.includes('quiet_floor'))

  assert.equal(assessRetention(Array(6).fill(500), T.quietVolumeQuotePerHour).pass, false)
})

test('retention: flat-zero A (a dead market) fails — 企稳不是死寂', () => {
  const a = assessRetention(Array(12).fill(0), T.quietVolumeQuotePerHour)
  assert.equal(a.pass, false)
  assert.ok(a.reasons.includes('A<=0'))
})

const bars = (prices: number[], everyVolume = true): PriceBar[] =>
  prices.map((p) => ({ close: p, hasVolume: everyVolume }))

test('stabilization: quieting vol-2 with a ≥5% rebound over the anchor passes', () => {
  // 72 5-min bars: first 3h noisy (σA), last 3h quiet (σB ≪ σA), all above
  // the anchor by ≥5%. Build with a seeded alternating pattern.
  const prices: number[] = []
  let p = 1.06
  for (let i = 0; i < 72; i++) {
    const amp = i < 36 ? 0.02 : 0.002
    p *= 1 + (i % 2 === 0 ? amp : -amp)
    prices.push(p)
  }
  const a = assessStabilization(bars(prices), 1.0)
  assert.equal(a.pass, true, `reasons=${a.reasons.join(',')}`)
  assert.ok(a.sigmaB <= a.sigmaA * T.sigmaRatioMax)
})

test('stabilization: σ not converging (σB/σA > 0.8) fails', () => {
  const prices: number[] = []
  let p = 1.06
  for (let i = 0; i < 72; i++) {
    const amp = i < 36 ? 0.001 : 0.02
    p *= 1 + (i % 2 === 0 ? amp : -amp)
    prices.push(p)
  }
  const a = assessStabilization(bars(prices), 1.0)
  assert.equal(a.pass, false)
  assert.ok(a.reasons.includes('sigmaB/sigmaA>0.8'))
})

test('stabilization: no rebound off the frozen anchor fails even with perfect σ', () => {
  const prices: number[] = []
  let p = 1.0
  for (let i = 0; i < 72; i++) {
    p *= 1 + (i % 2 === 0 ? 0.002 : -0.002)
    prices.push(p)
  }
  // Anchor = the last close itself: rebound ≈ 0 < 5%.
  const a = assessStabilization(bars(prices), prices[prices.length - 1])
  assert.equal(a.pass, false)
  assert.ok(a.reasons.some((r) => r.startsWith('rebound<')))
})

test('stabilization: thin sampling (<24 valid returns per window) fails honestly', () => {
  const bars72 = Array.from({ length: 72 }, (_, i) => ({
    close: 1.06 * (1 + (i % 2 === 0 ? 0.001 : -0.001)),
    hasVolume: i % 3 === 0, // two thirds of bars untraded → most returns invalid
  }))
  const a = assessStabilization(bars72, 1.0)
  assert.equal(a.pass, false)
  assert.ok(a.reasons.some((r) => r.startsWith('returns<')))
})
