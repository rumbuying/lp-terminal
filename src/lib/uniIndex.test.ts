import assert from 'node:assert/strict'
import test from 'node:test'
import { getAddress, zeroAddress } from 'viem'
import { CHAIN_ID } from '../config/addresses'
import { CHAIN, CHAINS } from '../config/chains'
import {
  canUseUniV3Fallback,
  catalogMatchesChain,
  fetchUniIndex,
  fetchUniV4Index,
  mergeUniIndexPages,
} from './uniIndex'

const POOL1 = '0x0000000000000000000000000000000000000011'
const POOL2 = '0x0000000000000000000000000000000000000012'
const POOL3 = '0x0000000000000000000000000000000000000013'
const TOKEN0 = '0x00000000000000000000000000000000000000a1'
const TOKEN1 = '0x00000000000000000000000000000000000000b1'
const CURSOR = '0x0000000000000000000000000000000000000009'
const NEXT_CURSOR = '0x000000000000000000000000000000000000000a'
const VERIFIED_TOKENS = {
  [TOKEN0]: {
    address: TOKEN0,
    symbol: 'AAA',
    decimals: 18,
    metaOk: true,
    priceUsd: 1,
  },
  [TOKEN1]: {
    address: TOKEN1,
    symbol: 'BBB',
    decimals: 6,
    metaOk: true,
    priceUsd: 2,
  },
}

test('index client forwards the stable cursor and maps response pagination', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  let requested = ''
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://terminal.example' },
  })
  globalThis.fetch = (async (input) => {
    requested = String(input)
    return new Response(
      JSON.stringify({
        ready: true,
        chainId: CHAIN_ID,
        chain: { key: CHAIN.key, id: CHAIN_ID },
        totals: { univ2: 20, univ3: 30, pancakev2: 40, pancakev3: 50 },
        count: 7,
        nextCursor: NEXT_CURSOR,
        pools: [
          {
            proto: 'univ2',
            address: POOL1,
            token0: TOKEN0,
            token1: TOKEN1,
            feePpm: 3000,
            tickSpacing: null,
            sqrtPriceX96: null,
            tick: null,
            liquidity: null,
            reserve0: '5',
            reserve1: '6',
            totalSupply: '7',
            stateReady: true,
            tvlUsd: 123,
            vol24hUsd: 45,
            txns24h: 6,
            gtLiqUsd: 120,
            statsSource: 'geckoterminal',
          },
        ],
        tokens: VERIFIED_TOKENS,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch

  try {
    const page = await fetchUniIndex(' AAA/BBB ', 1_000, 'univ2', 2, CURSOR)
    assert.ok(page)
    const url = new URL(requested)
    assert.equal(url.origin, 'https://terminal.example')
    assert.equal(url.searchParams.get('q'), 'AAA/BBB')
    assert.equal(url.searchParams.get('min_tvl'), '1000')
    assert.equal(url.searchParams.get('proto'), 'univ2')
    assert.equal(url.searchParams.get('limit'), '2')
    assert.equal(url.searchParams.get('after'), CURSOR)
    assert.equal(url.searchParams.get('catalog_seq'), null)
    assert.equal(url.searchParams.get('catalog_generation'), null)
    assert.equal(page.nextCursor, NEXT_CURSOR)
    assert.equal(page.catalogSeq, null)
    assert.equal(page.catalogGeneration, null)
    assert.equal(page.total, 7)
    assert.equal(page.indexed, 140)
    assert.equal(page.pools.length, 1)
    assert.equal(page.stats[POOL1].liqUsd, 123)
  } finally {
    globalThis.fetch = originalFetch
    if (originalLocation)
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: originalLocation,
      })
    else Reflect.deleteProperty(globalThis, 'location')
  }
})

test('V2/V3 client carries the fence and safely replaces pages after a 409', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  const requests: URL[] = []
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://terminal.example' },
  })
  const response = (pool: string, catalogSeq: string, catalogGeneration: string) => ({
    ready: true,
    chainId: CHAIN_ID,
    chain: { key: CHAIN.key, id: CHAIN_ID },
    totals: { univ2: 2, univ3: 0, pancakev2: 0, pancakev3: 0 },
    count: 2,
    nextCursor: CURSOR,
    catalogSeq,
    catalogGeneration,
    pools: [
      {
        proto: 'univ2',
        address: pool,
        token0: TOKEN0,
        token1: TOKEN1,
        feePpm: 3000,
        tickSpacing: null,
        sqrtPriceX96: null,
        tick: null,
        liquidity: null,
        reserve0: '5',
        reserve1: '6',
        totalSupply: '7',
        stateReady: true,
        tvlUsd: 1,
        vol24hUsd: 1,
        txns24h: 1,
        gtLiqUsd: 1,
        statsSource: 'chain',
      },
    ],
    tokens: VERIFIED_TOKENS,
  })
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input))
    requests.push(url)
    if (requests.length === 1)
      return new Response(JSON.stringify(response(POOL1, '10', '3')), { status: 200 })
    if (requests.length === 2) return new Response('{"error":"changed"}', { status: 409 })
    return new Response(JSON.stringify(response(POOL2, '11', '4')), { status: 200 })
  }) as typeof fetch

  try {
    const first = await fetchUniIndex('', 0, undefined, 1)
    assert.ok(first)
    assert.equal(first.catalogSeq, '10')
    assert.equal(first.catalogGeneration, '3')
    const restarted = await fetchUniIndex(
      '',
      0,
      undefined,
      1,
      first.nextCursor,
      first.catalogSeq ?? null,
      first.catalogGeneration ?? null,
    )
    assert.ok(restarted)
    assert.equal(requests[1].searchParams.get('after'), CURSOR)
    assert.equal(requests[1].searchParams.get('catalog_seq'), '10')
    assert.equal(requests[1].searchParams.get('catalog_generation'), '3')
    assert.equal(requests[2].searchParams.get('after'), null)
    assert.equal(requests[2].searchParams.get('catalog_seq'), null)

    const merged = mergeUniIndexPages([first, restarted])
    assert.deepEqual(merged.pools.map((pool) => pool.address), [getAddress(POOL2)])
    assert.equal(merged.catalogSeq, '11')
    assert.equal(merged.catalogGeneration, '4')
  } finally {
    globalThis.fetch = originalFetch
    if (originalLocation)
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: originalLocation,
      })
    else Reflect.deleteProperty(globalThis, 'location')
  }
})

test('index client maps Pancake V2/V3 rows onto the executable home venue', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  let requested = ''
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://terminal.example' },
  })
  globalThis.fetch = (async (input) => {
    requested = String(input)
    return new Response(
      JSON.stringify({
        ready: true,
        chainId: CHAIN_ID,
        chain: { key: CHAIN.key, id: CHAIN_ID },
        totals: { univ2: 20, univ3: 30, pancakev2: 40, pancakev3: 50 },
        count: 2,
        nextCursor: null,
        pools: [
          {
            proto: 'pancakev2',
            address: POOL2,
            token0: TOKEN0,
            token1: TOKEN1,
            feePpm: 2500,
            tickSpacing: null,
            sqrtPriceX96: null,
            tick: null,
            liquidity: null,
            reserve0: '5',
            reserve1: '6',
            totalSupply: '7',
            stateReady: true,
            tvlUsd: 10,
            vol24hUsd: 1,
            txns24h: 1,
            gtLiqUsd: 9,
            statsSource: 'chain',
          },
          {
            proto: 'pancakev3',
            address: POOL3,
            token0: TOKEN0,
            token1: TOKEN1,
            feePpm: 500,
            tickSpacing: 10,
            sqrtPriceX96: '2',
            tick: 1,
            liquidity: '8',
            reserve0: '0',
            reserve1: '0',
            totalSupply: null,
            stateReady: true,
            tvlUsd: 20,
            vol24hUsd: 2,
            txns24h: 2,
            gtLiqUsd: 19,
            statsSource: 'chain',
          },
        ],
        tokens: VERIFIED_TOKENS,
      }),
      { status: 200 },
    )
  }) as typeof fetch

  try {
    const page = await fetchUniIndex('', 0, 'pancakev2,pancakev3')
    assert.ok(page)
    assert.equal(new URL(requested).searchParams.get('proto'), 'pancakev2,pancakev3')
    assert.equal(page.indexed, 140)
    assert.equal(page.pools.length, 2)
    const [v2, v3] = page.pools
    assert.equal(v2.kind, 'v2')
    assert.equal(v2.protocol, 'home')
    if (v2.kind === 'v2') assert.equal(v2.feeBps, 25)
    assert.equal(v3.kind, 'cl')
    assert.equal(v3.protocol, 'home')
    if (v3.kind === 'cl') {
      assert.equal(v3.feePpm, 500)
      assert.equal(v3.tickSpacing, 10)
    }
  } finally {
    globalThis.fetch = originalFetch
    if (originalLocation)
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: originalLocation,
      })
    else Reflect.deleteProperty(globalThis, 'location')
  }
})

test('exact-address unswept Pancake V2 remains counted and pageable but is not actionable', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  let requested = ''
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://terminal.example' },
  })
  globalThis.fetch = (async (input) => {
    requested = String(input)
    return new Response(
      JSON.stringify({
        ready: true,
        chainId: CHAIN_ID,
        chain: { key: CHAIN.key, id: CHAIN_ID },
        totals: { univ2: 0, univ3: 0, pancakev2: 1, pancakev3: 0 },
        count: 1,
        nextCursor: NEXT_CURSOR,
        pools: [
          {
            proto: 'pancakev2',
            address: POOL2,
            token0: TOKEN0,
            token1: TOKEN1,
            feePpm: 2500,
            tickSpacing: null,
            sqrtPriceX96: null,
            tick: null,
            liquidity: null,
            reserve0: '0',
            reserve1: '0',
            totalSupply: null,
            stateReady: false,
            tvlUsd: null,
            vol24hUsd: null,
            txns24h: null,
            gtLiqUsd: null,
            statsSource: null,
          },
        ],
        tokens: VERIFIED_TOKENS,
      }),
      { status: 200 },
    )
  }) as typeof fetch

  try {
    const page = await fetchUniIndex(POOL2, 0, 'pancakev2', 1)
    assert.ok(page)
    assert.equal(new URL(requested).searchParams.get('q'), POOL2)
    assert.deepEqual(page.pools, [])
    assert.deepEqual(page.stats, {})
    assert.equal(page.total, 1)
    assert.equal(page.indexed, 1)
    assert.equal(page.nextCursor, NEXT_CURSOR)
    assert.deepEqual(Object.keys(page.tokens).sort(), [TOKEN0, TOKEN1])
  } finally {
    globalThis.fetch = originalFetch
    if (originalLocation)
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: originalLocation,
      })
    else Reflect.deleteProperty(globalThis, 'location')
  }
})

test('state-complete pools still require chain-verified decimals for both tokens', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://terminal.example' },
  })
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        ready: true,
        chainId: CHAIN_ID,
        chain: { key: CHAIN.key, id: CHAIN_ID },
        totals: { univ2: 0, univ3: 0, pancakev2: 1, pancakev3: 0 },
        count: 1,
        nextCursor: null,
        pools: [
          {
            proto: 'pancakev2',
            address: POOL2,
            token0: TOKEN0,
            token1: TOKEN1,
            feePpm: 2500,
            tickSpacing: null,
            sqrtPriceX96: null,
            tick: null,
            liquidity: null,
            reserve0: '5',
            reserve1: '6',
            totalSupply: '7',
            stateReady: true,
            tvlUsd: 10,
            vol24hUsd: 1,
            txns24h: 1,
            gtLiqUsd: 9,
            statsSource: 'chain',
          },
        ],
        tokens: {
          ...VERIFIED_TOKENS,
          [TOKEN1]: { ...VERIFIED_TOKENS[TOKEN1], metaOk: false },
        },
      }),
      { status: 200 },
    )) as typeof fetch

  try {
    const page = await fetchUniIndex(POOL2, 0, 'pancakev2')
    assert.ok(page)
    assert.deepEqual(page.pools, [])
    assert.equal(page.total, 1)
    assert.equal(page.indexed, 1)
    assert.deepEqual(Object.keys(page.tokens), [TOKEN0])
  } finally {
    globalThis.fetch = originalFetch
    if (originalLocation)
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: originalLocation,
      })
    else Reflect.deleteProperty(globalThis, 'location')
  }
})

test('protocol-scoped index responses reject ignored filters and fallback only where truthful', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  let requestCount = 0
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://terminal.example' },
  })
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        ready: true,
        chainId: CHAIN_ID,
        chain: { key: CHAIN.key, id: CHAIN_ID },
        // First call is the legacy two-family capability; the second simulates
        // a unified indexer returning a row outside proto=pancakev2.
        totals:
          requestCount++ === 0
            ? { univ2: 1, univ3: 1 }
            : { univ2: 1, univ3: 1, pancakev2: 0, pancakev3: 0 },
        count: 1,
        nextCursor: null,
        pools: [
          {
            proto: 'univ3',
            address: POOL1,
            token0: TOKEN0,
            token1: TOKEN1,
            feePpm: 3000,
            tickSpacing: 60,
            sqrtPriceX96: '1',
            tick: 0,
            liquidity: '1',
            reserve0: '0',
            reserve1: '0',
            totalSupply: null,
            tvlUsd: 1,
            vol24hUsd: 1,
            txns24h: 1,
            gtLiqUsd: 1,
            statsSource: 'chain',
          },
        ],
        tokens: {},
      }),
      { status: 200 },
    )) as typeof fetch

  try {
    assert.equal(await fetchUniIndex('', 0), null)
    assert.equal(await fetchUniIndex('', 0, 'pancakev2'), null)
    assert.equal(canUseUniV3Fallback(undefined), true)
    assert.equal(canUseUniV3Fallback('univ3'), true)
    assert.equal(canUseUniV3Fallback('univ2'), false)
    assert.equal(canUseUniV3Fallback('pancakev2'), false)
    assert.equal(canUseUniV3Fallback('pancakev2,pancakev3'), false)
    assert.equal(canUseUniV3Fallback('univ3,pancakev3'), CHAIN.id === 56)
  } finally {
    globalThis.fetch = originalFetch
    if (originalLocation)
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: originalLocation,
      })
    else Reflect.deleteProperty(globalThis, 'location')
  }
})

test('index page merge de-duplicates landing-page overlap without losing its order', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://terminal.example' },
  })
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        ready: true,
        chainId: CHAIN_ID,
        chain: { key: CHAIN.key, id: CHAIN_ID },
        totals: { univ2: 2, univ3: 0, pancakev2: 0, pancakev3: 0 },
        count: 2,
        nextCursor: CURSOR,
        pools: [
          {
            proto: 'univ2',
            address: POOL1,
            token0: TOKEN0,
            token1: TOKEN1,
            feePpm: 3000,
            tickSpacing: null,
            sqrtPriceX96: null,
            tick: null,
            liquidity: null,
            reserve0: '1',
            reserve1: '2',
            totalSupply: '3',
            stateReady: true,
            tvlUsd: 10,
            vol24hUsd: 1,
            txns24h: 1,
            gtLiqUsd: 9,
            statsSource: 'chain',
          },
        ],
        tokens: VERIFIED_TOKENS,
      }),
      { status: 200 },
    )) as typeof fetch

  try {
    const first = await fetchUniIndex('', 0)
    assert.ok(first)
    const original = first.pools[0]
    assert.equal(original.kind, 'v2')
    const secondPool = {
      ...original,
      address: getAddress(POOL2),
      reserve0: 8n,
    }
    const duplicate = { ...original, reserve0: 9n }
    const merged = mergeUniIndexPages([
      first,
      {
        ...first,
        pools: [duplicate, secondPool],
        stats: {
          ...first.stats,
          [POOL2]: { liqUsd: 20, vol24hUsd: 2, source: 'chain' },
        },
        total: 999,
        indexed: 999,
        nextCursor: null,
      },
    ])
    assert.deepEqual(
      merged.pools.map((pool) => pool.address),
      [getAddress(POOL1), getAddress(POOL2)],
    )
    assert.equal(merged.pools[0].kind, 'v2')
    if (merged.pools[0].kind === 'v2') assert.equal(merged.pools[0].reserve0, 9n)
    assert.equal(merged.nextCursor, null)
    assert.equal(merged.total, 2)
    assert.equal(merged.indexed, 2)
  } finally {
    globalThis.fetch = originalFetch
    if (originalLocation)
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: originalLocation,
      })
    else Reflect.deleteProperty(globalThis, 'location')
  }
})

test('index client rejects a response whose structured chain key is wrong', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://terminal.example' },
  })
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        ready: true,
        chainId: CHAIN_ID,
        chain: { key: 'wrong', id: CHAIN_ID },
        totals: {},
        count: 0,
        nextCursor: null,
        pools: [],
        tokens: {},
      }),
      { status: 200 },
    )) as typeof fetch

  try {
    assert.equal(await fetchUniIndex('', 0), null)
  } finally {
    globalThis.fetch = originalFetch
    if (originalLocation)
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: originalLocation,
      })
    else Reflect.deleteProperty(globalThis, 'location')
  }
})

const [a, b] = Object.values(CHAINS).map((c) => c.id)

// The indexer's catalog has no chain column — one instance serves one chain —
// so a wrong-chain answer is a perfectly well-formed pool list of pools that do
// not exist where the wallet is. Addresses are the one thing the caller cannot
// check for itself, which is why the response has to say which chain it is about.
test('a catalog about another chain is refused', () => {
  assert.equal(catalogMatchesChain(a, a), true)
  assert.equal(catalogMatchesChain(a, b), false)
  assert.equal(catalogMatchesChain(b, a), false)
})

test('a catalog without chain identity is refused', () => {
  assert.equal(catalogMatchesChain(undefined, a), false)
})

// A falsy-check would wave through a catalog claiming chain 0.
test('invalid numeric identities are refused too', () => {
  assert.equal(catalogMatchesChain(0, a), false)
  assert.equal(catalogMatchesChain(NaN, a), false)
})

const onlyV4 = { skip: CHAIN.uniV4 === null }
const V4_POOL1 = `0x${'11'.repeat(32)}`
const V4_POOL2 = `0x${'22'.repeat(32)}`
const V4_CURSOR = `0x${'09'.repeat(32)}`
const V4_NEXT = `0x${'0a'.repeat(32)}`
const V4_GENERATION = `0x${'ab'.repeat(32)}`

function v4Api(overrides: Record<string, unknown> = {}) {
  return {
    ready: true,
    chainId: CHAIN_ID,
    chain: { key: CHAIN.key, id: CHAIN_ID },
    catalogs: { univ4: { ready: true } },
    totals: { univ4: 162_206 },
    count: 2,
    nextCursor: null,
    subgraphBlock: 12_345,
    catalogBlock: 12_400,
    catalogGeneration: V4_GENERATION,
    pools: [],
    tokens: {},
    ...overrides,
  }
}

async function withIndexResponses<T>(payloads: unknown[], run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://terminal.example' },
  })
  let i = 0
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payloads[i++] ?? payloads.at(-1)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
    if (originalLocation)
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: originalLocation,
      })
    else Reflect.deleteProperty(globalThis, 'location')
  }
}

test(
  'v4 capability distinguishes old/unavailable, warming, and authoritative empty catalogs',
  onlyV4,
  async () => {
    const unavailable = v4Api()
    Reflect.deleteProperty(unavailable, 'catalogs')
    const unfenced = v4Api()
    Reflect.deleteProperty(unfenced, 'catalogBlock')
    const ungenerated = v4Api()
    Reflect.deleteProperty(ungenerated, 'catalogGeneration')
    await withIndexResponses(
      [
        unavailable,
        unfenced,
        ungenerated,
        v4Api({ catalogs: { univ4: { ready: false } } }),
        v4Api(),
      ],
      async () => {
        assert.deepEqual(await fetchUniV4Index(''), { status: 'unavailable' })
        assert.deepEqual(await fetchUniV4Index(''), { status: 'unavailable' })
        assert.deepEqual(await fetchUniV4Index(''), { status: 'unavailable' })
        assert.deepEqual(await fetchUniV4Index(''), { status: 'warming' })
        const empty = await fetchUniV4Index('')
        assert.equal(empty.status, 'ready')
        if (empty.status === 'ready') {
          assert.deepEqual(empty.data.rows, [])
          assert.equal(empty.data.indexed, 162_206)
        }
      },
    )
  },
)

test(
  'v4 index pages keep PoolIds distinct, force native metadata, and reject a foreign manager',
  onlyV4,
  async () => {
    const manager = CHAIN.uniV4!.POOL_MANAGER
    const token1 = TOKEN1
    const rawDays = [
      { date: -1, volume0: '1', volume1: '2' },
      { date: 100, volume0: '-1', volume1: '3' },
      ...Array.from({ length: 10 }, (_, i) => ({
        date: 200 + i,
        volume0: String(i),
        volume1: String(i + 1),
      })),
    ]
    const row = (poolId: string, address = manager, withStats = true) => ({
      proto: 'univ4',
      address,
      poolId,
      token0: zeroAddress,
      token1,
      tickSpacing: 10,
      hooks: zeroAddress,
      rawTvl0: withStats ? '10' : null,
      rawTvl1: withStats ? '6000' : null,
      rawDays: withStats ? rawDays : [],
    })
    let requested = ''
    const originalFetch = globalThis.fetch
    const originalLocation = globalThis.location
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { origin: 'https://terminal.example' },
    })
    globalThis.fetch = (async (input) => {
      requested = String(input)
      return new Response(
        JSON.stringify(
          v4Api({
            nextCursor: V4_NEXT,
            pools: [
              row(V4_POOL1),
              row(V4_POOL2, manager, false),
              row(`0x${'33'.repeat(32)}`, POOL1),
            ],
            tokens: {
              [zeroAddress]: {
                address: zeroAddress,
                symbol: 'FAKE',
                decimals: 6,
                priceUsd: 99,
              },
              [token1]: {
                address: token1,
                symbol: 'USDT',
                decimals: 18,
                priceUsd: 1,
              },
            },
          }),
        ),
        { status: 200 },
      )
    }) as typeof fetch
    try {
      const result = await fetchUniV4Index(' BNB/USDT ', 2, V4_CURSOR, 12_400, V4_GENERATION)
      assert.equal(result.status, 'ready')
      if (result.status !== 'ready') return
      const url = new URL(requested)
      assert.equal(url.searchParams.get('proto'), 'univ4')
      assert.equal(url.searchParams.get('q'), 'BNB/USDT')
      assert.equal(url.searchParams.get('after'), V4_CURSOR)
      assert.equal(url.searchParams.get('catalog_block'), '12400')
      assert.equal(url.searchParams.get('catalog_generation'), V4_GENERATION)
      assert.deepEqual(
        result.data.rows.map((r) => r.poolId),
        [V4_POOL1, V4_POOL2],
      )
      assert.ok(result.data.rows.every((r) => r.address === getAddress(manager)))
      assert.equal(result.data.nextCursor, V4_NEXT)
      assert.equal(result.data.catalogBlock, 12_400)
      assert.equal(result.data.catalogGeneration, V4_GENERATION)
      assert.deepEqual(result.data.tokens[zeroAddress], {
        address: zeroAddress,
        symbol: CHAIN.nativeCurrency.symbol,
        decimals: CHAIN.nativeCurrency.decimals,
        native: true,
      })
      assert.equal(result.data.rawStats[V4_POOL1].days.length, 7)
      assert.equal(result.data.rawStats[V4_POOL1].days[0].volume0, null)
      assert.equal(result.data.rawStats[V4_POOL2], undefined, 'absent stats must not become zero')
    } finally {
      globalThis.fetch = originalFetch
      if (originalLocation)
        Object.defineProperty(globalThis, 'location', {
          configurable: true,
          value: originalLocation,
        })
      else Reflect.deleteProperty(globalThis, 'location')
    }
  },
)

test('v4 cursor accepts only a strictly advancing bytes32 PoolId', onlyV4, async () => {
  await withIndexResponses(
    [
      v4Api({ nextCursor: NEXT_CURSOR }),
      v4Api({ nextCursor: V4_CURSOR }),
      v4Api({ nextCursor: `0x${'08'.repeat(32)}` }),
    ],
    async () => {
      const short = await fetchUniV4Index('', 1, V4_CURSOR)
      const equal = await fetchUniV4Index('', 1, V4_CURSOR)
      const backward = await fetchUniV4Index('', 1, V4_CURSOR)
      assert.equal(short.status === 'ready' ? short.data.nextCursor : 'bad', null)
      assert.equal(equal.status === 'ready' ? equal.data.nextCursor : 'bad', null)
      assert.equal(backward.status === 'ready' ? backward.data.nextCursor : 'bad', null)
    },
  )
})
