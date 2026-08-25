import assert from 'node:assert/strict'
import test from 'node:test'
import type { ClPool, Pool, V2Pool } from '../types'
import { clTokenUsd, feeAprOf, feesOf, simulateV2Add, volumeOf, volumeWindowLabel } from './apr'
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

test('formats every rolling window label without losing its unit', () => {
  assert.deepEqual(['m5', 'h1', 'h6', 'h24'].map((window) => volumeWindowLabel(window as 'm5' | 'h1' | 'h6' | 'h24')), ['5M', '1H', '6H', '24H'])
})

test('personal add preview uses the selected rolling window', () => {
  const pool = {
    kind: 'v2', protocol: 'univ2', feeBps: 30,
    reserve0: 1_000n, reserve1: 1_000n, totalSupply: 1_000n, gaugeTotalSupply: 0n,
  } as unknown as V2Pool
  const args = { pool, amount0h: 10, amount1h: 10, dec0: 0, dec1: 0, stat: { ...stat, vol1hUsd: 2_000 } }
  const h1 = simulateV2Add({ ...args, volumeWindow: 'h1' })!
  const h24 = simulateV2Add({ ...args, volumeWindow: 'h24' })!
  assert.ok(Math.abs(h1.feeApr / h24.feeApr - 2) < 1e-12)
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

const TOKEN0 = '0x0000000000000000000000000000000000000010'
const TOKEN1 = '0x0000000000000000000000000000000000000020'
const oneToOneCl = {
  kind: 'cl',
  token0: TOKEN0,
  token1: TOKEN1,
  sqrtPriceX96: 1n << 96n,
} as unknown as ClPool

test('CL valuation prefers two direct indexer marks', () => {
  assert.deepEqual(clTokenUsd(oneToOneCl, 18, 18, undefined, undefined, {
    [TOKEN0]: 2,
    [TOKEN1]: 3,
  }), { p0: 2, p1: 3 })
})

test('CL valuation derives the missing side from pool spot and one direct mark', () => {
  assert.deepEqual(clTokenUsd(oneToOneCl, 18, 18, undefined, undefined, {
    [TOKEN0]: 2,
  }), { p0: 2, p1: 2 })
})
