import assert from 'node:assert/strict'
import test, { afterEach, beforeEach, mock } from 'node:test'

type McRow = { status: 'success' | 'failure'; result?: unknown }
type Call = { functionName: string; args?: unknown[] }

const FACTORY = '0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7'
const POOL0 = '0x0000000000000000000000000000000000000010'
const POOL1 = '0x0000000000000000000000000000000000000011'
const ORPHAN_POOL = '0x0000000000000000000000000000000000000012'
const TOKEN0 = '0x0000000000000000000000000000000000000001'
const TOKEN1 = '0x0000000000000000000000000000000000000002'
const TOKEN2 = '0x0000000000000000000000000000000000000003'
const TARGET_HASH = `0x${'2'.repeat(64)}`
const LATEST_HASH = `0x${'3'.repeat(64)}`
const ORPHAN_HASH = `0x${'4'.repeat(64)}`
const DEPLOYMENT = 'QmctqZqG2SY5wvwLVBPZY8God2cW3wjNQ14Z4swKeJJX9D'

const kv = new Map<string, string>()
const inserted: Array<Record<string, unknown>> = []
let rpcBlockHash = TARGET_HASH

mock.module('./config', {
  namedExports: {
    CHAIN: { id: 56 },
    UNI: { V3_FACTORY: FACTORY },
    UNI_V3_START_BLOCK: 100,
  },
})

mock.module('./rpc', {
  namedExports: {
    pc: {
      getBlock: async () => ({ hash: rpcBlockHash }),
    },
    mc: async (calls: Call[]): Promise<McRow[]> =>
      calls.map((call) => {
        if (call.functionName === 'feeAmountTickSpacing')
          return { status: 'success', result: call.args?.[0] === 500 ? 10 : 60 }
        if (call.functionName === 'getPool') {
          const token1 = call.args?.[1]
          return { status: 'success', result: token1 === TOKEN1 ? POOL0 : POOL1 }
        }
        return { status: 'failure' }
      }),
    ok: <T>(row?: McRow): T | undefined =>
      row?.status === 'success' ? (row.result as T) : undefined,
  },
})

mock.module('./store', {
  namedExports: {
    insertPool: (pool: Record<string, unknown>) => {
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
    kvGet: (key: string) => kv.get(key),
    kvSet: (key: string, value: string) => void kv.set(key, value),
    poolCounts: () => [
      {
        proto: 'univ3',
        n: inserted.filter((row) => row.proto === 'univ3').length,
      },
    ],
    poolRow: (poolAddress: string) => {
      const row = inserted.find((candidate) => candidate.address === poolAddress)
      if (!row) return undefined
      return {
        address: row.address,
        proto: row.proto,
        token0: row.token0,
        token1: row.token1,
        fee_ppm: row.feePpm,
        tick_spacing: row.tickSpacing,
      }
    },
    tx: (fn: () => void) => fn(),
  },
})

const {
  BSC_UNI_V3_SUBGRAPH_ID,
  importBscV3Snapshot,
  hasCompleteV3GraphSnapshot,
} = await import('./v3Subgraph')

const envBefore = {
  key: process.env.THEGRAPH_API_KEY,
  id: process.env.INDEXER_V3_SUBGRAPH_ID,
  deployment: process.env.INDEXER_V3_SUBGRAPH_DEPLOYMENT,
  lag: process.env.INDEXER_V3_SUBGRAPH_MAX_LAG_BLOCKS,
}

beforeEach(() => {
  process.env.INDEXER_V3_SUBGRAPH_DEPLOYMENT = DEPLOYMENT
})

afterEach(() => {
  kv.clear()
  inserted.length = 0
  rpcBlockHash = TARGET_HASH
  mock.restoreAll()
  if (envBefore.key === undefined) delete process.env.THEGRAPH_API_KEY
  else process.env.THEGRAPH_API_KEY = envBefore.key
  if (envBefore.id === undefined) delete process.env.INDEXER_V3_SUBGRAPH_ID
  else process.env.INDEXER_V3_SUBGRAPH_ID = envBefore.id
  if (envBefore.deployment === undefined)
    delete process.env.INDEXER_V3_SUBGRAPH_DEPLOYMENT
  else process.env.INDEXER_V3_SUBGRAPH_DEPLOYMENT = envBefore.deployment
  if (envBefore.lag === undefined) delete process.env.INDEXER_V3_SUBGRAPH_MAX_LAG_BLOCKS
  else process.env.INDEXER_V3_SUBGRAPH_MAX_LAG_BLOCKS = envBefore.lag
})

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('imports one pinned complete snapshot and publishes provenance only after chain verification', async () => {
  process.env.THEGRAPH_API_KEY = 'server-secret'
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
        dexAmmProtocols: [{ id: FACTORY, network: 'BSC', totalPoolCount: '2' }],
        liquidityPools: [
          {
            id: POOL0,
            inputTokens: [{ id: TOKEN0 }, { id: TOKEN1 }],
            fees: [
              { feeType: 'FIXED_TRADING_FEE', feePercentage: '0.05' },
              { feeType: 'FIXED_LP_FEE', feePercentage: '0.04' },
            ],
            createdBlockNumber: '150',
          },
          {
            id: POOL1,
            inputTokens: [{ id: TOKEN0 }, { id: TOKEN2 }],
            fees: [
              { feeType: 'FIXED_TRADING_FEE', feePercentage: '0.3' },
              { feeType: 'FIXED_LP_FEE', feePercentage: '0.25' },
            ],
            createdBlockNumber: '160',
            },
          ],
        },
      })
    },
  )

  const result = await importBscV3Snapshot(200)

  assert.deepEqual(result, {
    added: 2,
    block: 200,
    blockHash: TARGET_HASH,
    downloaded: 2,
    deployment: DEPLOYMENT,
  })
  assert.equal(requests[1].variables.hash, TARGET_HASH, 'pages are pinned by canonical hash')
  assert.equal(inserted[0].tickSpacing, 10)
  assert.equal(inserted[1].tickSpacing, 60)
  assert.equal(inserted[0].addedTs, 0)
  assert.equal(inserted[1].addedTs, 0)
  assert.equal(inserted[0].feePpm, 500, 'factory tier comes from trading fee, not LP share')
  assert.equal(inserted[1].feePpm, 3_000)
  assert.equal(kv.get('v3_snapshot_source'), 'thegraph')
  assert.equal(kv.get('v3_snapshot_block'), '200')
  assert.equal(kv.get('v3_snapshot_block_hash'), TARGET_HASH)
  assert.equal(kv.get('v3_snapshot_pool_count'), '2')
  assert.equal(kv.get('v3_snapshot_deployment'), DEPLOYMENT)
  assert.equal(kv.get('v3_snapshot_complete'), '1')
  assert.equal(kv.get('v3_cursor'), '200')
  assert.equal(await hasCompleteV3GraphSnapshot(), true)
})

test('fails closed before network access when the server-side key is absent', async () => {
  delete process.env.THEGRAPH_API_KEY
  const fetchMock = mock.method(globalThis, 'fetch', async () => json({ data: {} }))
  await assert.rejects(
    importBscV3Snapshot(200),
    /requires server-side THEGRAPH_API_KEY; RPC full-history fallback is disabled/,
  )
  assert.equal(fetchMock.mock.callCount(), 0)
  assert.equal(await hasCompleteV3GraphSnapshot(), false)
})

test('requires an expected deployment for a custom subgraph id', async () => {
  process.env.THEGRAPH_API_KEY = 'server-secret'
  process.env.INDEXER_V3_SUBGRAPH_ID =
    '78EUqzJmEVJsAKvWghn7qotf9LVGqcTQxJhT5z84ZmgJ'
  delete process.env.INDEXER_V3_SUBGRAPH_DEPLOYMENT
  const fetchMock = mock.method(globalThis, 'fetch', async () => json({ data: {} }))

  await assert.rejects(
    importBscV3Snapshot(200),
    /custom Uniswap V3 subgraph requires INDEXER_V3_SUBGRAPH_DEPLOYMENT/,
  )
  assert.equal(fetchMock.mock.callCount(), 0)
})

test('rejects a deployment outside the reviewed identity', async () => {
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
    importBscV3Snapshot(200),
    new RegExp(`deployment ${unreviewed} is not the reviewed deployment`),
  )
  assert.equal(kv.get('v3_snapshot_complete'), undefined)
})

test('rejects an incomplete Graph page without publishing snapshot provenance', async () => {
  process.env.THEGRAPH_API_KEY = 'server-secret'
  let n = 0
  mock.method(globalThis, 'fetch', async () => {
    n++
    if (n === 1)
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
        dexAmmProtocols: [{ id: FACTORY, network: 'BSC', totalPoolCount: '2' }],
        liquidityPools: [
          {
            id: POOL0,
            inputTokens: [{ id: TOKEN0 }, { id: TOKEN1 }],
            fees: [{ feeType: 'FIXED_TRADING_FEE', feePercentage: '0.05' }],
            createdBlockNumber: '150',
          },
        ],
      },
    })
  })

  await assert.rejects(importBscV3Snapshot(200), /downloaded 1\/2 pools/)
  assert.equal(kv.get('v3_snapshot_complete'), '0')
  assert.equal(kv.get('v3_cursor'), undefined)
})

test('rejects a pool that the official factory does not return', async () => {
  process.env.THEGRAPH_API_KEY = 'server-secret'
  let n = 0
  mock.method(globalThis, 'fetch', async () => {
    n++
    if (n === 1)
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
        dexAmmProtocols: [{ id: FACTORY, network: 'BSC', totalPoolCount: '1' }],
        liquidityPools: [
          {
            id: POOL1,
            inputTokens: [{ id: TOKEN0 }, { id: TOKEN1 }],
            fees: [{ feeType: 'FIXED_TRADING_FEE', feePercentage: '0.05' }],
            createdBlockNumber: '150',
          },
        ],
      },
    })
  })

  await assert.rejects(importBscV3Snapshot(200), /failed official factory verification/)
  assert.equal(inserted.length, 0)
  assert.equal(kv.get('v3_snapshot_complete'), '0')
})

test('rejects a stale subgraph instead of turning the RPC tail into a history scan', async () => {
  process.env.THEGRAPH_API_KEY = 'server-secret'
  process.env.INDEXER_V3_SUBGRAPH_MAX_LAG_BLOCKS = '10'
  const fetchMock = mock.method(globalThis, 'fetch', async () =>
    json({
      data: {
        _meta: {
          block: { number: 150, hash: LATEST_HASH },
          deployment: DEPLOYMENT,
          hasIndexingErrors: false,
        },
      },
    }),
  )

  await assert.rejects(importBscV3Snapshot(200), /lags the finalized chain head by 50 blocks/)
  assert.equal(fetchMock.mock.callCount(), 1)
  assert.equal(kv.get('v3_snapshot_complete'), undefined)
})

test('rejects a Graph head whose hash is not canonical before downloading pages', async () => {
  process.env.THEGRAPH_API_KEY = 'server-secret'
  const fetchMock = mock.method(globalThis, 'fetch', async () =>
    json({
      data: {
        _meta: {
          block: { number: 200, hash: ORPHAN_HASH },
          deployment: DEPLOYMENT,
          hasIndexingErrors: false,
        },
      },
    }),
  )

  await assert.rejects(
    importBscV3Snapshot(200),
    /does not match canonical RPC hash/,
  )
  assert.equal(fetchMock.mock.callCount(), 1)
  assert.equal(kv.get('v3_snapshot_complete'), undefined)
})

test('a stored canonical mismatch requests replacement without deleting before download', async () => {
  inserted.push({
    address: POOL0,
    proto: 'univ3',
    token0: TOKEN0,
    token1: TOKEN1,
    feePpm: 500,
    tickSpacing: 10,
    snapshotGeneration: 'old',
  })
  kv.set('v3_snapshot_source', 'thegraph')
  kv.set('v3_snapshot_block', '200')
  kv.set('v3_snapshot_block_hash', TARGET_HASH)
  kv.set('v3_snapshot_pool_count', '1')
  kv.set('v3_snapshot_subgraph_id', BSC_UNI_V3_SUBGRAPH_ID)
  kv.set('v3_snapshot_deployment', DEPLOYMENT)
  kv.set('v3_snapshot_complete', '1')
  kv.set('v3_cursor', '220')
  rpcBlockHash = ORPHAN_HASH

  assert.equal(await hasCompleteV3GraphSnapshot(), false)
  assert.equal(inserted.length, 1, 'the hash check performs no destructive mutation')
})

test('canonical mismatch rebuild publishes only candidates observed in the new generation', async () => {
  process.env.THEGRAPH_API_KEY = 'server-secret'
  inserted.push({
    address: ORPHAN_POOL,
    proto: 'univ3',
    token0: TOKEN0,
    token1: TOKEN2,
    feePpm: 3_000,
    tickSpacing: 60,
    snapshotGeneration: 'orphan-generation',
  })
  kv.set('v3_snapshot_source', 'thegraph')
  kv.set('v3_snapshot_block', '200')
  kv.set('v3_snapshot_block_hash', TARGET_HASH)
  kv.set('v3_snapshot_pool_count', '1')
  kv.set('v3_snapshot_subgraph_id', BSC_UNI_V3_SUBGRAPH_ID)
  kv.set('v3_snapshot_deployment', DEPLOYMENT)
  kv.set('v3_snapshot_complete', '1')
  kv.set('v3_cursor', '220')
  rpcBlockHash = ORPHAN_HASH

  let request = 0
  mock.method(globalThis, 'fetch', async () => {
    request++
    if (request === 1)
      return json({
        data: {
          _meta: {
            block: { number: 200, hash: ORPHAN_HASH },
            deployment: DEPLOYMENT,
            hasIndexingErrors: false,
          },
        },
      })
    return json({
      data: {
        _meta: {
          block: { number: 200, hash: ORPHAN_HASH },
          deployment: DEPLOYMENT,
          hasIndexingErrors: false,
        },
        dexAmmProtocols: [
          { id: FACTORY, network: 'BSC', totalPoolCount: '1' },
        ],
        liquidityPools: [
          {
            id: POOL0,
            inputTokens: [{ id: TOKEN0 }, { id: TOKEN1 }],
            fees: [
              { feeType: 'FIXED_TRADING_FEE', feePercentage: '0.05' },
            ],
            createdBlockNumber: '150',
          },
        ],
      },
    })
  })

  assert.equal(await hasCompleteV3GraphSnapshot(), false)
  await importBscV3Snapshot(200)

  assert.deepEqual(
    inserted.map((row) => row.address),
    [POOL0],
  )
  assert.equal(kv.get('v3_snapshot_block_hash'), ORPHAN_HASH)
  assert.equal(kv.get('v3_snapshot_complete'), '1')
  assert.equal(kv.get('v3_snapshot_import_generation'), '')
})

test('rejects duplicate or out-of-order pool ids inside one page', async () => {
  process.env.THEGRAPH_API_KEY = 'server-secret'
  let n = 0
  mock.method(globalThis, 'fetch', async () => {
    n++
    if (n === 1)
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
        dexAmmProtocols: [{ id: FACTORY, network: 'BSC', totalPoolCount: '2' }],
        liquidityPools: [
          {
            id: POOL1,
            inputTokens: [{ id: TOKEN0 }, { id: TOKEN2 }],
            fees: [{ feeType: 'FIXED_TRADING_FEE', feePercentage: '0.3' }],
            createdBlockNumber: '160',
          },
          {
            id: POOL0,
            inputTokens: [{ id: TOKEN0 }, { id: TOKEN1 }],
            fees: [{ feeType: 'FIXED_TRADING_FEE', feePercentage: '0.05' }],
            createdBlockNumber: '150',
          },
        ],
      },
    })
  })

  await assert.rejects(importBscV3Snapshot(200), /not strictly ordered by pool id/)
  assert.equal(inserted.length, 0)
  assert.equal(kv.get('v3_snapshot_complete'), '0')
})
