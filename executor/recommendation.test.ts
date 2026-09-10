import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'lp-recommendation-freshness-'))
process.env.LP_EXECUTOR_DATA_DIR = dir

const { assertFreshRecommendationMarket } = await import('./recommendation')
const { db } = await import('./store')

after(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('recommendations fail closed unless source observations are explicitly fresh', () => {
  const now = 2_000
  assert.deepEqual(
    assertFreshRecommendationMarket({ status: 'fresh', observedAt: 1_700, ttlSeconds: 300 }, now),
    { observedAt: 1_700, ttlSeconds: 300 },
  )
  for (const value of [
    undefined,
    { status: 'stale', observedAt: 1_900, ttlSeconds: 300 },
    { status: 'unavailable', observedAt: null, ttlSeconds: 300 },
    { status: 'fresh', observedAt: 1_699, ttlSeconds: 300 },
    { status: 'fresh', observedAt: 2_001, ttlSeconds: 300 },
    { status: 'fresh', observedAt: 1_900, ttlSeconds: 0 },
  ]) assert.throws(() => assertFreshRecommendationMarket(value, now), /stale or unavailable/)
})
