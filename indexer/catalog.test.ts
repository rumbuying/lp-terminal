import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

type McRow = { status: 'success' | 'failure'; result?: unknown }

const kv = new Map<string, string>()
const kvHistory: Array<[string, string]> = []
let factoryCount = 0n
let mcImpl: () => Promise<McRow[]> = async () => []
let blockHead = 0n
let getLogsImpl: (request: { fromBlock: bigint; toBlock: bigint }) => Promise<unknown[]> = async () => []
const inserted: string[] = []

mock.module('./config', {
  namedExports: {
    ADDR: {
      V2_FACTORY: '0x0000000000000000000000000000000000000003',
      CL_FACTORY: '0x0000000000000000000000000000000000000004',
    },
    BLOCKSCOUT: 'https://explorer.invalid',
    CHAIN: { id: 4663, explorer: { api: 'blockscout', name: 'Blockscout' } },
    INDEXER_FINALITY_BLOCKS: 0,
    UNI: {
      V2_FACTORY: '0x0000000000000000000000000000000000000001',
      V3_FACTORY: '0x0000000000000000000000000000000000000002',
    },
    UNI_V3_START_BLOCK: 0,
    PANCAKE_V3_START_BLOCK: 0,
    log: () => undefined,
    sleep: async () => undefined,
  },
})

mock.module('./rpc', {
  namedExports: {
    pc: {
      readContract: async () => factoryCount,
      getBlockNumber: async () => blockHead,
      getLogs: (request: { fromBlock: bigint; toBlock: bigint }) => getLogsImpl(request),
    },
    withRotatingRpcClient: <T>(request: (client: {
      getLogs: (request: { fromBlock: bigint; toBlock: bigint }) => Promise<unknown[]>
    }) => Promise<T>) => request({ getLogs: (request) => getLogsImpl(request) }),
    mc: async () => mcImpl(),
    ok: <T>(row: McRow | undefined): T | undefined =>
      row?.status === 'success' ? (row.result as T) : undefined,
  },
})

mock.module('./store', {
  namedExports: {
    insertPool: (pool: { address: string }) => {
      inserted.push(pool.address)
      return true
    },
    kvGet: (key: string) => kv.get(key),
    kvSet: (key: string, value: string) => {
      kv.set(key, value)
      kvHistory.push([key, value])
    },
    tx: (fn: () => void) => fn(),
  },
})

mock.module('./v3Subgraph', {
  namedExports: {
    hasCompleteV3GraphSnapshot: async () => false,
    importBscV3Snapshot: async () => {
      throw new Error('unexpected BSC snapshot import in Blockscout test')
    },
  },
})

mock.module('./pancakeV3Subgraph', {
  namedExports: {
    hasCompletePancakeV3GraphSnapshot: () => false,
    importBscPancakeV3Snapshot: async () => {
      throw new Error('unexpected Pancake snapshot import in non-BSC test')
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

const { backfillV3, syncV2, tailV3 } = await import('./catalog')

test('v3 RPC backfill checkpoints successful windows and resumes after a transient failure', async () => {
  kv.clear()
  kvHistory.length = 0
  blockHead = 6n
  const previousMode = process.env.INDEXER_BACKFILL
  process.env.INDEXER_BACKFILL = 'rpc'
  getLogsImpl = async ({ fromBlock, toBlock }) => {
    const span = Number(toBlock - fromBlock + 1n)
    if (span > 2) throw new Error('limit exceeded')
    if (fromBlock >= 4n) throw new Error('temporary transport failure')
    return []
  }

  try {
    await assert.rejects(backfillV3(), /temporary transport failure/)
    assert.equal(kv.get('v3_cursor'), '3')
    assert.equal(kv.get('v3_backfilled'), undefined)
    assert.deepEqual(
      kvHistory.filter(([key]) => key === 'v3_cursor').map(([, value]) => value),
      ['1', '3'],
    )

    const resumedFrom: bigint[] = []
    getLogsImpl = async ({ fromBlock }) => {
      resumedFrom.push(fromBlock)
      return []
    }
    assert.equal(await backfillV3(), 0)
    assert.equal(resumedFrom[0], 3n, 'resume overlaps the durable block for safe de-duplication')
    assert.equal(kv.get('v3_cursor'), '6')
    assert.equal(kv.get('v3_backfilled'), '1')
  } finally {
    if (previousMode === undefined) delete process.env.INDEXER_BACKFILL
    else process.env.INDEXER_BACKFILL = previousMode
  }
})

test('completed v3 catalog catches up from its durable cursor before restart is ready', async () => {
  kv.clear()
  kvHistory.length = 0
  kv.set('v3_backfilled', '1')
  kv.set('v3_cursor', '500')
  blockHead = 650n
  const requested: Array<{ fromBlock: bigint; toBlock: bigint }> = []
  getLogsImpl = async (request) => {
    requested.push(request)
    return []
  }

  assert.equal(await backfillV3(), 0)
  assert.deepEqual(
    requested.map(({ fromBlock, toBlock }) => ({ fromBlock, toBlock })),
    [{ fromBlock: 380n, toBlock: 650n }],
  )
  assert.equal(kv.get('v3_target_block'), '650')
  assert.equal(kv.get('v3_cursor'), '650')
  assert.equal(kv.get('v3_backfilled'), '1')
})

test('v3 tail keeps its last-good fence while a shrunken overlap scan is in flight', async () => {
  kv.clear()
  kvHistory.length = 0
  kv.set('v3_backfilled', '1')
  kv.set('v3_cursor', '500')
  kv.set('v3_target_block', '500')
  blockHead = 650n

  let laterWindowStarted = false
  let releaseLaterWindows!: (rows: unknown[]) => void
  const laterWindows = new Promise<unknown[]>((resolve) => {
    releaseLaterWindows = resolve
  })
  let successfulWindows = 0
  getLogsImpl = async ({ fromBlock, toBlock }) => {
    if (toBlock - fromBlock + 1n > 10n) throw new Error('range limit exceeded')
    if (successfulWindows++ === 0) return []
    laterWindowStarted = true
    return laterWindows
  }

  const pending = tailV3()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(laterWindowStarted, true)
  assert.equal(kv.get('v3_cursor'), '500', 'overlap checkpoints never rewind the cursor')
  assert.equal(kv.get('v3_target_block'), '500', 'the in-flight head is not published')

  releaseLaterWindows([])
  assert.deepEqual(await pending, [])
  assert.equal(kv.get('v3_cursor'), '650')
  assert.equal(kv.get('v3_target_block'), '650')

  blockHead = 700n
  getLogsImpl = async () => {
    throw new Error('temporary transport failure')
  }
  await assert.rejects(tailV3(), /temporary transport failure/)
  assert.equal(kv.get('v3_cursor'), '650')
  assert.equal(kv.get('v3_target_block'), '650')
})

test('v2 sync rejects a partial multicall instead of advertising a complete catalog', async () => {
  kv.clear()
  inserted.length = 0
  factoryCount = 2n
  mcImpl = async () => []

  await assert.rejects(syncV2(), /durable cursor 0\/2; refusing to mark the index ready/)
  assert.equal(kv.get('v2_factory_count'), undefined)
  assert.equal(kv.get('v2_count'), undefined)
  assert.deepEqual(inserted, [])
})

test('v2 publishes a new factory count only with its verified pair batch', async () => {
  kv.clear()
  inserted.length = 0
  kv.set('v2_count', '1')
  kv.set('v2_factory_count', '1')
  factoryCount = 2n
  const pair = '0x0000000000000000000000000000000000000011'
  const token0 = '0x0000000000000000000000000000000000000020'
  const token1 = '0x0000000000000000000000000000000000000021'
  let releasePairs!: (rows: McRow[]) => void
  const pairs = new Promise<McRow[]>((resolve) => {
    releasePairs = resolve
  })
  let call = 0
  mcImpl = () =>
    call++ === 0
      ? pairs
      : Promise.resolve([
          { status: 'success', result: token0 },
          { status: 'success', result: token1 },
        ])

  const pending = syncV2()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(kv.get('v2_count'), '1')
  assert.equal(kv.get('v2_factory_count'), '1')

  releasePairs([{ status: 'success', result: pair }])
  assert.deepEqual(await pending, { added: 1, fresh: [pair] })
  assert.equal(kv.get('v2_count'), '2')
  assert.equal(kv.get('v2_factory_count'), '2')
  assert.deepEqual(inserted, [pair])
})

test('v2 sync advances the durable cursor only after pair tokens resolve', async () => {
  kv.clear()
  inserted.length = 0
  factoryCount = 2n
  const pair0 = '0x0000000000000000000000000000000000000010'
  const pair1 = '0x0000000000000000000000000000000000000011'
  const token0 = '0x0000000000000000000000000000000000000020'
  const token1 = '0x0000000000000000000000000000000000000021'
  const responses: McRow[][] = [
    [
      { status: 'success', result: pair0 },
      { status: 'success', result: pair1 },
    ],
    [
      { status: 'success', result: token0 },
      { status: 'success', result: token1 },
      { status: 'success', result: token0 },
      { status: 'success', result: token1 },
    ],
  ]
  mcImpl = async () => responses.shift() ?? []

  assert.deepEqual(await syncV2(), { added: 2, fresh: [pair0, pair1] })
  assert.equal(kv.get('v2_count'), '2')
  assert.deepEqual(inserted, [pair0, pair1])
})
