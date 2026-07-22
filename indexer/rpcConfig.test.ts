import assert from 'node:assert/strict'
import test from 'node:test'
import { rpcUrls } from './config'

test('indexer uses its dedicated RPC before the shared paid RPC', () => {
  const previousExtraKey = process.env.EXTRA_ALCHEMY_RPC_KEY
  const previousRpc = process.env.RPC
  try {
    process.env.EXTRA_ALCHEMY_RPC_KEY = 'extra-test-key'
    process.env.RPC = 'https://shared.invalid'
    assert.deepEqual(rpcUrls(), [
      'https://robinhood-mainnet.g.alchemy.com/v2/extra-test-key',
      'https://shared.invalid',
    ])
  } finally {
    if (previousExtraKey === undefined) delete process.env.EXTRA_ALCHEMY_RPC_KEY
    else process.env.EXTRA_ALCHEMY_RPC_KEY = previousExtraKey
    if (previousRpc === undefined) delete process.env.RPC
    else process.env.RPC = previousRpc
  }
})
