import assert from 'node:assert/strict'
import test from 'node:test'
import { PNL_SNAPSHOT_INTERVAL_SECONDS, bucketPnlCurveRows, type PnlCurveRow } from './pnlBuckets'

const quote = { address: '0xquote', symbol: 'USDG', decimals: 6 }

const row = (strategyId: string, bucketAt: number, pnlRaw: string, observedAt = bucketAt): PnlCurveRow => ({
  strategyId, bucketAt, observedAt, quote, pnlRaw, pnlUsdgRaw: pnlRaw,
})

const hour = 60 * 60

test('the raw cadence is returned untouched', () => {
  const rows = [row('a', 0, '1'), row('a', PNL_SNAPSHOT_INTERVAL_SECONDS, '2')]
  assert.equal(bucketPnlCurveRows(rows, PNL_SNAPSHOT_INTERVAL_SECONDS), rows)
})

test('coarser buckets keep the last observation in each bucket', () => {
  const rows = [
    row('a', 0, '1', 0),
    row('a', 5 * 60, '2', 5 * 60),
    row('a', 55 * 60, '3', 55 * 60),
    row('a', hour, '4', hour),
  ]
  const bucketed = bucketPnlCurveRows(rows, hour)
  assert.deepEqual(bucketed.map((point) => [point.bucketAt, point.pnlRaw]), [[0, '3'], [hour, '4']])
})

test('bucketing is per strategy and sorted by time then strategy', () => {
  const rows = [
    row('b', 10 * 60, 'b1'),
    row('a', 20 * 60, 'a1'),
    row('b', 2 * hour, 'b2'),
    row('a', 2 * hour + 60, 'a2'),
  ]
  const bucketed = bucketPnlCurveRows(rows, hour)
  assert.deepEqual(
    bucketed.map((point) => `${point.strategyId}@${point.bucketAt}`),
    ['a@0', 'b@0', 'a@7200', 'b@7200'],
  )
  assert.equal(rows[0].bucketAt, 10 * 60, 'input rows are not mutated')
})

test('observedAt ordering decides the winner when a bucket has ties later', () => {
  const rows = [row('a', 30 * 60, 'old', 30 * 60), row('a', 20 * 60, 'late', 50 * 60)]
  const bucketed = bucketPnlCurveRows(rows, hour)
  assert.deepEqual(bucketed.map((point) => point.pnlRaw), ['late'])
})
