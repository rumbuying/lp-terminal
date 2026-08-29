import assert from 'node:assert/strict'
import test from 'node:test'
import { executorAdminTokenStorageKey, executorHealth, executorWalletSessionStorageKey } from './executorClient'

test('executor browser credentials are isolated by chain and wallet', () => {
  const address = '0x1234567890ABCDEF1234567890ABCDEF12345678'
  assert.notEqual(executorAdminTokenStorageKey('bsc'), executorAdminTokenStorageKey('robinhood'))
  assert.notEqual(
    executorWalletSessionStorageKey(address, 'bsc'),
    executorWalletSessionStorageKey(address, 'robinhood'),
  )
  assert.match(executorWalletSessionStorageKey(address, 'bsc'), /1234567890abcdef/)
})

test('executor client rejects a response without the selected chain identity', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-lp-chain-id': '0' },
  })
  try {
    await assert.rejects(executorHealth(), /chain mismatch/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
