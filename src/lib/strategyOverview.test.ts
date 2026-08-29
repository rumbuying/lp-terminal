import assert from 'node:assert/strict'
import test from 'node:test'
import { dailyCycleTotals, weightedDailyReturnPct } from './strategyOverview'
import { shanghaiDay } from '../../shared/strategy/calendar'

test('daily return weights strategies by opening portfolio value', () => {
  assert.equal(weightedDailyReturnPct([
    { pnlRaw: '100', openingAssetsRaw: '10000', openingAssetsStable: 100 },
    { pnlRaw: '-100', openingAssetsRaw: '20000', openingAssetsStable: 200 },
  ]), 0)
})

test('daily return ignores incomplete snapshots', () => {
  assert.equal(weightedDailyReturnPct([
    { pnlRaw: null, openingAssetsRaw: '10000', openingAssetsStable: 100 },
    { pnlRaw: '250', openingAssetsRaw: '10000', openingAssetsStable: 100 },
  ]), 2.5)
  assert.equal(weightedDailyReturnPct([]), null)
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
