import assert from 'node:assert/strict'
import test from 'node:test'
import type { Address, Hex } from 'viem'
import { effectiveClFeePpm, mergePoolsByIdentity, poolIdentity } from './poolIdentity'
import type { ClPool } from '../types'

const manager = '0x00000000000000000000000000000000000000A1' as Address
const token0 = '0x0000000000000000000000000000000000000000' as Address
const token1 = '0x00000000000000000000000000000000000000B1' as Address
const base = {
  kind: 'cl',
  protocol: 'univ4',
  address: manager,
  token0,
  token1,
  tickSpacing: 10,
  feePpm: 500,
  unstakedFeePpm: 0,
  sqrtPriceX96: 1n,
  tick: 0,
  liquidity: 1n,
  stakedLiquidity: 0n,
  gauge: null,
  gaugeAlive: false,
  weight: 0n,
  rewardRate: 0n,
  periodFinish: 0n,
} as const

const v4 = (poolId: Hex, liquidity: bigint): ClPool => ({ ...base, poolId, liquidity })

test('v4 pools use poolId rather than their shared manager address', () => {
  const a = v4(`0x${'11'.repeat(32)}` as Hex, 1n)
  const b = v4(`0x${'22'.repeat(32)}` as Hex, 1n)
  assert.notEqual(poolIdentity(a), poolIdentity(b))
  assert.equal(a.address, b.address)
})

test('catalog and held rows dedupe by poolId and the fresh held row wins', () => {
  const id = `0x${'33'.repeat(32)}` as Hex
  const catalog = v4(id, 10n)
  const held = v4(id, 99n)
  const other = v4(`0x${'44'.repeat(32)}` as Hex, 7n)

  const merged = mergePoolsByIdentity([catalog, other], [held]) as ClPool[]
  assert.equal(merged.length, 2)
  assert.equal(merged[0].liquidity, 99n)
  assert.equal(merged[1].liquidity, 7n)
})

test('dynamic v4 identity fee stays separate from the effective LP fee', () => {
  const dynamic = {
    ...v4(`0x${'55'.repeat(32)}` as Hex, 1n),
    feePpm: 0x800000,
    lpFeePpm: 420,
  }
  assert.equal(effectiveClFeePpm(dynamic), 420)
  assert.equal(dynamic.feePpm, 0x800000)
})
