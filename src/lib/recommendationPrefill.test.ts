import assert from 'node:assert/strict'
import test from 'node:test'
import type { RecommendationItem } from '../../shared/recommendation/types'
import { queueRecommendationPrefill, takeRecommendationPrefill } from './recommendationPrefill'

test('v4 recommendation handoff preserves PoolId, hooks and exact model ticks once', () => {
  const item = {
    pool: '0x1111111111111111111111111111111111111111',
    poolId: `0x${'AB'.repeat(32)}`,
    hooks: '0x2222222222222222222222222222222222222222',
    protocol: 'univ4',
    range: { lowerPct: 7.5, upperPct: 7.5, tickLower: -120, tickUpper: 180 },
  } as unknown as RecommendationItem

  queueRecommendationPrefill(item, 2_500, 'recommended')
  assert.deepEqual(takeRecommendationPrefill(), {
    pool: item.pool.toLowerCase(),
    poolId: item.poolId!.toLowerCase(),
    hooks: item.hooks!.toLowerCase(),
    protocol: 'univ4',
    status: 'recommended',
    pct: 7.5,
    capitalUsd: 2_500,
    tickLower: -120,
    tickUpper: 180,
  })
  assert.equal(takeRecommendationPrefill(), null)
})
