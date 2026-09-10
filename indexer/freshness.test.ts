import assert from 'node:assert/strict'
import test from 'node:test'
import { dataFreshness, freshEnough } from './freshness'

const now = 2_000
const ttl = 300_000

test('observation freshness has explicit fresh, stale and unavailable states', () => {
  assert.equal(dataFreshness(1_700, ttl, now), 'fresh')
  assert.equal(dataFreshness(1_699, ttl, now), 'stale')
  for (const value of [null, undefined, 0, -1, NaN, now + 1])
    assert.equal(dataFreshness(value, ttl, now), 'unavailable')
  assert.equal(freshEnough(1_700, ttl, now), true)
  assert.equal(freshEnough(1_699, ttl, now), false)
})
