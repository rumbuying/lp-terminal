import assert from 'node:assert/strict'
import test from 'node:test'
import { isTransientRpcFailure, retryDelay } from '../../executor/rpc-retry'

test('classifies temporary HTTP and transport failures for safe exact retries', () => {
  assert.equal(isTransientRpcFailure({ status: 403, message: 'forbidden by provider rate limit' }), true)
  assert.equal(isTransientRpcFailure({ cause: { code: 'ETIMEDOUT' } }), true)
  assert.equal(isTransientRpcFailure(new Error('HTTP request failed. Status: 503')), true)
  assert.equal(isTransientRpcFailure(new Error('socket connection reset')), true)
})

test('does not retry deterministic transaction rejection errors', () => {
  assert.equal(isTransientRpcFailure(new Error('Missing or invalid parameters')), false)
  assert.equal(isTransientRpcFailure(new Error('execution reverted')), false)
  assert.equal(isTransientRpcFailure(new Error('nonce too low')), false)
  assert.equal(isTransientRpcFailure(new Error('replacement transaction underpriced')), false)
})

test('uses capped exponential retry delay', () => {
  assert.equal(retryDelay(400, 0), 400)
  assert.equal(retryDelay(400, 3), 3_200)
  assert.equal(retryDelay(400, 10), 10_000)
})
