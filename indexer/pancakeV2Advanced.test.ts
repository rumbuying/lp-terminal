import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test, { mock } from 'node:test'
import {
  ensurePancakeV2AdvancedSnapshot,
  PancakeV2PageTokenRejectedError,
  PANCAKE_V2_FACTORY_START_BLOCK,
  PANCAKE_V2_PAIR_CREATED_TOPIC,
  PANCAKE_V2_SNAPSHOT_KEYS as KEY,
  PANCAKE_V2_SNAPSHOT_SOURCE,
  type PancakeV2AdvancedRequest,
  type PancakeV2PoolIdentity,
  type PancakeV2SnapshotStorage,
} from './pancakeV2AdvancedCore'

mock.module('./config', {
  namedExports: {
    ADDR: { V2_FACTORY: '0x0000000000000000000000000000000000000001' },
    CHAIN: { id: 56 },
    INDEXER_FINALITY_BLOCKS: 20,
    log: () => undefined,
    rpcUrls: () => [],
    sleep: async () => undefined,
  },
})
mock.module('./rpc', { namedExports: { pc: {} } })
mock.module('./store', {
  namedExports: {
    insertPool: () => true,
    kvGet: () => undefined,
    kvSet: () => undefined,
    tx: (fn: () => void) => fn(),
    pancakeV2CatalogGeneration: () => '0',
    v2PairIndexStats: () => ({ count: 0, min: null, max: null, distinct: 0, missing: 0 }),
    v2PoolIdentity: () => undefined,
  },
})

const {
  createAnkrAdvancedGenerationFetcher,
  createAnkrAdvancedPageFetcher,
  createPancakeV2PublishedSnapshotCache,
  deriveAnkrAdvancedEndpoints,
} = await import('./pancakeV2Advanced')

const FACTORY = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73'
const TARGET_HASH = `0x${'a'.repeat(64)}`
const OTHER_HASH = `0x${'b'.repeat(64)}`

const address = (value: number) => `0x${value.toString(16).padStart(40, '0')}`
const word = (value: string) => value.slice(2).padStart(64, '0')
const integerWord = (value: number) => value.toString(16).padStart(64, '0')

function pairLog(
  ordinal: number,
  overrides: Partial<Record<
    'address' | 'blockHash' | 'blockNumber' | 'transactionHash' |
    'transactionIndex' | 'logIndex' | 'data' | 'removed',
    unknown
  >> = {},
) {
  const token0 = address(100 + ordinal * 2)
  const token1 = address(101 + ordinal * 2)
  const pair = address(1_000 + ordinal)
  return {
    address: FACTORY,
    blockHash: TARGET_HASH,
    blockNumber: `0x${(PANCAKE_V2_FACTORY_START_BLOCK + ordinal).toString(16)}`,
    transactionHash: `0x${ordinal.toString(16).padStart(64, '0')}`,
    transactionIndex: '0x0',
    logIndex: `0x${ordinal.toString(16)}`,
    data: `0x${word(pair)}${integerWord(ordinal)}`,
    removed: false,
    topics: [
      PANCAKE_V2_PAIR_CREATED_TOPIC,
      `0x${word(token0)}`,
      `0x${word(token1)}`,
    ],
    ...overrides,
  }
}

type Stored = PancakeV2PoolIdentity & { added_ts: number }

function storedPair(ordinal: number, addedTs = 0): Stored {
  return {
    address: address(1_000 + ordinal),
    proto: 'pancakev2',
    token0: address(100 + ordinal * 2),
    token1: address(101 + ordinal * 2),
    fee_ppm: 2_500,
    created_block: null,
    pair_index: ordinal - 1,
    added_ts: addedTs,
  }
}

function harness(count = 3) {
  const kv = new Map<string, string>()
  const pools = new Map<string, Stored>()
  let canonicalHash = TARGET_HASH
  let canonicalCount = count
  let head = 200_000_000
  let catalogGeneration = '0'
  const storage: PancakeV2SnapshotStorage = {
    get: (key) => kv.get(key),
    set: (key, value) => void kv.set(key, value),
    transaction: (fn) => {
      const beforeKv = new Map(kv)
      const beforePools = new Map(pools)
      try {
        fn()
      } catch (error) {
        kv.clear()
        for (const [key, value] of beforeKv) kv.set(key, value)
        pools.clear()
        for (const [key, value] of beforePools) pools.set(key, value)
        throw error
      }
    },
    insertPool: (pool) => {
      const key = pool.address.toLowerCase()
      if (pools.has(key)) return false
      if (
        [...pools.values()].some(
          (row) => row.proto === pool.proto && row.pair_index === pool.pairIndex,
        )
      ) {
        return false
      }
      pools.set(key, {
        address: key,
        proto: pool.proto,
        token0: pool.token0.toLowerCase(),
        token1: pool.token1.toLowerCase(),
        fee_ppm: pool.feePpm,
        created_block: pool.createdBlock,
        pair_index: pool.pairIndex,
        added_ts: pool.addedTs,
      })
      return true
    },
    poolIdentity: (pool) => pools.get(pool.toLowerCase()),
    pairIndexStats: () => {
      const rows = [...pools.values()].filter((row) => row.proto === 'pancakev2')
      const indices = rows
        .map((row) => row.pair_index)
        .filter((value): value is number => value !== null)
      return {
        count: rows.length,
        min: indices.length ? Math.min(...indices) : null,
        max: indices.length ? Math.max(...indices) : null,
        distinct: new Set(indices).size,
        missing: rows.length - indices.length,
      }
    },
    catalogGeneration: () => catalogGeneration,
  }
  const chain = {
    getHead: async () => head,
    getBlockHash: async () => canonicalHash,
    getFactoryCount: async () => canonicalCount,
  }
  return {
    kv,
    pools,
    storage,
    chain,
    setHash: (hash: string) => void (canonicalHash = hash),
    setCount: (value: number) => void (canonicalCount = value),
    setHead: (value: number) => void (head = value),
    setGeneration: (value: string) => void (catalogGeneration = value),
    getGeneration: () => catalogGeneration,
  }
}

const options = (
  state: ReturnType<typeof harness>,
  fetchPage: (request: PancakeV2AdvancedRequest) => Promise<unknown>,
) => ({
  factory: FACTORY,
  finalityBlocks: 20,
  pageSize: 2,
  chain: state.chain,
  storage: state.storage,
  fetchPage,
})

test('imports paginated PairCreated logs and atomically publishes pinned provenance', async () => {
  const state = harness()
  const requests: PancakeV2AdvancedRequest[] = []
  const result = await ensurePancakeV2AdvancedSnapshot(
    options(state, async (request) => {
      requests.push(request)
      return request.pageToken
        ? { result: { logs: [pairLog(3)] } }
        : { result: { logs: [pairLog(1), pairLog(2)], nextPageToken: 'page-2' } }
    }),
  )

  assert.equal(result.added, 3)
  assert.equal(result.bootstrapped, true)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].fromBlock, PANCAKE_V2_FACTORY_START_BLOCK)
  assert.equal(requests[0].toBlock, 199_999_980)
  assert.equal(requests[1].pageToken, 'page-2')
  assert.equal(state.kv.get(KEY.source), PANCAKE_V2_SNAPSHOT_SOURCE)
  assert.equal(state.kv.get(KEY.complete), '1')
  assert.equal(state.kv.get(KEY.block), '199999980')
  assert.equal(state.kv.get(KEY.blockHash), TARGET_HASH)
  assert.equal(state.kv.get(KEY.poolCount), '3')
  assert.equal(state.kv.get(KEY.catalogGeneration), '0')
  assert.equal(state.kv.get(KEY.cursor), '3')
  assert.equal(state.kv.get(KEY.factoryCount), '3')
  assert.deepEqual(
    [...state.pools.values()].map(({ pair_index, added_ts }) => ({ pair_index, added_ts })),
    [
      { pair_index: 0, added_ts: 0 },
      { pair_index: 1, added_ts: 0 },
      { pair_index: 2, added_ts: 0 },
    ],
  )
})

test('defaults Ankr requests to the production-probed 5000-log page size', async () => {
  const state = harness(1)
  const configured = options(state, async (request) => {
    assert.equal(request.pageSize, 5_000)
    return { result: { logs: [pairLog(1)] } }
  })
  const { pageSize: _pageSize, ...withoutPageSize } = configured
  await ensurePancakeV2AdvancedSnapshot(withoutPageSize)
})

test('process cache skips repeat core, canonical RPC, and full-table stats validation', async () => {
  const kv = new Map<string, string>([
    [KEY.complete, '1'],
    [KEY.source, PANCAKE_V2_SNAPSHOT_SOURCE],
    [KEY.block, '100'],
    [KEY.blockHash, TARGET_HASH],
    [KEY.poolCount, '3'],
    [KEY.catalogGeneration, '0'],
  ])
  let coreCalls = 0
  let rpcCalls = 0
  let statsCalls = 0
  const limits: number[] = []
  const ensureCached = createPancakeV2PublishedSnapshotCache(
    (key) => kv.get(key),
    () => '0',
    async (freshLimit) => {
      coreCalls++
      rpcCalls++
      statsCalls++
      limits.push(freshLimit)
      kv.set(KEY.complete, '1')
      return {
        added: 0,
        fresh: [],
        snapshotBlock: Number(kv.get(KEY.block)),
        snapshotPoolCount: Number(kv.get(KEY.poolCount)),
        bootstrapped: false,
      }
    },
  )

  await ensureCached(10)
  const second = await ensureCached(20)
  assert.deepEqual(
    { coreCalls, rpcCalls, statsCalls, limits },
    { coreCalls: 1, rpcCalls: 1, statsCalls: 1, limits: [10] },
  )
  assert.equal(second.snapshotBlock, 100)

  kv.set(KEY.block, '101')
  await ensureCached(30)
  await ensureCached(40)
  assert.deepEqual(
    { coreCalls, rpcCalls, statsCalls, limits },
    { coreCalls: 2, rpcCalls: 2, statsCalls: 2, limits: [10, 30] },
  )

  kv.set(KEY.complete, '0')
  await ensureCached(50)
  assert.deepEqual(
    { coreCalls, rpcCalls, statsCalls, limits },
    { coreCalls: 3, rpcCalls: 3, statsCalls: 3, limits: [10, 30, 50] },
  )
})

test('catalog delete or identity-update generation invalidates cache at unchanged snapshot count', async () => {
  const kv = new Map<string, string>([
    [KEY.complete, '1'],
    [KEY.source, PANCAKE_V2_SNAPSHOT_SOURCE],
    [KEY.block, '100'],
    [KEY.blockHash, TARGET_HASH],
    [KEY.poolCount, '3'],
    [KEY.catalogGeneration, '7'],
  ])
  let generation = '7'
  let coreCalls = 0
  const ensureCached = createPancakeV2PublishedSnapshotCache(
    (key) => kv.get(key),
    () => generation,
    async () => {
      coreCalls++
      kv.set(KEY.catalogGeneration, generation)
      return {
        added: 0,
        fresh: [],
        snapshotBlock: 100,
        snapshotPoolCount: 3,
        bootstrapped: false,
      }
    },
  )

  await ensureCached(1)
  await ensureCached(1)
  assert.equal(coreCalls, 1)

  generation = '8' // DELETE/INSERT may keep count stable but changes identity.
  await ensureCached(1)
  assert.equal(coreCalls, 2)

  generation = '9' // An in-place token/pair-index identity UPDATE also invalidates.
  await ensureCached(1)
  assert.equal(coreCalls, 3)
})

test('cache never accepts a generation mutation between core return and cache write', async () => {
  const kv = new Map<string, string>([
    [KEY.complete, '1'],
    [KEY.source, PANCAKE_V2_SNAPSHOT_SOURCE],
    [KEY.block, '100'],
    [KEY.blockHash, TARGET_HASH],
    [KEY.poolCount, '3'],
    [KEY.catalogGeneration, '0'],
  ])
  let generation = '0'
  let coreCalls = 0
  const ensureCached = createPancakeV2PublishedSnapshotCache(
    (key) => kv.get(key),
    () => generation,
    async () => {
      coreCalls++
      if (coreCalls === 1) generation = '1'
      else kv.set(KEY.catalogGeneration, generation)
      return {
        added: 0,
        fresh: [],
        snapshotBlock: 100,
        snapshotPoolCount: 3,
        bootstrapped: false,
      }
    },
  )

  await ensureCached(1)
  await ensureCached(1)
  await ensureCached(1)
  assert.equal(coreCalls, 2)
})

test('publishes over a contiguous RPC tail without lowering its observed factory high-water mark', async () => {
  const state = harness(2)
  for (const ordinal of [1, 2, 3]) {
    const row = storedPair(ordinal, 123)
    state.pools.set(row.address, row)
  }
  state.kv.set(KEY.cursor, '3')
  state.kv.set(KEY.factoryCount, '5')

  const result = await ensurePancakeV2AdvancedSnapshot(
    options(state, async () => ({ result: { logs: [pairLog(1), pairLog(2)] } })),
  )

  assert.equal(result.added, 0)
  assert.equal(state.kv.get(KEY.complete), '1')
  assert.equal(state.kv.get(KEY.poolCount), '2')
  assert.equal(state.kv.get(KEY.cursor), '3')
  assert.equal(state.kv.get(KEY.factoryCount), '5')
  assert.equal(state.kv.get(KEY.importSource), '')
})

test('rejects duplicate, missing, and out-of-order event streams without publishing', async (t) => {
  const cases: Array<[string, unknown[], RegExp]> = [
    ['missing ordinal', [pairLog(2)], /ordinal is not contiguous/],
    ['duplicate ordinal', [pairLog(1), pairLog(1)], /ordinal is not contiguous/],
    [
      'out-of-order chain position',
      [pairLog(1, { blockNumber: '0x64' }), pairLog(2, { blockNumber: '0x63' })],
      /out-of-order/,
    ],
  ]
  for (const [name, logs, expected] of cases) {
    await t.test(name, async () => {
      const state = harness(2)
      await assert.rejects(
        ensurePancakeV2AdvancedSnapshot(
          options(state, async () => ({ result: { logs } })),
        ),
        expected,
      )
      assert.notEqual(state.kv.get(KEY.complete), '1')
      assert.equal(state.pools.size, 0)
    })
  }
})

test('rejects wrong factory, premature end, and a non-canonical token order', async (t) => {
  const badTokens = pairLog(1)
  badTokens.topics[1] = `0x${word(address(9))}`
  badTokens.topics[2] = `0x${word(address(8))}`
  const cases: Array<[string, unknown[], number, RegExp]> = [
    ['wrong factory', [pairLog(1, { address: address(999) })], 1, /wrong.*factory/],
    ['premature end', [pairLog(1)], 2, /ended before/],
    ['token order', [badTokens], 1, /non-canonical/],
  ]
  for (const [name, logs, count, expected] of cases) {
    await t.test(name, async () => {
      const state = harness(count)
      await assert.rejects(
        ensurePancakeV2AdvancedSnapshot(
          options(state, async () => ({ result: { logs } })),
        ),
        expected,
      )
      assert.notEqual(state.kv.get(KEY.complete), '1')
    })
  }
})

test('revalidates the published block hash and count on restart', async () => {
  const state = harness(1)
  const fetchPage = async () => ({ result: { logs: [pairLog(1)] } })
  await ensurePancakeV2AdvancedSnapshot(options(state, fetchPage))
  state.setHash(OTHER_HASH)
  await assert.rejects(
    ensurePancakeV2AdvancedSnapshot(options(state, async () => {
      throw new Error('published snapshots must not download again')
    })),
    /block hash no longer matches/,
  )
  assert.equal(state.kv.get(KEY.complete), '0')
  assert.equal(state.kv.get(KEY.importSource), '')

  const recovered = await ensurePancakeV2AdvancedSnapshot(
    options(state, async () => ({ result: { logs: [pairLog(1)] } })),
  )
  assert.equal(recovered.bootstrapped, true)
  assert.equal(state.kv.get(KEY.complete), '1')
  assert.equal(state.kv.get(KEY.blockHash), OTHER_HASH)
})

test('rejects a published snapshot whose pinned factory count changed', async () => {
  const state = harness(1)
  const fetchPage = async () => ({ result: { logs: [pairLog(1)] } })
  await ensurePancakeV2AdvancedSnapshot(options(state, fetchPage))
  state.setCount(2)
  await assert.rejects(
    ensurePancakeV2AdvancedSnapshot(options(state, fetchPage)),
    /factory count no longer matches/,
  )
  assert.equal(state.kv.get(KEY.complete), '0')
  assert.equal(state.kv.get(KEY.importSource), '')
})

test('repairs incomplete published rows by replaying the same target from page one', async () => {
  const state = harness(2)
  await ensurePancakeV2AdvancedSnapshot(
    options(state, async () => ({ result: { logs: [pairLog(1), pairLog(2)] } })),
  )
  state.pools.delete(address(1_002))
  state.setGeneration('1')

  let unexpectedFetches = 0
  await assert.rejects(
    ensurePancakeV2AdvancedSnapshot(
      options(state, async () => {
        unexpectedFetches++
        throw new Error('row validation must happen before replay')
      }),
    ),
    /catalog generation changed/,
  )
  assert.equal(unexpectedFetches, 0)
  assert.equal(state.kv.get(KEY.complete), '0')
  assert.equal(state.kv.get(KEY.importSource), PANCAKE_V2_SNAPSHOT_SOURCE)
  assert.equal(state.kv.get(KEY.importBlock), '199999980')
  assert.equal(state.kv.get(KEY.importBlockHash), TARGET_HASH)
  assert.equal(state.kv.get(KEY.importPoolCount), '2')
  assert.equal(state.kv.get(KEY.importCatalogGeneration), '1')
  assert.equal(state.kv.get(KEY.importNextIndex), '0')
  assert.equal(state.kv.get(KEY.importPageToken), '')

  const requests: PancakeV2AdvancedRequest[] = []
  const recovered = await ensurePancakeV2AdvancedSnapshot(
    options(state, async (request) => {
      requests.push(request)
      return { result: { logs: [pairLog(1), pairLog(2)] } }
    }),
  )
  assert.equal(recovered.added, 1)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].pageToken, undefined)
  assert.equal(state.pools.size, 2)
  assert.equal(state.kv.get(KEY.complete), '1')
  assert.equal(state.kv.get(KEY.catalogGeneration), '1')
  assert.equal(state.kv.get(KEY.importSource), '')
})

test('persistent generation fence detects same-count identity corruption after restart', async () => {
  const state = harness(1)
  await ensurePancakeV2AdvancedSnapshot(
    options(state, async () => ({ result: { logs: [pairLog(1)] } })),
  )
  const corrupted = state.pools.get(address(1_001))
  assert.ok(corrupted)
  corrupted.token0 = address(999)
  state.setGeneration('1')

  let fetches = 0
  await assert.rejects(
    ensurePancakeV2AdvancedSnapshot(
      options(state, async () => {
        fetches++
        return { result: { logs: [pairLog(1)] } }
      }),
    ),
    /catalog generation changed/,
  )
  assert.equal(fetches, 0)
  assert.equal(state.kv.get(KEY.complete), '0')
  assert.equal(state.kv.get(KEY.catalogGeneration), '0')
  assert.equal(state.kv.get(KEY.importCatalogGeneration), '1')

  await assert.rejects(
    ensurePancakeV2AdvancedSnapshot(
      options(state, async () => ({ result: { logs: [pairLog(1)] } })),
    ),
    /conflicts with the Pancake V2 snapshot/,
  )
  assert.equal(state.kv.get(KEY.complete), '0')
  assert.equal(state.kv.get(KEY.catalogGeneration), '0')
})

test('migrates an incomplete legacy completed checkpoint into a page-one replay', async () => {
  const state = harness(2)
  const first = storedPair(1, 123)
  state.pools.set(first.address, first)
  state.kv.set(KEY.complete, '0')
  state.kv.set(KEY.importSource, PANCAKE_V2_SNAPSHOT_SOURCE)
  state.kv.set(KEY.importBlock, '199999980')
  state.kv.set(KEY.importBlockHash, TARGET_HASH)
  state.kv.set(KEY.importPoolCount, '2')
  state.kv.set(KEY.importCatalogGeneration, '0')
  state.kv.set(KEY.importNextIndex, '2')
  state.kv.set(KEY.importPageToken, '')
  state.kv.set(
    KEY.importLastPosition,
    `${PANCAKE_V2_FACTORY_START_BLOCK + 2}:0:2`,
  )

  const tokens: Array<string | undefined> = []
  const recovered = await ensurePancakeV2AdvancedSnapshot(
    options(state, async (request) => {
      tokens.push(request.pageToken)
      return { result: { logs: [pairLog(1), pairLog(2)] } }
    }),
  )
  assert.deepEqual(tokens, [undefined])
  assert.equal(recovered.added, 1)
  assert.equal(state.pools.size, 2)
  assert.equal(state.kv.get(KEY.complete), '1')
  assert.equal(state.kv.get(KEY.importSource), '')
})

test('does not invalidate a published generation on a transient canonical RPC error', async () => {
  const state = harness(1)
  await ensurePancakeV2AdvancedSnapshot(
    options(state, async () => ({ result: { logs: [pairLog(1)] } })),
  )
  const getBlockHash = state.chain.getBlockHash
  state.chain.getBlockHash = async () => {
    throw new Error('temporary canonical RPC outage')
  }
  let fetches = 0
  await assert.rejects(
    ensurePancakeV2AdvancedSnapshot(
      options(state, async () => {
        fetches++
        return { result: { logs: [] } }
      }),
    ),
    /temporary canonical RPC outage/,
  )
  assert.equal(fetches, 0)
  assert.equal(state.kv.get(KEY.complete), '1')

  state.chain.getBlockHash = getBlockHash
  const recovered = await ensurePancakeV2AdvancedSnapshot(
    options(state, async () => {
      throw new Error('published snapshots must not redownload')
    }),
  )
  assert.equal(recovered.bootstrapped, false)
})

test('invalidates malformed published metadata so the next run can re-pin', async () => {
  const state = harness(1)
  state.kv.set(KEY.complete, '1')
  state.kv.set(KEY.source, PANCAKE_V2_SNAPSHOT_SOURCE)
  state.kv.set(KEY.block, '199999980')
  state.kv.set(KEY.blockHash, 'malformed')
  state.kv.set(KEY.poolCount, '1')
  state.kv.set(KEY.importSource, PANCAKE_V2_SNAPSHOT_SOURCE)
  state.kv.set(KEY.importBlock, '199999980')

  await assert.rejects(
    ensurePancakeV2AdvancedSnapshot(
      options(state, async () => ({ result: { logs: [pairLog(1)] } })),
    ),
    /published snapshot block hash is invalid/,
  )
  assert.equal(state.kv.get(KEY.complete), '0')
  assert.equal(state.kv.get(KEY.importSource), '')

  await ensurePancakeV2AdvancedSnapshot(
    options(state, async () => ({ result: { logs: [pairLog(1)] } })),
  )
  assert.equal(state.kv.get(KEY.complete), '1')
})

test('rechecks hash and factory count after the last page before publishing', async (t) => {
  const cases: Array<[string, (state: ReturnType<typeof harness>) => void, RegExp]> = [
    ['block hash', (state) => state.setHash(OTHER_HASH), /block hash no longer matches/],
    ['factory count', (state) => state.setCount(2), /factory count no longer matches/],
  ]
  for (const [name, changeCanonicalTarget, expected] of cases) {
    await t.test(name, async () => {
      const state = harness(1)
      await assert.rejects(
        ensurePancakeV2AdvancedSnapshot(
          options(state, async () => {
            changeCanonicalTarget(state)
            return { result: { logs: [pairLog(1)] } }
          }),
        ),
        expected,
      )
      assert.notEqual(state.kv.get(KEY.source), PANCAKE_V2_SNAPSHOT_SOURCE)
      assert.equal(state.kv.get(KEY.complete), '0')
      assert.equal(state.kv.get(KEY.importSource), '')
    })
  }
})

test('destructive generation drift during download cannot be published', async () => {
  const state = harness(1)
  await assert.rejects(
    ensurePancakeV2AdvancedSnapshot(
      options(state, async () => {
        state.setGeneration('1')
        return { result: { logs: [pairLog(1)] } }
      }),
    ),
    /catalog changed before publish/,
  )
  assert.notEqual(state.kv.get(KEY.source), PANCAKE_V2_SNAPSHOT_SOURCE)
  assert.equal(state.kv.get(KEY.complete), '0')
  assert.equal(state.kv.get(KEY.importCatalogGeneration), '1')
  assert.equal(state.kv.get(KEY.importNextIndex), '0')
  assert.equal(state.kv.get(KEY.importPageToken), '')
})

test('resumes with an endpoint-bound token and safely replays if that token is rejected', async () => {
  const state = harness(2)
  const first = pairLog(1)
  const firstPool = address(1_001)
  state.pools.set(firstPool, {
    address: firstPool,
    proto: 'pancakev2',
    token0: address(102),
    token1: address(103),
    fee_ppm: 2_500,
    created_block: null,
    pair_index: 0,
    added_ts: 123,
  })
  state.kv.set(KEY.complete, '0')
  state.kv.set(KEY.importSource, PANCAKE_V2_SNAPSHOT_SOURCE)
  state.kv.set(KEY.importBlock, '199999980')
  state.kv.set(KEY.importBlockHash, TARGET_HASH)
  state.kv.set(KEY.importPoolCount, '2')
  state.kv.set(KEY.importCatalogGeneration, '0')
  state.kv.set(KEY.importNextIndex, '1')
  state.kv.set(KEY.importPageToken, 'stale-endpoint-token')
  state.kv.set(
    KEY.importLastPosition,
    `${PANCAKE_V2_FACTORY_START_BLOCK + 1}:0:1`,
  )

  const tokens: Array<string | undefined> = []
  const result = await ensurePancakeV2AdvancedSnapshot(
    options(state, async (request) => {
      tokens.push(request.pageToken)
      if (request.pageToken === 'stale-endpoint-token')
        throw new PancakeV2PageTokenRejectedError('opaque token rejected')
      return { result: { logs: [first, pairLog(2)] } }
    }),
  )
  assert.deepEqual(tokens, ['stale-endpoint-token', undefined])
  assert.equal(result.added, 1, 'the existing allPairs row is verified, not duplicated')
  assert.equal(state.pools.get(firstPool)?.created_block, null)
  assert.equal(state.kv.get(KEY.complete), '1')
})

test('preserves a resumed page token after a transient fetch failure', async () => {
  const state = harness(2)
  const first = storedPair(1, 123)
  state.pools.set(first.address, first)
  state.kv.set(KEY.complete, '0')
  state.kv.set(KEY.importSource, PANCAKE_V2_SNAPSHOT_SOURCE)
  state.kv.set(KEY.importBlock, '199999980')
  state.kv.set(KEY.importBlockHash, TARGET_HASH)
  state.kv.set(KEY.importPoolCount, '2')
  state.kv.set(KEY.importCatalogGeneration, '0')
  state.kv.set(KEY.importNextIndex, '1')
  state.kv.set(KEY.importPageToken, 'resume-after-outage')
  state.kv.set(
    KEY.importLastPosition,
    `${PANCAKE_V2_FACTORY_START_BLOCK + 1}:0:1`,
  )

  const failedTokens: Array<string | undefined> = []
  await assert.rejects(
    ensurePancakeV2AdvancedSnapshot(
      options(state, async (request) => {
        failedTokens.push(request.pageToken)
        throw new Error('temporary transport outage')
      }),
    ),
    /temporary transport outage/,
  )
  assert.deepEqual(failedTokens, ['resume-after-outage'])
  assert.equal(state.kv.get(KEY.importNextIndex), '1')
  assert.equal(state.kv.get(KEY.importPageToken), 'resume-after-outage')
  assert.equal(
    state.kv.get(KEY.importLastPosition),
    `${PANCAKE_V2_FACTORY_START_BLOCK + 1}:0:1`,
  )

  const resumedTokens: Array<string | undefined> = []
  const result = await ensurePancakeV2AdvancedSnapshot(
    options(state, async (request) => {
      resumedTokens.push(request.pageToken)
      return { result: { logs: [pairLog(2)] } }
    }),
  )
  assert.deepEqual(resumedTokens, ['resume-after-outage'])
  assert.equal(result.added, 1)
  assert.equal(state.kv.get(KEY.complete), '1')
})

test('destructive generation drift restarts a resumed import at page one', async () => {
  const state = harness(2)
  const first = storedPair(1, 123)
  state.pools.set(first.address, first)
  state.kv.set(KEY.complete, '0')
  state.kv.set(KEY.importSource, PANCAKE_V2_SNAPSHOT_SOURCE)
  state.kv.set(KEY.importBlock, '199999980')
  state.kv.set(KEY.importBlockHash, TARGET_HASH)
  state.kv.set(KEY.importPoolCount, '2')
  state.kv.set(KEY.importCatalogGeneration, '0')
  state.kv.set(KEY.importNextIndex, '1')
  state.kv.set(KEY.importPageToken, 'invalidated-by-identity-update')
  state.kv.set(
    KEY.importLastPosition,
    `${PANCAKE_V2_FACTORY_START_BLOCK + 1}:0:1`,
  )
  state.setGeneration('1')

  let fetches = 0
  await assert.rejects(
    ensurePancakeV2AdvancedSnapshot(
      options(state, async () => {
        fetches++
        return { result: { logs: [] } }
      }),
    ),
    /catalog changed during import/,
  )
  assert.equal(fetches, 0)
  assert.equal(state.kv.get(KEY.importCatalogGeneration), '1')
  assert.equal(state.kv.get(KEY.importNextIndex), '0')
  assert.equal(state.kv.get(KEY.importPageToken), '')
  assert.equal(state.kv.get(KEY.importLastPosition), '')
})

test('fails when another address already occupies the decoded factory pair index', async () => {
  const state = harness(1)
  state.pools.set(address(9_999), {
    address: address(9_999),
    proto: 'pancakev2',
    token0: address(7),
    token1: address(8),
    fee_ppm: 2_500,
    created_block: null,
    pair_index: 0,
    added_ts: 0,
  })
  await assert.rejects(
    ensurePancakeV2AdvancedSnapshot(
      options(state, async () => ({ result: { logs: [pairLog(1)] } })),
    ),
    /failed to persist Pancake V2 pair/,
  )
  assert.notEqual(state.kv.get(KEY.complete), '1')
  assert.equal(state.pools.size, 1)
})

test('published snapshots allow later contiguous allPairs tail growth', async () => {
  const state = harness(1)
  await ensurePancakeV2AdvancedSnapshot(
    options(state, async () => ({ result: { logs: [pairLog(1)] } })),
  )
  state.pools.set(address(2_000), {
    address: address(2_000),
    proto: 'pancakev2',
    token0: address(200),
    token1: address(201),
    fee_ppm: 2_500,
    created_block: null,
    pair_index: 1,
    added_ts: 999,
  })
  const result = await ensurePancakeV2AdvancedSnapshot(
    options(state, async () => {
      throw new Error('published snapshots must not redownload')
    }),
  )
  assert.equal(result.bootstrapped, false)
  assert.equal(state.kv.get(KEY.complete), '1')
})

test('derives only strict authenticated Ankr BSC endpoints and de-duplicates them', () => {
  const token = 'a'.repeat(64)
  const accepted = `https://rpc.ankr.com/bsc/${token}`
  assert.deepEqual(
    deriveAnkrAdvancedEndpoints([
      accepted,
      accepted,
      `${accepted}?archive=true`,
      `https://user@rpc.ankr.com/bsc/${token}`,
      `https://rpc.ankr.com/bsc/${token}/extra`,
      `https://rpc.ankr.com/eth/${token}`,
      `http://rpc.ankr.com/bsc/${token}`,
      'https://rpc.ankr.com/bsc/short',
      `https://example.invalid/bsc/${token}`,
      `https://rpc.ankr.com/bsc/${'!'.repeat(64)}`,
    ]),
    [`https://rpc.ankr.com/multichain/${token}`],
  )
})

const rpcRequest = (pageToken?: string): PancakeV2AdvancedRequest => ({
  blockchain: ['bsc'],
  fromBlock: PANCAKE_V2_FACTORY_START_BLOCK,
  toBlock: 7_000_000,
  address: [FACTORY],
  topics: [[PANCAKE_V2_PAIR_CREATED_TOPIC]],
  decodeLogs: false,
  descOrder: false,
  pageSize: 1,
  ...(pageToken ? { pageToken } : {}),
})

test('selects a working endpoint before page one, then pins every page token to it', async () => {
  const endpoints = [
    'https://rpc.ankr.com/multichain/' + '1'.repeat(64),
    'https://rpc.ankr.com/multichain/' + '2'.repeat(64),
  ]
  const calls: string[] = []
  const slot = { value: '', fingerprint: '' }
  const requestFetch: typeof fetch = async (input) => {
    const url = String(input)
    calls.push(url)
    if (url === endpoints[0]) return new Response('busy', { status: 503 })
    return new Response(JSON.stringify({ result: { logs: [{}] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const fetchPage = createAnkrAdvancedGenerationFetcher(endpoints, requestFetch, {
    get: () => slot.value,
    set: (value) => void (slot.value = value),
    getFingerprint: () => slot.fingerprint,
    setFingerprint: (value) => void (slot.fingerprint = value),
  })

  await fetchPage(rpcRequest())
  await fetchPage(rpcRequest('page-2'))
  assert.equal(calls.filter((url) => url === endpoints[0]).length, 4)
  assert.equal(calls.filter((url) => url === endpoints[1]).length, 2)
  assert.equal(calls.at(-1), endpoints[1])
  assert.equal(slot.value, '1')
  assert.equal(
    slot.fingerprint,
    createHash('sha256').update(endpoints[1]).digest('hex'),
  )
})

test('falls back before pinning when an HTTP 200 candidate has a malformed page envelope', async (t) => {
  const malformedBodies: Array<[string, unknown]> = [
    ['null result', { jsonrpc: '2.0', id: 1, result: null }],
    ['string error', { jsonrpc: '2.0', id: 1, error: 'malformed error' }],
    ['empty logs', { jsonrpc: '2.0', id: 1, result: { logs: [] } }],
  ]
  for (const [name, malformed] of malformedBodies) {
    await t.test(name, async () => {
      const endpoints = [
        'https://rpc.ankr.com/multichain/' + '5'.repeat(64),
        'https://rpc.ankr.com/multichain/' + '6'.repeat(64),
      ]
      const calls: string[] = []
      const slot = { value: '', fingerprint: '' }
      const requestFetch: typeof fetch = async (input) => {
        const endpoint = String(input)
        calls.push(endpoint)
        return new Response(
          JSON.stringify(
            endpoint === endpoints[0]
              ? malformed
              : { jsonrpc: '2.0', id: 1, result: { logs: [{}] } },
          ),
          { status: 200 },
        )
      }
      const fetchPage = createAnkrAdvancedGenerationFetcher(
        endpoints,
        requestFetch,
        {
          get: () => slot.value,
          set: (value) => void (slot.value = value),
          getFingerprint: () => slot.fingerprint,
          setFingerprint: (value) => void (slot.fingerprint = value),
        },
      )

      await fetchPage(rpcRequest())
      assert.deepEqual(calls, endpoints)
      assert.equal(slot.value, '1')
      assert.equal(
        slot.fingerprint,
        createHash('sha256').update(endpoints[1]).digest('hex'),
      )
    })
  }
})

test('a malformed later page triggers one page-one replay and endpoint failover', async () => {
  const state = harness(3)
  const endpoints = [
    'https://rpc.ankr.com/multichain/' + '7'.repeat(64),
    'https://rpc.ankr.com/multichain/' + '8'.repeat(64),
  ]
  const calls: Array<{ endpoint: string; pageToken?: string }> = []
  const requestFetch: typeof fetch = async (input, init) => {
    const endpoint = String(input)
    const request = JSON.parse(String(init?.body)) as {
      params: PancakeV2AdvancedRequest
    }
    const pageToken = request.params.pageToken
    calls.push({ endpoint, ...(pageToken ? { pageToken } : {}) })

    let body: unknown
    if (endpoint === endpoints[0]) {
      if (pageToken) {
        body = { jsonrpc: '2.0', id: 1, result: null }
      } else {
        body = {
          jsonrpc: '2.0',
          id: 1,
          result: {
            logs: [pairLog(1), pairLog(2)],
            nextPageToken: 'bad-page',
          },
        }
      }
    } else {
      body = pageToken
        ? { jsonrpc: '2.0', id: 1, result: { logs: [pairLog(3)] } }
        : {
            jsonrpc: '2.0',
            id: 1,
            result: {
              logs: [pairLog(1), pairLog(2)],
              nextPageToken: 'good-page',
            },
          }
    }
    return new Response(JSON.stringify(body), { status: 200 })
  }
  const fetchPage = createAnkrAdvancedGenerationFetcher(endpoints, requestFetch, {
    get: () => state.kv.get(KEY.importEndpointSlot),
    set: (value) => void state.kv.set(KEY.importEndpointSlot, value),
    getFingerprint: () => state.kv.get(KEY.importEndpointFingerprint),
    setFingerprint: (value) =>
      void state.kv.set(KEY.importEndpointFingerprint, value),
  })

  const result = await ensurePancakeV2AdvancedSnapshot(options(state, fetchPage))
  assert.equal(result.added, 3)
  assert.deepEqual(calls, [
    { endpoint: endpoints[0] },
    { endpoint: endpoints[0], pageToken: 'bad-page' },
    { endpoint: endpoints[1] },
    { endpoint: endpoints[1], pageToken: 'good-page' },
  ])
  assert.equal(state.kv.get(KEY.complete), '1')
  assert.equal(state.kv.get(KEY.importEndpointSlot), '')
  assert.equal(state.kv.get(KEY.importEndpointFingerprint), '')
})

test('page-one replay prioritizes other keys and remains bounded if fallback fails', async () => {
  const state = harness(3)
  const endpoints = [
    'https://rpc.ankr.com/multichain/' + 'a'.repeat(64),
    'https://rpc.ankr.com/multichain/' + 'b'.repeat(64),
  ]
  const calls: Array<{ endpoint: string; pageToken?: string }> = []
  const requestFetch: typeof fetch = async (input, init) => {
    const endpoint = String(input)
    const request = JSON.parse(String(init?.body)) as {
      params: PancakeV2AdvancedRequest
    }
    const pageToken = request.params.pageToken
    calls.push({ endpoint, ...(pageToken ? { pageToken } : {}) })
    const body = endpoint === endpoints[0] && !pageToken
      ? {
          result: {
            logs: [pairLog(1), pairLog(2)],
            nextPageToken: 'always-bad-continuation',
          },
        }
      : { result: null }
    return new Response(JSON.stringify(body), { status: 200 })
  }
  const fetchPage = createAnkrAdvancedGenerationFetcher(endpoints, requestFetch, {
    get: () => state.kv.get(KEY.importEndpointSlot),
    set: (value) => void state.kv.set(KEY.importEndpointSlot, value),
    getFingerprint: () => state.kv.get(KEY.importEndpointFingerprint),
    setFingerprint: (value) =>
      void state.kv.set(KEY.importEndpointFingerprint, value),
  })

  await assert.rejects(
    ensurePancakeV2AdvancedSnapshot(options(state, fetchPage)),
    /bound page-token generation/,
  )
  assert.deepEqual(calls, [
    { endpoint: endpoints[0] },
    { endpoint: endpoints[0], pageToken: 'always-bad-continuation' },
    { endpoint: endpoints[1] },
    { endpoint: endpoints[0] },
    { endpoint: endpoints[0], pageToken: 'always-bad-continuation' },
  ])
  assert.equal(state.kv.get(KEY.complete), '0')
  assert.equal(state.kv.get(KEY.importNextIndex), '2')
  assert.equal(state.kv.get(KEY.importPageToken), 'always-bad-continuation')
})

test('resumes a page token only on its matching slot and fingerprint', async () => {
  const endpoints = [
    'https://rpc.ankr.com/multichain/' + '3'.repeat(64),
    'https://rpc.ankr.com/multichain/' + '4'.repeat(64),
  ]
  const calls: string[] = []
  const requestFetch: typeof fetch = async (input) => {
    calls.push(String(input))
    return new Response(JSON.stringify({ result: { logs: [{}] } }), { status: 200 })
  }
  const matching = createAnkrAdvancedGenerationFetcher(endpoints, requestFetch, {
    get: () => '1',
    set: () => undefined,
    getFingerprint: () => createHash('sha256').update(endpoints[1]).digest('hex'),
    setFingerprint: () => undefined,
  })
  await matching(rpcRequest('resume-token'))
  assert.deepEqual(calls, [endpoints[1]])

  calls.length = 0
  const mismatched = createAnkrAdvancedGenerationFetcher(endpoints, requestFetch, {
    get: () => '1',
    set: () => undefined,
    getFingerprint: () => createHash('sha256').update(endpoints[0]).digest('hex'),
    setFingerprint: () => undefined,
  })
  await assert.rejects(
    mismatched(rpcRequest('resume-token')),
    /no bound endpoint slot/,
  )
  assert.deepEqual(calls, [], 'a mismatched opaque token is rejected before network I/O')
})

test('retryable HTTP exhaustion does not reject or rotate a bound page token', async () => {
  const endpoint = 'https://rpc.ankr.com/multichain/' + '9'.repeat(64)
  let calls = 0
  const fetchPage = createAnkrAdvancedGenerationFetcher(
    [endpoint],
    async () => {
      calls++
      return new Response('temporarily unavailable', { status: 503 })
    },
    {
      get: () => '0',
      set: () => undefined,
      getFingerprint: () => createHash('sha256').update(endpoint).digest('hex'),
      setFingerprint: () => undefined,
    },
  )

  await assert.rejects(fetchPage(rpcRequest('resume-token')), (error: unknown) => {
    assert.equal(error instanceof PancakeV2PageTokenRejectedError, false)
    assert.match(String(error), /HTTP 503/)
    return true
  })
  assert.equal(calls, 4)
})

test('transport and RPC failures never expose an endpoint or API token', async () => {
  const token = 'secretToken_'.repeat(6)
  const endpoint = `https://rpc.ankr.com/multichain/${token}`
  const transport = createAnkrAdvancedPageFetcher(endpoint, async (input) => {
    throw new Error(`failed to fetch ${String(input)}`)
  })
  await assert.rejects(transport(rpcRequest()), (error: unknown) => {
    const message = String(error)
    assert.doesNotMatch(message, /rpc\.ankr\.com/)
    assert.doesNotMatch(message, new RegExp(token))
    assert.doesNotMatch(message, /secretToken_secretToken/)
    return true
  })

  const rpc = createAnkrAdvancedPageFetcher(endpoint, async () =>
    new Response(
      JSON.stringify({
        error: { code: -32000, message: `bad endpoint ${endpoint} token ${token}` },
      }),
      { status: 200 },
    ),
  )
  await assert.rejects(rpc(rpcRequest()), (error: unknown) => {
    const message = String(error)
    assert.doesNotMatch(message, /rpc\.ankr\.com/)
    assert.doesNotMatch(message, new RegExp(token))
    assert.doesNotMatch(message, /secretToken_secretToken/)
    return true
  })
})
