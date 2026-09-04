import assert from 'node:assert/strict'
import test from 'node:test'

test('provider batch rejection with HTTP 400 is transient provider noise', async () => {
  const { isBatchRejection, isTransientRpcFailure } = await import('./rpc-retry')
  const viemLike = {
    status: 400,
    message: 'HTTP request failed.\n\nStatus: 400\nURL: https://robinhood-mainnet.g.alchemy.com/v2/alch_secret_key\n\nRequest body: {\"method\":\"eth_getTransactionReceipt\"}\n\nDetails: Missing or invalid parameters.\nDouble check you have provided the correct parameters.',
  }
  assert.equal(isBatchRejection(viemLike), true)
  assert.equal(isTransientRpcFailure(viemLike), true, 'the batch artifact must not false-fail idempotent reads')
})

test('a stripped body without status is still recognized as a batch rejection', async () => {
  const { isBatchRejection, isTransientRpcFailure } = await import('./rpc-retry')
  const stripped = new Error('Missing or invalid parameters.\nDouble check you have provided the correct parameters.\n\nURL: https://robinhood-mainnet.g.alchemy.com/v2/alch_secret_key')
  assert.equal(isBatchRejection(stripped), true)
  assert.equal(isTransientRpcFailure(stripped), true, 'the recovery classifier must treat it as noise, not execution-grade')
})

test('genuine malformed-params and revert errors stay non-transient', async () => {
  const { isBatchRejection, isTransientRpcFailure } = await import('./rpc-retry')
  assert.equal(isBatchRejection(new Error('Invalid params: expected a hex string')), false, 'a JSON-RPC -32602 from our own call is ours, not provider noise')
  assert.equal(isTransientRpcFailure(new Error('Invalid params')), false)
  assert.equal(isTransientRpcFailure(new Error('execution reverted')), false)
  assert.equal(isTransientRpcFailure(new Error('nonce too low')), false)
  assert.equal(isTransientRpcFailure({ status: 400, message: 'some other bad request' }), false)
})

test('classic transient failures remain transient', async () => {
  const { isTransientRpcFailure } = await import('./rpc-retry')
  assert.equal(isTransientRpcFailure(new Error('Timed out while waiting for transaction with hash "0x1"')), true)
  assert.equal(isTransientRpcFailure({ status: 429, message: 'rate limited' }), true)
  assert.equal(isTransientRpcFailure({ status: 503, message: 'provider degraded' }), true)
  assert.equal(isTransientRpcFailure({ code: 'ECONNRESET', message: 'socket reset' }), true)
})
