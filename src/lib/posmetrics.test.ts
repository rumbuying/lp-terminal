import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ClPool, ClPosition } from '../types'
import { compareClPositionDisplay } from './posmetrics'

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
