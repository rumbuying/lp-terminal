import assert from 'node:assert/strict'
import test from 'node:test'
import type { PoolStat } from './poolstats'
import { poolStatWithFallback } from './poolStatFallback'

const fallback: PoolStat = {
  vol5mUsd: 2_000,
  vol1hUsd: 12_000,
  vol6hUsd: 48_000,
  vol24hUsd: 130_000,
  liqUsd: 900_000,
  source: 'dexscreener',
}

test('fills missing volume without replacing chain liquidity', () => {
  const primary: PoolStat = {
    vol5mUsd: null,
    vol1hUsd: null,
    vol6hUsd: null,
    vol24hUsd: null,
    liqUsd: 1_000_000,
    source: 'chain',
  }

  assert.deepEqual(poolStatWithFallback(primary, fallback), {
    vol5mUsd: 2_000,
    vol1hUsd: 12_000,
    vol6hUsd: 48_000,
    vol24hUsd: 130_000,
    liqUsd: 1_000_000,
    source: 'dexscreener',
  })
})

test('preserves valid zero volume and only fills missing liquidity', () => {
  const primary: PoolStat = {
    vol5mUsd: 0,
    vol1hUsd: 0,
    vol6hUsd: 0,
    vol24hUsd: 0,
    liqUsd: null,
    source: 'chain',
  }

  assert.deepEqual(poolStatWithFallback(primary, fallback), {
    vol5mUsd: 0,
    vol1hUsd: 0,
    vol6hUsd: 0,
    vol24hUsd: 0,
    liqUsd: 900_000,
    source: 'chain',
  })
})

test('uses whichever complete stat is available', () => {
  assert.equal(poolStatWithFallback(undefined, undefined), undefined)
  assert.equal(poolStatWithFallback(fallback, undefined), fallback)
  assert.equal(poolStatWithFallback(undefined, fallback), fallback)
})
