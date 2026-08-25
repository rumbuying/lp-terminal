import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ClPool, ClPosition, V2Pool } from '../types'
import { compareClPositionDisplay, v2TokenUsd } from './posmetrics'

const position = (tokenId: bigint, protocol: ClPool['protocol'], staked: boolean) =>
  ({ tokenId, staked, pool: { protocol } }) as ClPosition

test('unstaking a CL position does not change display order', () => {
  const values = new Map([[1n, 100], [2n, 200]])
  const ids = (positions: ClPosition[]) =>
    [...positions]
      .sort((a, b) => compareClPositionDisplay(a, b, values.get(a.tokenId)!, values.get(b.tokenId)!))
      .map((position) => position.tokenId)

  assert.deepEqual(ids([position(1n, 'up33', true), position(2n, 'up33', false)]), [2n, 1n])
  assert.deepEqual(ids([position(1n, 'up33', false), position(2n, 'up33', false)]), [2n, 1n])
})

test('v2 valuation prefers direct marks and derives only a missing counter-side', () => {
  const token0 = '0x0000000000000000000000000000000000000010'
  const token1 = '0x0000000000000000000000000000000000000020'
  const pool = {
    kind: 'v2',
    token0,
    token1,
    reserve0: 100n * 10n ** 18n,
    reserve1: 50n * 10n ** 18n,
  } as unknown as V2Pool
  assert.deepEqual(v2TokenUsd(pool, 18, 18, undefined, undefined, undefined, {
    [token0]: 2,
    [token1]: 7,
  }), { p0: 2, p1: 7 })
  assert.deepEqual(v2TokenUsd(pool, 18, 18, undefined, undefined, undefined, {
    [token0]: 2,
  }), { p0: 2, p1: 4 })
})
