export const PANCAKE_V2_SNAPSHOT_SOURCE = 'ankr_getLogs'
export const PANCAKE_V2_PAIR_CREATED_TOPIC =
  '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9'
/** Official PancakeSwap V2 factory deployment block on BSC. */
export const PANCAKE_V2_FACTORY_START_BLOCK = 6_809_737

export const PANCAKE_V2_SNAPSHOT_KEYS = {
  source: 'pancake_v2_snapshot_source',
  complete: 'pancake_v2_snapshot_complete',
  block: 'pancake_v2_snapshot_block',
  blockHash: 'pancake_v2_snapshot_block_hash',
  poolCount: 'pancake_v2_snapshot_pool_count',
  catalogGeneration: 'pancake_v2_snapshot_catalog_generation',
  importSource: 'pancake_v2_snapshot_import_source',
  importBlock: 'pancake_v2_snapshot_import_block',
  importBlockHash: 'pancake_v2_snapshot_import_block_hash',
  importPoolCount: 'pancake_v2_snapshot_import_pool_count',
  importCatalogGeneration: 'pancake_v2_snapshot_import_catalog_generation',
  importNextIndex: 'pancake_v2_snapshot_import_next_index',
  importPageToken: 'pancake_v2_snapshot_import_page_token',
  importLastPosition: 'pancake_v2_snapshot_import_last_position',
  importEndpointSlot: 'pancake_v2_snapshot_import_endpoint_slot',
  importEndpointFingerprint: 'pancake_v2_snapshot_import_endpoint_fingerprint',
  cursor: 'pancake_v2_count',
  factoryCount: 'pancake_v2_factory_count',
} as const

const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const TOPIC_ADDRESS = /^0x0{24}[0-9a-f]{40}$/
const HEX_INTEGER = /^0x[0-9a-f]+$/
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`
// Production probes found 10k continuation pages can stall at the 90s transport
// timeout; 5k stays fast while keeping the full import comfortably below 2h.
const DEFAULT_PAGE_SIZE = 5_000
const MAX_PAGE_SIZE = 10_000

export type PancakeV2AdvancedRequest = {
  blockchain: ['bsc']
  fromBlock: number
  toBlock: number
  address: [string]
  topics: [[string]]
  decodeLogs: false
  descOrder: false
  pageSize: number
  pageToken?: string
}

export type PancakeV2PoolIdentity = {
  address: string
  proto: string
  token0: string
  token1: string
  fee_ppm: number
  created_block: number | null
  pair_index: number | null
}

export type PancakeV2PairIndexStats = {
  count: number
  min: number | null
  max: number | null
  distinct: number
  missing: number
}

export type PancakeV2SnapshotStorage = {
  get: (key: string) => string | undefined
  set: (key: string, value: string) => void
  transaction: (fn: () => void) => void
  insertPool: (pool: {
    address: string
    proto: 'pancakev2'
    token0: string
    token1: string
    feePpm: number
    createdBlock: number
    pairIndex: number
    addedTs: number
  }) => boolean
  poolIdentity: (address: string) => PancakeV2PoolIdentity | undefined
  pairIndexStats: () => PancakeV2PairIndexStats
  catalogGeneration: () => string
}

export type PancakeV2SnapshotChain = {
  getHead: () => Promise<number>
  getBlockHash: (block: number) => Promise<string>
  getFactoryCount: (block: number) => Promise<number>
}

export type PancakeV2AdvancedSnapshotOptions = {
  factory: string
  finalityBlocks: number
  pageSize?: number
  freshLimit?: number
  chain: PancakeV2SnapshotChain
  storage: PancakeV2SnapshotStorage
  fetchPage: (request: PancakeV2AdvancedRequest) => Promise<unknown>
  progress?: (processed: number, total: number) => void
}

export type PancakeV2AdvancedSnapshotResult = {
  added: number
  fresh: string[]
  snapshotBlock: number
  snapshotPoolCount: number
  bootstrapped: boolean
}

type Target = { block: number; blockHash: string; poolCount: number }
type CatalogTarget = Target & { catalogGeneration: string }
type Position = { block: number; transaction: number; log: number }
type DecodedPair = {
  address: string
  token0: string
  token1: string
  createdBlock: number
  pairIndex: number
  position: Position
}

export class PancakeV2SnapshotError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PancakeV2SnapshotError'
  }
}

/** A deterministic opaque-token/generation rejection, never a transport retry. */
export class PancakeV2PageTokenRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PancakeV2PageTokenRejectedError'
  }
}

const fail = (message: string): never => {
  throw new PancakeV2SnapshotError(message)
}

function nonnegativeInteger(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(`${label} is invalid`)
  return parsed
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonnegativeInteger(value, label)
  if (parsed === 0) fail(`${label} is invalid`)
  return parsed
}

function generation(value: unknown, label: string): string {
  const parsed = String(value ?? '')
  if (!/^(0|[1-9]\d*)$/.test(parsed)) fail(`${label} is invalid`)
  return parsed
}

function normalizedAddress(value: unknown, label: string): string {
  const parsed = String(value ?? '').toLowerCase()
  if (!ADDRESS.test(parsed) || parsed === ZERO_ADDRESS) fail(`${label} is invalid`)
  return parsed
}

function normalizedHash(value: unknown, label: string): string {
  const parsed = String(value ?? '').toLowerCase()
  if (!HASH.test(parsed)) fail(`${label} is invalid`)
  return parsed
}

function hexInteger(value: unknown, label: string): number {
  const text = String(value ?? '').toLowerCase()
  if (!HEX_INTEGER.test(text)) fail(`${label} is invalid`)
  const parsed = BigInt(text)
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${label} is too large`)
  return Number(parsed)
}

function topicAddress(value: unknown, label: string): string {
  const text = String(value ?? '').toLowerCase()
  if (!TOPIC_ADDRESS.test(text)) fail(`${label} is invalid`)
  return normalizedAddress(`0x${text.slice(-40)}`, label)
}

function comparePosition(left: Position, right: Position): number {
  return (
    left.block - right.block ||
    left.transaction - right.transaction ||
    left.log - right.log
  )
}

function encodePosition(position: Position | null): string {
  return position
    ? `${position.block}:${position.transaction}:${position.log}`
    : ''
}

function decodePosition(value: string | undefined): Position | null {
  if (!value) return null
  const match = /^(0|[1-9]\d*):(0|[1-9]\d*):(0|[1-9]\d*)$/.exec(value)
  if (!match) return fail('Pancake V2 snapshot checkpoint position is invalid')
  return {
    block: nonnegativeInteger(match[1], 'checkpoint block'),
    transaction: nonnegativeInteger(match[2], 'checkpoint transaction'),
    log: nonnegativeInteger(match[3], 'checkpoint log'),
  }
}

function targetFrom(
  block: unknown,
  blockHash: unknown,
  poolCount: unknown,
  label: string,
): Target {
  return {
    block: positiveInteger(block, `${label} block`),
    blockHash: normalizedHash(blockHash, `${label} block hash`),
    poolCount: positiveInteger(poolCount, `${label} pool count`),
  }
}

function publishedTarget(storage: PancakeV2SnapshotStorage): CatalogTarget | null {
  const key = PANCAKE_V2_SNAPSHOT_KEYS
  if (storage.get(key.complete) !== '1') return null
  if (storage.get(key.source) !== PANCAKE_V2_SNAPSHOT_SOURCE)
    fail('Pancake V2 published snapshot source is invalid')
  return {
    ...targetFrom(
      storage.get(key.block),
      storage.get(key.blockHash),
      storage.get(key.poolCount),
      'Pancake V2 published snapshot',
    ),
    catalogGeneration: generation(
      storage.get(key.catalogGeneration),
      'Pancake V2 published snapshot catalog generation',
    ),
  }
}

type ImportCheckpoint = CatalogTarget & {
  nextIndex: number
  pageToken: string | null
  lastPosition: Position | null
}

function importCheckpoint(storage: PancakeV2SnapshotStorage): ImportCheckpoint | null {
  const key = PANCAKE_V2_SNAPSHOT_KEYS
  const source = storage.get(key.importSource)
  if (!source) return null
  if (source !== PANCAKE_V2_SNAPSHOT_SOURCE)
    fail('Pancake V2 snapshot checkpoint source is invalid')
  const target = targetFrom(
    storage.get(key.importBlock),
    storage.get(key.importBlockHash),
    storage.get(key.importPoolCount),
    'Pancake V2 snapshot checkpoint',
  )
  const catalogGeneration = generation(
    storage.get(key.importCatalogGeneration),
    'Pancake V2 snapshot checkpoint catalog generation',
  )
  const nextIndex = nonnegativeInteger(
    storage.get(key.importNextIndex),
    'Pancake V2 snapshot checkpoint index',
  )
  if (nextIndex > target.poolCount)
    fail('Pancake V2 snapshot checkpoint is ahead of its target')
  const pageToken = storage.get(key.importPageToken)?.trim() || null
  if (nextIndex > 0 && nextIndex < target.poolCount && !pageToken)
    fail('Pancake V2 snapshot checkpoint is missing its page token')
  if ((nextIndex === 0 || nextIndex === target.poolCount) && pageToken)
    fail('Pancake V2 snapshot checkpoint has an unexpected page token')
  const lastPosition = decodePosition(storage.get(key.importLastPosition))
  if ((nextIndex === 0) !== (lastPosition === null))
    fail('Pancake V2 snapshot checkpoint position conflicts with its index')
  return { ...target, catalogGeneration, nextIndex, pageToken, lastPosition }
}

function assertPairIndexStats(
  stats: PancakeV2PairIndexStats,
  minimumCount: number,
  label: string,
): number {
  if (
    stats.count < minimumCount ||
    stats.min !== 0 ||
    stats.max !== stats.count - 1 ||
    stats.distinct !== stats.count ||
    stats.missing !== 0
  ) {
    fail(
      `${label} pair-index coverage is incomplete ` +
        `(required>=${minimumCount}, count=${stats.count}, min=${stats.min}, max=${stats.max}, distinct=${stats.distinct}, missing=${stats.missing})`,
    )
  }
  return stats.count
}

function currentCatalogGeneration(
  storage: PancakeV2SnapshotStorage,
  label: string,
): string {
  return generation(storage.catalogGeneration(), label)
}

async function assertPinnedTarget(
  chain: PancakeV2SnapshotChain,
  target: Target,
  label: string,
): Promise<void> {
  const canonicalHash = normalizedHash(
    await chain.getBlockHash(target.block),
    `${label} canonical block hash`,
  )
  if (canonicalHash !== target.blockHash)
    fail(`${label} block hash no longer matches canonical RPC`)
  const canonicalCount = positiveInteger(
    await chain.getFactoryCount(target.block),
    `${label} canonical factory count`,
  )
  if (canonicalCount !== target.poolCount)
    fail(`${label} factory count no longer matches canonical RPC`)
}

async function pinNewTarget(
  chain: PancakeV2SnapshotChain,
  finalityBlocks: number,
): Promise<Target> {
  const head = positiveInteger(await chain.getHead(), 'BSC chain head')
  const targetBlock = head - finalityBlocks
  if (!Number.isSafeInteger(targetBlock) || targetBlock <= 0)
    fail('Pancake V2 finalized snapshot target is invalid')
  const firstHash = normalizedHash(
    await chain.getBlockHash(targetBlock),
    'Pancake V2 snapshot target block hash',
  )
  const poolCount = positiveInteger(
    await chain.getFactoryCount(targetBlock),
    'Pancake V2 snapshot target factory count',
  )
  const secondHash = normalizedHash(
    await chain.getBlockHash(targetBlock),
    'Pancake V2 snapshot target block hash',
  )
  if (firstHash !== secondHash)
    fail('Pancake V2 snapshot target changed while it was being pinned')
  return { block: targetBlock, blockHash: firstHash, poolCount }
}

function decodePairCreated(
  raw: unknown,
  factory: string,
  target: Target,
  expectedPairIndex: number,
): DecodedPair {
  if (!raw || typeof raw !== 'object') fail('Ankr returned an invalid Pancake V2 log')
  const log = raw as Record<string, unknown>
  if (String(log.address ?? '').toLowerCase() !== factory)
    fail('Ankr returned a log from the wrong Pancake V2 factory')
  if (log.removed !== false) fail('Ankr returned a removed Pancake V2 log')
  normalizedHash(log.blockHash, 'Pancake V2 log block hash')
  normalizedHash(log.transactionHash, 'Pancake V2 log transaction hash')
  const createdBlock = hexInteger(log.blockNumber, 'Pancake V2 log block number')
  if (createdBlock > target.block)
    fail('Ankr returned a Pancake V2 log after the pinned target block')
  const position = {
    block: createdBlock,
    transaction: hexInteger(log.transactionIndex, 'Pancake V2 log transaction index'),
    log: hexInteger(log.logIndex, 'Pancake V2 log index'),
  }
  if (!Array.isArray(log.topics) || log.topics.length !== 3)
    fail('Ankr returned invalid Pancake V2 log topics')
  const [topic0, rawToken0, rawToken1] = log.topics as unknown[]
  if (String(topic0 ?? '').toLowerCase() !== PANCAKE_V2_PAIR_CREATED_TOPIC)
    fail('Ankr returned the wrong Pancake V2 event signature')
  const token0 = topicAddress(rawToken0, 'Pancake V2 token0')
  const token1 = topicAddress(rawToken1, 'Pancake V2 token1')
  if (token0 >= token1)
    fail('Ankr returned a non-canonical Pancake V2 token pair')

  const data = String(log.data ?? '').toLowerCase()
  if (!/^0x[0-9a-f]{128}$/.test(data))
    fail('Ankr returned invalid Pancake V2 PairCreated data')
  const pair = topicAddress(`0x${data.slice(2, 66)}`, 'Pancake V2 pair')
  const ordinal = BigInt(`0x${data.slice(66)}`)
  if (ordinal > BigInt(Number.MAX_SAFE_INTEGER))
    fail('Ankr returned an oversized Pancake V2 PairCreated ordinal')
  const pairIndex = Number(ordinal) - 1
  if (pairIndex !== expectedPairIndex)
    fail(
      `Pancake V2 PairCreated ordinal is not contiguous: expected ${expectedPairIndex + 1}, received ${Number(ordinal)}`,
    )
  if (pairIndex < 0 || pairIndex >= target.poolCount)
    fail('Ankr returned a Pancake V2 PairCreated ordinal outside the target count')
  return { address: pair, token0, token1, createdBlock, pairIndex, position }
}

function parsedPage(raw: unknown, pageSize: number): { logs: unknown[]; nextPageToken: string | null } {
  if (!raw || typeof raw !== 'object') fail('Ankr Advanced API returned an invalid response')
  const body = raw as Record<string, unknown>
  if (body.error) fail('Ankr Advanced API returned an RPC error')
  if (!body.result || typeof body.result !== 'object')
    fail('Ankr Advanced API response is missing result')
  const result = body.result as Record<string, unknown>
  const logs = result.logs
  if (!Array.isArray(logs)) return fail('Ankr Advanced API response is missing logs')
  if (logs.length > pageSize)
    fail('Ankr Advanced API returned an oversized log page')
  const token = result.nextPageToken
  if (token !== undefined && token !== null && typeof token !== 'string')
    fail('Ankr Advanced API returned an invalid page token')
  return { logs, nextPageToken: typeof token === 'string' && token ? token : null }
}

function assertExistingIdentity(
  existing: PancakeV2PoolIdentity,
  row: DecodedPair,
): void {
  if (
    existing.address.toLowerCase() !== row.address ||
    existing.proto !== 'pancakev2' ||
    existing.token0.toLowerCase() !== row.token0 ||
    existing.token1.toLowerCase() !== row.token1 ||
    existing.fee_ppm !== 2_500 ||
    existing.pair_index !== row.pairIndex ||
    (existing.created_block !== null && existing.created_block !== row.createdBlock)
  ) {
    fail(`existing pool ${row.address} conflicts with the Pancake V2 snapshot`)
  }
}

function writeCheckpointValues(
  storage: PancakeV2SnapshotStorage,
  target: Target,
  catalogGeneration: string,
): void {
  const key = PANCAKE_V2_SNAPSHOT_KEYS
  storage.set(key.complete, '0')
  storage.set(key.importSource, PANCAKE_V2_SNAPSHOT_SOURCE)
  storage.set(key.importBlock, String(target.block))
  storage.set(key.importBlockHash, target.blockHash)
  storage.set(key.importPoolCount, String(target.poolCount))
  storage.set(key.importCatalogGeneration, catalogGeneration)
  storage.set(key.importNextIndex, '0')
  storage.set(key.importPageToken, '')
  storage.set(key.importLastPosition, '')
  storage.set(key.importEndpointSlot, '')
  storage.set(key.importEndpointFingerprint, '')
}

function initializeCheckpoint(
  storage: PancakeV2SnapshotStorage,
  target: Target,
): ImportCheckpoint {
  let catalogGeneration = ''
  storage.transaction(() => {
    catalogGeneration = currentCatalogGeneration(
      storage,
      'Pancake V2 snapshot catalog generation',
    )
    writeCheckpointValues(storage, target, catalogGeneration)
  })
  return {
    ...target,
    catalogGeneration,
    nextIndex: 0,
    pageToken: null,
    lastPosition: null,
  }
}

function clearImportGenerationValues(storage: PancakeV2SnapshotStorage): void {
  const key = PANCAKE_V2_SNAPSHOT_KEYS
  for (const importKey of [
    key.importSource,
    key.importBlock,
    key.importBlockHash,
    key.importPoolCount,
    key.importCatalogGeneration,
    key.importNextIndex,
    key.importPageToken,
    key.importLastPosition,
    key.importEndpointSlot,
    key.importEndpointFingerprint,
  ]) storage.set(importKey, '')
}

function clearImportGeneration(storage: PancakeV2SnapshotStorage): void {
  const key = PANCAKE_V2_SNAPSHOT_KEYS
  if (![
    key.importSource,
    key.importBlock,
    key.importBlockHash,
    key.importPoolCount,
    key.importCatalogGeneration,
    key.importNextIndex,
    key.importPageToken,
    key.importLastPosition,
    key.importEndpointSlot,
    key.importEndpointFingerprint,
  ].some((importKey) => Boolean(storage.get(importKey)))) return
  storage.transaction(() => clearImportGenerationValues(storage))
}

function restartCheckpoint(
  storage: PancakeV2SnapshotStorage,
  target: CatalogTarget,
): ImportCheckpoint {
  const key = PANCAKE_V2_SNAPSHOT_KEYS
  storage.transaction(() => {
    storage.set(key.importNextIndex, '0')
    storage.set(key.importPageToken, '')
    storage.set(key.importLastPosition, '')
    storage.set(key.importCatalogGeneration, target.catalogGeneration)
    storage.set(key.importEndpointSlot, '')
    storage.set(key.importEndpointFingerprint, '')
  })
  return { ...target, nextIndex: 0, pageToken: null, lastPosition: null }
}

/**
 * Import one immutable BSC Pancake V2 directory from Ankr's indexed log API.
 * Only one page is retained at a time. Every committed page advances its opaque
 * token and PairCreated ordinal atomically; a rejected resumed token causes one
 * safe replay from page one against the same pinned target.
 */
export async function ensurePancakeV2AdvancedSnapshot({
  factory: rawFactory,
  finalityBlocks,
  pageSize: rawPageSize = DEFAULT_PAGE_SIZE,
  freshLimit: rawFreshLimit = 1_000,
  chain,
  storage,
  fetchPage,
  progress,
}: PancakeV2AdvancedSnapshotOptions): Promise<PancakeV2AdvancedSnapshotResult> {
  const factory = normalizedAddress(rawFactory, 'Pancake V2 factory')
  const pageSize = positiveInteger(rawPageSize, 'Pancake V2 snapshot page size')
  if (pageSize > MAX_PAGE_SIZE) fail('Pancake V2 snapshot page size exceeds 10000')
  const freshLimit = nonnegativeInteger(rawFreshLimit, 'Pancake V2 fresh address limit')
  if (!Number.isSafeInteger(finalityBlocks) || finalityBlocks < 0)
    fail('Pancake V2 finality block count is invalid')

  let published: CatalogTarget | null
  try {
    published = publishedTarget(storage)
  } catch (error) {
    if (error instanceof PancakeV2SnapshotError) {
      storage.transaction(() => {
        storage.set(PANCAKE_V2_SNAPSHOT_KEYS.complete, '0')
        clearImportGenerationValues(storage)
      })
    }
    throw error
  }
  if (published) {
    try {
      await assertPinnedTarget(chain, published, 'Pancake V2 published snapshot')
    } catch (error) {
      if (error instanceof PancakeV2SnapshotError) {
        storage.transaction(() => {
          storage.set(PANCAKE_V2_SNAPSHOT_KEYS.complete, '0')
          clearImportGenerationValues(storage)
        })
      }
      throw error
    }
    let liveCatalogGeneration: string
    try {
      liveCatalogGeneration = currentCatalogGeneration(
        storage,
        'Pancake V2 live catalog generation',
      )
    } catch (error) {
      if (error instanceof PancakeV2SnapshotError) {
        storage.transaction(() => {
          storage.set(PANCAKE_V2_SNAPSHOT_KEYS.complete, '0')
          clearImportGenerationValues(storage)
        })
      }
      throw error
    }
    if (liveCatalogGeneration !== published.catalogGeneration) {
      // A destructive pool identity mutation invalidates aggregate-only row
      // coverage. Replay the same canonical event history to verify every row.
      initializeCheckpoint(storage, published)
      fail('Pancake V2 published snapshot catalog generation changed')
    }
    try {
      assertPairIndexStats(
        storage.pairIndexStats(),
        published.poolCount,
        'Pancake V2 published snapshot',
      )
    } catch (error) {
      // The pinned generation is still canonical, so replay that exact immutable
      // history from page one to repair missing/corrupt local rows. Reusing the
      // completed import checkpoint would skip the replay forever.
      if (error instanceof PancakeV2SnapshotError)
        initializeCheckpoint(storage, published)
      throw error
    }
    // Older releases retained a completed opaque-token generation after publish.
    // It has no recovery value and must not shadow a future repair/re-pin.
    clearImportGeneration(storage)
    return {
      added: 0,
      fresh: [],
      snapshotBlock: published.block,
      snapshotPoolCount: published.poolCount,
      bootstrapped: false,
    }
  }

  let checkpoint: ImportCheckpoint | null
  try {
    checkpoint = importCheckpoint(storage)
  } catch (error) {
    if (error instanceof PancakeV2SnapshotError)
      clearImportGeneration(storage)
    throw error
  }
  if (checkpoint) {
    try {
      await assertPinnedTarget(chain, checkpoint, 'Pancake V2 snapshot checkpoint')
    } catch (error) {
      // A canonical mismatch invalidates the immutable generation. Transport
      // errors are deliberately left untouched so a transient RPC outage can
      // resume the same checkpoint on the next tick.
      if (error instanceof PancakeV2SnapshotError)
        clearImportGeneration(storage)
      throw error
    }
    const liveCatalogGeneration = currentCatalogGeneration(
      storage,
      'Pancake V2 live catalog generation',
    )
    if (liveCatalogGeneration !== checkpoint.catalogGeneration) {
      // Preserve the immutable chain target but restart identity verification at
      // ordinal zero under the new destructive-generation fence.
      initializeCheckpoint(storage, checkpoint)
      fail('Pancake V2 snapshot catalog changed during import; checkpoint restarted')
    }
    if (checkpoint.nextIndex === checkpoint.poolCount) {
      try {
        assertPairIndexStats(
          storage.pairIndexStats(),
          checkpoint.poolCount,
          'Pancake V2 completed snapshot checkpoint',
        )
      } catch (error) {
        // Migrate the exact bad state written by older releases: complete=0 with
        // a completed checkpoint would otherwise skip the loop on every boot.
        if (error instanceof PancakeV2SnapshotError)
          checkpoint = restartCheckpoint(storage, checkpoint)
        else
          throw error
      }
    }
  } else {
    checkpoint = initializeCheckpoint(
      storage,
      await pinNewTarget(chain, finalityBlocks),
    )
  }

  const target: CatalogTarget = {
    block: checkpoint.block,
    blockHash: checkpoint.blockHash,
    poolCount: checkpoint.poolCount,
    catalogGeneration: checkpoint.catalogGeneration,
  }
  let nextIndex = checkpoint.nextIndex
  let pageToken = checkpoint.pageToken
  let lastPosition = checkpoint.lastPosition
  let replayed = false
  let added = 0
  const fresh: string[] = []
  const seenTokens = new Set<string>()

  while (nextIndex < target.poolCount) {
    const request: PancakeV2AdvancedRequest = {
      blockchain: ['bsc'],
      fromBlock: PANCAKE_V2_FACTORY_START_BLOCK,
      toBlock: target.block,
      address: [factory],
      topics: [[PANCAKE_V2_PAIR_CREATED_TOPIC]],
      decodeLogs: false,
      descOrder: false,
      pageSize,
      ...(pageToken ? { pageToken } : {}),
    }
    let raw: unknown
    try {
      raw = await fetchPage(request)
    } catch (error) {
      // Opaque page tokens are endpoint-bound. A resumed token may have become
      // unusable after process/config churn; replay once from page one. A fresh
      // request failure remains fatal and the catalog stays unpublished.
      if (
        pageToken &&
        error instanceof PancakeV2PageTokenRejectedError &&
        !replayed
      ) {
        checkpoint = restartCheckpoint(storage, target)
        nextIndex = checkpoint.nextIndex
        pageToken = checkpoint.pageToken
        lastPosition = checkpoint.lastPosition
        seenTokens.clear()
        replayed = true
        continue
      }
      throw error
    }
    const page = parsedPage(raw, pageSize)
    if (!page.logs.length)
      fail('Ankr Advanced API returned an empty non-final Pancake V2 page')
    if (page.nextPageToken && page.nextPageToken === pageToken)
      fail('Ankr Advanced API repeated a Pancake V2 page token')
    if (page.nextPageToken && seenTokens.has(page.nextPageToken))
      fail('Ankr Advanced API cycled a Pancake V2 page token')

    const rows: DecodedPair[] = []
    const pagePairs = new Set<string>()
    let previous = lastPosition
    for (const rawLog of page.logs) {
      const row = decodePairCreated(rawLog, factory, target, nextIndex + rows.length)
      if (previous && comparePosition(row.position, previous) <= 0)
        fail('Ankr returned out-of-order Pancake V2 logs')
      if (pagePairs.has(row.address))
        fail('Ankr returned a duplicate Pancake V2 pair in one page')
      pagePairs.add(row.address)
      previous = row.position
      rows.push(row)
    }
    const nextProcessed = nextIndex + rows.length
    if (nextProcessed > target.poolCount)
      fail('Ankr returned more Pancake V2 events than the pinned factory count')
    if (nextProcessed < target.poolCount && !page.nextPageToken)
      fail('Ankr Pancake V2 snapshot ended before the pinned factory count')
    if (nextProcessed === target.poolCount && page.nextPageToken)
      fail('Ankr Pancake V2 snapshot has extra pages after the pinned factory count')

    storage.transaction(() => {
      for (const row of rows) {
        const inserted = storage.insertPool({
          address: row.address,
          proto: 'pancakev2',
          token0: row.token0,
          token1: row.token1,
          feePpm: 2_500,
          createdBlock: row.createdBlock,
          pairIndex: row.pairIndex,
          addedTs: 0,
        })
        if (!inserted) {
          const existing = storage.poolIdentity(row.address)
          if (!existing)
            return fail(`failed to persist Pancake V2 pair ${row.address}`)
          assertExistingIdentity(existing, row)
          continue
        }
        added++
        if (fresh.length < freshLimit) fresh.push(row.address)
      }
      storage.set(PANCAKE_V2_SNAPSHOT_KEYS.importNextIndex, String(nextProcessed))
      storage.set(
        PANCAKE_V2_SNAPSHOT_KEYS.importPageToken,
        page.nextPageToken ?? '',
      )
      storage.set(
        PANCAKE_V2_SNAPSHOT_KEYS.importLastPosition,
        encodePosition(previous),
      )
    })
    nextIndex = nextProcessed
    pageToken = page.nextPageToken
    lastPosition = previous
    if (pageToken) seenTokens.add(pageToken)
    progress?.(nextIndex, target.poolCount)
  }

  try {
    // A multi-million-row download can outlive a short reorg. Fence the target a
    // second time immediately before publication, not only before page one.
    await assertPinnedTarget(chain, target, 'Pancake V2 snapshot before publish')
  } catch (error) {
    if (error instanceof PancakeV2SnapshotError)
      clearImportGeneration(storage)
    throw error
  }
  const key = PANCAKE_V2_SNAPSHOT_KEYS
  let catalogCount = 0
  let generationDrifted = false
  try {
    storage.transaction(() => {
      const liveCatalogGeneration = currentCatalogGeneration(
        storage,
        'Pancake V2 catalog generation before publish',
      )
      if (liveCatalogGeneration !== target.catalogGeneration) {
        // Commit a page-one checkpoint under the new generation. Throwing inside
        // this transaction would roll the repair checkpoint back, so signal the
        // fail-closed error immediately after the transaction commits.
        writeCheckpointValues(storage, target, liveCatalogGeneration)
        generationDrifted = true
        return
      }

      catalogCount = assertPairIndexStats(
        storage.pairIndexStats(),
        target.poolCount,
        'Pancake V2 snapshot',
      )
      const previousFactoryCount = Number(storage.get(key.factoryCount))
      const observedFactoryCount =
        Number.isSafeInteger(previousFactoryCount) && previousFactoryCount >= catalogCount
          ? previousFactoryCount
          : catalogCount
      storage.set(key.source, PANCAKE_V2_SNAPSHOT_SOURCE)
      storage.set(key.block, String(target.block))
      storage.set(key.blockHash, target.blockHash)
      storage.set(key.poolCount, String(target.poolCount))
      storage.set(key.catalogGeneration, liveCatalogGeneration)
      // A pre-existing RPC catalog may already include a contiguous post-target
      // tail. Preserve that durable high-water mark instead of rewinding it.
      storage.set(key.cursor, String(catalogCount))
      // An interrupted tail sync may already have observed an even newer factory
      // count. Keep readiness false until syncV2Venue fills that known remainder.
      storage.set(key.factoryCount, String(observedFactoryCount))
      clearImportGenerationValues(storage)
      storage.set(key.complete, '1')
    })
  } catch (error) {
    if (error instanceof PancakeV2SnapshotError)
      initializeCheckpoint(storage, target)
    throw error
  }
  if (generationDrifted)
    fail('Pancake V2 snapshot catalog changed before publish; checkpoint restarted')
  return {
    added,
    fresh,
    snapshotBlock: target.block,
    snapshotPoolCount: target.poolCount,
    bootstrapped: true,
  }
}
