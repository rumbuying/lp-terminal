import assert from 'node:assert/strict'
import test, { afterEach, beforeEach, mock } from 'node:test'

type McRow = { status: 'success' | 'failure'; result?: unknown }
type Call = { functionName: string; address?: string; args?: unknown[] }
type StoredPool = {
  address: string
  proto: string
  token0: string
  token1: string
  feePpm: number
  tickSpacing: number
  createdBlock: number
  snapshotGeneration?: string
  addedTs?: number
}

const FACTORY = '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865'
const POOL0 = '0x0000000000000000000000000000000000000010'
const POOL1 = '0x0000000000000000000000000000000000000011'
const ORPHAN_POOL = '0x0000000000000000000000000000000000000012'
const TOKEN0 = '0x0000000000000000000000000000000000000001'
const TOKEN1 = '0x0000000000000000000000000000000000000002'
const TOKEN2 = '0x0000000000000000000000000000000000000003'
const LATEST_HASH = `0x${'a'.repeat(64)}`
const TARGET_HASH = `0x${'b'.repeat(64)}`
const SUBGRAPH = '78EUqzJmEVJsAKvWghn7qotf9LVGqcTQxJhT5z84ZmgJ'
const DEPLOYMENT = 'QmQhHo4B63yqxLsqFTMjEF6VQJ6xYorn6k5r5a8takVnJQ'
const ZERO = '0x0000000000000000000000000000000000000000'
const OLD_ROW_GENERATION = '11111111-1111-4111-8111-111111111111'
const RESUME_ROW_GENERATION = '22222222-2222-4222-8222-222222222222'

const kv = new Map<string, string>()
const inserted: StoredPool[] = []
let canonicalHash = TARGET_HASH
let canonicalHashSequence: string[] = []
let canonicalError: Error | null = null
let rejectFactoryIdentity = false

mock.module('./config', {
  namedExports: {
    ADDR: { CL_FACTORY: FACTORY },
    CHAIN: { id: 56 },
    PANCAKE_V3_START_BLOCK: 100,
    sleep: async () => {},
  },
})

mock.module('./rpc', {
  namedExports: {
    mc: async (calls: Call[]): Promise<McRow[]> =>
      calls.map((call) => {
        if (call.functionName === 'token0')
          return { status: 'success', result: TOKEN0 }
        if (call.functionName === 'token1')
          return {
            status: 'success',
            result: call.address?.toLowerCase() === POOL0 ? TOKEN1 : TOKEN2,
          }
        if (call.functionName === 'fee')
          return {
            status: 'success',
            result: call.address?.toLowerCase() === POOL0 ? 100 : 2_500,
          }
        if (call.functionName === 'tickSpacing')
          return {
            status: 'success',
            result: call.address?.toLowerCase() === POOL0 ? 1 : 50,
          }
        if (call.functionName === 'feeAmountTickSpacing')
          return {
            status: 'success',
            result: call.args?.[0] === 100 ? 1 : 50,
          }
        if (call.functionName === 'getPool')
          return {
            status: 'success',
            result: rejectFactoryIdentity
              ? '0x0000000000000000000000000000000000000000'
              : call.args?.[1] === TOKEN1
                ? POOL0
                : POOL1,
          }
        return { status: 'failure' }
      }),
    ok: <T>(row?: McRow): T | undefined =>
      row?.status === 'success' ? (row.result as T) : undefined,
    pc: {
      getBlock: async () => {
        if (canonicalError) throw canonicalError
        return { hash: canonicalHashSequence.shift() ?? canonicalHash }
      },
    },
  },
})

mock.module('./store', {
  namedExports: {
    insertPool: (pool: StoredPool) => {
      if (inserted.some((row) => row.address === pool.address)) return false
      inserted.push(pool)
      return true
    },
    setPoolSnapshotGeneration: (
      poolAddress: string,
      proto: string,
      generation: string,
    ) => {
      const row = inserted.find(
        (candidate) =>
          candidate.address === poolAddress && candidate.proto === proto,
      )
      if (!row) throw new Error('cannot mark missing pool snapshot generation')
      row.snapshotGeneration = generation
    },
    deletePoolsOutsideSnapshotGeneration: (
      proto: string,
      generation: string,
    ) => {
      let deleted = 0
      for (let index = inserted.length - 1; index >= 0; index--) {
        const row = inserted[index]
        if (row.proto === proto && row.snapshotGeneration !== generation) {
          inserted.splice(index, 1)
          deleted++
        }
      }
      return deleted
    },
    deletePoolSnapshotGeneration: (
      proto: string,
      generation: string,
    ) => {
      let deleted = 0
      for (let index = inserted.length - 1; index >= 0; index--) {
        const row = inserted[index]
        if (row.proto === proto && row.snapshotGeneration === generation) {
          inserted.splice(index, 1)
          deleted++
        }
      }
      return deleted
    },
    kvGet: (key: string) => kv.get(key),
    kvSet: (key: string, value: string) => void kv.set(key, value),
    poolCounts: () => [
      {
        proto: 'pancakev3',
        n: inserted.filter((row) => row.proto === 'pancakev3').length,
      },
    ],
    poolRow: (id: string) => {
      const row = inserted.find((pool) => pool.address === id)
      return row
        ? {
            address: row.address,
            proto: row.proto,
            token0: row.token0,
            token1: row.token1,
            fee_ppm: row.feePpm,
            tick_spacing: row.tickSpacing,
          }
        : undefined
    },
    tx: (fn: () => void) => fn(),
  },
})

const {
  hasCompletePancakeV3GraphSnapshot,
  importBscPancakeV3Snapshot,
} = await import('./pancakeV3Subgraph')

const envBefore = {
  key: process.env.THEGRAPH_API_KEY,
  id: process.env.INDEXER_PANCAKE_V3_SUBGRAPH_ID,
  deployment: process.env.INDEXER_PANCAKE_V3_SUBGRAPH_DEPLOYMENT,
  lag: process.env.INDEXER_PANCAKE_V3_SUBGRAPH_MAX_LAG_BLOCKS,
}

beforeEach(() => {
  process.env.INDEXER_PANCAKE_V3_SUBGRAPH_DEPLOYMENT = DEPLOYMENT
})

afterEach(() => {
  kv.clear()
  inserted.length = 0
  canonicalHash = TARGET_HASH
  canonicalHashSequence = []
  canonicalError = null
  rejectFactoryIdentity = false
  mock.restoreAll()
  if (envBefore.key === undefined) delete process.env.THEGRAPH_API_KEY
  else process.env.THEGRAPH_API_KEY = envBefore.key
  if (envBefore.id === undefined)
    delete process.env.INDEXER_PANCAKE_V3_SUBGRAPH_ID
  else process.env.INDEXER_PANCAKE_V3_SUBGRAPH_ID = envBefore.id
  if (envBefore.deployment === undefined)
    delete process.env.INDEXER_PANCAKE_V3_SUBGRAPH_DEPLOYMENT
  else
    process.env.INDEXER_PANCAKE_V3_SUBGRAPH_DEPLOYMENT = envBefore.deployment
  if (envBefore.lag === undefined)
    delete process.env.INDEXER_PANCAKE_V3_SUBGRAPH_MAX_LAG_BLOCKS
  else process.env.INDEXER_PANCAKE_V3_SUBGRAPH_MAX_LAG_BLOCKS = envBefore.lag
})

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const graphPool = (
  id: string,
  createdBlockNumber: string,
) => ({
  id,
  createdBlockNumber,
})

test('imports a canonical hash-pinned Pancake V3 snapshot and publishes provenance', async () => {
  process.env.THEGRAPH_API_KEY = 'server-secret'
  const requests: Array<{
    query: string
    variables: Record<string, unknown>
  }> = []
  mock.method(
    globalThis,
    'fetch',
    async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        query: string
        variables: Record<string, unknown>
      }
      requests.push(request)
      if (requests.length === 1)
        return json({
          data: {
            _meta: {
              block: { number: 220, hash: LATEST_HASH },
              deployment: DEPLOYMENT,
              hasIndexingErrors: false,
            },
          },
        })
      return json({
        data: {
          _meta: {
            block: { number: 200, hash: TARGET_HASH },
            deployment: DEPLOYMENT,
            hasIndexingErrors: false,
          },
          dexAmmProtocols: [
            { id: FACTORY, network: 'BSC', totalPoolCount: '2' },
          ],
          liquidityPools: [
            graphPool(POOL0, '150'),
            graphPool(POOL1, '160'),
          ],
        },
      })
    },
  )

  const result = await importBscPancakeV3Snapshot(200)

  assert.deepEqual(result, {
    added: 2,
    block: 200,
    blockHash: TARGET_HASH,
    downloaded: 2,
    deployment: DEPLOYMENT,
  })
  assert.equal(requests[1].variables.hash, TARGET_HASH)
  assert.doesNotMatch(
    requests[1].query,
    /inputTokens|fees\s*\{/,
    'large Graph pages carry candidate addresses only',
  )
  assert.equal(inserted[0].proto, 'pancakev3')
  assert.equal(inserted[0].tickSpacing, 1)
  assert.equal(inserted[1].tickSpacing, 50)
  assert.equal(inserted[0].addedTs, 0)
  assert.equal(inserted[1].addedTs, 0)
  assert.equal(inserted[1].feePpm, 2_500)
  assert.equal(kv.get('pancake_v3_snapshot_source'), 'thegraph')
  assert.equal(kv.get('pancake_v3_snapshot_block_hash'), TARGET_HASH)
  assert.equal(kv.get('pancake_v3_snapshot_pool_count'), '2')
  assert.equal(kv.get('pancake_v3_cursor'), '200')
  assert.match(
    kv.get('pancake_v3_snapshot_row_generation') ?? '',
    /^[0-9a-f-]{36}$/,
  )
  assert.equal(
    inserted[0].snapshotGeneration,
    kv.get('pancake_v3_snapshot_row_generation'),
  )
  assert.equal(await hasCompletePancakeV3GraphSnapshot(), true)
})

test('retries transient Graph indexer errors inside the pinned page request', async () => {
  process.env.THEGRAPH_API_KEY = 'server-secret'
  let request = 0
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    request++
    if (request === 1)
      return json({
        errors: [
          {
            message:
              'bad indexers: {0x1234: BadResponse(expected value at line 1 column 1)}',
          },
        ],
      })
    if (request === 2)
      return json({
        data: {
          _meta: {
            block: { number: 200, hash: TARGET_HASH },
            deployment: DEPLOYMENT,
            hasIndexingErrors: false,
          },
        },
      })
    return json({
      data: {
        _meta: {
          block: { number: 200, hash: TARGET_HASH },
          deployment: DEPLOYMENT,
          hasIndexingErrors: false,
        },
        dexAmmProtocols: [
          { id: FACTORY, network: 'BSC', totalPoolCount: '1' },
        ],
        liquidityPools: [graphPool(POOL0, '150')],
      },
    })
  })

  const result = await importBscPancakeV3Snapshot(200)

  assert.equal(result.downloaded, 1)
  assert.equal(fetchMock.mock.callCount(), 3)
  assert.equal(kv.get('pancake_v3_snapshot_complete'), '1')
})

test('does not retry non-transient GraphQL errors', async () => {
  process.env.THEGRAPH_API_KEY = 'server-secret'
  const fetchMock = mock.method(globalThis, 'fetch', async () =>
    json({ errors: [{ message: 'Cannot query field "unknown"' }] }),
  )

  await assert.rejects(
    importBscPancakeV3Snapshot(200),
    /Cannot query field "unknown"/,
  )
  assert.equal(fetchMock.mock.callCount(), 1)
})

test('a stored canonical mismatch requests replacement without eager deletion', async () => {
  inserted.push({
    address: POOL0,
    proto: 'pancakev3',
    token0: TOKEN0,
    token1: TOKEN1,
    feePpm: 100,
    tickSpacing: 1,
    createdBlock: 150,
    snapshotGeneration: OLD_ROW_GENERATION,
  })
  kv.set('pancake_v3_snapshot_source', 'thegraph')
  kv.set('pancake_v3_snapshot_complete', '1')
  kv.set('pancake_v3_snapshot_block', '200')
  kv.set('pancake_v3_snapshot_block_hash', LATEST_HASH)
  kv.set('pancake_v3_snapshot_pool_count', '1')
  kv.set('pancake_v3_snapshot_row_generation', OLD_ROW_GENERATION)
  kv.set('pancake_v3_snapshot_subgraph_id', SUBGRAPH)
  kv.set('pancake_v3_snapshot_deployment', DEPLOYMENT)
  kv.set('pancake_v3_cursor', '250')
  canonicalHash = TARGET_HASH

  assert.equal(await hasCompletePancakeV3GraphSnapshot(), false)
  assert.equal(inserted.length, 1, 'the hash check performs no destructive mutation')
})

test('a transient canonical RPC error preserves the previous generation', async () => {
  inserted.push({
    address: POOL0,
    proto: 'pancakev3',
    token0: TOKEN0,
    token1: TOKEN1,
    feePpm: 100,
    tickSpacing: 1,
    createdBlock: 150,
    snapshotGeneration: OLD_ROW_GENERATION,
  })
  kv.set('pancake_v3_snapshot_source', 'thegraph')
  kv.set('pancake_v3_snapshot_complete', '1')
  kv.set('pancake_v3_snapshot_block', '200')
  kv.set('pancake_v3_snapshot_block_hash', TARGET_HASH)
  kv.set('pancake_v3_snapshot_pool_count', '1')
  kv.set('pancake_v3_snapshot_row_generation', OLD_ROW_GENERATION)
  kv.set('pancake_v3_snapshot_subgraph_id', SUBGRAPH)
  kv.set('pancake_v3_snapshot_deployment', DEPLOYMENT)
  kv.set('pancake_v3_cursor', '250')
  canonicalError = new Error('RPC temporarily unavailable')

  await assert.rejects(
    hasCompletePancakeV3GraphSnapshot(),
    /RPC temporarily unavailable/,
  )
  assert.equal(inserted.length, 1)
  assert.equal(kv.get('pancake_v3_snapshot_complete'), '1')
})

test('canonical mismatch rebuild prunes absent old and tail candidates atomically', async () => {
  process.env.THEGRAPH_API_KEY = 'server-secret'
  inserted.push({
    address: ORPHAN_POOL,
    proto: 'pancakev3',
    token0: TOKEN0,
    token1: TOKEN2,
    feePpm: 2_500,
    tickSpacing: 50,
    createdBlock: 210,
    snapshotGeneration: OLD_ROW_GENERATION,
  })
  kv.set('pancake_v3_snapshot_source', 'thegraph')
  kv.set('pancake_v3_snapshot_complete', '1')
  kv.set('pancake_v3_snapshot_block', '200')
  kv.set('pancake_v3_snapshot_block_hash', LATEST_HASH)
  kv.set('pancake_v3_snapshot_pool_count', '1')
  kv.set('pancake_v3_snapshot_row_generation', OLD_ROW_GENERATION)
  kv.set('pancake_v3_snapshot_subgraph_id', SUBGRAPH)
  kv.set('pancake_v3_snapshot_deployment', DEPLOYMENT)
  kv.set('pancake_v3_cursor', '250')
  canonicalHash = TARGET_HASH

  let request = 0
  mock.method(globalThis, 'fetch', async () => {
    request++
    if (request === 1)
      return json({
        data: {
          _meta: {
            block: { number: 200, hash: TARGET_HASH },
            deployment: DEPLOYMENT,
            hasIndexingErrors: false,
          },
        },
      })
    return json({
      data: {
        _meta: {
          block: { number: 200, hash: TARGET_HASH },
          deployment: DEPLOYMENT,
          hasIndexingErrors: false,
        },
        dexAmmProtocols: [
          { id: FACTORY, network: 'BSC', totalPoolCount: '1' },
        ],
        liquidityPools: [graphPool(POOL0, '150')],
      },
    })
  })

  assert.equal(await hasCompletePancakeV3GraphSnapshot(), false)
  await importBscPancakeV3Snapshot(200)

  assert.deepEqual(
    inserted.map((row) => row.address),
    [POOL0],
  )
  assert.equal(kv.get('pancake_v3_snapshot_block_hash'), TARGET_HASH)
  assert.equal(kv.get('pancake_v3_snapshot_complete'), '1')
  assert.notEqual(
    kv.get('pancake_v3_snapshot_row_generation'),
    OLD_ROW_GENERATION,
  )
})

test('fails closed without a server-side Graph key', async () => {
  delete process.env.THEGRAPH_API_KEY
  const fetchMock = mock.method(globalThis, 'fetch', async () => json({ data: {} }))
  await assert.rejects(
    importBscPancakeV3Snapshot(200),
    /requires server-side THEGRAPH_API_KEY/,
  )
  assert.equal(fetchMock.mock.callCount(), 0)
})

test('rejects a Graph block hash that is not canonical on RPC', async () => {
  process.env.THEGRAPH_API_KEY = 'server-secret'
  canonicalHash = TARGET_HASH
  mock.method(globalThis, 'fetch', async () =>
    json({
      data: {
        _meta: {
          block: { number: 200, hash: LATEST_HASH },
          deployment: DEPLOYMENT,
          hasIndexingErrors: false,
        },
      },
    }),
  )
  await assert.rejects(
    importBscPancakeV3Snapshot(200),
    /does not match canonical RPC hash/,
  )
  assert.equal(kv.get('pancake_v3_snapshot_complete'), undefined)
})

test('rechecks canonical hash after all pages before publishing a generation', async () => {
  process.env.THEGRAPH_API_KEY = 'server-secret'
  canonicalHashSequence = [TARGET_HASH, LATEST_HASH]
  let request = 0
  mock.method(globalThis, 'fetch', async () => {
    request++
    if (request === 1)
      return json({
        data: {
          _meta: {
            block: { number: 200, hash: TARGET_HASH },
            deployment: DEPLOYMENT,
            hasIndexingErrors: false,
          },
        },
      })
    return json({
      data: {
        _meta: {
          block: { number: 200, hash: TARGET_HASH },
          deployment: DEPLOYMENT,
          hasIndexingErrors: false,
        },
        dexAmmProtocols: [
          { id: FACTORY, network: 'BSC', totalPoolCount: '1' },
        ],
        liquidityPools: [graphPool(POOL0, '150')],
      },
    })
  })

  await assert.rejects(
    importBscPancakeV3Snapshot(200),
    /does not match canonical RPC hash/,
  )
  assert.equal(kv.get('pancake_v3_snapshot_complete'), '0')
  assert.equal(kv.get('pancake_v3_snapshot_source'), undefined)
  assert.equal(inserted.length, 1, 'partial rows remain checkpointed for safe retry')
})

test('rejects a stale deployment instead of attempting a huge RPC tail', async () => {
  process.env.THEGRAPH_API_KEY = 'server-secret'
  process.env.INDEXER_PANCAKE_V3_SUBGRAPH_MAX_LAG_BLOCKS = '5'
  mock.method(globalThis, 'fetch', async () =>
    json({
      data: {
        _meta: {
          block: { number: 190, hash: LATEST_HASH },
          deployment: DEPLOYMENT,
          hasIndexingErrors: false,
        },
      },
    }),
  )
  await assert.rejects(
    importBscPancakeV3Snapshot(200),
    /lags the finalized chain head by 10 blocks; maximum is 5/,
  )
  assert.equal(kv.get('pancake_v3_snapshot_complete'), undefined)
})

test('requires an explicitly reviewed content-addressed deployment', async () => {
  process.env.THEGRAPH_API_KEY = 'server-secret'
  const unreviewed = 'QmY67iZDTsTdpWXSCotpVPYankwnyHXNT7N95YEn8ccUsn'
  mock.method(globalThis, 'fetch', async () =>
    json({
      data: {
        _meta: {
          block: { number: 200, hash: TARGET_HASH },
          deployment: unreviewed,
          hasIndexingErrors: false,
        },
      },
    }),
  )
  await assert.rejects(
    importBscPancakeV3Snapshot(200),
    new RegExp(`deployment ${unreviewed} is not the reviewed deployment`),
  )
  assert.equal(kv.get('pancake_v3_snapshot_complete'), undefined)
})

test('does not publish an incomplete snapshot', async () => {
  process.env.THEGRAPH_API_KEY = 'server-secret'
  let request = 0
  mock.method(globalThis, 'fetch', async () => {
    request++
    if (request === 1)
      return json({
        data: {
          _meta: {
            block: { number: 200, hash: TARGET_HASH },
            deployment: DEPLOYMENT,
            hasIndexingErrors: false,
          },
        },
      })
    return json({
      data: {
        _meta: {
          block: { number: 200, hash: TARGET_HASH },
          deployment: DEPLOYMENT,
          hasIndexingErrors: false,
        },
        dexAmmProtocols: [
          { id: FACTORY, network: 'BSC', totalPoolCount: '2' },
        ],
        liquidityPools: [graphPool(POOL0, '150')],
      },
    })
  })

  await assert.rejects(
    importBscPancakeV3Snapshot(200),
    /incomplete: downloaded 1\/2 pools/,
  )
  assert.equal(kv.get('pancake_v3_snapshot_complete'), '0')
  assert.equal(kv.get('pancake_v3_cursor'), undefined)
})

test('rejects an address candidate that the official factory does not own', async () => {
  process.env.THEGRAPH_API_KEY = 'server-secret'
  rejectFactoryIdentity = true
  let request = 0
  mock.method(globalThis, 'fetch', async () => {
    request++
    if (request === 1)
      return json({
        data: {
          _meta: {
            block: { number: 200, hash: TARGET_HASH },
            deployment: DEPLOYMENT,
            hasIndexingErrors: false,
          },
        },
      })
    return json({
      data: {
        _meta: {
          block: { number: 200, hash: TARGET_HASH },
          deployment: DEPLOYMENT,
          hasIndexingErrors: false,
        },
        dexAmmProtocols: [
          { id: FACTORY, network: 'BSC', totalPoolCount: '1' },
        ],
        liquidityPools: [graphPool(POOL0, '150')],
      },
    })
  })

  await assert.rejects(
    importBscPancakeV3Snapshot(200),
    /failed official factory verification/,
  )
  assert.equal(inserted.length, 0)
  assert.equal(kv.get('pancake_v3_snapshot_complete'), '0')
})

test('resumes the same immutable generation from its atomic page checkpoint', async () => {
  process.env.THEGRAPH_API_KEY = 'server-secret'
  inserted.push({
    address: POOL0,
    proto: 'pancakev3',
    token0: TOKEN0,
    token1: TOKEN1,
    feePpm: 100,
    tickSpacing: 1,
    createdBlock: 150,
    snapshotGeneration: RESUME_ROW_GENERATION,
  })
  const generation = `${SUBGRAPH}\n${DEPLOYMENT}\n200\n${TARGET_HASH}`
  kv.set('pancake_v3_snapshot_import_generation', generation)
  kv.set(
    'pancake_v3_snapshot_import_row_generation',
    RESUME_ROW_GENERATION,
  )
  kv.set('pancake_v3_snapshot_import_subgraph_id', SUBGRAPH)
  kv.set('pancake_v3_snapshot_import_block', '200')
  kv.set('pancake_v3_snapshot_import_block_hash', TARGET_HASH)
  kv.set('pancake_v3_snapshot_import_deployment', DEPLOYMENT)
  kv.set('pancake_v3_snapshot_import_after', POOL0)
  kv.set('pancake_v3_snapshot_import_downloaded', '1')
  kv.set('pancake_v3_snapshot_import_pool_count', '2')
  kv.set('pancake_v3_snapshot_complete', '0')
  let request = 0
  mock.method(
    globalThis,
    'fetch',
    async (_url: string | URL | Request, init?: RequestInit) => {
    request++
    if (request === 1)
      return json({
        data: {
          _meta: {
            block: { number: 220, hash: LATEST_HASH },
            deployment: DEPLOYMENT,
            hasIndexingErrors: false,
          },
        },
      })
    const body = JSON.parse(String(init?.body)) as {
      variables: Record<string, unknown>
    }
    assert.equal(body.variables.after, POOL0)
    return json({
      data: {
        _meta: {
          block: { number: 200, hash: TARGET_HASH },
          deployment: DEPLOYMENT,
          hasIndexingErrors: false,
        },
        dexAmmProtocols: [
          { id: FACTORY, network: 'BSC', totalPoolCount: '2' },
        ],
        liquidityPools: [graphPool(POOL1, '160')],
      },
    })
    },
  )

  const result = await importBscPancakeV3Snapshot(220)
  assert.equal(result.added, 1)
  assert.equal(result.block, 200, 'moving Graph head reuses the durable pinned generation')
  assert.equal(result.downloaded, 2)
  assert.equal(inserted.length, 2)
  assert.equal(await hasCompletePancakeV3GraphSnapshot(), true)
})

test('orphaned resumable generation is discarded before a fresh canonical import', async () => {
  process.env.THEGRAPH_API_KEY = 'server-secret'
  inserted.push({
    address: POOL0,
    proto: 'pancakev3',
    token0: TOKEN0,
    token1: TOKEN1,
    feePpm: 100,
    tickSpacing: 1,
    createdBlock: 150,
    snapshotGeneration: RESUME_ROW_GENERATION,
  })
  const orphanGeneration = `${SUBGRAPH}\n${DEPLOYMENT}\n200\n${LATEST_HASH}`
  kv.set('pancake_v3_snapshot_import_generation', orphanGeneration)
  kv.set(
    'pancake_v3_snapshot_import_row_generation',
    RESUME_ROW_GENERATION,
  )
  kv.set('pancake_v3_snapshot_import_subgraph_id', SUBGRAPH)
  kv.set('pancake_v3_snapshot_import_block', '200')
  kv.set('pancake_v3_snapshot_import_block_hash', LATEST_HASH)
  kv.set('pancake_v3_snapshot_import_deployment', DEPLOYMENT)
  kv.set('pancake_v3_snapshot_import_after', POOL0)
  kv.set('pancake_v3_snapshot_import_downloaded', '1')
  kv.set('pancake_v3_snapshot_import_pool_count', '2')
  kv.set('pancake_v3_snapshot_complete', '0')
  canonicalHash = TARGET_HASH

  let request = 0
  mock.method(
    globalThis,
    'fetch',
    async (_url: string | URL | Request, init?: RequestInit) => {
      request++
      if (request === 1)
        return json({
          data: {
            _meta: {
              block: { number: 200, hash: TARGET_HASH },
              deployment: DEPLOYMENT,
              hasIndexingErrors: false,
            },
          },
        })
      const body = JSON.parse(String(init?.body)) as {
        variables: Record<string, unknown>
      }
      assert.equal(
        body.variables.after,
        ZERO,
        'orphan progress must restart from page one',
      )
      assert.equal(
        inserted.some((row) => row.address === POOL0),
        false,
        'orphan partial rows are removed before the replacement download',
      )
      return json({
        data: {
          _meta: {
            block: { number: 200, hash: TARGET_HASH },
            deployment: DEPLOYMENT,
            hasIndexingErrors: false,
          },
          dexAmmProtocols: [
            { id: FACTORY, network: 'BSC', totalPoolCount: '1' },
          ],
          liquidityPools: [graphPool(POOL1, '160')],
        },
      })
    },
  )

  const result = await importBscPancakeV3Snapshot(200)

  assert.equal(result.downloaded, 1)
  assert.deepEqual(
    inserted.map((row) => row.address),
    [POOL1],
  )
  assert.notEqual(
    kv.get('pancake_v3_snapshot_row_generation'),
    RESUME_ROW_GENERATION,
  )
  assert.equal(kv.get('pancake_v3_snapshot_complete'), '1')
})

test('resumable checkpoint survives a transient canonical RPC failure unchanged', async () => {
  process.env.THEGRAPH_API_KEY = 'server-secret'
  inserted.push({
    address: POOL0,
    proto: 'pancakev3',
    token0: TOKEN0,
    token1: TOKEN1,
    feePpm: 100,
    tickSpacing: 1,
    createdBlock: 150,
    snapshotGeneration: RESUME_ROW_GENERATION,
  })
  const generation = `${SUBGRAPH}\n${DEPLOYMENT}\n200\n${TARGET_HASH}`
  kv.set('pancake_v3_snapshot_import_generation', generation)
  kv.set(
    'pancake_v3_snapshot_import_row_generation',
    RESUME_ROW_GENERATION,
  )
  kv.set('pancake_v3_snapshot_import_subgraph_id', SUBGRAPH)
  kv.set('pancake_v3_snapshot_import_block', '200')
  kv.set('pancake_v3_snapshot_import_block_hash', TARGET_HASH)
  kv.set('pancake_v3_snapshot_import_deployment', DEPLOYMENT)
  kv.set('pancake_v3_snapshot_import_after', POOL0)
  kv.set('pancake_v3_snapshot_import_downloaded', '1')
  kv.set('pancake_v3_snapshot_import_pool_count', '2')
  kv.set('pancake_v3_snapshot_complete', '0')
  canonicalError = new Error('RPC temporarily unavailable')
  mock.method(globalThis, 'fetch', async () =>
    json({
      data: {
        _meta: {
          block: { number: 220, hash: LATEST_HASH },
          deployment: DEPLOYMENT,
          hasIndexingErrors: false,
        },
      },
    }),
  )

  await assert.rejects(
    importBscPancakeV3Snapshot(220),
    /RPC temporarily unavailable/,
  )
  assert.equal(inserted.length, 1)
  assert.equal(
    kv.get('pancake_v3_snapshot_import_generation'),
    generation,
  )
  assert.equal(kv.get('pancake_v3_snapshot_import_after'), POOL0)
  assert.equal(kv.get('pancake_v3_snapshot_import_downloaded'), '1')
})
