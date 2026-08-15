import assert from 'node:assert/strict'
import test from 'node:test'
import { bufferedLegacyGasPrice, isRetryableFeeRejection } from './gasPrice'

test('legacy gas price is buffered above both the RPC suggestion and base fee', () => {
  assert.equal(bufferedLegacyGasPrice(90n, 100n), 125n)
  assert.equal(bufferedLegacyGasPrice(120n, 100n), 150n)
})

test('a retry raises the previous buffered price', () => {
  assert.equal(bufferedLegacyGasPrice(90n, 100n, 125n), 157n)
})

test('only explicit pre-broadcast fee rejections are retryable', () => {
  assert.equal(isRetryableFeeRejection(new Error('max fee per gas less than block base fee')), true)
  assert.equal(isRetryableFeeRejection(new Error('transaction underpriced')), true)
  assert.equal(isRetryableFeeRejection(new Error('timeout while sending')), false)
})
