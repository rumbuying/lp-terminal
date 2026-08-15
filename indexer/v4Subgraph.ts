import {
  encodeAbiParameters,
  erc20Abi,
  keccak256,
  parseAbiItem,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { clampWidth } from '../src/lib/format'
import { scanAdaptiveLogWindows } from './adaptiveLogs'
import {
  CHAIN,
  INDEXER_FINALITY_BLOCKS,
  V4,
  log,
  sleep,
} from './config'
import { mc, ok, pc, withRotatingRpcClient } from './rpc'
import {
  clearV4Featured,
  deleteStaleV4SnapshotCandidates,
  hasCompleteV4SnapshotRows,
  insertV4Pool,
  kvGet,
  kvSet,
  markV4Featured,
  missingV4TokensPage,
  pruneV4StatsExcept,
  setV4EventIdentity,
  setV4SnapshotGeneration,
  tx,
  upsertV4GraphStats,
  upsertV4TokenMeta,
  v4PoolRow,
  v4SnapshotGenerationCount,
} from './store'
import { inV4DirectoryScope } from './v4Scope'

/** Published `uniswap-v4-bnb` catalog on The Graph Network. */
export const BSC_UNI_V4_SUBGRAPH_ID =
  'EAq1nJKgjnuKH6Gj4RFjCW7LcL7E2uipbncdwV7TTWkX'

const GRAPH_GATEWAY = 'https://gateway.thegraph.com/api/subgraphs/id'
const PAGE_SIZE = 1_000
// One logical page request plus at most four consistency refetches. Transport
// failures have their own retry budget inside graphQuery.
const PAGE_COUNT_ATTEMPTS = 5
const ZERO_POOL_ID = `0x${'0'.repeat(64)}`
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const POOL_ID = /^0x[0-9a-fA-F]{64}$/
const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/
const SUBGRAPH_ID = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/
const DEFAULT_MAX_SNAPSHOT_LAG_BLOCKS = 10_000
const DYNAMIC_FEE_FLAG = 0x800000

const positiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

// Sized by what the scan IS, not by which chain it is on.
//
// A Graph-backed chain pins a snapshot and then tails a short distance from it,
// so 9,001 blocks — inside the flat 10,000-block cap every provider honours —
// costs one request and never probes a limit. An RPC-directory chain has no
// snapshot: this scan IS the directory, from the PoolManager's deployment block
// to the head, and on Robinhood that is 28.6M blocks. At a tail's window it was
// 3,175 SERIAL requests taking 366s, with zero shrinks in the whole run — the
// provider never once objected, so the window was small for no reason at all.
//
// 500,000 is measured rather than guessed, against this chain 2026-08-05:
//
//   sparse (blk 9k+)        500k blocks →    17 logs  0.82s  ok
//   mid-history (15M)       500k blocks → 5,105 logs  2.87s  ok
//   dense launchpad (28M)   500k blocks → 3,510 logs  2.94s  ok
//   any era                   2M blocks →  REJECTED (log response size)
//
// So 500k clears the ceiling everywhere with room to spare, and the era that
// might not is exactly what scanAdaptiveLogWindows halves through — one wasted
// probe, not a permanently narrow window.
const V4_RPC_HISTORICAL = !!V4?.rpcDirectory
const V4_RPC_WINDOW_BLOCKS = positiveInt(
  process.env.INDEXER_BACKFILL_WINDOW_BLOCKS,
  CHAIN.id === 56 ? 1_000 : V4_RPC_HISTORICAL ? 500_000 : 9_001,
)
// The other half, and the larger one: 57 windows run serially still cost ~165s.
// The scanner probes a single window before batching (adaptiveLogs.ts), so a
// rejection is discovered at width 1 and the batch only ever runs a window size
// the provider has already accepted. getLogs parallelises cleanly here — the
// per-key serialisation this box has seen before was on eth_call batches.
const V4_RPC_CONCURRENCY = positiveInt(
  process.env.INDEXER_BACKFILL_CONCURRENCY,
  CHAIN.id === 56 ? 8 : V4_RPC_HISTORICAL ? 8 : 1,
)

type GraphMeta = {
  block?: { number?: number | string; hash?: string } | null
  deployment?: string
  hasIndexingErrors?: boolean
}

type GraphToken = {
  id: string
  symbol: string
  decimals: string
}

type GraphDay = {
  date: number | string
  volumeToken0: string
  volumeToken1: string
}

export type V4SnapshotGraphPool = {
  id: string
  token0: GraphToken
  token1: GraphToken
  tickSpacing: string
  hooks: string
  totalValueLockedToken0?: string
  totalValueLockedToken1?: string
  poolDayData?: GraphDay[]
}

type GraphBase = {
  _meta?: GraphMeta | null
  poolManagers?: Array<{ id: string; poolCount: string }> | null
}

type MetaResponse = { _meta?: GraphMeta | null }
type PageResponse = GraphBase & { pools?: V4SnapshotGraphPool[] | null }
type FrontResponse = GraphBase & {
  stable0?: V4SnapshotGraphPool[]
  stable1?: V4SnapshotGraphPool[]
  native0?: V4SnapshotGraphPool[]
  native1?: V4SnapshotGraphPool[]
  wrapped0?: V4SnapshotGraphPool[]
  wrapped1?: V4SnapshotGraphPool[]
  active?: V4SnapshotGraphPool[]
}

export type V4SnapshotResult = {
  added: number
  block: number
  blockHash: string
  downloaded: number
  deployment: string
  generation: string
}

const graphError = (body: unknown): string => {
  if (!body || typeof body !== 'object') return 'invalid response'
  const errors = (body as { errors?: Array<{ message?: unknown }> }).errors
  if (!Array.isArray(errors) || !errors.length) return 'missing data'
  return errors
    .map((error) => String(error?.message ?? '?'))
    .join('; ')
    .slice(0, 240)
}

async function graphQuery<T>(
  subgraphId: string,
  apiKey: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const attempts = 4
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response: Response
    try {
      response = await fetch(`${GRAPH_GATEWAY}/${subgraphId}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'user-agent': 'up33-lp-indexer/0.1',
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      if (attempt === attempts) throw error
      await sleep(750 * 2 ** (attempt - 1))
      continue
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      if ((response.status === 429 || response.status >= 500) && attempt < attempts) {
        await sleep(750 * 2 ** (attempt - 1))
        continue
      }
      throw new Error(`The Graph HTTP ${response.status}: invalid JSON`)
    }
    if (!response.ok) {
      if ((response.status === 429 || response.status >= 500) && attempt < attempts) {
        await sleep(750 * 2 ** (attempt - 1))
        continue
      }
      throw new Error(`The Graph HTTP ${response.status}: ${graphError(body)}`)
    }
    // GraphQL validation/indexing errors are deterministic for this document;
    // retrying them would only burn quota and hide a schema/provenance failure.
    if ((body as { errors?: unknown[] })?.errors?.length)
      throw new Error(`The Graph query failed: ${graphError(body)}`)
    const data = (body as { data?: T })?.data
    if (!data) throw new Error('The Graph query returned no data')
    return data
  }
  throw new Error('The Graph request exhausted retries')
}

const integer = (value: unknown, label: string): number => {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`The Graph returned invalid ${label}`)
  return parsed
}

const address = (value: unknown, label: string): string => {
  const parsed = String(value ?? '').toLowerCase()
  if (!ADDRESS.test(parsed)) throw new Error(`The Graph returned invalid ${label}`)
  return parsed
}

const poolId = (value: unknown): string => {
  const parsed = String(value ?? '').toLowerCase()
  if (!POOL_ID.test(parsed)) throw new Error('The Graph returned invalid v4 pool id')
  return parsed
}

const finiteNonnegative = (value: unknown, label: string): number | null => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    // Permissionless accounting may overflow JS display numbers. It must not
    // poison ranking, but it also must not invalidate the authentic directory.
    if (String(value ?? '').trim()) return null
    throw new Error(`The Graph returned invalid ${label}`)
  }
  return parsed
}

const printableSymbol = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') return fallback
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return clampWidth(clean || fallback, 32)
}

function graphConfig(): { apiKey: string; subgraphId: string; maxLagBlocks: number } {
  if (!V4?.poolSubgraph)
    throw new Error(`${CHAIN.key} has no configured Uniswap V4 pool subgraph`)
  const apiKey = process.env.THEGRAPH_API_KEY?.trim()
  if (!apiKey)
    throw new Error(
      'BSC Uniswap V4 bootstrap requires server-side THEGRAPH_API_KEY; RPC full-history fallback is disabled',
    )
  const subgraphId =
    process.env.INDEXER_V4_SUBGRAPH_ID?.trim() || V4.poolSubgraph || BSC_UNI_V4_SUBGRAPH_ID
  if (!SUBGRAPH_ID.test(subgraphId)) throw new Error('INDEXER_V4_SUBGRAPH_ID is invalid')
  const maxLagBlocks = Number(
    process.env.INDEXER_V4_SUBGRAPH_MAX_LAG_BLOCKS?.trim() ||
      DEFAULT_MAX_SNAPSHOT_LAG_BLOCKS,
  )
  if (!Number.isSafeInteger(maxLagBlocks) || maxLagBlocks <= 0)
    throw new Error('INDEXER_V4_SUBGRAPH_MAX_LAG_BLOCKS must be a positive integer')
  return { apiKey, subgraphId, maxLagBlocks }
}

type PinnedMeta = { block: number; blockHash: string }

function assertMeta(
  meta: GraphMeta | null | undefined,
  expectedBlock?: number,
  expectedHash?: string,
): PinnedMeta {
  if (!meta?.block) throw new Error('The Graph response is missing _meta.block')
  if (meta.hasIndexingErrors !== false)
    throw new Error('The Graph V4 subgraph reports indexing errors')
  const block = integer(meta.block.number, '_meta.block.number')
  if (expectedBlock !== undefined && block !== expectedBlock)
    throw new Error(`The Graph V4 snapshot moved from block ${expectedBlock} to ${block}`)
  const blockHash = String(meta.block.hash ?? '').toLowerCase()
  if (!BLOCK_HASH.test(blockHash))
    throw new Error('The Graph response is missing a valid _meta.block.hash')
  if (expectedHash !== undefined && blockHash !== expectedHash)
    throw new Error(`The Graph V4 snapshot block ${block} changed hash`)
  return { block, blockHash }
}

const snapshotGeneration = (
  subgraphId: string,
  deployment: string,
  block: number,
  blockHash: string,
): string =>
  keccak256(
    encodeAbiParameters(
      [{ type: 'string' }],
      [`${subgraphId}\n${deployment}\n${block}\n${blockHash}`],
    ),
  )

async function canonicalHash(block: number): Promise<string> {
  const chainBlock = await pc.getBlock({ blockNumber: BigInt(block) })
  const hash = String(chainBlock.hash ?? '').toLowerCase()
  if (!BLOCK_HASH.test(hash)) throw new Error(`RPC block ${block} is missing a canonical hash`)
  return hash
}

async function assertCanonicalSnapshot(block: number, graphHash: string): Promise<void> {
  const rpcHash = await canonicalHash(block)
  if (rpcHash !== graphHash)
    throw new Error(
      `The Graph V4 snapshot block ${block} hash ${graphHash} does not match canonical RPC hash ${rpcHash}`,
    )
}

function assertManager(data: GraphBase, expectedCount?: number): number {
  if (!V4) throw new Error(`${CHAIN.key} has no configured Uniswap V4 deployment`)
  const managers = data.poolManagers ?? []
  if (
    managers.length !== 1 ||
    address(managers[0]?.id, 'pool manager id') !== V4.POOL_MANAGER.toLowerCase()
  )
    throw new Error('The Graph V4 snapshot is not bound to the configured PoolManager')
  const count = integer(managers[0].poolCount, 'poolManager.poolCount')
  if (expectedCount !== undefined && count !== expectedCount)
    throw new Error('The Graph V4 poolCount changed inside a pinned snapshot')
  return count
}

export function hasCompleteV4GraphSnapshot(): boolean {
  if (!V4?.poolSubgraph || !hasCompleteV4SnapshotRows()) return false
  const configured = process.env.INDEXER_V4_SUBGRAPH_ID?.trim() || V4.poolSubgraph
  return SUBGRAPH_ID.test(configured) && kvGet('v4_snapshot_subgraph_id') === configured
}

const POOL_IDENTITY_FIELDS = `
  id
  token0 { id symbol decimals }
  token1 { id symbol decimals }
  tickSpacing
  hooks
`

const POOL_FEATURED_FIELDS = `
  ${POOL_IDENTITY_FIELDS}
  totalValueLockedToken0
  totalValueLockedToken1
  poolDayData(
    first: 2
    orderBy: date
    orderDirection: desc
    where: { date_gte: $sinceDay }
  ) { date volumeToken0 volumeToken1 }
`

const META_QUERY = `query V4SnapshotMeta {
  _meta { block { number hash } deployment hasIndexingErrors }
}`

const PAGE_QUERY = `query V4SnapshotPage(
  $hash: Bytes!
  $after: ID!
) {
  _meta(block: { hash: $hash }) {
    block { number hash }
    deployment
    hasIndexingErrors
  }
  poolManagers(first: 2, block: { hash: $hash }) { id poolCount }
  pools(
    first: 1000
    orderBy: id
    orderDirection: asc
    where: { id_gt: $after }
    block: { hash: $hash }
  ) { ${POOL_IDENTITY_FIELDS} }
}`

const FRONT_QUERY = `query V4PoolFront(
  $perAnchor: Int!
  $activeFirst: Int!
  $stable: String!
  $native: String!
  $wrapped: String!
  $sinceDay: Int!
) {
  _meta { block { number hash } deployment hasIndexingErrors }
  poolManagers(first: 2) { id poolCount }
  stable0: pools(first: $perAnchor, orderBy: totalValueLockedToken0, orderDirection: desc,
    where: { token0: $stable, liquidity_gt: "0" }) { ${POOL_FEATURED_FIELDS} }
  stable1: pools(first: $perAnchor, orderBy: totalValueLockedToken1, orderDirection: desc,
    where: { token1: $stable, liquidity_gt: "0" }) { ${POOL_FEATURED_FIELDS} }
  native0: pools(first: $perAnchor, orderBy: totalValueLockedToken0, orderDirection: desc,
    where: { token0: $native, liquidity_gt: "0" }) { ${POOL_FEATURED_FIELDS} }
  native1: pools(first: $perAnchor, orderBy: totalValueLockedToken1, orderDirection: desc,
    where: { token1: $native, liquidity_gt: "0" }) { ${POOL_FEATURED_FIELDS} }
  wrapped0: pools(first: $perAnchor, orderBy: totalValueLockedToken0, orderDirection: desc,
    where: { token0: $wrapped, liquidity_gt: "0" }) { ${POOL_FEATURED_FIELDS} }
  wrapped1: pools(first: $perAnchor, orderBy: totalValueLockedToken1, orderDirection: desc,
    where: { token1: $wrapped, liquidity_gt: "0" }) { ${POOL_FEATURED_FIELDS} }
  active: pools(first: $activeFirst, orderBy: txCount, orderDirection: desc,
    where: { liquidity_gt: "0" }) { ${POOL_FEATURED_FIELDS} }
}`

type ParsedPool = {
  id: string
  currency0: string
  currency1: string
  tickSpacing: number
  hooks: string
  token0: { symbol: string; decimals: number }
  token1: { symbol: string; decimals: number }
  tvl0: number | null
  tvl1: number | null
  days: { date: number; volume0: number | null; volume1: number | null }[]
}

function parsedPool(row: V4SnapshotGraphPool): ParsedPool {
  const id = poolId(row.id)
  const currency0 = address(row.token0?.id, `pool ${id} currency0`)
  const currency1 = address(row.token1?.id, `pool ${id} currency1`)
  if (currency0 >= currency1)
    throw new Error(`The Graph v4 pool ${id} has non-canonical currency order`)
  const hooks = address(row.hooks, `pool ${id} hooks`)
  const tickSpacing = integer(row.tickSpacing, `pool ${id} tickSpacing`)
  if (tickSpacing <= 0 || tickSpacing > 32_767)
    throw new Error(`The Graph v4 pool ${id} has invalid tickSpacing`)

  const token = (raw: GraphToken, currency: string) => {
    if (currency === zeroAddress)
      return {
        symbol: CHAIN.nativeCurrency.symbol,
        decimals: CHAIN.nativeCurrency.decimals,
      }
    const decimals = integer(raw?.decimals, `token ${currency} decimals`)
    if (decimals > 255) throw new Error(`The Graph token ${currency} has invalid decimals`)
    return {
      symbol: printableSymbol(raw?.symbol, `${currency.slice(0, 6)}…`),
      decimals,
    }
  }

  const seenDays = new Set<number>()
  const days = (row.poolDayData ?? []).map((day) => {
    const date = integer(day.date, `pool ${id} day date`)
    if (seenDays.has(date)) throw new Error(`The Graph v4 pool ${id} has duplicate day data`)
    seenDays.add(date)
    return {
      date,
      volume0: finiteNonnegative(day.volumeToken0, `pool ${id} volumeToken0`),
      volume1: finiteNonnegative(day.volumeToken1, `pool ${id} volumeToken1`),
    }
  })
  if (days.length > 2) throw new Error(`The Graph v4 pool ${id} returned too many day rows`)

  return {
    id,
    currency0,
    currency1,
    tickSpacing,
    hooks,
    token0: token(row.token0, currency0),
    token1: token(row.token1, currency1),
    tvl0:
      row.totalValueLockedToken0 === undefined
        ? null
        : finiteNonnegative(row.totalValueLockedToken0, `pool ${id} TVL0`),
    tvl1:
      row.totalValueLockedToken1 === undefined
        ? null
        : finiteNonnegative(row.totalValueLockedToken1, `pool ${id} TVL1`),
    days,
  }
}

function assertExistingIdentity(row: ParsedPool): void {
  if (!V4) throw new Error(`${CHAIN.key} has no configured Uniswap V4 deployment`)
  const existing = v4PoolRow(row.id)
  if (
    existing &&
    (existing.pool_manager !== V4.POOL_MANAGER.toLowerCase() ||
      existing.currency0 !== row.currency0 ||
      existing.currency1 !== row.currency1 ||
      existing.tick_spacing !== row.tickSpacing ||
      existing.hooks !== row.hooks)
  )
    throw new Error(`existing v4 pool ${row.id} conflicts with The Graph snapshot`)
}

function storeGraphIdentity(row: ParsedPool, generation: string): boolean {
  if (!V4) throw new Error(`${CHAIN.key} has no configured Uniswap V4 deployment`)
  assertExistingIdentity(row)
  const added = insertV4Pool({
    poolId: row.id,
    poolManager: V4.POOL_MANAGER,
    currency0: row.currency0,
    currency1: row.currency1,
    tickSpacing: row.tickSpacing,
    hooks: row.hooks,
    snapshotGeneration: generation,
  })
  // INSERT OR IGNORE protects an event-verified identity. Existing rows still
  // need to be counted in the exact generation now being imported.
  if (!added) setV4SnapshotGeneration(row.id, generation)
  upsertV4TokenMeta(row.currency0, row.token0.symbol, row.token0.decimals)
  upsertV4TokenMeta(row.currency1, row.token1.symbol, row.token1.decimals)
  return added
}

/**
 * Import one immutable, count-complete, identity-only candidate directory.
 * Historic Graph rows deliberately receive neither a fee/state blessing nor a
 * 162k-row statistics snapshot: Pool.feeTier mutates, StateView would turn boot
 * into an RPC history job, and full-catalog TVL/day data would be stale forever.
 * A small featured query owns fresh display stats. The browser proves only the
 * page it displays by hashing {currencies, live/static-or-dynamic fee, spacing,
 * hooks} back to this PoolId.
 */
export async function importBscV4Snapshot(targetBlock: number): Promise<V4SnapshotResult> {
  if (CHAIN.id !== 56 || !V4?.poolSubgraph)
    throw new Error('The Graph V4 snapshot importer is BSC-only')
  if (!Number.isSafeInteger(targetBlock) || targetBlock <= 0)
    throw new Error('invalid finalized target block for V4 snapshot')

  const { apiKey, subgraphId, maxLagBlocks } = graphConfig()
  const latest = await graphQuery<MetaResponse>(subgraphId, apiKey, META_QUERY)
  const indexedBlock = assertMeta(latest._meta).block
  const inflightBlock = Number(kvGet('v4_snapshot_inflight_block'))
  const inflightBlockHash = kvGet('v4_snapshot_inflight_block_hash')?.toLowerCase() ?? ''
  const inflightAfter = kvGet('v4_snapshot_inflight_after') ?? ''
  const inflightDownloaded = Number(kvGet('v4_snapshot_inflight_downloaded'))
  const inflightCount = Number(kvGet('v4_snapshot_inflight_pool_count'))
  const inflightDeployment = kvGet('v4_snapshot_inflight_deployment')?.trim() ?? ''
  const inflightGeneration = kvGet('v4_snapshot_inflight_generation')?.trim() ?? ''
  const expectedInflightGeneration =
    Number.isSafeInteger(inflightBlock) &&
    inflightBlock > 0 &&
    BLOCK_HASH.test(inflightBlockHash) &&
    inflightDeployment.length > 0
      ? snapshotGeneration(
          subgraphId,
          inflightDeployment,
          inflightBlock,
          inflightBlockHash,
        )
      : ''
  const canResume =
    kvGet('v4_snapshot_inflight_subgraph_id') === subgraphId &&
    Number.isSafeInteger(inflightBlock) &&
    inflightBlock > 0 &&
    inflightBlock <= indexedBlock &&
    inflightBlock <= targetBlock &&
    targetBlock - inflightBlock <= maxLagBlocks &&
    POOL_ID.test(inflightAfter) &&
    Number.isSafeInteger(inflightDownloaded) &&
    inflightDownloaded > 0 &&
    Number.isSafeInteger(inflightCount) &&
    inflightCount > 0 &&
    inflightDeployment.length > 0 &&
    inflightGeneration === expectedInflightGeneration &&
    v4SnapshotGenerationCount(inflightGeneration) === inflightDownloaded
  const snapshotBlock = canResume
    ? inflightBlock
    : Math.min(indexedBlock, targetBlock)
  const snapshotLag = targetBlock - snapshotBlock
  if (snapshotLag > maxLagBlocks)
    throw new Error(
      `The Graph V4 snapshot lags the finalized chain head by ${snapshotLag} blocks; maximum is ${maxLagBlocks}`,
    )

  let after = canResume ? inflightAfter : ZERO_POOL_ID
  let downloaded = canResume ? inflightDownloaded : 0
  let expectedCount: number | undefined = canResume ? inflightCount : undefined
  let added = 0
  let deployment: string | undefined = canResume ? inflightDeployment : undefined
  let snapshotHash: string
  let generation: string | undefined = canResume ? inflightGeneration : undefined

  if (canResume) {
    snapshotHash = inflightBlockHash
    await assertCanonicalSnapshot(snapshotBlock, snapshotHash)
  } else {
    // The Graph Network currently returns a null hash for
    // `_meta(block:{number})`. Resolve the finalized canonical hash from RPC
    // first and pin every historic entity query by that hash instead.
    snapshotHash = await canonicalHash(snapshotBlock)
  }

  for (;;) {
    let parsed: ParsedPool[] | undefined
    let acceptedCount: number | undefined
    let previousFirstCount: number | undefined
    const observedCounts: number[] = []

    for (let attempt = 1; attempt <= PAGE_COUNT_ATTEMPTS; attempt++) {
      const page = await graphQuery<PageResponse>(subgraphId, apiKey, PAGE_QUERY, {
        hash: snapshotHash,
        after,
      })
      assertMeta(page._meta, snapshotBlock, snapshotHash)
      const pageDeployment = page._meta?.deployment?.trim()
      if (!pageDeployment) throw new Error('The Graph response is missing _meta.deployment')
      if (deployment !== undefined && deployment !== pageDeployment)
        throw new Error('The Graph deployment changed inside a pinned V4 snapshot')
      deployment = pageDeployment
      const pageGeneration = snapshotGeneration(
        subgraphId,
        deployment,
        snapshotBlock,
        snapshotHash,
      )
      if (generation !== undefined && generation !== pageGeneration)
        throw new Error('The Graph V4 snapshot generation changed inside a pinned import')
      generation = pageGeneration

      // Meta/hash/deployment and identity ordering remain fail-closed on every
      // attempt. Only an otherwise-valid, transient poolCount disagreement is
      // eligible for a same-hash/same-cursor consistency refetch.
      const count = assertManager(page)
      observedCounts.push(count)
      const rows = page.pools ?? []
      if (rows.length > PAGE_SIZE) throw new Error('The Graph returned an oversized V4 page')
      let previousId = after
      const candidateRows = rows.map((raw) => {
        const row = parsedPool(raw)
        if (row.id <= previousId)
          throw new Error('The Graph V4 page is not strictly ordered by pool id')
        previousId = row.id
        return row
      })

      const countAccepted =
        expectedCount === undefined
          ? previousFirstCount === count
          : count === expectedCount
      if (countAccepted) {
        parsed = candidateRows
        acceptedCount = count
        break
      }
      previousFirstCount = count
      if (attempt === PAGE_COUNT_ATTEMPTS) {
        if (expectedCount === undefined)
          throw new Error(
            `The Graph V4 initial poolCount did not stabilize after ${PAGE_COUNT_ATTEMPTS} attempts: ${observedCounts.join(', ')}`,
          )
        throw new Error(
          `The Graph V4 poolCount mismatch after ${PAGE_COUNT_ATTEMPTS} attempts: expected ${expectedCount}, actual ${count}`,
        )
      }
      await sleep(250 * attempt)
    }

    if (!parsed || acceptedCount === undefined)
      throw new Error('The Graph V4 page consistency check returned no accepted page')
    expectedCount ??= acceptedCount

    const nextAfter = parsed.at(-1)?.id ?? after
    const nextDownloaded = downloaded + parsed.length
    tx(() => {
      for (const row of parsed) if (storeGraphIdentity(row, generation!)) added++
      // The row inserts and resume point commit together. A killed 11-minute
      // bootstrap resumes at the next page without either skipping identities
      // or spending another 160 metered requests replaying a known prefix.
      kvSet('v4_snapshot_inflight_block', String(snapshotBlock))
      kvSet('v4_snapshot_inflight_block_hash', snapshotHash!)
      kvSet('v4_snapshot_inflight_subgraph_id', subgraphId)
      kvSet('v4_snapshot_inflight_after', nextAfter)
      kvSet('v4_snapshot_inflight_downloaded', String(nextDownloaded))
      kvSet('v4_snapshot_inflight_pool_count', String(expectedCount))
      kvSet('v4_snapshot_inflight_deployment', deployment!)
      kvSet('v4_snapshot_inflight_generation', generation!)
    })
    downloaded = nextDownloaded
    after = nextAfter
    if (parsed.length < PAGE_SIZE) break
  }

  if (expectedCount === undefined || expectedCount <= 0 || downloaded !== expectedCount)
    throw new Error(
      `The Graph V4 snapshot is incomplete: downloaded ${downloaded}/${expectedCount ?? '?'} pools`,
    )

  if (!snapshotHash || !generation || !deployment)
    throw new Error('The Graph V4 snapshot is missing complete provenance')
  const generationCount = v4SnapshotGenerationCount(generation)
  if (generationCount !== downloaded)
    throw new Error(
      `The Graph V4 snapshot generation is incomplete: stored ${generationCount}/${downloaded} pools`,
    )
  // Recheck after the potentially long download, immediately before publish.
  await assertCanonicalSnapshot(snapshotBlock, snapshotHash)

  tx(() => {
    deleteStaleV4SnapshotCandidates(generation)
    kvSet('v4_snapshot_source', 'thegraph')
    kvSet('v4_snapshot_block', String(snapshotBlock))
    kvSet('v4_snapshot_block_hash', snapshotHash)
    kvSet('v4_snapshot_subgraph_id', subgraphId)
    kvSet('v4_snapshot_deployment', deployment)
    kvSet('v4_snapshot_pool_count', String(downloaded))
    // The generation write is the armed atomic switch. Publish every field it
    // validates first, especially the replacement's potentially changed count.
    kvSet('v4_snapshot_generation', generation)
    kvSet('v4_snapshot_complete', '1')
    kvSet('v4_cursor', String(snapshotBlock))
    kvSet('v4_snapshot_inflight_block', '')
    kvSet('v4_snapshot_inflight_block_hash', '')
    kvSet('v4_snapshot_inflight_subgraph_id', '')
    kvSet('v4_snapshot_inflight_after', '')
    kvSet('v4_snapshot_inflight_downloaded', '')
    kvSet('v4_snapshot_inflight_pool_count', '')
    kvSet('v4_snapshot_inflight_deployment', '')
    kvSet('v4_snapshot_inflight_generation', '')
  })

  return {
    added,
    block: snapshotBlock,
    blockHash: snapshotHash,
    downloaded,
    deployment,
    generation,
  }
}

/** Refresh only the useful landing set; the 162k-row identity snapshot stays immutable. */
export async function refreshV4FeaturedStats(): Promise<number> {
  if (!V4?.poolSubgraph) return 0
  const { apiKey, subgraphId } = graphConfig()
  const today = Math.floor(Date.now() / 86_400_000) * 86_400
  const data = await graphQuery<FrontResponse>(subgraphId, apiKey, FRONT_QUERY, {
    perAnchor: 30,
    activeFirst: 60,
    stable: CHAIN.addr.STABLE.toLowerCase(),
    native: zeroAddress,
    wrapped: CHAIN.addr.WNATIVE.toLowerCase(),
    sinceDay: today - 86_400,
  })
  const block = assertMeta(data._meta).block
  assertManager(data)
  const feeds = [
    data.stable0,
    data.stable1,
    data.native0,
    data.native1,
    data.wrapped0,
    data.wrapped1,
    data.active,
  ]
  const byId = new Map<string, ParsedPool>()
  for (const feed of feeds) {
    for (const raw of feed ?? []) {
      const row = parsedPool(raw)
      if (!byId.has(row.id)) byId.set(row.id, row)
    }
  }

  const featuredRows = [...byId.values()].filter((row) => {
    if (!v4PoolRow(row.id)) return false
    assertExistingIdentity(row)
    return true
  })
  if (!featuredRows.length)
    throw new Error('The Graph V4 featured refresh returned no locally indexed pools')

  let rank = 0
  let updated = 0
  tx(() => {
    clearV4Featured()
    for (const row of featuredRows) {
      // Latest Graph may be ahead of the finalized RPC tail. It can enrich
      // candidates already indexed, but it cannot admit a new identity.
      upsertV4TokenMeta(row.currency0, row.token0.symbol, row.token0.decimals)
      upsertV4TokenMeta(row.currency1, row.token1.symbol, row.token1.decimals)
      upsertV4GraphStats(row.id, row.tvl0, row.tvl1, row.days)
      markV4Featured(row.id, block, rank++)
      updated++
    }
    pruneV4StatsExcept(block)
    kvSet('v4_featured_block', String(block))
    kvSet('v4_featured_count', String(updated))
    kvSet('v4_featured_asof', String(Math.floor(Date.now() / 1_000)))
  })
  return updated
}

const INITIALIZE = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
)

function eventPoolId(
  currency0: Address,
  currency1: Address,
  fee: number,
  tickSpacing: number,
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
      [currency0, currency1, fee, tickSpacing, hooks],
    ),
  )
}

type InitializeLog = {
  args: {
    id?: Hex
    currency0?: Address
    currency1?: Address
    fee?: number
    tickSpacing?: number
    hooks?: Address
  }
  blockNumber: bigint
}

function storeInitialize(logRow: InitializeLog, durableCursor: number): string | null {
  if (!V4) throw new Error(`${CHAIN.key} has no configured Uniswap V4 deployment`)
  const args = logRow.args
  if (
    !args.id ||
    !args.currency0 ||
    !args.currency1 ||
    args.fee === undefined ||
    args.tickSpacing === undefined ||
    !args.hooks
  )
    throw new Error('PoolManager returned a malformed Initialize log')
  const id = args.id.toLowerCase()
  const currency0 = args.currency0.toLowerCase()
  const currency1 = args.currency1.toLowerCase()
  const hooks = args.hooks.toLowerCase()
  if (
    currency0 >= currency1 ||
    args.tickSpacing <= 0 ||
    args.tickSpacing > 32_767 ||
    !(
      (args.fee >= 0 && args.fee <= 1_000_000) ||
      args.fee === DYNAMIC_FEE_FLAG
    )
  )
    throw new Error(`PoolManager Initialize ${id} has invalid PoolKey fields`)
  const derived = eventPoolId(
    args.currency0,
    args.currency1,
    args.fee,
    args.tickSpacing,
    args.hooks,
  ).toLowerCase()
  if (derived !== id)
    throw new Error(`PoolManager Initialize ${id} failed PoolId round-trip verification`)

  // An RPC-sourced directory is SCOPED, and this is the single gate every
  // Initialize row passes through, so the scope is applied here rather than at
  // each caller. It sits ahead of the durable fence below on purpose: a row
  // that was never going to be stored must not raise for being behind it.
  if (!inV4DirectoryScope(currency0, currency1)) return null

  const existing = v4PoolRow(id)
  if (
    existing &&
    (existing.pool_manager !== V4.POOL_MANAGER.toLowerCase() ||
      existing.currency0 !== currency0 ||
      existing.currency1 !== currency1 ||
      existing.tick_spacing !== args.tickSpacing ||
      existing.hooks !== hooks)
  )
    throw new Error(`existing v4 pool ${id} conflicts with Initialize event`)
  const createdBlock = Number(logRow.blockNumber)
  if (!Number.isSafeInteger(createdBlock))
    throw new Error(`PoolManager Initialize ${id} has invalid block number`)
  // A genuinely new row behind an already-issued block fence would mutate
  // old topology/page traversals. Overlap windows may only replay known rows.
  if (!existing && createdBlock <= durableCursor)
    throw new Error(
      `new PoolManager Initialize ${id} at block ${createdBlock} is at or behind durable cursor ${durableCursor}`,
    )
  const added = insertV4Pool({
    poolId: id,
    poolManager: V4.POOL_MANAGER,
    currency0,
    currency1,
    keyFeePpm: args.fee,
    tickSpacing: args.tickSpacing,
    hooks,
    createdBlock,
  })
  if (!added) setV4EventIdentity(id, args.fee, createdBlock)
  return added ? id : null
}

/**
 * A scan with no cursor to be behind.
 *
 * `storeInitialize` refuses a NEW row at or behind the durable cursor, because
 * the forward tail appending one would mutate a page traversal already issued
 * against that fence. A targeted historical scan is the other case entirely:
 * every row it finds is behind the cursor by construction, and finding them is
 * the point. The caller bumps the directory generation instead, which is the
 * mechanism that exists for exactly this — see v4Rpc.directoryGeneration.
 */
const NO_CURSOR = 0

/**
 * Every v4 pool one token has ever been a currency of.
 *
 * Initialize declares both currencies as INDEXED topics, so the chain can
 * answer this directly: two filtered log queries over the whole range rather
 * than a re-scan of all 257k Initialize events. That is what makes proving a
 * token's origin late — long after its pools were created — affordable enough
 * to do whenever the issuer sweep turns one up.
 */
export async function scanV4ForToken(
  token: string,
  from: number,
  to: number,
): Promise<string[]> {
  if (!V4) return []
  const poolManager = V4.POOL_MANAGER
  const currency = token.toLowerCase() as Address
  const fresh: string[] = []
  for (const side of ['currency0', 'currency1'] as const) {
    await scanAdaptiveLogWindows({
      fromBlock: from,
      toBlock: to,
      // The whole range in one request, unlike the unfiltered scan above.
      // V4_RPC_WINDOW_BLOCKS is sized for a query that returns thousands of
      // logs per window; filtered to one currency the same range returns a
      // handful, so the response-size ceiling that motivates windowing never
      // comes near. Chunking anyway cost 59 requests per side on this chain
      // (29,272,162 blocks at 500k) to fetch what one call returns. A provider
      // with a hard RANGE cap is still handled — scanAdaptiveLogWindows halves
      // until it is accepted, which costs ~6 probes, not 59 round trips.
      maxWindowBlocks: Math.max(1, to - from + 1),
      concurrency: V4_RPC_CONCURRENCY,
      fetchWindow: (lo, hi) =>
        withRotatingRpcClient((client) =>
          client.getLogs({
            address: poolManager,
            event: INITIALIZE,
            args: { [side]: currency },
            fromBlock: BigInt(lo),
            toBlock: BigInt(hi),
          }),
        ),
      commitWindow: ({ rows }) => {
        // No cursor write. This scan is not the directory's forward progress
        // and must not be able to move — or rewind — the fence the tail owns.
        tx(() => {
          for (const row of rows) {
            const added = storeInitialize(row as InitializeLog, NO_CURSOR)
            if (added) fresh.push(added)
          }
        })
      },
      onShrink: (windowBlocks) =>
        log(`[catalog] RPC log range rejected; shrinking v4 token window to ${windowBlocks} blocks`),
      singleBlockError:
        'RPC rejects even a one-block v4 eth_getLogs request; configure a logs-capable indexer RPC',
    })
  }
  return fresh
}

export async function scanV4Windows(
  from: number,
  to: number,
  initialCursor: number,
): Promise<string[]> {
  if (!V4) return []
  const poolManager = V4.POOL_MANAGER
  const fresh: string[] = []
  let durableCursor = initialCursor
  await scanAdaptiveLogWindows({
    fromBlock: from,
    toBlock: to,
    maxWindowBlocks: V4_RPC_WINDOW_BLOCKS,
    concurrency: V4_RPC_CONCURRENCY,
    fetchWindow: (lo, hi) =>
      withRotatingRpcClient((client) =>
        client.getLogs({
          address: poolManager,
          event: INITIALIZE,
          fromBlock: BigInt(lo),
          toBlock: BigInt(hi),
        }),
      ),
    commitWindow: ({ toBlock, rows }) => {
      // Adaptive shrinking can make the first overlap window end behind the
      // published cursor. Checkpoint only a monotonically complete prefix.
      const nextCursor = Math.max(durableCursor, toBlock)
      tx(() => {
        for (const row of rows) {
          const added = storeInitialize(row as InitializeLog, durableCursor)
          if (added) fresh.push(added)
        }
        kvSet('v4_cursor', String(nextCursor))
      })
      durableCursor = nextCursor
    },
    onShrink: (windowBlocks) =>
      log(`[catalog] RPC log range rejected; shrinking v4 window to ${windowBlocks} blocks`),
    singleBlockError:
      'RPC rejects even a one-block v4 eth_getLogs request; configure a logs-capable indexer RPC',
  })
  return fresh
}

/** Bounded finalized Initialize tail; a Graph snapshot is mandatory first. */
export async function tailV4(): Promise<string[]> {
  if (!V4?.poolSubgraph) return []
  if (!hasCompleteV4GraphSnapshot())
    throw new Error('Uniswap V4 RPC tail requires a complete The Graph snapshot')
  const snapshotBlock = Number(kvGet('v4_snapshot_block'))
  const snapshotHash = kvGet('v4_snapshot_block_hash')?.toLowerCase() ?? ''
  if (!Number.isSafeInteger(snapshotBlock) || snapshotBlock <= 0 || !BLOCK_HASH.test(snapshotHash))
    throw new Error('Uniswap V4 snapshot is missing canonical block provenance')
  await assertCanonicalSnapshot(snapshotBlock, snapshotHash)
  const head = Number(await pc.getBlockNumber()) - INDEXER_FINALITY_BLOCKS
  if (!Number.isSafeInteger(head) || head <= 0)
    throw new Error('invalid finalized target block for V4 tail')
  const storedCursor = Number(kvGet('v4_cursor'))
  const cursor = Number.isSafeInteger(storedCursor) ? storedCursor : snapshotBlock
  if (cursor > head)
    throw new Error(
      `univ4 durable cursor ${cursor} is ahead of finalized head ${head}; refusing a destructive rewind`,
    )
  const from = Math.max(snapshotBlock, cursor - 120)
  const fresh = await scanV4Windows(from, head, cursor)
  // Keep the prior successful target published while scanning; publish the
  // completed target and cursor together only after every window succeeds.
  tx(() => {
    kvSet('v4_cursor', String(head))
    kvSet('v4_target_block', String(head))
  })
  return fresh
}

/** Snapshot once, then use only the bounded PoolManager tail for identity. */
export async function backfillV4(): Promise<number> {
  if (!V4?.poolSubgraph) return 0
  const target = Number(await pc.getBlockNumber()) - INDEXER_FINALITY_BLOCKS
  if (!Number.isSafeInteger(target) || target <= 0)
    throw new Error('invalid finalized target block for V4 bootstrap')
  let added = 0
  if (!hasCompleteV4GraphSnapshot()) {
    const snapshot = await importBscV4Snapshot(target)
    added += snapshot.added
    log(
      `[catalog] univ4 The Graph snapshot: ${snapshot.downloaded} candidate pools at blk ${snapshot.block}`,
    )
  }
  added += (await tailV4()).length
  kvSet('v4_backfilled', '1')
  return added
}

const CATALOG_PAGE_SIZE = 1_000

/** Fill metadata for event-tail currencies; address(0) is never called as ERC-20. */
export async function ensureV4TokenMeta(): Promise<number> {
  if (!V4) return 0
  let cursor = ''
  let total = 0
  for (;;) {
    const missing = missingV4TokensPage(cursor, CATALOG_PAGE_SIZE)
    if (!missing.length) break
    const native = missing.includes(zeroAddress)
    const erc20 = missing.filter((token) => token !== zeroAddress)
    const result = await mc(
      erc20.flatMap((token) => [
        { abi: erc20Abi, address: token as Address, functionName: 'symbol' },
        { abi: erc20Abi, address: token as Address, functionName: 'decimals' },
      ]),
    )
    let written = 0
    tx(() => {
      if (native) {
        upsertV4TokenMeta(
          zeroAddress,
          CHAIN.nativeCurrency.symbol,
          CHAIN.nativeCurrency.decimals,
        )
        written++
      }
      erc20.forEach((token, index) => {
        const rawDecimals = ok<number>(result[index * 2 + 1])
        if (
          typeof rawDecimals !== 'number' ||
          !Number.isSafeInteger(rawDecimals) ||
          rawDecimals < 0 ||
          rawDecimals > 255
        )
          return
        const symbol = printableSymbol(
          ok<string>(result[index * 2]),
          `${token.slice(0, 6)}…`,
        )
        upsertV4TokenMeta(token, symbol, rawDecimals)
        written++
      })
    })
    total += written
    cursor = missing.at(-1)!
  }
  return total
}
