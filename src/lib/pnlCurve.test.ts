import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExecutorPerformance, ExecutorPnlCurvePoint } from './executorClient'
import { mergePnlCurveSnapshots, strategyPnlCurvePoints } from './pnlCurve'

const performance: ExecutorPerformance = {
  strategyId: 's1', calculatedAt: 300, state: 'monitoring',
  quote: { address: '0xabc', symbol: 'WETH', decimals: 2 },
  baseline: { kind: 'strategy_start', at: 50, tokenId: '1', priceSource: 'strategy_start_snapshot', blockNumber: '1', tick: 0 },
  summary: {
    reopens: 0, grossFeesQuoteRaw: '0', protocolFeesQuoteRaw: '0', incomeTaxQuoteRaw: '0', netFeesQuoteRaw: '0', gasCostQuoteRaw: '0', openingGasCostQuoteRaw: '0', executionCostQuoteRaw: '0', marketAndLpQuoteRaw: '0', currentValueQuoteRaw: '0', profitReserveQuoteRaw: '0', withdrawnProfitQuoteRaw: '0', withdrawnProfitUsdgRaw: '0', currentUncollectedFeesQuoteRaw: '0', currentUnclaimedRewardsQuoteRaw: '0', currentUnclaimedTotalQuoteRaw: '0', baselineValueQuoteRaw: '0', pnlQuoteRaw: '350', pnlPct: 0, currentValueUsdgRaw: '0', baselineValueUsdgRaw: '0', gasCostUsdgRaw: '0', pnlUsdgRaw: '4250000', pnlUsdgPct: 0,
  },
}
const row = (overrides: Partial<ExecutorPnlCurvePoint>): ExecutorPnlCurvePoint => ({
  strategyId: 's1', bucketAt: 0, observedAt: 200,
  quote: { address: '0xAbC', symbol: 'WETH', decimals: 2 }, pnlRaw: '250', pnlUsdgRaw: '3000000',
  ...overrides,
})

test('P/L curve uses five-minute snapshots, baseline, and the live value', () => {
  assert.deepEqual(strategyPnlCurvePoints('s1', [row({})], performance, 'quote'), [
    { at: 50, value: 0 }, { at: 200, value: 2.5 }, { at: 300, value: 3.5 },
  ])
  assert.deepEqual(strategyPnlCurvePoints('s1', [row({})], performance, 'stable'), [
    { at: 50, value: 0 }, { at: 200, value: 3 }, { at: 300, value: 4.25 },
  ])
})

test('incremental snapshots replace the same five-minute bucket and retain the window', () => {
  assert.deepEqual(mergePnlCurveSnapshots([
    row({ bucketAt: 300, observedAt: 310, pnlRaw: '100' }),
    row({ bucketAt: 600, observedAt: 610, pnlRaw: '200' }),
  ], [
    row({ bucketAt: 600, observedAt: 620, pnlRaw: '250' }),
    row({ bucketAt: 900, observedAt: 905, pnlRaw: '300' }),
  ], 500).map(({ bucketAt, observedAt, pnlRaw }) => ({ bucketAt, observedAt, pnlRaw })), [
    { bucketAt: 600, observedAt: 620, pnlRaw: '250' },
    { bucketAt: 900, observedAt: 905, pnlRaw: '300' },
  ])
})

test('quote curve ignores snapshots from an obsolete quote asset', () => {
  assert.deepEqual(strategyPnlCurvePoints('s1', [row({ quote: { address: '0xdef', symbol: 'OTHER', decimals: 2 } })], performance, 'quote'), [
    { at: 50, value: 0 }, { at: 300, value: 3.5 },
  ])
})
