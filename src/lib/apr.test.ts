import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from '../types'
import { feeAprOf, feesOf, volumeOf } from './apr'
import type { PoolStat } from './poolstats'

const stat: PoolStat = {
  vol5mUsd: 100,
  vol1hUsd: 1_000,
  vol6hUsd: 6_000,
  vol24hUsd: 24_000,
  liqUsd: 100_000,
  source: 'dexscreener',
}

const onePctCl = { kind: 'cl', feePpm: 10_000, unstakedFeePpm: 0 } as Pool

test('selects volume and estimates gross fees from the same window', () => {
  assert.equal(volumeOf(stat, 'm5'), 100)
  assert.equal(feesOf(onePctCl, stat, 'm5'), 1)
  assert.equal(feesOf(onePctCl, stat, 'h1'), 10)
  assert.equal(feesOf(onePctCl, stat, 'h6'), 60)
  assert.equal(feesOf(onePctCl, stat, 'h24'), 240)
})

test('keeps uncovered windows empty instead of fabricating zero fees', () => {
  assert.equal(feesOf(onePctCl, { ...stat, vol5mUsd: null }, 'm5'), null)
  assert.equal(feeAprOf(onePctCl, { ...stat, vol5mUsd: null }, 'm5'), null)
})

test('annualizes fee APR from the selected rolling window', () => {
  assert.ok(Math.abs(feeAprOf(onePctCl, stat, 'm5')! - 105.12) < 1e-12)
  assert.ok(Math.abs(feeAprOf(onePctCl, stat, 'h1')! - 87.6) < 1e-12)
  assert.ok(Math.abs(feeAprOf(onePctCl, stat, 'h6')! - 87.6) < 1e-12)
  assert.ok(Math.abs(feeAprOf(onePctCl, stat, 'h24')! - 87.6) < 1e-12)
})

test('applies the CL unstaked fee levy after deriving selected-window fees', () => {
  const levied = { ...onePctCl, unstakedFeePpm: 100_000 } as Pool
  assert.ok(Math.abs(feeAprOf(levied, stat, 'h1')! - 78.84) < 1e-12)
})
