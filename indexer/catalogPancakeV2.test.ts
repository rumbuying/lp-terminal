import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'

type McRow = { status: 'success' | 'failure'; result?: unknown }
type InsertedPool = {
  address: string
  proto: string
  token0: string
  token1: string
  feePpm: number
  pairIndex?: number
}

const UNI_FACTORY = '0x0000000000000000000000000000000000000001'
const PANCAKE_FACTORY = '0x0000000000000000000000000000000000000002'
const PAIR0 = '0x0000000000000000000000000000000000000010'
const PAIR1 = '0x0000000000000000000000000000000000000011'
const PAIR2 = '0x0000000000000000000000000000000000000012'
const TOKEN0 = '0x0000000000000000000000000000000000000020'
const TOKEN1 = '0x0000000000000000000000000000000000000021'

const kv = new Map<string, string>()
const inserted: InsertedPool[] = []
const factoryCounts = new Map<string, bigint>()
let mcResponses: McRow[][] = []
const multicallRequests: Array<Array<{ address: string; functionName: string; args?: readonly unknown[] }>> = []

mock.module('./config', {
  namedExports: {
    ADDR: { V2_FACTORY: PANCAKE_FACTORY, CL_FACTORY: PANCAKE_FACTORY },
    BLOCKSCOUT: 'https://explorer.invalid',
    CHAIN: { id: 56, explorer: { api: 'etherscan', name: 'BscScan' } },
    INDEXER_FINALITY_BLOCKS: 0,
    UNI: { V2_FACTORY: UNI_FACTORY, V3_FACTORY: PANCAKE_FACTORY },
    UNI_V3_START_BLOCK: 0,
    PANCAKE_V3_START_BLOCK: 0,
    log: () => undefined,
    sleep: async () => undefined,
  },
})

mock.module('./rpc', {
  namedExports: {
    pc: {
      readContract: async ({ address }: { address: string }) =>
        factoryCounts.get(address.toLowerCase()) ?? 0n,
      getBlockNumber: async () => 0n,
      getLogs: async () => [],
    },
    withRotatingRpcClient: async <T>(request: (client: { getLogs: () => Promise<unknown[]> }) => Promise<T>) =>
      request({ getLogs: async () => [] }),
    mc: async (requests: Array<{ address: string; functionName: string; args?: readonly unknown[] }>) => {
      multicallRequests.push(requests)
      return mcResponses.shift() ?? []
    },
    ok: <T>(row: McRow | undefined): T | undefined =>
      row?.status === 'success' ? (row.result as T) : undefined,
  },
})

mock.module('./store', {
  namedExports: {
    insertPool: (pool: InsertedPool) => {
      inserted.push(pool)
      return true
    },
    kvGet: (key: string) => kv.get(key),
    kvSet: (key: string, value: string) => void kv.set(key, value),
    tx: (fn: () => void) => fn(),
  },
})

mock.module('./v3Subgraph', {
  namedExports: {
    hasCompleteV3GraphSnapshot: async () => false,
    importBscV3Snapshot: async () => {
      throw new Error('not used by v2 catalog tests')
    },
  },
})

mock.module('./pancakeV3Subgraph', {
  namedExports: {
    hasCompletePancakeV3GraphSnapshot: () => false,
    importBscPancakeV3Snapshot: async () => {
      throw new Error('not used by v2 catalog tests')
    },
  },
})

mock.module('./pancakeV2Advanced', {
  namedExports: {
    ensureBscPancakeV2AdvancedSnapshot: async () => ({
      added: 0,
      fresh: [],
      snapshotBlock: 0,
      snapshotPoolCount: 0,
      bootstrapped: false,
    }),
  },
})

const { syncV2 } = await import('./catalog')

const success = (result: unknown): McRow => ({ status: 'success', result })

beforeEach(() => {
  kv.clear()
  inserted.length = 0
  factoryCounts.clear()
  mcResponses = []
  multicallRequests.length = 0
})

test('BSC sync enumerates Uniswap and Pancake v2 with independent cursors and fees', async () => {
  factoryCounts.set(UNI_FACTORY, 1n)
  factoryCounts.set(PANCAKE_FACTORY, 2n)
  mcResponses = [
    [success(PAIR0)],
    [success(TOKEN0), success(TOKEN1)],
    [success(PAIR1), success(PAIR2)],
    [success(TOKEN0), success(TOKEN1), success(TOKEN0), success(TOKEN1)],
  ]

  assert.deepEqual(await syncV2(), {
    added: 3,
    fresh: [PAIR0, PAIR1, PAIR2],
  })
  assert.equal(kv.get('v2_count'), '1')
  assert.equal(kv.get('v2_factory_count'), '1')
  assert.equal(kv.get('pancake_v2_count'), '2')
  assert.equal(kv.get('pancake_v2_factory_count'), '2')
  assert.deepEqual(
    inserted.map(({ proto, feePpm, pairIndex }) => ({ proto, feePpm, pairIndex })),
    [
      { proto: 'univ2', feePpm: 3_000, pairIndex: 0 },
      { proto: 'pancakev2', feePpm: 2_500, pairIndex: 0 },
      { proto: 'pancakev2', feePpm: 2_500, pairIndex: 1 },
    ],
  )
})

test('a partial Pancake token multicall publishes no rows and does not advance its cursor', async () => {
  factoryCounts.set(UNI_FACTORY, 0n)
  factoryCounts.set(PANCAKE_FACTORY, 2n)
  mcResponses = [
    [success(PAIR1), success(PAIR2)],
    [success(TOKEN0), success(TOKEN1), success(TOKEN0), { status: 'failure' }],
  ]

  await assert.rejects(syncV2(), /pancakev2 catalog sync incomplete: durable cursor 0\/2/)
  assert.equal(kv.get('pancake_v2_factory_count'), undefined)
  assert.equal(kv.get('pancake_v2_count'), undefined)
  assert.deepEqual(inserted, [])
})

test('Pancake resumes from its own durable allPairs index without replaying Uniswap', async () => {
  factoryCounts.set(UNI_FACTORY, 1n)
  factoryCounts.set(PANCAKE_FACTORY, 2n)
  kv.set('v2_count', '1')
  kv.set('pancake_v2_count', '1')
  mcResponses = [
    [success(PAIR2)],
    [success(TOKEN0), success(TOKEN1)],
  ]

  assert.deepEqual(await syncV2(), { added: 1, fresh: [PAIR2] })
  assert.equal(kv.get('v2_count'), '1')
  assert.equal(kv.get('pancake_v2_count'), '2')
  assert.equal(multicallRequests[0][0].address, PANCAKE_FACTORY)
  assert.deepEqual(multicallRequests[0][0].args, [1n])
  assert.deepEqual(inserted.map(({ proto, pairIndex }) => ({ proto, pairIndex })), [
    { proto: 'pancakev2', pairIndex: 1 },
  ])
})

test('a large bootstrap writes every pair but bounds the returned refresh addresses', async () => {
  const count = 1_001
  factoryCounts.set(UNI_FACTORY, 0n)
  factoryCounts.set(PANCAKE_FACTORY, BigInt(count))
  const pairs = Array.from(
    { length: count },
    (_, index) => `0x${(index + 1).toString(16).padStart(40, '0')}`,
  )
  mcResponses = [
    pairs.map(success),
    pairs.flatMap(() => [success(TOKEN0), success(TOKEN1)]),
  ]

  const result = await syncV2()
  assert.equal(result.added, count)
  assert.equal(result.fresh.length, 1_000)
  assert.equal(inserted.length, count, 'the durable directory is not truncated')
  assert.equal(kv.get('pancake_v2_count'), String(count))
})
