import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildLiquidityBins,
  distributionDomain,
  floorDiv,
  initializedTicksFromBitmap,
} from './liquidityDistribution'

test('bitmap word math preserves negative compressed ticks', () => {
  assert.equal(floorDiv(-1, 256), -1)
  assert.equal(floorDiv(-257, 256), -2)
  assert.deepEqual(initializedTicksFromBitmap(-1, (1n << 0n) | (1n << 255n), 10), [-2560, -10])
})

test('normal concentrated selections fit fully while full range is bounded', () => {
  const normal = distributionDomain(0, 1, -2624, 2624)
  assert.equal(normal.clipped, false)
  assert.ok(normal.tickLow <= -2624)
  assert.ok(normal.tickHigh >= 2624)

  const full = distributionDomain(0, 1, -887272, 887272)
  assert.equal(full.clipped, true)
  assert.equal(full.wordHigh - full.wordLow + 1, 24)
  assert.ok(full.tickHigh - full.tickLow <= 6_000)
})

test('keeps a high-spacing chart zoomed to the selection instead of the bitmap word', () => {
  const domain = distributionDomain(102458, 200, 101400, 103600)
  assert.equal(domain.clipped, false)
  assert.ok(domain.tickHigh - domain.tickLow < 5_000)
  assert.ok((domain.wordHigh - domain.wordLow + 1) <= 2)
})

test('reconstructs active liquidity on both sides of current tick', () => {
  const bins = buildLiquidityBins(
    0,
    100n,
    [
      { tick: -10, liquidityNet: 50n },
      { tick: 10, liquidityNet: -30n },
    ],
    { tickLow: -20, tickHigh: 20 },
    4,
  )
  assert.deepEqual(bins.map((bin) => bin.liquidity), [50, 100, 100, 70])
})
