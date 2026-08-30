import assert from 'node:assert/strict'
import { basename } from 'node:path'
import test from 'node:test'
import {
  allowLegacyDbAdoption,
  BSC_PUBLIC_INDEXER_RPCS,
  CHAIN,
  DB_CHAIN_TOKEN,
  DB_PATH,
  INDEXER_FINALITY_BLOCKS,
  PUBLIC_RPC,
  UNI_V3_START_BLOCK,
  rpcUrl,
  rpcUrls,
} from './config'
import {
  assertConfiguredChainId,
  assertConfiguredRpcChainIds,
  createRpcRequestRotator,
  pc,
  redactRpcUrls,
  RpcChainMismatchError,
} from './rpc'

test('indexer uses its dedicated RPC before the shared authenticated RPC', () => {
  const previousExtraKey = process.env.EXTRA_ALCHEMY_RPC_KEY
  const previousRpc = process.env.RPC
  const previousPrimary = process.env.INDEXER_RPC_PRIMARY
  const previousFallback = process.env.INDEXER_RPC_FALLBACK
  try {
    delete process.env.INDEXER_RPC_PRIMARY
    delete process.env.INDEXER_RPC_FALLBACK
    process.env.EXTRA_ALCHEMY_RPC_KEY = 'extra-test-key'
    process.env.RPC = 'https://shared.invalid'
    // the Alchemy subdomain is per-chain; what this pins is the ORDER —
    // the indexer's own endpoint leads, the shared authenticated RPC backs it up
    const urls = rpcUrls()
    assert.equal(urls.length, 2)
    const network = CHAIN.id === 56 ? 'bnb-mainnet' : 'robinhood-mainnet'
    assert.equal(urls[0], `https://${network}.g.alchemy.com/v2/extra-test-key`)
    assert.equal(urls[1], 'https://shared.invalid')
  } finally {
    if (previousExtraKey === undefined) delete process.env.EXTRA_ALCHEMY_RPC_KEY
    else process.env.EXTRA_ALCHEMY_RPC_KEY = previousExtraKey
    if (previousRpc === undefined) delete process.env.RPC
    else process.env.RPC = previousRpc
    if (previousPrimary === undefined) delete process.env.INDEXER_RPC_PRIMARY
    else process.env.INDEXER_RPC_PRIMARY = previousPrimary
    if (previousFallback === undefined) delete process.env.INDEXER_RPC_FALLBACK
    else process.env.INDEXER_RPC_FALLBACK = previousFallback
  }
})

test('indexer appends and de-duplicates an indexer-only generic fallback', () => {
  const previousExtraKey = process.env.EXTRA_ALCHEMY_RPC_KEY
  const previousRpc = process.env.RPC
  const previousPrimary = process.env.INDEXER_RPC_PRIMARY
  const previousFallback = process.env.INDEXER_RPC_FALLBACK
  try {
    delete process.env.INDEXER_RPC_PRIMARY
    delete process.env.EXTRA_ALCHEMY_RPC_KEY
    process.env.RPC = 'https://primary.invalid'
    process.env.INDEXER_RPC_FALLBACK = 'https://secondary.invalid'
    assert.deepEqual(rpcUrls(), ['https://primary.invalid', 'https://secondary.invalid'])

    process.env.INDEXER_RPC_FALLBACK = 'https://primary.invalid'
    assert.deepEqual(rpcUrls(), ['https://primary.invalid'])
  } finally {
    if (previousExtraKey === undefined) delete process.env.EXTRA_ALCHEMY_RPC_KEY
    else process.env.EXTRA_ALCHEMY_RPC_KEY = previousExtraKey
    if (previousRpc === undefined) delete process.env.RPC
    else process.env.RPC = previousRpc
    if (previousPrimary === undefined) delete process.env.INDEXER_RPC_PRIMARY
    else process.env.INDEXER_RPC_PRIMARY = previousPrimary
    if (previousFallback === undefined) delete process.env.INDEXER_RPC_FALLBACK
    else process.env.INDEXER_RPC_FALLBACK = previousFallback
  }
})

test('explicit indexer primary strictly excludes the browser RPC and preserves endpoint order', () => {
  const previousPrimary = process.env.INDEXER_RPC_PRIMARY
  const previousExtraKey = process.env.EXTRA_ALCHEMY_RPC_KEY
  const previousRpc = process.env.RPC
  const previousFallback = process.env.INDEXER_RPC_FALLBACK
  try {
    process.env.INDEXER_RPC_PRIMARY = ' https://indexer-primary.invalid '
    process.env.EXTRA_ALCHEMY_RPC_KEY = 'extra-test-key'
    process.env.RPC = 'https://browser-only.invalid'
    process.env.INDEXER_RPC_FALLBACK = 'https://indexer-fallback.invalid'
    const network = CHAIN.id === 56 ? 'bnb-mainnet' : 'robinhood-mainnet'
    assert.deepEqual(rpcUrls(), [
      'https://indexer-primary.invalid',
      `https://${network}.g.alchemy.com/v2/extra-test-key`,
      'https://indexer-fallback.invalid',
    ])
    assert.equal(rpcUrls().includes('https://browser-only.invalid'), false)

    process.env.INDEXER_RPC_FALLBACK = 'https://indexer-primary.invalid'
    assert.deepEqual(rpcUrls(), [
      'https://indexer-primary.invalid',
      `https://${network}.g.alchemy.com/v2/extra-test-key`,
    ])
  } finally {
    if (previousPrimary === undefined) delete process.env.INDEXER_RPC_PRIMARY
    else process.env.INDEXER_RPC_PRIMARY = previousPrimary
    if (previousExtraKey === undefined) delete process.env.EXTRA_ALCHEMY_RPC_KEY
    else process.env.EXTRA_ALCHEMY_RPC_KEY = previousExtraKey
    if (previousRpc === undefined) delete process.env.RPC
    else process.env.RPC = previousRpc
    if (previousFallback === undefined) delete process.env.INDEXER_RPC_FALLBACK
    else process.env.INDEXER_RPC_FALLBACK = previousFallback
  }
})

test('direct RPC requests rotate across endpoints and retry a failure through aggregate HA', async () => {
  type Client = { id: 'a' | 'b' | 'aggregate' }
  const aggregate: Client = { id: 'aggregate' }
  const rotate = createRpcRequestRotator<Client>([{ id: 'a' }, { id: 'b' }], aggregate)
  const selected: string[] = []

  const results = await Promise.all(
    [0, 1, 2, 3].map(() =>
      rotate(async (client) => {
        selected.push(client.id)
        return client.id
      }),
    ),
  )
  assert.deepEqual(selected, ['a', 'b', 'a', 'b'])
  assert.deepEqual(results, ['a', 'b', 'a', 'b'])

  const attempts: string[] = []
  const fallbackResult = await rotate(async (client) => {
    attempts.push(client.id)
    if (client.id !== 'aggregate') throw new Error('direct endpoint unavailable')
    return 'recovered'
  })
  assert.equal(fallbackResult, 'recovered')
  assert.deepEqual(attempts, ['a', 'aggregate'])
})

test('RPC error redaction removes every configured endpoint', () => {
  const endpoints = ['https://primary.invalid', 'https://primary.invalid/private-token']
  const redacted = redactRpcUrls(
    `failed ${endpoints[1]} then ${endpoints[0]} and normalized https://other.invalid/key`,
    endpoints,
  )
  assert.equal(redacted.includes('private-token'), false)
  assert.equal(redacted.includes('/key'), false)
  assert.equal(redacted, 'failed <rpc> then <rpc> and normalized <rpc>')
})

test('indexer viem client and chain-id guard follow configured CHAIN', () => {
  assert.equal(pc.chain?.id, CHAIN.id)
  assert.equal(pc.chain?.name, CHAIN.name)
  assert.doesNotThrow(() => assertConfiguredChainId(CHAIN.id))

  const otherChainId = CHAIN.id === 56 ? 4663 : 56
  assert.throws(
    () => assertConfiguredChainId(otherChainId),
    (error) =>
      error instanceof RpcChainMismatchError &&
      error.message.includes(`${CHAIN.key}:${CHAIN.id}`) &&
      error.message.includes(String(otherChainId)),
  )
  assert.doesNotThrow(() => assertConfiguredRpcChainIds([CHAIN.id, CHAIN.id]))
  assert.throws(
    () => assertConfiguredRpcChainIds([CHAIN.id, otherChainId]),
    /RPC chain mismatch/,
  )
})

test('default DB path is isolated by configured chain', () => {
  if (process.env.INDEXER_DB) return
  assert.equal(basename(DB_PATH), `index.${CHAIN.key}-${CHAIN.id}.db`)
})

test('legacy adoption requires the exact configured chain token', () => {
  assert.equal(allowLegacyDbAdoption(undefined), false)
  assert.equal(allowLegacyDbAdoption(` ${DB_CHAIN_TOKEN} `), true)
  assert.throws(
    () => allowLegacyDbAdoption(CHAIN.id === 56 ? 'robinhood:4663' : 'bsc:56'),
    /does not match configured chain/,
  )
})

test('BSC does not inherit the Robinhood-only workspace RPC', () => {
  if (CHAIN.key !== 'bsc') return
  const previousRpc = process.env.RPC
  try {
    delete process.env.RPC
    assert.equal(rpcUrl(), PUBLIC_RPC)
  } finally {
    if (previousRpc === undefined) delete process.env.RPC
    else process.env.RPC = previousRpc
  }
})

test('BSC defaults to public endpoints that support historical log reads', () => {
  if (CHAIN.key !== 'bsc') return
  const previousExtraKey = process.env.EXTRA_ALCHEMY_RPC_KEY
  const previousRpc = process.env.RPC
  const previousPrimary = process.env.INDEXER_RPC_PRIMARY
  const previousFallback = process.env.INDEXER_RPC_FALLBACK
  try {
    delete process.env.EXTRA_ALCHEMY_RPC_KEY
    delete process.env.RPC
    delete process.env.INDEXER_RPC_PRIMARY
    delete process.env.INDEXER_RPC_FALLBACK
    assert.deepEqual(rpcUrls(), [...BSC_PUBLIC_INDEXER_RPCS])
    assert.equal(rpcUrls().includes(PUBLIC_RPC), false)
  } finally {
    if (previousExtraKey === undefined) delete process.env.EXTRA_ALCHEMY_RPC_KEY
    else process.env.EXTRA_ALCHEMY_RPC_KEY = previousExtraKey
    if (previousRpc === undefined) delete process.env.RPC
    else process.env.RPC = previousRpc
    if (previousPrimary === undefined) delete process.env.INDEXER_RPC_PRIMARY
    else process.env.INDEXER_RPC_PRIMARY = previousPrimary
    if (previousFallback === undefined) delete process.env.INDEXER_RPC_FALLBACK
    else process.env.INDEXER_RPC_FALLBACK = previousFallback
  }
})

test('Uniswap v3 backfill start follows the configured deployment', () => {
  assert.equal(UNI_V3_START_BLOCK, CHAIN.id === 56 ? 12_369_621 : 0)
  assert.equal(INDEXER_FINALITY_BLOCKS, CHAIN.id === 56 ? 20 : 12)
})
