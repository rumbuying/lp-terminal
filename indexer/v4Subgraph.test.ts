import assert from 'node:assert/strict'
import {
  encodeAbiParameters,
  keccak256,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import test, { afterEach, beforeEach, mock } from 'node:test'

type StoredPool = {
  pool_id: string
  pool_manager: string
  currency0: string
  currency1: string
  key_fee_ppm: number | null
  tick_spacing: number
  hooks: string
  created_block: number | null
  snapshot_generation?: string | null
}

const MANAGER = '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df' as Address
const STABLE = '0x55d398326f99059ff775485246999027b3197955' as Address
const WNATIVE = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' as Address
const TOKEN = '0x0000000000000000000000000000000000000010' as Address
const TOKEN2 = '0x0000000000000000000000000000000000000020' as Address
const SUBGRAPH = 'EAq1nJKgjnuKH6Gj4RFjCW7LcL7E2uipbncdwV7TTWkX'
const DEPLOYMENT = 'QmbQBjZ1VUK42k1V6sn6PnP3BZ1vLZhUmzfDpyF9Eiwfgt'
const blockHash = (block: number) => `0x${block.toString(16).padStart(64, '0')}`
const generation = (block: number, deployment = DEPLOYMENT, subgraph = SUBGRAPH) =>
  keccak256(
    encodeAbiParameters(
      [{ type: 'string' }],
      [`${subgraph}\n${deployment}\n${block}\n${blockHash(block)}`],
    ),
  )

const kv = new Map<string, string>()
const pools = new Map<string, StoredPool>()
/** the RPC-directory scope; empty here, because BSC declares no scope */
const launchpadTokens = new Set<string>()
const tokens = new Map<string, { symbol: string; decimals: number }>()
const stats = new Map<string, unknown>()
let blockNumber = 300n
let getBlockHash = (block: number) => blockHash(block)
let getLogs: (request: { fromBlock: bigint; toBlock: bigint }) => Promise<unknown[]> =
  async () => []
type MetadataCall = { address: string; functionName: string }
type MetadataResult = { status: 'success' | 'failure'; result?: unknown }
let multicallCalls: MetadataCall[] = []
let metadataResult: (calls: MetadataCall[]) => MetadataResult[] = (calls) =>
  calls.map((call) =>
    call.functionName === 'symbol'
      ? { status: 'success', result: 'TOK' }
      : { status: 'success', result: 18 },
  )
let featuredClears = 0
let featuredPrunes = 0

mock.module('./config', {
  namedExports: {
    CHAIN: {
      id: 56,
      key: 'bsc',
      nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
      addr: { STABLE, WNATIVE },
    },
    INDEXER_FINALITY_BLOCKS: 0,
    V4: {
      POOL_MANAGER: MANAGER,
      poolSubgraph: SUBGRAPH,
    },
    log: () => undefined,
    sleep: async () => undefined,
  },
})

const rpcClient = {
  getBlockNumber: async () => blockNumber,
  getBlock: async ({ blockNumber: number }: { blockNumber: bigint }) => ({
    hash: getBlockHash(Number(number)),
  }),
  getLogs: (request: { fromBlock: bigint; toBlock: bigint }) => getLogs(request),
}

mock.module('./rpc', {
  namedExports: {
    pc: rpcClient,
    withRotatingRpcClient: <T>(fn: (client: typeof rpcClient) => Promise<T>) => fn(rpcClient),
    mc: async (calls: MetadataCall[]) => {
      multicallCalls = calls
      return metadataResult(calls)
    },
    ok: <T>(row?: { status: string; result?: unknown }): T | undefined =>
      row?.status === 'success' ? (row.result as T) : undefined,
  },
})

mock.module('./store', {
  namedExports: {
    // Only consulted on a chain that declares an RPC directory scope; BSC (the
    // chain these tests run as) declares none, so the gate never reaches here.
    isLaunchpadToken: (address: string) => launchpadTokens.has(address.toLowerCase()),
    // the directory's other origin rule; this file is about the launchpad one
    isStockToken: () => false,
    clearV4Featured: () => {
      featuredClears++
    },
    pruneV4StatsExcept: () => {
      featuredPrunes++
    },
    hasCompleteV4SnapshotRows: () => {
      const expected = Number(kv.get('v4_snapshot_pool_count'))
      const currentGeneration = kv.get('v4_snapshot_generation')
      return (
        kv.get('v4_snapshot_source') === 'thegraph' &&
        kv.get('v4_snapshot_complete') === '1' &&
        Number.isSafeInteger(expected) &&
        expected > 0 &&
        Boolean(currentGeneration) &&
        [...pools.values()].filter(
          (pool) => pool.snapshot_generation === currentGeneration,
        ).length === expected &&
        /^0x[0-9a-f]{64}$/.test(kv.get('v4_snapshot_block_hash') ?? '') &&
        Boolean(kv.get('v4_snapshot_deployment')) &&
        Boolean(kv.get('v4_snapshot_subgraph_id'))
      )
    },
    insertV4Pool: (input: {
      poolId: string
      poolManager: string
      currency0: string
      currency1: string
      keyFeePpm?: number
      tickSpacing: number
      hooks: string
      createdBlock?: number
      snapshotGeneration?: string
    }) => {
      const id = input.poolId.toLowerCase()
      if (pools.has(id)) return false
      pools.set(id, {
        pool_id: id,
        pool_manager: input.poolManager.toLowerCase(),
        currency0: input.currency0.toLowerCase(),
        currency1: input.currency1.toLowerCase(),
        key_fee_ppm: input.keyFeePpm ?? null,
        tick_spacing: input.tickSpacing,
        hooks: input.hooks.toLowerCase(),
        created_block: input.createdBlock ?? null,
        snapshot_generation: input.snapshotGeneration ?? null,
      })
      return true
    },
    kvGet: (key: string) => kv.get(key),
    kvSet: (key: string, value: string) => void kv.set(key, value),
    markV4Featured: () => undefined,
    missingV4TokensPage: (after: string, limit: number) => {
      const all = [
        ...new Set([...pools.values()].flatMap((pool) => [pool.currency0, pool.currency1])),
      ]
        .filter((address) => address > after && !tokens.has(address))
        .sort()
      return all.slice(0, limit)
    },
    setV4EventIdentity: (id: string, fee: number, createdBlock: number) => {
      const row = pools.get(id)!
      if (
        (row.key_fee_ppm !== null && row.key_fee_ppm !== fee) ||
        (row.created_block !== null && row.created_block !== createdBlock)
      )
        throw new Error('conflict')
      row.key_fee_ppm = fee
      row.created_block = createdBlock
    },
    setV4SnapshotGeneration: (id: string, nextGeneration: string) => {
      const row = pools.get(id.toLowerCase())
      if (!row) throw new Error('missing pool')
      row.snapshot_generation = nextGeneration
    },
    v4SnapshotGenerationCount: (currentGeneration: string) =>
      [...pools.values()].filter(
        (pool) => pool.snapshot_generation === currentGeneration,
      ).length,
    deleteStaleV4SnapshotCandidates: (currentGeneration: string) => {
      let deleted = 0
      for (const [poolId, row] of pools) {
        if (
          row.snapshot_generation !== currentGeneration &&
          !(row.key_fee_ppm !== null && row.created_block !== null)
        ) {
          pools.delete(poolId)
          deleted++
        }
      }
      return deleted
    },
    tx: (fn: () => void) => fn(),
    upsertV4GraphStats: (id: string, tvl0: number | null, tvl1: number | null) =>
      void stats.set(id, { tvl0, tvl1 }),
    upsertV4TokenMeta: (address: string, symbol: string, decimals: number) =>
      void tokens.set(address.toLowerCase(), { symbol, decimals }),
    v4PoolCount: () => pools.size,
    v4PoolRow: (id: string) => pools.get(id.toLowerCase()),
  },
})

const v4 = await import('./v4Subgraph')

const previousEnv = {
  key: process.env.THEGRAPH_API_KEY,
  id: process.env.INDEXER_V4_SUBGRAPH_ID,
  lag: process.env.INDEXER_V4_SUBGRAPH_MAX_LAG_BLOCKS,
}

beforeEach(() => {
  kv.clear()
  pools.clear()
  tokens.clear()
  stats.clear()
  blockNumber = 300n
  getBlockHash = (block) => blockHash(block)
  getLogs = async () => []
  multicallCalls = []
  metadataResult = (calls) =>
    calls.map((call) =>
      call.functionName === 'symbol'
        ? { status: 'success', result: 'TOK' }
        : { status: 'success', result: 18 },
    )
  featuredClears = 0
  featuredPrunes = 0
  process.env.THEGRAPH_API_KEY = 'server-secret'
  delete process.env.INDEXER_V4_SUBGRAPH_ID
  delete process.env.INDEXER_V4_SUBGRAPH_MAX_LAG_BLOCKS
})

afterEach(() => {
  mock.restoreAll()
  if (previousEnv.key === undefined) delete process.env.THEGRAPH_API_KEY
  else process.env.THEGRAPH_API_KEY = previousEnv.key
  if (previousEnv.id === undefined) delete process.env.INDEXER_V4_SUBGRAPH_ID
  else process.env.INDEXER_V4_SUBGRAPH_ID = previousEnv.id
  if (previousEnv.lag === undefined) delete process.env.INDEXER_V4_SUBGRAPH_MAX_LAG_BLOCKS
  else process.env.INDEXER_V4_SUBGRAPH_MAX_LAG_BLOCKS = previousEnv.lag
})

const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
const graphPool = (poolId: string, token0: Address, token1: Address) => ({
  id: poolId,
  token0: { id: token0, symbol: token0 === zeroAddress ? 'BNB' : 'AAA', decimals: '18' },
  token1: { id: token1, symbol: 'BBB', decimals: '18' },
  tickSpacing: '10',
  hooks: zeroAddress,
  totalValueLockedToken0: '1.5',
  totalValueLockedToken1: '2.5',
  poolDayData: [{ date: '100', volumeToken0: '3', volumeToken1: '4' }],
})

const meta = (block: number) => ({
  block: { number: block, hash: blockHash(block) },
  deployment: DEPLOYMENT,
  hasIndexingErrors: false,
})

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })

test('imports a pinned, manager-bound and count-complete v4 candidate snapshot', async () => {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = []
  mock.method(
    globalThis,
    'fetch',
    async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string
        variables: Record<string, unknown>
      }
      requests.push(body)
      if (requests.length === 1) return json({ data: { _meta: meta(220) } })
      return json({
        data: {
          _meta: meta(200),
          poolManagers: [{ id: MANAGER, poolCount: '2' }],
          pools: [
            graphPool(id(1), zeroAddress, TOKEN),
            graphPool(id(2), TOKEN, TOKEN2),
          ],
        },
      })
    },
  )

  const result = await v4.importBscV4Snapshot(200)
  assert.deepEqual(result, {
    added: 2,
    block: 200,
    blockHash: blockHash(200),
    downloaded: 2,
    deployment: DEPLOYMENT,
    generation: generation(200),
  })
  assert.equal(requests[1].variables.hash, blockHash(200))
  assert.equal('block' in requests[1].variables, false)
  assert.equal(/block\s*:\s*\{\s*number\s*:/.test(requests[1].query), false)
  assert.equal(
    requests[1].query.match(/block\s*:\s*\{\s*hash\s*:\s*\$hash\s*\}/g)?.length,
    3,
    'meta, manager, and pools are all pinned by the same hash',
  )
  assert.equal(pools.size, 2)
  assert.equal(stats.size, 0, 'full snapshot stores identity only')
  assert.ok([...pools.values()].every((pool) => pool.key_fee_ppm === null))
  assert.deepEqual(tokens.get(zeroAddress), { symbol: 'BNB', decimals: 18 })
  assert.equal(kv.get('v4_snapshot_pool_count'), '2')
  assert.equal(kv.get('v4_snapshot_block_hash'), blockHash(200))
  assert.equal(kv.get('v4_snapshot_generation'), generation(200))
  assert.equal(kv.get('v4_snapshot_complete'), '1')
  assert.equal(kv.get('v4_cursor'), '200')
  assert.equal(v4.hasCompleteV4GraphSnapshot(), true)
})

test('retries a transient Graph page and resumes a durable pinned prefix', async () => {
  // Pretend page one committed before the prior process was killed.
  pools.set(id(1), {
    pool_id: id(1),
    pool_manager: MANAGER,
    currency0: zeroAddress,
    currency1: TOKEN,
    key_fee_ppm: null,
    tick_spacing: 10,
    hooks: zeroAddress,
    created_block: null,
    snapshot_generation: generation(200),
  })
  kv.set('v4_snapshot_inflight_block', '200')
  kv.set('v4_snapshot_inflight_block_hash', blockHash(200))
  kv.set('v4_snapshot_inflight_subgraph_id', SUBGRAPH)
  kv.set('v4_snapshot_inflight_after', id(1))
  kv.set('v4_snapshot_inflight_downloaded', '1')
  kv.set('v4_snapshot_inflight_pool_count', '2')
  kv.set('v4_snapshot_inflight_deployment', DEPLOYMENT)
  kv.set('v4_snapshot_inflight_generation', generation(200))

  let requests = 0
  const pageVariables: Record<string, unknown>[] = []
  mock.method(
    globalThis,
    'fetch',
    async (_url: string | URL | Request, init?: RequestInit) => {
      requests++
      const body = JSON.parse(String(init?.body)) as {
        query: string
        variables: Record<string, unknown>
      }
      if (body.query.includes('V4SnapshotMeta'))
        return json({ data: { _meta: meta(220) } })
      pageVariables.push(body.variables)
      if (pageVariables.length === 1) return json({ errors: [{ message: 'busy' }] }, 503)
      return json({
        data: {
          _meta: meta(200),
          poolManagers: [{ id: MANAGER, poolCount: '2' }],
          pools: [graphPool(id(2), TOKEN, TOKEN2)],
        },
      })
    },
  )

  const result = await v4.importBscV4Snapshot(210)
  assert.equal(requests, 3, 'meta + retried continuation page')
  assert.equal(pageVariables[0].after, id(1))
  assert.equal(pageVariables[1].after, id(1))
  assert.equal(result.downloaded, 2)
  assert.equal(result.added, 1)
  assert.equal(kv.get('v4_snapshot_complete'), '1')
})

test('recovers transient initial and later-page poolCount disagreements', async () => {
  const firstRows = Array.from({ length: 1_000 }, (_, index) =>
    graphPool(id(index + 1), zeroAddress, TOKEN),
  )
  const pageAfters: string[] = []
  let initialAttempt = 0
  let continuationAttempt = 0
  mock.method(
    globalThis,
    'fetch',
    async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string
        variables: Record<string, unknown>
      }
      if (body.query.includes('V4SnapshotMeta'))
        return json({ data: { _meta: meta(220) } })
      const after = String(body.variables.after)
      pageAfters.push(after)
      const firstPage = after === id(0)
      const attempt = firstPage ? ++initialAttempt : ++continuationAttempt
      const count =
        firstPage
          ? attempt === 1
            ? '1002'
            : '1001'
          : attempt === 1
            ? '1002'
            : '1001'
      return json({
        data: {
          _meta: meta(200),
          poolManagers: [{ id: MANAGER, poolCount: count }],
          pools: firstPage
            ? firstRows
            : [graphPool(id(1001), TOKEN, TOKEN2)],
        },
      })
    },
  )

  const result = await v4.importBscV4Snapshot(200)
  assert.equal(result.downloaded, 1_001)
  assert.equal(pools.size, 1_001)
  assert.deepEqual(
    pageAfters,
    [id(0), id(0), id(0), id(1000), id(1000)],
    'fresh count stabilizes twice; later mismatch refetches the same cursor',
  )
  assert.equal(kv.get('v4_snapshot_pool_count'), '1001')
})

test('rejects a Graph snapshot on a different fork before storing candidates', async () => {
  getBlockHash = () => blockHash(199)
  let request = 0
  mock.method(globalThis, 'fetch', async () => {
    request++
    if (request === 1) return json({ data: { _meta: meta(200) } })
    return json({
      data: {
        _meta: meta(200),
        poolManagers: [{ id: MANAGER, poolCount: '1' }],
        pools: [graphPool(id(1), zeroAddress, TOKEN)],
      },
    })
  })

  await assert.rejects(v4.importBscV4Snapshot(200), /snapshot block 200 changed hash/)
  assert.equal(pools.size, 0)
  assert.equal(kv.get('v4_snapshot_complete'), undefined)
})

test('replacement generation counts exactly and removes only stale unverified rows', async () => {
  const alternateSubgraph = `${SUBGRAPH.slice(0, -1)}Y`
  const oldGeneration = generation(200)
  const nextGeneration = generation(200, DEPLOYMENT, alternateSubgraph)
  process.env.INDEXER_V4_SUBGRAPH_ID = alternateSubgraph
  pools.set(id(8), {
    pool_id: id(8),
    pool_manager: MANAGER,
    currency0: zeroAddress,
    currency1: TOKEN,
    key_fee_ppm: null,
    tick_spacing: 10,
    hooks: zeroAddress,
    created_block: null,
    snapshot_generation: oldGeneration,
  })
  pools.set(id(9), {
    pool_id: id(9),
    pool_manager: MANAGER,
    currency0: TOKEN,
    currency1: TOKEN2,
    key_fee_ppm: 500,
    tick_spacing: 10,
    hooks: zeroAddress,
    created_block: 180,
    snapshot_generation: oldGeneration,
  })
  let request = 0
  mock.method(globalThis, 'fetch', async () => {
    request++
    if (request === 1) return json({ data: { _meta: meta(200) } })
    return json({
      data: {
        _meta: meta(200),
        poolManagers: [{ id: MANAGER, poolCount: '1' }],
        pools: [graphPool(id(1), zeroAddress, TOKEN)],
      },
    })
  })

  const result = await v4.importBscV4Snapshot(200)
  assert.equal(result.generation, nextGeneration)
  assert.equal(kv.get('v4_snapshot_generation'), nextGeneration)
  assert.equal(pools.has(id(8)), false, 'stale Graph-only row is deleted')
  assert.equal(pools.has(id(9)), true, 'Initialize-verified row survives replacement')
  assert.equal(pools.get(id(1))?.snapshot_generation, nextGeneration)
  assert.equal(
    [...pools.values()].filter((pool) => pool.snapshot_generation === nextGeneration).length,
    1,
  )
})

test('featured refresh, not the full snapshot, owns raw display statistics', async () => {
  pools.set(id(1), {
    pool_id: id(1),
    pool_manager: MANAGER,
    currency0: zeroAddress,
    currency1: TOKEN,
    key_fee_ppm: null,
    tick_spacing: 10,
    hooks: zeroAddress,
    created_block: null,
  })
  mock.method(globalThis, 'fetch', async () =>
    json({
      data: {
        _meta: meta(230),
        poolManagers: [{ id: MANAGER, poolCount: '1' }],
        stable0: [],
        stable1: [],
        native0: [graphPool(id(1), zeroAddress, TOKEN)],
        native1: [],
        wrapped0: [],
        wrapped1: [],
        active: [],
      },
    }),
  )

  assert.equal(await v4.refreshV4FeaturedStats(), 1)
  assert.equal(featuredClears, 1)
  assert.equal(featuredPrunes, 1)
  assert.equal(stats.size, 1)
  assert.equal(kv.get('v4_featured_block'), '230')
  assert.equal(kv.get('v4_featured_count'), '1')
})

test('rejects incomplete and out-of-order snapshots without publishing completion', async () => {
  let mode: 'incomplete' | 'order' = 'incomplete'
  mock.method(
    globalThis,
    'fetch',
    async (_url: string | URL | Request, init?: RequestInit) => {
      const query = (JSON.parse(String(init?.body)) as { query: string }).query
      if (query.includes('V4SnapshotMeta'))
        return json({ data: { _meta: meta(200) } })
      const rows =
        mode === 'order'
          ? [graphPool(id(2), TOKEN, TOKEN2), graphPool(id(1), zeroAddress, TOKEN)]
          : [graphPool(id(1), zeroAddress, TOKEN)]
      return json({
        data: {
          _meta: meta(200),
          poolManagers: [{ id: MANAGER, poolCount: '2' }],
          pools: rows,
        },
      })
    },
  )

  await assert.rejects(v4.importBscV4Snapshot(200), /downloaded 1\/2 pools/)
  assert.equal(kv.get('v4_snapshot_complete'), undefined)

  kv.clear()
  pools.clear()
  mode = 'order'
  await assert.rejects(v4.importBscV4Snapshot(200), /not strictly ordered/)
  assert.equal(kv.get('v4_snapshot_complete'), undefined)
})

test('rejects stale or wrong-manager Graph provenance before marking ready', async () => {
  process.env.INDEXER_V4_SUBGRAPH_MAX_LAG_BLOCKS = '10'
  mock.method(globalThis, 'fetch', async () => json({ data: { _meta: meta(150) } }))
  await assert.rejects(v4.importBscV4Snapshot(200), /lags the finalized chain head by 50/)
  assert.equal(kv.get('v4_snapshot_complete'), undefined)

  mock.restoreAll()
  delete process.env.INDEXER_V4_SUBGRAPH_MAX_LAG_BLOCKS
  let n = 0
  mock.method(globalThis, 'fetch', async () => {
    n++
    if (n === 1) return json({ data: { _meta: meta(200) } })
    return json({
      data: {
        _meta: meta(200),
        poolManagers: [{ id: TOKEN, poolCount: '1' }],
        pools: [graphPool(id(1), zeroAddress, TOKEN)],
      },
    })
  })
  await assert.rejects(v4.importBscV4Snapshot(200), /not bound to the configured PoolManager/)
  assert.equal(kv.get('v4_snapshot_complete'), undefined)
})

function poolIdOf(
  currency0: Address,
  currency1: Address,
  fee: number,
  spacing: number,
  hooks: Address,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'uint24' },
        { type: 'int24' },
        { type: 'address' },
      ],
      [currency0, currency1, fee, spacing, hooks],
    ),
  )
}

const initializeLog = (poolId: Hex, block: number) => ({
  args: {
    id: poolId,
    currency0: TOKEN,
    currency1: TOKEN2,
    fee: 500,
    tickSpacing: 10,
    hooks: zeroAddress,
  },
  blockNumber: BigInt(block),
})

function markSnapshotReady(snapshotBlock = 200, cursor = snapshotBlock) {
  const readyGeneration = generation(snapshotBlock)
  pools.set(id(1), {
    pool_id: id(1),
    pool_manager: MANAGER,
    currency0: zeroAddress,
    currency1: TOKEN,
    key_fee_ppm: null,
    tick_spacing: 10,
    hooks: zeroAddress,
    created_block: null,
    snapshot_generation: readyGeneration,
  })
  kv.set('v4_snapshot_source', 'thegraph')
  kv.set('v4_snapshot_block', String(snapshotBlock))
  kv.set('v4_snapshot_block_hash', blockHash(snapshotBlock))
  kv.set('v4_snapshot_pool_count', '1')
  kv.set('v4_snapshot_deployment', DEPLOYMENT)
  kv.set('v4_snapshot_subgraph_id', SUBGRAPH)
  kv.set('v4_snapshot_generation', readyGeneration)
  kv.set('v4_snapshot_complete', '1')
  kv.set('v4_cursor', String(cursor))
  kv.set('v4_target_block', String(cursor))
}

test('Initialize tail verifies PoolId round-trip and checkpoints the finalized cursor', async () => {
  markSnapshotReady()
  const poolId = poolIdOf(TOKEN, TOKEN2, 500, 10, zeroAddress)
  getLogs = async ({ fromBlock, toBlock }) => {
    assert.equal(fromBlock, 200n)
    assert.equal(toBlock, 300n)
    return [initializeLog(poolId, 250)]
  }
  assert.deepEqual(await v4.tailV4(), [poolId.toLowerCase()])
  assert.equal(kv.get('v4_cursor'), '300')
  assert.equal(kv.get('v4_target_block'), '300')
  assert.equal(pools.get(poolId.toLowerCase())?.key_fee_ppm, 500)
  assert.equal(pools.get(poolId.toLowerCase())?.created_block, 250)
})

test('periodic Initialize tail keeps the last successful target published until completion', async () => {
  markSnapshotReady()
  let entered!: () => void
  let release!: () => void
  const fetching = new Promise<void>((resolve) => {
    entered = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  getLogs = async () => {
    entered()
    await blocked
    return []
  }

  const tail = v4.tailV4()
  await fetching
  assert.equal(kv.get('v4_cursor'), '200')
  assert.equal(kv.get('v4_target_block'), '200')
  release()
  await tail
  assert.equal(kv.get('v4_cursor'), '300')
  assert.equal(kv.get('v4_target_block'), '300')
})

test('restart V4 catch-up also preserves the prior published target while scanning', async () => {
  markSnapshotReady()
  let entered!: () => void
  let release!: () => void
  const fetching = new Promise<void>((resolve) => {
    entered = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  getLogs = async () => {
    entered()
    await blocked
    return []
  }

  const backfill = v4.backfillV4()
  await fetching
  assert.equal(kv.get('v4_cursor'), '200')
  assert.equal(kv.get('v4_target_block'), '200')
  release()
  assert.equal(await backfill, 0)
  assert.equal(kv.get('v4_cursor'), '300')
  assert.equal(kv.get('v4_target_block'), '300')
  assert.equal(kv.get('v4_backfilled'), '1')
})

test('adaptive overlap windows never move the durable Initialize cursor backwards', async () => {
  markSnapshotReady(100, 300)
  blockNumber = 400n
  let observedPostReplayWindow = false
  getLogs = async ({ fromBlock, toBlock }) => {
    const blocks = Number(toBlock - fromBlock + 1n)
    if (blocks > 62) throw new Error('block range limit')
    if (fromBlock === 242n) {
      observedPostReplayWindow = true
      assert.equal(kv.get('v4_cursor'), '300')
      assert.equal(kv.get('v4_target_block'), '300')
    }
    return []
  }

  assert.deepEqual(await v4.tailV4(), [])
  assert.equal(observedPostReplayWindow, true)
  assert.equal(kv.get('v4_cursor'), '400')
  assert.equal(kv.get('v4_target_block'), '400')
})

test('Initialize tail rejects a newly discovered identity behind its durable fence', async () => {
  markSnapshotReady(100, 200)
  const poolId = poolIdOf(TOKEN, TOKEN2, 500, 10, zeroAddress)
  getLogs = async () => [initializeLog(poolId, 190)]

  await assert.rejects(v4.tailV4(), /at or behind durable cursor 200/)
  assert.equal(pools.has(poolId.toLowerCase()), false)
  assert.equal(kv.get('v4_cursor'), '200')
  assert.equal(kv.get('v4_target_block'), '200')
})

test('Initialize tail permits an existing identity in the overlap window', async () => {
  markSnapshotReady(100, 200)
  const poolId = poolIdOf(TOKEN, TOKEN2, 500, 10, zeroAddress)
  pools.set(poolId.toLowerCase(), {
    pool_id: poolId.toLowerCase(),
    pool_manager: MANAGER,
    currency0: TOKEN,
    currency1: TOKEN2,
    key_fee_ppm: 500,
    tick_spacing: 10,
    hooks: zeroAddress,
    created_block: 190,
    snapshot_generation: null,
  })
  getLogs = async () => [initializeLog(poolId, 190)]

  assert.deepEqual(await v4.tailV4(), [])
  assert.equal(kv.get('v4_cursor'), '300')
  assert.equal(kv.get('v4_target_block'), '300')
})

test('Initialize with a mismatched PoolId fails without advancing the cursor', async () => {
  markSnapshotReady()
  getLogs = async () => [initializeLog(id(99) as Hex, 250)]
  await assert.rejects(v4.tailV4(), /failed PoolId round-trip verification/)
  assert.equal(kv.get('v4_cursor'), '200')
  assert.equal(kv.get('v4_target_block'), '200')
})

test('native currency metadata never generates an ERC-20 call', async () => {
  pools.set(id(1), {
    pool_id: id(1),
    pool_manager: MANAGER,
    currency0: zeroAddress,
    currency1: TOKEN,
    key_fee_ppm: null,
    tick_spacing: 10,
    hooks: zeroAddress,
    created_block: null,
  })
  assert.equal(await v4.ensureV4TokenMeta(), 2)
  assert.deepEqual(
    multicallCalls.map((call) => [call.address, call.functionName]),
    [
      [TOKEN, 'symbol'],
      [TOKEN, 'decimals'],
    ],
  )
  assert.deepEqual(tokens.get(zeroAddress), { symbol: 'BNB', decimals: 18 })
})

test('failed ERC-20 decimals stays missing and is filled on the next metadata pass', async () => {
  pools.set(id(1), {
    pool_id: id(1),
    pool_manager: MANAGER,
    currency0: zeroAddress,
    currency1: TOKEN,
    key_fee_ppm: null,
    tick_spacing: 10,
    hooks: zeroAddress,
    created_block: null,
  })
  let decimalsReady = false
  metadataResult = (calls) =>
    calls.map((call) => {
      if (call.functionName === 'symbol') return { status: 'success', result: 'TOK' }
      return decimalsReady
        ? { status: 'success', result: 6 }
        : { status: 'failure' }
    })

  assert.equal(await v4.ensureV4TokenMeta(), 1, 'only native metadata was written')
  assert.deepEqual(tokens.get(zeroAddress), { symbol: 'BNB', decimals: 18 })
  assert.equal(tokens.get(TOKEN), undefined, 'failed decimals must remain retryable')
  assert.deepEqual(
    multicallCalls.map((call) => [call.address, call.functionName]),
    [
      [TOKEN, 'symbol'],
      [TOKEN, 'decimals'],
    ],
    'address(0) is never called as ERC-20',
  )

  decimalsReady = true
  assert.equal(await v4.ensureV4TokenMeta(), 1, 'the retried ERC-20 was written')
  assert.deepEqual(tokens.get(TOKEN), { symbol: 'TOK', decimals: 6 })
})
