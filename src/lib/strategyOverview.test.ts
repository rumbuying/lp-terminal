import assert from 'node:assert/strict'
import test from 'node:test'
import { dailyCycleTotals, quoteDailyReturnPct, stableDailyReturnPct } from './strategyOverview'
import { shanghaiDay } from '../../shared/strategy/calendar'

test('quote daily return aggregates same-quote rows: Σ pnl / Σ opening', () => {
  assert.equal(quoteDailyReturnPct([
    { pnlRaw: '100', openingAssetsRaw: '10000', quoteAddress: '0xA' },
    { pnlRaw: '-100', openingAssetsRaw: '20000', quoteAddress: '0xA' },
  ]), 0)
  assert.equal(quoteDailyReturnPct([
    { pnlRaw: '250', openingAssetsRaw: '10000', quoteAddress: '0xA' },
  ]), 2.5)
})

test('quote daily return shares the sign of the quote P/L sum', () => {
  assert.equal(quoteDailyReturnPct([
    { pnlRaw: '50', openingAssetsRaw: '10000', quoteAddress: '0xA' },
    { pnlRaw: '-300', openingAssetsRaw: '20000', quoteAddress: '0xA' },
  ]), -0.8333)
})

test('quote daily return refuses mixed quotes and incomplete snapshots', () => {
  assert.equal(quoteDailyReturnPct([
    { pnlRaw: '100', openingAssetsRaw: '10000', quoteAddress: '0xA' },
    { pnlRaw: '100', openingAssetsRaw: '10000', quoteAddress: '0xB' },
  ]), null)
  assert.equal(quoteDailyReturnPct([
    { pnlRaw: null, openingAssetsRaw: '10000', quoteAddress: '0xA' },
  ]), null)
  assert.equal(quoteDailyReturnPct([]), null)
  // non-positive opening assets cannot be a denominator
  assert.equal(quoteDailyReturnPct([
    { pnlRaw: '100', openingAssetsRaw: '0', quoteAddress: '0xA' },
  ]), null)
})

test('stable daily return is Σ pnlUsdg / Σ opening usdg and matches its sign', () => {
  // 11.5 USDG of P/L on 2000 USDG of day-start assets → +0.575%
  const row = (pnlUsdgRaw: string | null, openingAssetsUsdgRaw: string | null) =>
    ({ pnlUsdgRaw, openingAssetsUsdgRaw })
  const pct = stableDailyReturnPct([row('11500000', '2000000000')])!
  assert.ok(Math.abs(pct - 0.575) < 1e-9)
  // negative P/L yields a negative rate — never the inverted-sign artifact
  const negative = stableDailyReturnPct([row('-500000', '2000000000')])!
  assert.ok(negative < 0 && Math.abs(negative - -0.025) < 1e-9)
  // a row whose quote-unit P/L is negative but USDG P/L positive stays positive
  const quotedLoss = stableDailyReturnPct([row('11500000', '2000000000')])!
  assert.ok(quotedLoss > 0)
})

test('stable daily return refuses a current-price substitute for a missing opening mark', () => {
  assert.equal(stableDailyReturnPct([
    { pnlUsdgRaw: '11500000', openingAssetsUsdgRaw: null },
  ]), null)
  assert.equal(stableDailyReturnPct([
    { pnlUsdgRaw: null, openingAssetsUsdgRaw: '2000000000' },
  ]), null)
  assert.equal(stableDailyReturnPct([]), null)
})

test('daily cycle totals roll over at Shanghai midnight and skip unfinished cycles', () => {
  const day = shanghaiDay(Date.parse('2026-08-27T08:00:00Z') / 1000)
  assert.deepEqual(dailyCycleTotals([
    { completedAt: Date.parse('2026-08-26T15:59:59Z') / 1000, grossFeesQuoteRaw: '10', incomeTaxQuoteRaw: '1' },
    { completedAt: Date.parse('2026-08-26T16:00:00Z') / 1000, grossFeesQuoteRaw: '200', incomeTaxQuoteRaw: '20' },
    { completedAt: Date.parse('2026-08-27T03:00:00Z') / 1000, grossFeesQuoteRaw: '300', incomeTaxQuoteRaw: '30' },
    { completedAt: null, grossFeesQuoteRaw: '900', incomeTaxQuoteRaw: '90' },
  ], shanghaiDay, day), { grossFeesRaw: '500', incomeTaxRaw: '50' })
})
