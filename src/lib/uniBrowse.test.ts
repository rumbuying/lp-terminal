import assert from 'node:assert/strict'
import test from 'node:test'
import type { PublicClient } from 'viem'
import { CHAIN } from '../config/chains'
import { fetchUniBrowse } from './uniBrowse'

test('catalog cancellation stops waiting for a fallback RPC multicall', async (t) => {
  const requested: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request): Promise<Response> => {
    requested.push(String(input))
    return new Response(JSON.stringify([{
      chainId: CHAIN.slugs.dexscreener,
      dexId: CHAIN.slugs.dexIds.uni,
      labels: ['v3'],
      pairAddress: '0x0000000000000000000000000000000000000011',
      liquidity: { usd: 1_000_000 },
      volume: { h24: 10_000 },
    }]), { status: 200 })
  })

  let rpcStarted!: () => void
  const started = new Promise<void>((resolve) => {
    rpcStarted = resolve
  })
  const client = {
    multicall: () => {
      rpcStarted()
      return new Promise<never>(() => {})
    },
  } as unknown as PublicClient
  const controller = new AbortController()
  const catalog = fetchUniBrowse(client, '', controller.signal)

  await started
  const connectors = [...new Set(CHAIN.connectors.map((address) => address.toLowerCase()))]
  assert.equal(requested.length, connectors.length)
  for (const connector of connectors) {
    assert.equal(requested.some((url) => url.toLowerCase().endsWith(`/${connector}`)), true)
  }
  controller.abort(new DOMException('catalog deadline', 'TimeoutError'))
  await assert.rejects(
    catalog,
    (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
  )
})
