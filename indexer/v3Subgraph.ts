import { randomUUID } from 'node:crypto'
import { parseAbi } from 'viem'
import { CHAIN, UNI, UNI_V3_START_BLOCK } from './config'
import { mc, ok, pc } from './rpc'
import {
  deletePoolsOutsideSnapshotGeneration,
  insertPool,
  kvGet,
  kvSet,
  poolCounts,
  poolRow,
  setPoolSnapshotGeneration,
  tx,
} from './store'

/** Reviewed Uniswap V3 BSC snapshot identity on The Graph Network. */
export const BSC_UNI_V3_SUBGRAPH_ID =
  '8f1KyiuNYiNGrjagzEVpf6k6KkPG517prtjdrJihgHw'
export const BSC_UNI_V3_SUBGRAPH_DEPLOYMENT =
  'QmctqZqG2SY5wvwLVBPZY8God2cW3wjNQ14Z4swKeJJX9D'

const GRAPH_GATEWAY = 'https://gateway.thegraph.com/api/subgraphs/id'
const PAGE_SIZE = 1_000
const DEFAULT_MAX_SNAPSHOT_LAG_BLOCKS = 10_000
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/
const SUBGRAPH_ID = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/
const ZERO = '0x0000000000000000000000000000000000000000'

const factoryVerifyAbi = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
  'function feeAmountTickSpacing(uint24 fee) view returns (int24 tickSpacing)',
])

type GraphMeta = {
  block?: { number?: number | string; hash?: string } | null
  deployment?: string
  hasIndexingErrors?: boolean
}

type GraphPool = {
  id: string
  inputTokens: Array<{ id: string }>
  fees: Array<{ feeType: string; feePercentage: string | null }>
  createdBlockNumber: string
}

type MetaResponse = { _meta?: GraphMeta | null }
type PageResponse = {
  _meta?: GraphMeta | null
  dexAmmProtocols?: Array<{
    id: string
    network: string
    totalPoolCount: number | string
  }>
  liquidityPools?: GraphPool[]
}

export type V3SnapshotResult = {
  added: number
  block: number
  blockHash: string
  downloaded: number
  deployment: string
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
  const response = await fetch(`${GRAPH_GATEWAY}/${subgraphId}`, {
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
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error(`The Graph HTTP ${response.status}: invalid JSON`)
  }
  if (!response.ok) throw new Error(`The Graph HTTP ${response.status}: ${graphError(body)}`)
  if ((body as { errors?: unknown[] })?.errors?.length)
    throw new Error(`The Graph query failed: ${graphError(body)}`)
  const data = (body as { data?: T })?.data
  if (!data) throw new Error('The Graph query returned no data')
  return data
}

const int = (value: unknown, label: string): number => {
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

/** Messari schema stores feePercentage in human percent: 0.3 => 3,000 ppm. */
const feePercentageToPpm = (value: unknown): number => {
  const text = String(value ?? '')
  if (!/^\d+(?:\.\d+)?$/.test(text))
    throw new Error('The Graph returned invalid FIXED_TRADING_FEE percentage')
  const [whole, fraction = ''] = text.split('.')
  if (fraction.length > 4 && /[1-9]/.test(fraction.slice(4)))
    throw new Error('The Graph returned a sub-ppm FIXED_TRADING_FEE percentage')
  const ppm = Number(whole) * 10_000 + Number((fraction + '0000').slice(0, 4))
  if (!Number.isSafeInteger(ppm) || ppm <= 0 || ppm >= 1_000_000)
    throw new Error('The Graph returned invalid FIXED_TRADING_FEE percentage')
  return ppm
}

type PinnedMeta = { block: number; blockHash: string; deployment: string }

function assertMeta(
  meta: GraphMeta | null | undefined,
  expectedBlock?: number,
  expectedHash?: string,
  expectedDeployment?: string,
): PinnedMeta {
  if (!meta?.block) throw new Error('The Graph response is missing _meta.block')
  if (meta.hasIndexingErrors !== false)
    throw new Error('The Graph V3 subgraph reports indexing errors')
  const block = int(meta.block.number, '_meta.block.number')
  if (expectedBlock !== undefined && block !== expectedBlock)
    throw new Error(`The Graph snapshot moved from block ${expectedBlock} to ${block}`)
  const blockHash = String(meta.block.hash ?? '').toLowerCase()
  if (!BLOCK_HASH.test(blockHash))
    throw new Error('The Graph response is missing a valid _meta.block.hash')
  if (expectedHash !== undefined && blockHash !== expectedHash)
    throw new Error(`The Graph V3 snapshot block ${block} changed hash`)
  const deployment = String(meta.deployment ?? '').trim()
  if (!deployment) throw new Error('The Graph response is missing _meta.deployment')
  if (expectedDeployment !== undefined && deployment !== expectedDeployment)
    throw new Error('The Graph deployment changed inside a pinned V3 snapshot')
  return { block, blockHash, deployment }
}

function snapshotConfigured(): {
  apiKey: string
  subgraphId: string
  expectedDeployment: string
  maxLagBlocks: number
} {
  const apiKey = process.env.THEGRAPH_API_KEY?.trim()
  if (!apiKey)
    throw new Error(
      'BSC Uniswap V3 bootstrap requires server-side THEGRAPH_API_KEY; RPC full-history fallback is disabled',
    )
  const subgraphId =
    process.env.INDEXER_V3_SUBGRAPH_ID?.trim() || BSC_UNI_V3_SUBGRAPH_ID
  if (!SUBGRAPH_ID.test(subgraphId))
    throw new Error('INDEXER_V3_SUBGRAPH_ID is invalid')
  const expectedDeployment =
    process.env.INDEXER_V3_SUBGRAPH_DEPLOYMENT?.trim() ||
    (subgraphId === BSC_UNI_V3_SUBGRAPH_ID
      ? BSC_UNI_V3_SUBGRAPH_DEPLOYMENT
      : '')
  if (!SUBGRAPH_ID.test(expectedDeployment))
    throw new Error(
      'a custom Uniswap V3 subgraph requires INDEXER_V3_SUBGRAPH_DEPLOYMENT',
    )
  const maxLagBlocks = Number(
    process.env.INDEXER_V3_SUBGRAPH_MAX_LAG_BLOCKS?.trim() ||
      DEFAULT_MAX_SNAPSHOT_LAG_BLOCKS,
  )
  if (!Number.isSafeInteger(maxLagBlocks) || maxLagBlocks <= 0)
    throw new Error('INDEXER_V3_SUBGRAPH_MAX_LAG_BLOCKS must be a positive integer')
  return { apiKey, subgraphId, expectedDeployment, maxLagBlocks }
}

const configuredSubgraphId = (): string =>
  process.env.INDEXER_V3_SUBGRAPH_ID?.trim() || BSC_UNI_V3_SUBGRAPH_ID
const configuredDeployment = (): string =>
  process.env.INDEXER_V3_SUBGRAPH_DEPLOYMENT?.trim() ||
  (configuredSubgraphId() === BSC_UNI_V3_SUBGRAPH_ID
    ? BSC_UNI_V3_SUBGRAPH_DEPLOYMENT
    : '')

async function canonicalHash(block: number): Promise<string> {
  const chainBlock = await pc.getBlock({ blockNumber: BigInt(block) })
  const hash = String(chainBlock.hash ?? '').toLowerCase()
  if (!BLOCK_HASH.test(hash)) throw new Error(`RPC block ${block} is missing a canonical hash`)
  return hash
}

class V3SnapshotCanonicalMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'V3SnapshotCanonicalMismatchError'
  }
}

async function assertCanonicalSnapshot(block: number, graphHash: string): Promise<void> {
  const rpcHash = await canonicalHash(block)
  if (rpcHash !== graphHash)
    throw new V3SnapshotCanonicalMismatchError(
      `The Graph Uniswap V3 snapshot block ${block} hash ${graphHash} does not match canonical RPC hash ${rpcHash}`,
    )
}

function storedCompleteV3GraphSnapshot(): PinnedMeta | null {
  if (CHAIN.id !== 56) return null
  const block = Number(kvGet('v3_snapshot_block'))
  const blockHash = kvGet('v3_snapshot_block_hash')?.toLowerCase() ?? ''
  const snapshotPoolCount = Number(kvGet('v3_snapshot_pool_count'))
  const storedSubgraphId = kvGet('v3_snapshot_subgraph_id') ?? ''
  const deployment = kvGet('v3_snapshot_deployment')?.trim() ?? ''
  const cursor = Number(kvGet('v3_cursor'))
  const storedV3Pools = poolCounts().find((row) => row.proto === 'univ3')?.n ?? 0
  const complete = (
    kvGet('v3_snapshot_source') === 'thegraph' &&
    kvGet('v3_snapshot_complete') === '1' &&
    Number.isSafeInteger(block) &&
    block >= UNI_V3_START_BLOCK &&
    Number.isSafeInteger(cursor) &&
    cursor >= block &&
    Number.isSafeInteger(snapshotPoolCount) &&
    snapshotPoolCount > 0 &&
    storedV3Pools >= snapshotPoolCount &&
    SUBGRAPH_ID.test(storedSubgraphId) &&
    storedSubgraphId === configuredSubgraphId() &&
    BLOCK_HASH.test(blockHash) &&
    deployment === configuredDeployment()
  )
  return complete ? { block, blockHash, deployment } : null
}

/**
 * A durable completion marker is only a reuse candidate. Re-prove the stored
 * block/hash against the current RPC canonical chain before extending its tail.
 */
export async function hasCompleteV3GraphSnapshot(): Promise<boolean> {
  const stored = storedCompleteV3GraphSnapshot()
  if (!stored) return false
  try {
    await assertCanonicalSnapshot(stored.block, stored.blockHash)
  } catch (error) {
    // A confirmed fork mismatch is rebuildable. Transport failures remain
    // errors so a temporary RPC outage never mutates a previously good seed.
    if (error instanceof V3SnapshotCanonicalMismatchError) return false
    throw error
  }
  return true
}

const META_QUERY = `
  query V3SnapshotMeta {
    _meta { block { number hash } deployment hasIndexingErrors }
  }
`

const PAGE_QUERY = `
  query V3SnapshotPage($hash: Bytes!, $after: Bytes!) {
    _meta(block: { hash: $hash }) {
      block { number hash }
      deployment
      hasIndexingErrors
    }
    dexAmmProtocols(first: 2, block: { hash: $hash }) {
      id
      network
      totalPoolCount
    }
    liquidityPools(
      first: 1000
      orderBy: id
      orderDirection: asc
      where: { id_gt: $after }
      block: { hash: $hash }
    ) {
      id
      inputTokens { id }
      fees { feeType feePercentage }
      createdBlockNumber
    }
  }
`

/**
 * Download one immutable BSC V3 catalog snapshot from The Graph, verify every
 * row against the official factory, and only then durably publish provenance
 * and advance the RPC cursor. Partial page inserts are harmless: without the
 * completion marker the next boot repeats the pinned import and de-duplicates.
 */
export async function importBscV3Snapshot(targetBlock: number): Promise<V3SnapshotResult> {
  if (CHAIN.id !== 56) throw new Error('The Graph V3 snapshot importer is BSC-only')
  if (!Number.isSafeInteger(targetBlock) || targetBlock < UNI_V3_START_BLOCK)
    throw new Error('invalid finalized target block for V3 snapshot')

  const { apiKey, subgraphId, expectedDeployment, maxLagBlocks } =
    snapshotConfigured()
  const latest = await graphQuery<MetaResponse>(subgraphId, apiKey, META_QUERY)
  const indexed = assertMeta(latest._meta)
  if (indexed.deployment !== expectedDeployment)
    throw new Error(
      `The Graph Uniswap V3 deployment ${indexed.deployment} is not the reviewed deployment ${expectedDeployment}`,
    )
  if (indexed.block < UNI_V3_START_BLOCK)
    throw new Error('The Graph V3 subgraph has not reached the factory deployment block')
  const snapshotBlock = Math.min(indexed.block, targetBlock)
  const snapshotLag = targetBlock - snapshotBlock
  if (snapshotLag > maxLagBlocks)
    throw new Error(
      `The Graph V3 snapshot lags the finalized chain head by ${snapshotLag} blocks; maximum is ${maxLagBlocks}`,
    )
  const snapshotHash =
    snapshotBlock === indexed.block ? indexed.blockHash : await canonicalHash(snapshotBlock)
  await assertCanonicalSnapshot(snapshotBlock, snapshotHash)
  // Unique per traversal, even when retrying the same immutable Graph block.
  // A row survives publication only if this exact complete pass observed it.
  const importGeneration = `${subgraphId}\n${indexed.deployment}\n${snapshotBlock}\n${snapshotHash}\n${randomUUID()}`
  tx(() => {
    kvSet('v3_snapshot_complete', '0')
    kvSet('v3_snapshot_import_generation', importGeneration)
  })

  let after = ZERO
  let downloaded = 0
  let expectedCount: number | null = null
  let added = 0
  const deployment = indexed.deployment
  const tickSpacingByFee = new Map<number, number>()

  for (;;) {
    const page = await graphQuery<PageResponse>(subgraphId, apiKey, PAGE_QUERY, {
      hash: snapshotHash,
      after,
    })
    assertMeta(page._meta, snapshotBlock, snapshotHash, deployment)

    const protocols = page.dexAmmProtocols ?? []
    if (
      protocols.length !== 1 ||
      address(protocols[0].id, 'protocol id') !== UNI.V3_FACTORY.toLowerCase() ||
      protocols[0].network !== 'BSC'
    )
      throw new Error('The Graph V3 snapshot is not bound to the configured official factory')
    const pageFactoryCount = int(protocols[0].totalPoolCount, 'protocol.totalPoolCount')
    if (expectedCount === null) expectedCount = pageFactoryCount
    else if (expectedCount !== pageFactoryCount)
      throw new Error('The Graph factory poolCount changed inside a pinned snapshot')

    const rows = page.liquidityPools ?? []
    if (rows.length > PAGE_SIZE) throw new Error('The Graph returned an oversized V3 page')

    let previousId = after
    const parsed = rows.map((row) => {
      const id = address(row.id, 'pool id')
      if (id <= previousId) throw new Error('The Graph V3 page is not strictly ordered by pool id')
      previousId = id
      if (row.inputTokens?.length !== 2)
        throw new Error(`The Graph pool ${id} does not have exactly two input tokens`)
      const token0 = address(row.inputTokens[0]?.id, 'pool token0')
      const token1 = address(row.inputTokens[1]?.id, 'pool token1')
      if (token0 >= token1) throw new Error(`The Graph pool ${id} has non-canonical token order`)
      const tradingFees = (row.fees ?? []).filter(
        (fee) => fee.feeType === 'FIXED_TRADING_FEE',
      )
      if (tradingFees.length !== 1)
        throw new Error(`The Graph pool ${id} does not have exactly one FIXED_TRADING_FEE`)
      const fee = feePercentageToPpm(tradingFees[0].feePercentage)
      const createdBlock = int(row.createdBlockNumber, 'pool createdBlockNumber')
      if (createdBlock < UNI_V3_START_BLOCK || createdBlock > snapshotBlock)
        throw new Error(`The Graph pool ${id} has invalid creation block`)
      return { id, token0, token1, fee, createdBlock }
    })

    const missingFees = [...new Set(parsed.map((row) => row.fee))].filter(
      (fee) => !tickSpacingByFee.has(fee),
    )
    if (missingFees.length) {
      const spacingRows = await mc(
        missingFees.map((fee) => ({
          abi: factoryVerifyAbi,
          address: UNI.V3_FACTORY,
          functionName: 'feeAmountTickSpacing',
          args: [fee],
        })),
      )
      missingFees.forEach((fee, index) => {
        const spacing = ok<number>(spacingRows[index])
        if (spacing === undefined || !Number.isSafeInteger(spacing) || spacing === 0)
          throw new Error(`official V3 factory rejected fee tier ${fee}`)
        tickSpacingByFee.set(fee, spacing)
      })
    }

    const factoryRows = await mc(
      parsed.map((row) => ({
        abi: factoryVerifyAbi,
        address: UNI.V3_FACTORY,
        functionName: 'getPool',
        args: [row.token0, row.token1, row.fee],
      })),
    )
    parsed.forEach((row, index) => {
      const canonical = ok<string>(factoryRows[index])?.toLowerCase()
      if (canonical !== row.id)
        throw new Error(`The Graph pool ${row.id} failed official factory verification`)
    })

    tx(() => {
      for (const row of parsed) {
        const spacing = tickSpacingByFee.get(row.fee)!
        const existing = poolRow(row.id)
        if (
          existing &&
          (existing.proto !== 'univ3' ||
            existing.token0 !== row.token0 ||
            existing.token1 !== row.token1 ||
            existing.fee_ppm !== row.fee ||
            existing.tick_spacing !== spacing)
        )
          throw new Error(`existing pool ${row.id} conflicts with verified The Graph snapshot`)
        if (existing) setPoolSnapshotGeneration(row.id, 'univ3', importGeneration)
        else if (
          insertPool({
            address: row.id,
            proto: 'univ3',
            token0: row.token0,
            token1: row.token1,
            feePpm: row.fee,
            tickSpacing: spacing,
            createdBlock: row.createdBlock,
            snapshotGeneration: importGeneration,
            addedTs: 0,
          })
        )
          added++
      }
    })

    downloaded += parsed.length
    if (parsed.length) after = parsed.at(-1)!.id
    if (parsed.length < PAGE_SIZE) break
  }

  if (expectedCount === null || expectedCount <= 0 || downloaded !== expectedCount)
    throw new Error(
      `The Graph V3 snapshot is incomplete: downloaded ${downloaded}/${expectedCount ?? '?'} pools`,
    )

  // A long catalog download can straddle a finalized-chain reorg. Re-check
  // immediately before the generation swap so an orphan hash is never
  // published merely because it was canonical when page one started.
  await assertCanonicalSnapshot(snapshotBlock, snapshotHash)

  tx(() => {
    deletePoolsOutsideSnapshotGeneration('univ3', importGeneration)
    const publishedCount =
      poolCounts().find((row) => row.proto === 'univ3')?.n ?? 0
    if (publishedCount !== downloaded)
      throw new Error(
        `Uniswap V3 snapshot replacement retained ${publishedCount}/${downloaded} pools`,
      )
    kvSet('v3_snapshot_source', 'thegraph')
    kvSet('v3_snapshot_block', String(snapshotBlock))
    kvSet('v3_snapshot_block_hash', snapshotHash)
    kvSet('v3_snapshot_subgraph_id', subgraphId)
    kvSet('v3_snapshot_deployment', deployment)
    kvSet('v3_snapshot_pool_count', String(downloaded))
    kvSet('v3_snapshot_complete', '1')
    kvSet('v3_snapshot_import_generation', '')
    kvSet('v3_cursor', String(snapshotBlock))
  })

  return { added, block: snapshotBlock, blockHash: snapshotHash, downloaded, deployment }
}
