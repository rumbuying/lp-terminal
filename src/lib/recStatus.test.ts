import assert from 'node:assert/strict'
import test from 'node:test'
import type { RecommendationItem, RecommendationResponse } from '../../shared/recommendation/types'
import { recStatusByPool } from './recStatus'

const item = (pool: string, mode: RecommendationItem['mode'], status: 'items' | 'observed', netUsd: number, poolId?: string): RecommendationItem => ({
  rank: 1,
  pool,
  ...(poolId ? { poolId } : {}),
  protocol: 'univ3',
  pair: 'A/B',
  mode,
  lookback: { window: 'h6', hourlyVolumeUsd: 10, confidence: 0.6, reason: 'bootstrap_6h', errors: {} },
  range: { lowerPct: 2, upperPct: 2, tickLower: -120, tickUpper: 120, actualLowerPct: 2, actualUpperPct: 2 },
  projection24h: { grossFeeUsd: 5, rewardUsd: 0, gasUsd: 1, executionUsd: 1, netUsd, riskAdjustedNetUsd: netUsd, reopens: 1, inRangePct: 90, cvar95Usd: -2, coverageRatio: 1 },
  confidence: { level: 'medium', score: 0.7 },
  market: { tvlUsd: 1000, vol1hUsd: 10, vol6hUsd: 60, vol24hUsd: 240, feePpm: 3000, statsUpdatedAt: 1, tickCoverageHours: 24 },
  cost: { protocol: 'univ3', gasUsdPerCycle: 1, executionBpsPerCycle: 2, cycleSeconds: 60, sampleCycles: 2, source: 'pool' },
  gateReasons: status === 'observed' ? ['excessive_reopens'] : [],
  warnings: [],
})

const response = (items: RecommendationItem[], observed: RecommendationItem[] = []): RecommendationResponse => ({
  modelVersion: 'lp-rec-v3',
  generatedAt: 1,
  marketAsOf: 1,
  capitalUsd: 1000,
  mode: 'fees',
  risk: 'balanced',
  observed,
  items,
})

test('one entry per pool, address keys lowercased, gate reasons carried', () => {
  const byPool = recStatusByPool({
    fees: response([], [item('0xABC', 'fees', 'observed', 3)]),
    rewards: null,
  })
  const entry = byPool.get('0xabc')
  assert.ok(entry)
  assert.equal(entry.status, 'observed')
  assert.deepEqual(entry.modes, ['fees'])
  assert.deepEqual(entry.gateReasons, ['excessive_reopens'])
  assert.equal(entry.net24h, 3)
  // unlisted pools resolve to nothing
  assert.equal(byPool.get('0xzzz'), undefined)
})

test('recommended beats observed even when the watchlist row has the higher net', () => {
  const byPool = recStatusByPool({
    fees: response([item('0x2', 'fees', 'items', 5)], [item('0x1', 'fees', 'observed', 9)]),
    rewards: response([item('0x1', 'rewards', 'items', 2)]),
  })
  assert.equal(byPool.get('0x1')?.status, 'recommended')
  assert.equal(byPool.get('0x1')?.net24h, 2)
  assert.deepEqual(byPool.get('0x1')?.modes, ['fees', 'rewards'])
  assert.deepEqual(byPool.get('0x1')?.gateReasons, [])
})

test('same status across modes keeps the better net and merges modes', () => {
  const byPool = recStatusByPool({
    fees: response([item('0x2', 'fees', 'items', 5)]),
    rewards: response([item('0x2', 'rewards', 'items', 7)]),
  })
  const entry = byPool.get('0x2')
  assert.ok(entry)
  assert.equal(entry.status, 'recommended')
  assert.equal(entry.net24h, 7)
  assert.deepEqual(entry.modes, ['fees', 'rewards'])
})

test('a v4 poolId key resolves alongside the manager address key', () => {
  const byPool = recStatusByPool({
    fees: response([item('0xmgr', 'fees', 'items', 4, '0xpoolid')]),
    rewards: null,
  })
  assert.ok(byPool.get('0xmgr'))
  assert.equal(byPool.get('0xpoolid')?.net24h, 4)
})

test('empty or missing responses yield an empty map', () => {
  assert.equal(recStatusByPool({ fees: null, rewards: null }).size, 0)
  assert.equal(recStatusByPool({ fees: response([]), rewards: response([]) }).size, 0)
})
