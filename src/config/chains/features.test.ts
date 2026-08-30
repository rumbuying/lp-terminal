import assert from 'node:assert/strict'
import test from 'node:test'
import { v2PoolsEnabled } from '../features'

test('the public V2 mode requires an explicit disable value', () => {
  assert.equal(v2PoolsEnabled('1'), false)
  assert.equal(v2PoolsEnabled('0'), true)
  assert.equal(v2PoolsEnabled(undefined), true)
})
