import assert from 'node:assert/strict'
import test from 'node:test'
import { zeroAddress, type Address, type Hex } from 'viem'
import { ADDR } from '../config/addresses'
import { CHAIN } from '../config/chains'
import type { McRes } from './multicall'
import { V4_DYNAMIC_FEE_FLAG, v4PoolId, type V4PoolKey } from './uniV4'
import {
  fetchV4GraphPoolCatalog,
  fetchV4PoolCatalog,
  mergeV4CatalogPages,
  resetV4PoolCatalogCache,
  V4IndexerWarmingError,
  v4PoolSearchSpec,
  v4PoolStats,
  v4PoolsFromGraphRows,
  v4PoolsFromIndexRows,
  type UniV4PoolCatalog,
  type V4GraphPool,
} from './uniV4Pools'
import type { UniV4IndexRow } from './uniIndex'

const onlyBsc = { skip: CHAIN.key !== 'bsc' }
const V4_GENERATION = `0x${'ab'.repeat(32)}` as Hex

const success = (result: unknown): McRes => ({ status: 'success', result })
const failure = (): McRes => ({ status: 'failure' })

type TestContract = { address: Address; functionName: string }

function catalogClient(
  state: (contracts: readonly TestContract[]) => McRes[],
  metadata: (contracts: readonly TestContract[]) => McRes[] = (contracts) =>
    contracts.map((contract) =>
      contract.functionName === 'decimals'
        ? success(18)
        : success(contract.address.toLowerCase() === ADDR.STABLE.toLowerCase() ? 'USDT' : 'TOKEN'),
    ),
) {
  return {
    multicall: async ({ contracts }: { contracts: readonly TestContract[] }) =>
      contracts.some((contract) => contract.functionName === 'getSlot0')
        ? state(contracts)
        : metadata(contracts),
  }
}

function row(key: V4PoolKey, overrides: Partial<V4GraphPool> = {}): V4GraphPool {
  const today = Math.floor(Date.now() / 86_400_000) * 86_400
  return {
    id: v4PoolId(key),
    token0: {
      id: key.currency0,
      symbol: key.currency0 === zeroAddress ? 'BNB' : 'TOKEN0',
      decimals: '18',
    },
    token1: { id: key.currency1, symbol: 'USDT', decimals: '18' },
    tickSpacing: String(key.tickSpacing),
    hooks: key.hooks,
    totalValueLockedToken0: '10',
    totalValueLockedToken1: '6000',
    poolDayData: [
      { date: today, volumeToken0: '0.25', volumeToken1: '123' },
      { date: today - 86_400, volumeToken0: '0.10', volumeToken1: '77' },
    ],
    ...overrides,
  }
}

async function withLocation<T>(run: () => Promise<T>): Promise<T> {
  const originalLocation = globalThis.location
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://terminal.example' },
  })
  try {
    return await run()
  } finally {
    if (originalLocation) Object.defineProperty(globalThis, 'location', { configurable: true, value: originalLocation })
    else Reflect.deleteProperty(globalThis, 'location')
  }
}

test('v4 catalog search distinguishes pool ids, token addresses, pairs and symbols', () => {
  assert.deepEqual(v4PoolSearchSpec(''), { kind: 'front', terms: [] })
  assert.deepEqual(v4PoolSearchSpec('*'), { kind: 'all', terms: [] })
  assert.deepEqual(v4PoolSearchSpec(`0x${'11'.repeat(32)}`), {
    kind: 'pool',
    terms: [`0x${'11'.repeat(32)}`],
  })
  assert.deepEqual(v4PoolSearchSpec(`0x${'22'.repeat(20)}`), {
    kind: 'token',
    terms: [`0x${'22'.repeat(20)}`],
  })
  assert.deepEqual(v4PoolSearchSpec(' BNB / USDT '), { kind: 'pair', terms: ['bnb', 'usdt'] })
  assert.deepEqual(v4PoolSearchSpec('usd'), { kind: 'symbol', terms: ['usd'] })
})

test('a live BNB/USDT row round-trips to its exact static PoolKey', onlyBsc, () => {
  const key: V4PoolKey = {
    currency0: zeroAddress,
    currency1: ADDR.STABLE,
    fee: 500,
    tickSpacing: 10,
    hooks: zeroAddress,
  }
  const livePoolId = '0xa77d89e40ddd6a57b72ad4a8c55554b2fd6171026c903462a9f9c7be133811a6' as Hex
  assert.equal(v4PoolId(key).toLowerCase(), livePoolId)

  const mapped = v4PoolsFromGraphRows(
    [row(key, { id: livePoolId })],
    [success([1n << 96n, 123, 0, 500] as const), success(9_000_000n)],
  )
  assert.equal(mapped.pools.length, 1)
  assert.equal(mapped.pools[0].poolId, livePoolId)
  assert.equal(mapped.pools[0].feePpm, 500, 'PoolKey fee must stay executable')
  assert.equal(mapped.pools[0].lpFeePpm, 500, 'live LP fee is separate display/APR state')
  assert.equal(mapped.tokens[zeroAddress].native, true)
  assert.equal(mapped.tokens[zeroAddress].symbol, 'BNB')
})

test('dynamic pools retain the key flag while exposing their current LP fee', onlyBsc, () => {
  const key: V4PoolKey = {
    currency0: zeroAddress,
    currency1: ADDR.STABLE,
    fee: V4_DYNAMIC_FEE_FLAG,
    tickSpacing: 60,
    hooks: zeroAddress,
  }
  const mapped = v4PoolsFromGraphRows(
    [row(key)],
    [success([1n << 96n, -42, 0, 3_000] as const), success(1_000n)],
  )
  assert.equal(mapped.pools.length, 1)
  assert.equal(mapped.pools[0].feePpm, V4_DYNAMIC_FEE_FLAG)
  assert.equal(mapped.pools[0].lpFeePpm, 3_000)
})

test('index rows become executable only after aligned StateView and PoolId/PoolKey proof', onlyBsc, () => {
  const key: V4PoolKey = {
    currency0: zeroAddress,
    currency1: ADDR.STABLE,
    fee: 500,
    tickSpacing: 10,
    hooks: zeroAddress,
  }
  const valid: UniV4IndexRow = {
    address: CHAIN.uniV4!.POOL_MANAGER,
    poolId: v4PoolId(key),
    token0: key.currency0,
    token1: key.currency1,
    tickSpacing: key.tickSpacing,
    hooks: key.hooks,
  }
  const invalid = { ...valid, poolId: `0x${'44'.repeat(32)}` as Hex }
  const pools = v4PoolsFromIndexRows(
    [invalid, valid],
    [
      success([1n << 96n, 1, 0, 500] as const), success(10n),
      success([1n << 96n, 2, 0, 500] as const), success(20n),
    ],
  )
  assert.equal(pools.length, 1)
  assert.equal(pools[0].poolId, valid.poolId)
  assert.equal(pools[0].tick, 2, 'dropping row zero must not shift row one state')
  assert.equal(pools[0].liquidity, 20n)
})

test('catalog page merge keeps one source and one finalized index block', onlyBsc, () => {
  const baseKey: V4PoolKey = {
    currency0: zeroAddress,
    currency1: ADDR.STABLE,
    fee: 500,
    tickSpacing: 10,
    hooks: zeroAddress,
  }
  const keys = [baseKey, { ...baseKey, tickSpacing: 11 }]
  const pools = keys.flatMap((key, i) => v4PoolsFromIndexRows([{
    address: CHAIN.uniV4!.POOL_MANAGER,
    poolId: v4PoolId(key),
    token0: key.currency0,
    token1: key.currency1,
    tickSpacing: key.tickSpacing,
    hooks: key.hooks,
  }], [success([1n << 96n, i, 0, 500] as const), success(BigInt(i + 1))]))
  const page = (
    source: 'index' | 'fallback',
    pagePools: typeof pools,
    nextCursor: string | null,
    catalogBlock = source === 'index' ? 2 : null,
    catalogGeneration = source === 'index' ? V4_GENERATION : null,
  ): UniV4PoolCatalog => ({
    pools: pagePools,
    tokens: {},
    rawStats: {},
    stats: {},
    indexed: 2,
    matched: 2,
    capped: nextCursor !== null,
    nextCursor,
    subgraphBlock: 1,
    catalogBlock,
    catalogGeneration,
    source,
  })
  const merged = mergeV4CatalogPages([
    page('index', [pools[0]], pools[0].poolId!),
    page('index', [pools[1]], null),
    page('fallback', [{ ...pools[0], tick: 999 }], null),
    page('index', [{ ...pools[0], tick: 888 }], null, 3),
    page('index', [{ ...pools[0], tick: 777 }], null, 2, `0x${'cd'.repeat(32)}`),
  ])
  assert.ok(merged)
  assert.deepEqual(merged.pools.map((pool) => pool.poolId), pools.map((pool) => pool.poolId))
  assert.equal(merged.pools[0].address, merged.pools[1].address)
  assert.equal(merged.pools[0].tick, 0, 'mixed-source replacement must be ignored')
  assert.equal(merged.catalogBlock, 2)
  assert.equal(merged.catalogGeneration, V4_GENERATION)
  assert.equal(merged.matched, 2, 'index count is exact and must not be summed per page')
})

test('index pages prove pool state and override index decimals without calling native address(0)', onlyBsc, async () => {
  const key: V4PoolKey = {
    currency0: zeroAddress,
    currency1: ADDR.STABLE,
    fee: 500,
    tickSpacing: 10,
    hooks: zeroAddress,
  }
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async (input) => {
    calls++
    assert.match(String(input), /\/api\/pools/)
    return new Response(JSON.stringify({
      ready: true,
      chainId: CHAIN.id,
      chain: { key: CHAIN.key, id: CHAIN.id },
      catalogs: { univ4: { ready: true } },
      totals: { univ4: 162_206 },
      count: 1,
      nextCursor: null,
      subgraphBlock: 123,
      catalogBlock: 130,
      catalogGeneration: V4_GENERATION,
      pools: [{
        proto: 'univ4',
        address: CHAIN.uniV4!.POOL_MANAGER,
        poolId: v4PoolId(key),
        token0: key.currency0,
        token1: key.currency1,
        tickSpacing: key.tickSpacing,
        hooks: key.hooks,
        rawTvl0: '10',
        rawTvl1: '6000',
        rawDays: [],
      }],
      tokens: {
        [zeroAddress]: { address: zeroAddress, symbol: 'BNB', decimals: 18, priceUsd: null },
        [ADDR.STABLE]: { address: ADDR.STABLE, symbol: 'FAKE', decimals: 99, priceUsd: 1 },
      },
    }), { status: 200 })
  }) as typeof fetch
  const metadataContracts: TestContract[] = []
  const pc = catalogClient(
    () => [success([1n << 96n, 7, 0, 500] as const), success(99n)],
    (contracts) => {
      metadataContracts.push(...contracts)
      return contracts.map((contract) =>
        contract.functionName === 'decimals' ? success(6) : success('USDT'),
      )
    },
  )

  resetV4PoolCatalogCache()
  try {
    const result = await withLocation(() => fetchV4PoolCatalog(pc as never, '*', 10))
    assert.equal(calls, 1, 'the browser must not query The Graph when the index page is ready')
    assert.equal(result.source, 'index')
    assert.equal(result.indexed, 162_206)
    assert.equal(result.pools[0].poolId, v4PoolId(key))
    assert.equal(result.pools[0].tick, 7)
    assert.equal(result.pools[0].liquidity, 99n)
    assert.equal(result.tokens[ADDR.STABLE.toLowerCase()].decimals, 6)
    assert.equal(result.tokens[ADDR.STABLE.toLowerCase()].symbol, 'USDT')
    assert.equal(result.tokens[zeroAddress].native, true)
    assert.deepEqual(
      metadataContracts.map((contract) => [contract.address.toLowerCase(), contract.functionName]),
      [
        [ADDR.STABLE.toLowerCase(), 'decimals'],
        [ADDR.STABLE.toLowerCase(), 'symbol'],
      ],
      'native currency must never be sent to ERC-20 metadata calls',
    )
  } finally {
    globalThis.fetch = originalFetch
    resetV4PoolCatalogCache()
  }
})

test('a successful index refresh clears stats for a pool that left the featured set', onlyBsc, async () => {
  const key: V4PoolKey = {
    currency0: zeroAddress,
    currency1: ADDR.STABLE,
    fee: 500,
    tickSpacing: 10,
    hooks: zeroAddress,
  }
  const poolId = v4PoolId(key).toLowerCase()
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    const featured = calls === 1
    return new Response(JSON.stringify({
      ready: true,
      chainId: CHAIN.id,
      chain: { key: CHAIN.key, id: CHAIN.id },
      catalogs: { univ4: { ready: true } },
      totals: { univ4: 1 },
      count: 1,
      nextCursor: null,
      subgraphBlock: 123,
      catalogBlock: 130,
      catalogGeneration: V4_GENERATION,
      pools: [{
        proto: 'univ4',
        address: CHAIN.uniV4!.POOL_MANAGER,
        poolId,
        token0: key.currency0,
        token1: key.currency1,
        tickSpacing: key.tickSpacing,
        hooks: key.hooks,
        rawTvl0: featured ? '10' : null,
        rawTvl1: featured ? '6000' : null,
        rawDays: featured ? [{ date: 100, volume0: '1', volume1: '2' }] : [],
      }],
      tokens: {
        [zeroAddress]: { address: zeroAddress, symbol: 'BNB', decimals: 18, priceUsd: null },
        [ADDR.STABLE]: { address: ADDR.STABLE, symbol: 'USDT', decimals: 18, priceUsd: 1 },
      },
    }), { status: 200 })
  }) as typeof fetch
  const pc = catalogClient(() => [success([1n << 96n, 7, 0, 500] as const), success(99n)])

  resetV4PoolCatalogCache()
  try {
    const first = await withLocation(() => fetchV4PoolCatalog(pc as never, '*', 10))
    const second = await withLocation(() => fetchV4PoolCatalog(pc as never, '*', 10))
    assert.ok(first.rawStats[poolId])
    assert.equal(second.rawStats[poolId], undefined)
  } finally {
    globalThis.fetch = originalFetch
    resetV4PoolCatalogCache()
  }
})

test('an explicitly warming v4 index is retried by the hook, never bypassed through Graph', onlyBsc, async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return new Response(JSON.stringify({
      ready: false,
      chainId: CHAIN.id,
      chain: { key: CHAIN.key, id: CHAIN.id },
      catalogs: { univ4: { ready: false } },
      totals: { univ4: 0 },
      count: 0,
      nextCursor: null,
      pools: [],
      tokens: {},
    }), { status: 200 })
  }) as typeof fetch

  resetV4PoolCatalogCache()
  try {
    await assert.rejects(
      withLocation(() => fetchV4PoolCatalog({ multicall: async () => [] } as never, '*', 10)),
      V4IndexerWarmingError,
    )
    assert.equal(calls, 1, 'warming must not spend a direct Graph fallback request')
  } finally {
    globalThis.fetch = originalFetch
    resetV4PoolCatalogCache()
  }
})

test('a pre-v4 indexer deliberately falls back to the direct Graph catalog', onlyBsc, async () => {
  const key: V4PoolKey = {
    currency0: zeroAddress,
    currency1: ADDR.STABLE,
    fee: 500,
    tickSpacing: 10,
    hooks: zeroAddress,
  }
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    if (calls === 1) {
      return new Response(JSON.stringify({
        ready: true,
        chainId: CHAIN.id,
        chain: { key: CHAIN.key, id: CHAIN.id },
        totals: { univ2: 1, univ3: 1 },
        count: 0,
        nextCursor: null,
        pools: [],
        tokens: {},
      }), { status: 200 })
    }
    return new Response(JSON.stringify({
      data: {
        _meta: { block: { number: 123 }, hasIndexingErrors: false },
        poolManagers: [{ poolCount: '42' }],
        pools: [row(key)],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const pc = catalogClient(() => [success([1n << 96n, 0, 0, 500] as const), success(1n)])

  resetV4PoolCatalogCache()
  try {
    const result = await withLocation(() => fetchV4PoolCatalog(pc as never, '*', 10))
    assert.equal(calls, 2)
    assert.equal(result.source, 'fallback')
    assert.equal(result.pools[0].poolId, v4PoolId(key))
  } finally {
    globalThis.fetch = originalFetch
    resetV4PoolCatalogCache()
  }
})

test('a graph row that cannot prove its PoolId/PoolKey round trip is dropped', onlyBsc, () => {
  const key: V4PoolKey = {
    currency0: zeroAddress,
    currency1: ADDR.STABLE,
    fee: 500,
    tickSpacing: 10,
    hooks: zeroAddress,
  }
  const mapped = v4PoolsFromGraphRows(
    [row(key, { id: `0x${'11'.repeat(32)}` })],
    [success([1n << 96n, 0, 0, 500] as const), success(1n)],
  )
  assert.deepEqual(mapped.pools, [])
  assert.deepEqual(mapped.tokens, {})
})

test('v4 USD stats use raw trusted sides instead of graph USD fields', onlyBsc, () => {
  const key: V4PoolKey = {
    currency0: zeroAddress,
    currency1: ADDR.STABLE,
    fee: 500,
    tickSpacing: 10,
    hooks: zeroAddress,
  }
  const mapped = v4PoolsFromGraphRows(
    [row(key)],
    [success([1n << 96n, 0, 0, 500] as const), success(1n)],
  )
  const catalog: UniV4PoolCatalog = {
    ...mapped,
    stats: {},
    indexed: 1,
    matched: 1,
    capped: false,
    nextCursor: null,
    subgraphBlock: 1,
    catalogBlock: null,
    catalogGeneration: null,
    source: 'fallback',
  }
  const id = v4PoolId(key).toLowerCase()
  const noon = Math.floor(Date.now() / 86_400_000) * 86_400 + 43_200
  assert.deepEqual(v4PoolStats(catalog, 600, noon)[id], {
    liqUsd: 12_000,
    vol24hUsd: 161.5,
    source: 'subgraph',
  })
})

// The server has to win, because it is the thing doing the RANKING. A page can
// only sort what it was sent, which is how a chip came to narrow one page of
// results instead of the catalog; if the browser then re-derived a different
// depth, the order would no longer match the numbers beside it.
test('the indexer\'s own figures win over the same arithmetic done here', onlyBsc, () => {
  const key: V4PoolKey = {
    currency0: zeroAddress,
    currency1: ADDR.STABLE,
    fee: 500,
    tickSpacing: 10,
    hooks: zeroAddress,
  }
  const mapped = v4PoolsFromGraphRows(
    [row(key)],
    [success([1n << 96n, 0, 0, 500] as const), success(1n)],
  )
  const id = v4PoolId(key).toLowerCase()
  const noon = Math.floor(Date.now() / 86_400_000) * 86_400 + 43_200
  const base = {
    ...mapped,
    indexed: 1,
    matched: 1,
    capped: false,
    nextCursor: null,
    subgraphBlock: 1,
    catalogBlock: null,
    catalogGeneration: null,
    source: 'index' as const,
  }

  assert.deepEqual(
    v4PoolStats(
      { ...base, stats: { [id]: { liqUsd: 999, vol24hUsd: 42, source: 'geckoterminal' } } },
      600,
      noon,
    )[id],
    { liqUsd: 999, vol24hUsd: 42, source: 'geckoterminal' },
  )

  // A partial answer keeps what it has and lets the derivation fill the rest,
  // rather than discarding either one.
  assert.deepEqual(
    v4PoolStats(
      { ...base, stats: { [id]: { liqUsd: 999, vol24hUsd: null, source: 'geckoterminal' } } },
      600,
      noon,
    )[id],
    { liqUsd: 999, vol24hUsd: 161.5, source: 'geckoterminal' },
  )

  // And with no server answer at all — the Graph fallback path — nothing
  // changes from what this function always did.
  assert.deepEqual(v4PoolStats({ ...base, stats: {} }, 600, noon)[id], {
    liqUsd: 12_000,
    vol24hUsd: 161.5,
    source: 'subgraph',
  })
})

test('unpriced token sides cannot manufacture USD TVL', () => {
  const unknown0 = '0x0000000000000000000000000000000000000001' as Address
  const unknown1 = '0x0000000000000000000000000000000000000002' as Address
  const id = `0x${'33'.repeat(32)}` as Hex
  const catalog: UniV4PoolCatalog = {
    pools: [
      {
        kind: 'cl',
        protocol: 'univ4',
        address: unknown0,
        poolId: id,
        hooks: zeroAddress,
        token0: unknown0,
        token1: unknown1,
        tickSpacing: 10,
        feePpm: 500,
        unstakedFeePpm: 0,
        sqrtPriceX96: 1n << 96n,
        tick: 0,
        liquidity: 1n,
        stakedLiquidity: 0n,
        gauge: null,
        gaugeAlive: false,
        weight: 0n,
        rewardRate: 0n,
        periodFinish: 0n,
      },
    ],
    tokens: {},
    rawStats: { [id]: { tvl0: 1_000_000, tvl1: 1_000_000, days: [] } },
    stats: {},
    indexed: 1,
    matched: 1,
    capped: false,
    nextCursor: null,
    subgraphBlock: 1,
    catalogBlock: null,
    catalogGeneration: null,
    source: 'fallback',
  }
  assert.deepEqual(v4PoolStats(catalog, 600)[id], {
    liqUsd: null,
    vol24hUsd: null,
    source: 'subgraph',
  })
})

test('catalog calls collapse in flight and reuse the metered-query cache', onlyBsc, async () => {
  const key: V4PoolKey = {
    currency0: zeroAddress,
    currency1: ADDR.STABLE,
    fee: 500,
    tickSpacing: 10,
    hooks: zeroAddress,
  }
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  let multicallCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls++
    return new Response(
      JSON.stringify({
        data: {
          _meta: { block: { number: 123 }, hasIndexingErrors: false },
          poolManagers: [{ poolCount: '42' }],
          pools: [row(key)],
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch
  let metadataCalls = 0
  const pc = catalogClient(
    () => {
      multicallCalls++
      return [success([1n << 96n, 0, 0, 500] as const), success(1n)]
    },
    (contracts) => {
      metadataCalls++
      return contracts.map((contract) =>
        contract.functionName === 'decimals' ? success(18) : success('USDT'),
      )
    },
  )

  resetV4PoolCatalogCache()
  try {
    const [a, b] = await Promise.all([
      fetchV4GraphPoolCatalog(pc as never, 'cache-test', 10),
      fetchV4GraphPoolCatalog(pc as never, 'cache-test', 10),
    ])
    const c = await fetchV4GraphPoolCatalog(pc as never, 'cache-test', 10)
    assert.equal(a, b)
    assert.equal(c.pools[0].poolId, b.pools[0].poolId)
    assert.equal(fetchCalls, 1)
    assert.equal(multicallCalls, 2, 'cache hits refresh StateView without another Graph request')
    assert.equal(metadataCalls, 2, 'each rendered page rechecks its unique ERC-20 once')
    assert.equal(a.indexed, 42)
    assert.equal(a.pools.length, 1)
  } finally {
    globalThis.fetch = originalFetch
    resetV4PoolCatalogCache()
  }
})

test('pair search uses schema-supported nocase filters for mixed-case symbols', onlyBsc, async () => {
  const token = '0x1111111111111111111111111111111111111111' as Address
  const key: V4PoolKey = {
    currency0: token,
    currency1: ADDR.STABLE,
    fee: 500,
    tickSpacing: 10,
    hooks: zeroAddress,
  }
  const mixed = row(key, {
    token0: { id: token, symbol: 'slisBNB', decimals: '250' },
    token1: { id: ADDR.STABLE, symbol: 'USDT', decimals: '251' },
  })
  const originalFetch = globalThis.fetch
  let request: { query: string; variables: Record<string, unknown> } | undefined
  globalThis.fetch = (async (_input, init) => {
    request = JSON.parse(String(init?.body)) as typeof request
    return new Response(
      JSON.stringify({
        data: {
          _meta: { block: { number: 123 }, hasIndexingErrors: false },
          poolManagers: [{ poolCount: '1' }],
          pools: [mixed],
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch
  const pc = catalogClient(
    () => [success([1n << 96n, 0, 0, 500] as const), success(1n)],
    (contracts) => contracts.map((contract) =>
      contract.functionName === 'decimals'
        ? success(contract.address.toLowerCase() === token.toLowerCase() ? 8 : 6)
        : success(contract.address.toLowerCase() === token.toLowerCase() ? 'slisBNB' : 'USDT'),
    ),
  )

  resetV4PoolCatalogCache()
  try {
    const result = await fetchV4GraphPoolCatalog(pc as never, 'slisBNB/USDT', 10)
    assert.equal(result.pools.length, 1)
    assert.equal(result.tokens[token].symbol, 'slisBNB')
    assert.equal(result.tokens[token].decimals, 8)
    assert.equal(result.tokens[ADDR.STABLE.toLowerCase()].decimals, 6)
    assert.match(request?.query ?? '', /symbol_starts_with_nocase/)
    assert.match(request?.query ?? '', /symbol_ends_with_nocase/)
    assert.doesNotMatch(request?.query ?? '', /symbol_in/)
    assert.equal(request?.variables.a, 'slisbnb')
    assert.equal(request?.variables.b, 'usdt')
  } finally {
    globalThis.fetch = originalFetch
    resetV4PoolCatalogCache()
  }
})

test('symbol search includes initialized pools with zero active liquidity', onlyBsc, async () => {
  const key: V4PoolKey = {
    currency0: zeroAddress,
    currency1: ADDR.STABLE,
    fee: 500,
    tickSpacing: 10,
    hooks: zeroAddress,
  }
  const originalFetch = globalThis.fetch
  let query = ''
  globalThis.fetch = (async (_input, init) => {
    query = (JSON.parse(String(init?.body)) as { query: string }).query
    return new Response(
      JSON.stringify({
        data: {
          _meta: { block: { number: 123 }, hasIndexingErrors: false },
          poolManagers: [{ poolCount: '1' }],
          pools: [row(key)],
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch
  const pc = catalogClient(() => [success([1n << 96n, 0, 0, 500] as const), success(0n)])

  resetV4PoolCatalogCache()
  try {
    const result = await fetchV4GraphPoolCatalog(pc as never, 'BNB', 10)
    assert.doesNotMatch(query, /liquidity_gt/)
    assert.equal(result.pools.length, 1)
    assert.equal(result.pools[0].liquidity, 0n)
  } finally {
    globalThis.fetch = originalFetch
    resetV4PoolCatalogCache()
  }
})

test('a per-pool StateView failure is retained and recovered on a cache hit', onlyBsc, async () => {
  const key: V4PoolKey = {
    currency0: zeroAddress,
    currency1: ADDR.STABLE,
    fee: 500,
    tickSpacing: 10,
    hooks: zeroAddress,
  }
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  let multicallCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls++
    return new Response(
      JSON.stringify({
        data: {
          _meta: { block: { number: 123 }, hasIndexingErrors: false },
          poolManagers: [{ poolCount: '1' }],
          pools: [row(key)],
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch
  const pc = catalogClient(() => {
    multicallCalls++
    return multicallCalls === 1
      ? [failure(), success(1n)]
      : [success([1n << 96n, 0, 0, 500] as const), success(1n)]
  })

  resetV4PoolCatalogCache()
  try {
    const first = await fetchV4GraphPoolCatalog(pc as never, 'state-retry', 10)
    assert.equal(first.pools.length, 0)
    const recovered = await fetchV4GraphPoolCatalog(pc as never, 'state-retry', 10)
    assert.equal(recovered.pools.length, 1)
    assert.equal(recovered.pools[0].poolId, v4PoolId(key))
    assert.equal(fetchCalls, 1, 'retrying StateView must reuse the metered Graph row')
    assert.equal(multicallCalls, 2)
  } finally {
    globalThis.fetch = originalFetch
    resetV4PoolCatalogCache()
  }
})

test('failed decimals drops an unproved pool but an RPC-proved last-good value is reusable', onlyBsc, async () => {
  const key: V4PoolKey = {
    currency0: zeroAddress,
    currency1: ADDR.STABLE,
    fee: 500,
    tickSpacing: 10,
    hooks: zeroAddress,
  }
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  let metadataMode: 'fail' | 'good' = 'fail'
  globalThis.fetch = (async () => {
    fetchCalls++
    return new Response(
      JSON.stringify({
        data: {
          _meta: { block: { number: 123 }, hasIndexingErrors: false },
          poolManagers: [{ poolCount: '1' }],
          pools: [row(key, {
            token1: { id: ADDR.STABLE, symbol: 'UNTRUSTED', decimals: '200' },
          })],
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch
  const pc = catalogClient(
    () => [success([1n << 96n, 0, 0, 500] as const), success(1n)],
    (contracts) => contracts.map((contract) => {
      if (contract.functionName === 'decimals')
        return metadataMode === 'good' ? success(6) : failure()
      return success('USDT')
    }),
  )

  resetV4PoolCatalogCache()
  try {
    const unproved = await fetchV4GraphPoolCatalog(pc as never, 'metadata-retry', 10)
    assert.equal(unproved.pools.length, 0)
    assert.equal(unproved.tokens[ADDR.STABLE.toLowerCase()], undefined)

    metadataMode = 'good'
    const proved = await fetchV4GraphPoolCatalog(pc as never, 'metadata-retry', 10)
    assert.equal(proved.pools.length, 1)
    assert.equal(proved.tokens[ADDR.STABLE.toLowerCase()].decimals, 6)

    metadataMode = 'fail'
    const lastGood = await fetchV4GraphPoolCatalog(pc as never, 'metadata-retry', 10)
    assert.equal(lastGood.pools.length, 1)
    assert.equal(lastGood.tokens[ADDR.STABLE.toLowerCase()].decimals, 6)
    assert.equal(lastGood.tokens[ADDR.STABLE.toLowerCase()].symbol, 'USDT')
    assert.equal(fetchCalls, 1, 'metadata retries must reuse the cached directory row')
  } finally {
    globalThis.fetch = originalFetch
    resetV4PoolCatalogCache()
  }
})

test('cursor pages cover the complete index without repeating the boundary row', onlyBsc, async () => {
  const firstKey: V4PoolKey = {
    currency0: zeroAddress,
    currency1: ADDR.STABLE,
    fee: 500,
    tickSpacing: 10,
    hooks: zeroAddress,
  }
  const secondKey: V4PoolKey = { ...firstKey, tickSpacing: 11 }
  const graphRows = [[row(firstKey)], [row(secondKey)], []]
  const afters: unknown[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { variables: { after?: string } }
    afters.push(body.variables.after)
    const pools = graphRows[afters.length - 1] ?? []
    return new Response(
      JSON.stringify({
        data: {
          _meta: { block: { number: 123 }, hasIndexingErrors: false },
          poolManagers: [{ poolCount: '42' }],
          pools,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch
  const pc = catalogClient(() => [success([1n << 96n, 0, 0, 500] as const), success(1n)])

  resetV4PoolCatalogCache()
  try {
    const first = await fetchV4GraphPoolCatalog(pc as never, '*', 1)
    const second = await fetchV4GraphPoolCatalog(pc as never, '*', 1, first.nextCursor)
    const end = await fetchV4GraphPoolCatalog(pc as never, '*', 1, second.nextCursor)
    assert.equal(afters[0], `0x${'0'.repeat(64)}`)
    assert.equal(afters[1], v4PoolId(firstKey).toLowerCase())
    assert.equal(afters[2], v4PoolId(secondKey).toLowerCase())
    assert.equal(first.pools[0].poolId, v4PoolId(firstKey))
    assert.equal(second.pools[0].poolId, v4PoolId(secondKey))
    assert.equal(end.pools.length, 0)
    assert.equal(end.nextCursor, null)
  } finally {
    globalThis.fetch = originalFetch
    resetV4PoolCatalogCache()
  }
})
