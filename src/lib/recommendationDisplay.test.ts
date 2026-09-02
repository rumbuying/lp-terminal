import assert from 'node:assert/strict'
import test from 'node:test'
import type { RecommendationItem } from '../../shared/recommendation/types'
import { recommendationDisplayItems } from './recommendationDisplay'

const item = (pool: string, rank: number, confidence: RecommendationItem['confidence']['level'], netUsd: number): RecommendationItem => ({
  rank,
  pool,
  protocol: 'univ3',
  pair: `PAIR-${rank}`,
  mode: 'fees',
  lookback: { window: 'h6', hourlyVolumeUsd: 10, confidence: 0.6, reason: 'bootstrap_6h', errors: {} },
  range: { lowerPct: 2, upperPct: 2, tickLower: -120, tickUpper: 120, actualLowerPct: 2, actualUpperPct: 2 },
  projection24h: { grossFeeUsd: 5, rewardUsd: 0, gasUsd: 1, executionUsd: 1, netUsd, riskAdjustedNetUsd: netUsd, reopens: 1, inRangePct: 90, cvar95Usd: -2, coverageRatio: 1 },
  confidence: { level: confidence, score: confidence === 'low' ? 0.4 : 0.7 },
  market: { tvlUsd: 1000, vol1hUsd: 10, vol6hUsd: 60, vol24hUsd: 240, feePpm: 3000, statsUpdatedAt: 1, tickCoverageHours: 24 },
  cost: { protocol: 'univ3', gasUsdPerCycle: 1, executionBpsPerCycle: 2, cycleSeconds: 60, sampleCycles: 2, source: 'pool' },
  gateReasons: [],
  warnings: [],
})

test('fills three cards with observations when only one pool is promoted', () => {
  const promoted = item('0xA', 1, 'high', 5)
  const low = item('0xB', 2, 'low', 4)
  const negative = item('0xC', 3, 'medium', -1)
  const displayed = recommendationDisplayItems({ items: [promoted], observed: [promoted, low, negative] })

  assert.deepEqual(displayed.map(({ item: row, status }) => [row.pool, status]), [
    ['0xA', 'recommended'], ['0xB', 'observed'], ['0xC', 'observed'],
  ])
  assert.deepEqual(displayed[1].observationReasons, ['low_confidence'])
  assert.deepEqual(displayed[2].observationReasons, ['non_positive_net'])
})

test('does not duplicate a promoted pool from the observed list', () => {
  const promoted = item('0xAbC', 1, 'high', 5)
  const displayed = recommendationDisplayItems({ items: [promoted], observed: [{ ...promoted, pool: '0xabc' }] })
  assert.equal(displayed.length, 1)
  assert.equal(displayed[0].status, 'recommended')
})

test('the rank-table LVR floor gate surfaces as an observation reason', () => {
  const gated = item('0xD', 1, 'medium', 3)
  gated.gateReasons = ['pool_below_lvr_floor']
  const displayed = recommendationDisplayItems({ items: [], observed: [gated] })
  assert.deepEqual(displayed[0].observationReasons, ['pool_below_lvr_floor'])
})
