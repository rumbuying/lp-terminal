import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

const kv = new Map<string, string>()
const logRequests: Array<{
  address?: string
  fromBlock: bigint
  toBlock: bigint
}> = []
let snapshotComplete = false
let importCalls = 0
let pancakeSnapshotComplete = false
let pancakeImportCalls = 0

mock.module('./config', {
  namedExports: {
    ADDR: {
      V2_FACTORY: '0x0000000000000000000000000000000000000003',
      CL_FACTORY: '0x0000000000000000000000000000000000000004',
    },
    BLOCKSCOUT: 'https://bscscan.invalid',
    CHAIN: { id: 56, explorer: { api: 'etherscan', name: 'BscScan' } },
    INDEXER_FINALITY_BLOCKS: 0,
    UNI: {
      V2_FACTORY: '0x0000000000000000000000000000000000000001',
      V3_FACTORY: '0x0000000000000000000000000000000000000002',
    },
    UNI_V3_START_BLOCK: 100,
    PANCAKE_V3_START_BLOCK: 200,
    log: () => undefined,
    sleep: async () => undefined,
  },
})

const rpcClient = {
  getBlockNumber: async () => 1_000n,
  getLogs: async (request: {
    address?: string
    fromBlock: bigint
    toBlock: bigint
  }) => {
    logRequests.push(request)
    return []
  },
  readContract: async () => 0n,
}

mock.module('./rpc', {
  namedExports: {
    pc: rpcClient,
    withRotatingRpcClient: <T>(fn: (client: typeof rpcClient) => Promise<T>) => fn(rpcClient),
    mc: async () => [],
    ok: () => undefined,
  },
})

mock.module('./store', {
  namedExports: {
    insertPool: () => true,
    kvGet: (key: string) => kv.get(key),
    kvSet: (key: string, value: string) => void kv.set(key, value),
    tx: (fn: () => void) => fn(),
  },
})

mock.module('./v3Subgraph', {
  namedExports: {
    hasCompleteV3GraphSnapshot: async () => snapshotComplete,
    importBscV3Snapshot: async (targetBlock: number) => {
      importCalls++
      assert.equal(targetBlock, 1_000)
      snapshotComplete = true
      kv.set('v3_cursor', '900')
      return {
        added: 2,
        downloaded: 2,
        block: 900,
        blockHash: `0x${'2'.repeat(64)}`,
        deployment: 'QmPinned',
      }
    },
  },
})

mock.module('./pancakeV3Subgraph', {
  namedExports: {
    hasCompletePancakeV3GraphSnapshot: async () => pancakeSnapshotComplete,
    importBscPancakeV3Snapshot: async (targetBlock: number) => {
      pancakeImportCalls++
      assert.equal(targetBlock, 1_000)
      pancakeSnapshotComplete = true
      kv.set('pancake_v3_cursor', '900')
      return {
        added: 3,
        downloaded: 3,
        block: 900,
        blockHash: `0x${'1'.repeat(64)}`,
        deployment: 'QmPancakePinned',
      }
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

const { backfillV3 } = await import('./catalog')

test('BSC imports The Graph snapshot then uses RPC only for the post-snapshot tail', async () => {
  kv.clear()
  logRequests.length = 0
  snapshotComplete = false
  importCalls = 0
  pancakeSnapshotComplete = false
  pancakeImportCalls = 0

  assert.equal(await backfillV3(), 5)
  assert.equal(importCalls, 1)
  assert.equal(pancakeImportCalls, 1)
  assert.deepEqual(
    logRequests.map(({ address, fromBlock, toBlock }) => ({
      address,
      fromBlock,
      toBlock,
    })),
    [
      {
        address: '0x0000000000000000000000000000000000000002',
        fromBlock: 780n,
        toBlock: 1_000n,
      },
      {
        address: '0x0000000000000000000000000000000000000004',
        fromBlock: 780n,
        toBlock: 1_000n,
      },
    ],
  )
  assert.equal(kv.get('v3_cursor'), '1000')
  assert.equal(kv.get('v3_target_block'), '1000')
  assert.equal(kv.get('pancake_v3_cursor'), '1000')
  assert.equal(kv.get('pancake_v3_target_block'), '1000')
  assert.equal(kv.get('v3_backfilled'), '1')
  assert.equal(kv.get('pancake_v3_backfilled'), '1')
})

test('BSC does not trust a legacy backfilled flag without The Graph provenance', async () => {
  kv.clear()
  logRequests.length = 0
  snapshotComplete = false
  importCalls = 0
  pancakeSnapshotComplete = false
  pancakeImportCalls = 0
  kv.set('v3_backfilled', '1')
  kv.set('v3_cursor', '700')

  await backfillV3()
  assert.equal(importCalls, 1)
  assert.equal(pancakeImportCalls, 1)
  assert.deepEqual(
    logRequests.map(({ address, fromBlock, toBlock }) => ({
      address,
      fromBlock,
      toBlock,
    })),
    [
      {
        address: '0x0000000000000000000000000000000000000002',
        fromBlock: 780n,
        toBlock: 1_000n,
      },
      {
        address: '0x0000000000000000000000000000000000000004',
        fromBlock: 780n,
        toBlock: 1_000n,
      },
    ],
  )
})
