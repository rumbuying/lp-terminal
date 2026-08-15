import { randomUUID } from 'node:crypto'
import { parseAbi } from 'viem'
import { ADDR, CHAIN, PANCAKE_V3_START_BLOCK, sleep } from './config'
import { mc, ok, pc } from './rpc'
import {
  deletePoolSnapshotGeneration,
  deletePoolsOutsideSnapshotGeneration,
  insertPool,
  kvGet,
  kvSet,
  poolCounts,
  poolRow,
  setPoolSnapshotGeneration,
  tx,
} from './store'

/**
 * Live Messari-schema PancakeSwap V3 BSC catalog on The Graph Network. Its
 * content-addressed manifest starts at the official factory deployment; every
 * imported identity is still independently proven through that factory.
 */
export const BSC_PANCAKE_V3_SUBGRAPH_ID =
  '78EUqzJmEVJsAKvWghn7qotf9LVGqcTQxJhT5z84ZmgJ'
export const BSC_PANCAKE_V3_SUBGRAPH_DEPLOYMENT =
  'QmQhHo4B63yqxLsqFTMjEF6VQJ6xYorn6k5r5a8takVnJQ'

const GRAPH_GATEWAY = 'https://gateway.thegraph.com/api/subgraphs/id'
const PAGE_SIZE = 1_000
const DEFAULT_MAX_SNAPSHOT_LAG_BLOCKS = 10_000
const ZERO = '0x0000000000000000000000000000000000000000'
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/
const SUBGRAPH_ID = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/
const ROW_GENERATION =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const factoryVerifyAbi = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
  'function feeAmountTickSpacing(uint24 fee) view returns (int24 tickSpacing)',
])
const poolIdentityAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
])

type GraphMeta = {
  block?: { number?: number | string; hash?: string } | null
  deployment?: string
  hasIndexingErrors?: boolean
}

type GraphPool = {
  id: string
  createdBlockNumber: string
}

type MetaResponse = { _meta?: GraphMeta | null }
type PageResponse = {
  _meta?: GraphMeta | null
  dexAmmProtocols?: Array<{
    id: string
    network: string
    totalPoolCount: string | number
  }> | null
  liquidityPools?: GraphPool[] | null
}

export type PancakeV3SnapshotResult = {
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

const transientGraphError = (message: string): boolean =>
  /bad indexers|BadResponse|timeout|internal server error|service unavailable/i.test(
    message,
  )

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
    if ((body as { errors?: unknown[] })?.errors?.length) {
      const message = graphError(body)
      if (transientGraphError(message) && attempt < attempts) {
        await sleep(750 * 2 ** (attempt - 1))
        continue
      }
      throw new Error(`The Graph query failed: ${message}`)
    }
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

type PinnedMeta = { block: number; blockHash: string; deployment: string }

function assertMeta(
  meta: GraphMeta | null | undefined,
  expectedBlock?: number,
  expectedHash?: string,
  expectedDeployment?: string,
): PinnedMeta {
  if (!meta?.block) throw new Error('The Graph response is missing _meta.block')
  if (meta.hasIndexingErrors !== false)
    throw new Error('The Graph Pancake V3 subgraph reports indexing errors')
  const block = integer(meta.block.number, '_meta.block.number')
  if (expectedBlock !== undefined && block !== expectedBlock)
    throw new Error(`The Graph Pancake V3 snapshot moved from block ${expectedBlock} to ${block}`)
  const blockHash = String(meta.block.hash ?? '').toLowerCase()
  if (!BLOCK_HASH.test(blockHash))
    throw new Error('The Graph response is missing a valid _meta.block.hash')
  if (expectedHash !== undefined && blockHash !== expectedHash)
    throw new Error(`The Graph Pancake V3 snapshot block ${block} changed hash`)
  const deployment = String(meta.deployment ?? '').trim()
  if (!deployment) throw new Error('The Graph response is missing _meta.deployment')
  if (expectedDeployment !== undefined && deployment !== expectedDeployment)
    throw new Error('The Graph deployment changed inside a pinned Pancake V3 snapshot')
  return { block, blockHash, deployment }
}

function graphConfig(): {
  apiKey: string
  subgraphId: string
  expectedDeployment: string
  maxLagBlocks: number
} {
  const apiKey = process.env.THEGRAPH_API_KEY?.trim()
  if (!apiKey)
    throw new Error(
      'BSC Pancake V3 bootstrap requires server-side THEGRAPH_API_KEY; RPC full-history fallback is disabled',
    )
  const subgraphId =
    process.env.INDEXER_PANCAKE_V3_SUBGRAPH_ID?.trim() ||
    BSC_PANCAKE_V3_SUBGRAPH_ID
  if (!SUBGRAPH_ID.test(subgraphId))
    throw new Error('INDEXER_PANCAKE_V3_SUBGRAPH_ID is invalid')
  const configuredDeployment =
    process.env.INDEXER_PANCAKE_V3_SUBGRAPH_DEPLOYMENT?.trim()
  const expectedDeployment =
    configuredDeployment ||
    (subgraphId === BSC_PANCAKE_V3_SUBGRAPH_ID
      ? BSC_PANCAKE_V3_SUBGRAPH_DEPLOYMENT
      : '')
  if (!SUBGRAPH_ID.test(expectedDeployment))
    throw new Error(
      'a custom Pancake V3 subgraph requires INDEXER_PANCAKE_V3_SUBGRAPH_DEPLOYMENT',
    )
  const maxLagBlocks = Number(
    process.env.INDEXER_PANCAKE_V3_SUBGRAPH_MAX_LAG_BLOCKS?.trim() ||
      DEFAULT_MAX_SNAPSHOT_LAG_BLOCKS,
  )
  if (!Number.isSafeInteger(maxLagBlocks) || maxLagBlocks <= 0)
    throw new Error(
      'INDEXER_PANCAKE_V3_SUBGRAPH_MAX_LAG_BLOCKS must be a positive integer',
    )
  return { apiKey, subgraphId, expectedDeployment, maxLagBlocks }
}

async function canonicalHash(block: number): Promise<string> {
  const chainBlock = await pc.getBlock({ blockNumber: BigInt(block) })
  const hash = String(chainBlock.hash ?? '').toLowerCase()
  if (!BLOCK_HASH.test(hash)) throw new Error(`RPC block ${block} is missing a canonical hash`)
  return hash
}

class PancakeV3SnapshotCanonicalMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PancakeV3SnapshotCanonicalMismatchError'
  }
}

async function assertCanonicalSnapshot(block: number, graphHash: string): Promise<void> {
  const rpcHash = await canonicalHash(block)
  if (rpcHash !== graphHash)
    throw new PancakeV3SnapshotCanonicalMismatchError(
      `The Graph Pancake V3 snapshot block ${block} hash ${graphHash} does not match canonical RPC hash ${rpcHash}`,
    )
}

const configuredSubgraphId = (): string =>
  process.env.INDEXER_PANCAKE_V3_SUBGRAPH_ID?.trim() ||
  BSC_PANCAKE_V3_SUBGRAPH_ID
const configuredDeployment = (): string =>
  process.env.INDEXER_PANCAKE_V3_SUBGRAPH_DEPLOYMENT?.trim() ||
  (configuredSubgraphId() === BSC_PANCAKE_V3_SUBGRAPH_ID
    ? BSC_PANCAKE_V3_SUBGRAPH_DEPLOYMENT
    : '')

function storedCompletePancakeV3GraphSnapshot(): PinnedMeta | null {
  if (CHAIN.id !== 56) return null
  const block = Number(kvGet('pancake_v3_snapshot_block'))
  const blockHash = kvGet('pancake_v3_snapshot_block_hash')?.toLowerCase() ?? ''
  const deployment = kvGet('pancake_v3_snapshot_deployment') ?? ''
  const rowGeneration =
    kvGet('pancake_v3_snapshot_row_generation')?.toLowerCase() ?? ''
  const count = Number(kvGet('pancake_v3_snapshot_pool_count'))
  const cursor = Number(kvGet('pancake_v3_cursor'))
  const storedPools =
    poolCounts().find((row) => row.proto === 'pancakev3')?.n ?? 0
  const complete = (
    kvGet('pancake_v3_snapshot_source') === 'thegraph' &&
    kvGet('pancake_v3_snapshot_complete') === '1' &&
    Number.isSafeInteger(block) &&
    block >= PANCAKE_V3_START_BLOCK &&
    Number.isSafeInteger(cursor) &&
    cursor >= block &&
    Number.isSafeInteger(count) &&
    count > 0 &&
    storedPools >= count &&
    kvGet('pancake_v3_snapshot_subgraph_id') === configuredSubgraphId() &&
    BLOCK_HASH.test(blockHash) &&
    ROW_GENERATION.test(rowGeneration) &&
    deployment === configuredDeployment()
  )
  return complete ? { block, blockHash, deployment } : null
}

/**
 * A durable completion flag is only a candidate for reuse. Re-prove its stored
 * block/hash against the current RPC canonical chain on every boot before the
 * catalog is allowed to continue from the stored post-snapshot cursor.
 */
export async function hasCompletePancakeV3GraphSnapshot(): Promise<boolean> {
  const stored = storedCompletePancakeV3GraphSnapshot()
  if (!stored) return false
  try {
    await assertCanonicalSnapshot(stored.block, stored.blockHash)
  } catch (error) {
    // A confirmed finalized-fork mismatch is repaired by the generation swap
    // below. RPC transport failures remain non-mutating boot errors.
    if (error instanceof PancakeV3SnapshotCanonicalMismatchError) return false
    throw error
  }
  return true
}

const META_QUERY = `query PancakeV3SnapshotMeta {
  _meta { block { number hash } deployment hasIndexingErrors }
}`

const PAGE_QUERY = `query PancakeV3SnapshotPage($hash: Bytes!, $after: Bytes!) {
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
    createdBlockNumber
  }
}`

/**
 * Import one immutable PancakeSwap V3 catalog generation. Graph identity is
 * pinned by canonical block hash, every row is checked with factory.getPool,
 * and page progress is checkpointed atomically so an interrupted 88k+ import
 * resumes without replaying completed pages.
 */
export async function importBscPancakeV3Snapshot(
  targetBlock: number,
): Promise<PancakeV3SnapshotResult> {
  if (CHAIN.id !== 56) throw new Error('The Graph Pancake V3 importer is BSC-only')
  if (!Number.isSafeInteger(targetBlock) || targetBlock < PANCAKE_V3_START_BLOCK)
    throw new Error('invalid finalized target block for Pancake V3 snapshot')

  const { apiKey, subgraphId, expectedDeployment, maxLagBlocks } = graphConfig()
  const latestResponse = await graphQuery<MetaResponse>(
    subgraphId,
    apiKey,
    META_QUERY,
  )
  const latest = assertMeta(latestResponse._meta)
  if (latest.deployment !== expectedDeployment)
    throw new Error(
      `The Graph Pancake V3 deployment ${latest.deployment} is not the reviewed deployment ${expectedDeployment}`,
    )
  if (latest.block < PANCAKE_V3_START_BLOCK)
    throw new Error('The Graph Pancake V3 subgraph has not reached the factory deployment block')
  const lag = Math.max(0, targetBlock - latest.block)
  if (lag > maxLagBlocks)
    throw new Error(
      `The Graph Pancake V3 snapshot lags the finalized chain head by ${lag} blocks; maximum is ${maxLagBlocks}`,
    )

  const storedImportBlock = Number(kvGet('pancake_v3_snapshot_import_block'))
  const storedImportHash =
    kvGet('pancake_v3_snapshot_import_block_hash')?.toLowerCase() ?? ''
  const storedImportDeployment =
    kvGet('pancake_v3_snapshot_import_deployment')?.trim() ?? ''
  const storedRowGeneration =
    kvGet('pancake_v3_snapshot_import_row_generation')?.toLowerCase() ?? ''
  let canResumePinnedGeneration =
    kvGet('pancake_v3_snapshot_complete') === '0' &&
    kvGet('pancake_v3_snapshot_import_subgraph_id') === subgraphId &&
    Number.isSafeInteger(storedImportBlock) &&
    storedImportBlock >= PANCAKE_V3_START_BLOCK &&
    storedImportBlock <= targetBlock &&
    targetBlock - storedImportBlock <= maxLagBlocks &&
    BLOCK_HASH.test(storedImportHash) &&
    storedImportDeployment === latest.deployment

  if (canResumePinnedGeneration) {
    try {
      await assertCanonicalSnapshot(storedImportBlock, storedImportHash)
    } catch (error) {
      // A resumable page checkpoint can itself become orphaned between boots.
      // Confirmed hash drift starts a fresh reviewed generation; transport
      // failures preserve the checkpoint and fail this boot attempt unchanged.
      if (error instanceof PancakeV3SnapshotCanonicalMismatchError) {
        tx(() => {
          if (ROW_GENERATION.test(storedRowGeneration))
            deletePoolSnapshotGeneration(
              'pancakev3',
              storedRowGeneration,
            )
          for (const key of [
            'pancake_v3_snapshot_import_generation',
            'pancake_v3_snapshot_import_row_generation',
            'pancake_v3_snapshot_import_subgraph_id',
            'pancake_v3_snapshot_import_block',
            'pancake_v3_snapshot_import_block_hash',
            'pancake_v3_snapshot_import_deployment',
            'pancake_v3_snapshot_import_after',
            'pancake_v3_snapshot_import_downloaded',
            'pancake_v3_snapshot_import_pool_count',
          ])
            kvSet(key, '')
          kvSet('pancake_v3_snapshot_complete', '0')
        })
        canResumePinnedGeneration = false
      } else throw error
    }
  }

  // A moving Graph head must not make every restart discard already-verified
  // pages. Reuse the durable immutable generation while it remains fresh and
  // queryable; start a new generation only when none exists or it aged beyond
  // the operator's explicit lag budget.
  const snapshotBlock = canResumePinnedGeneration
    ? storedImportBlock
    : Math.min(latest.block, targetBlock)
  const snapshotHash = canResumePinnedGeneration
    ? storedImportHash
    : snapshotBlock === latest.block
      ? latest.blockHash
      : await canonicalHash(snapshotBlock)
  const snapshotDeployment = canResumePinnedGeneration
    ? storedImportDeployment
    : latest.deployment
  await assertCanonicalSnapshot(snapshotBlock, snapshotHash)

  const generation = `${subgraphId}\n${snapshotDeployment}\n${snapshotBlock}\n${snapshotHash}`
  const resumable =
    canResumePinnedGeneration &&
    kvGet('pancake_v3_snapshot_import_generation') === generation &&
    ROW_GENERATION.test(storedRowGeneration)
  const rowGeneration = resumable ? storedRowGeneration : randomUUID()
  const storedAfter = kvGet('pancake_v3_snapshot_import_after') ?? ZERO
  const storedDownloaded = Number(kvGet('pancake_v3_snapshot_import_downloaded'))
  let after = resumable && ADDRESS.test(storedAfter) ? storedAfter.toLowerCase() : ZERO
  let downloaded =
    resumable && Number.isSafeInteger(storedDownloaded) && storedDownloaded >= 0
      ? storedDownloaded
      : 0
  let expectedCount: number | null = null
  let added = 0
  const tickSpacingByFee = new Map<number, number>()

  if (!resumable) {
    tx(() => {
      kvSet('pancake_v3_snapshot_import_generation', generation)
      kvSet('pancake_v3_snapshot_import_row_generation', rowGeneration)
      kvSet('pancake_v3_snapshot_import_subgraph_id', subgraphId)
      kvSet('pancake_v3_snapshot_import_block', String(snapshotBlock))
      kvSet('pancake_v3_snapshot_import_block_hash', snapshotHash)
      kvSet('pancake_v3_snapshot_import_deployment', snapshotDeployment)
      kvSet('pancake_v3_snapshot_import_after', ZERO)
      kvSet('pancake_v3_snapshot_import_downloaded', '0')
      kvSet('pancake_v3_snapshot_complete', '0')
    })
  }

  for (;;) {
    const page = await graphQuery<PageResponse>(subgraphId, apiKey, PAGE_QUERY, {
      hash: snapshotHash,
      after,
    })
    assertMeta(
      page._meta,
      snapshotBlock,
      snapshotHash,
      snapshotDeployment,
    )

    const protocols = page.dexAmmProtocols ?? []
    if (
      protocols.length !== 1 ||
      address(protocols[0]?.id, 'protocol id') !==
        ADDR.CL_FACTORY.toLowerCase() ||
      protocols[0]?.network !== 'BSC'
    )
      throw new Error(
        'The Graph Pancake V3 snapshot is not bound to the configured official factory',
      )
    const pageCount = integer(
      protocols[0].totalPoolCount,
      'protocol.totalPoolCount',
    )
    if (expectedCount === null) expectedCount = pageCount
    else if (expectedCount !== pageCount)
      throw new Error('The Graph Pancake V3 poolCount changed inside a pinned snapshot')
    const storedExpected = Number(kvGet('pancake_v3_snapshot_import_pool_count'))
    if (
      resumable &&
      Number.isSafeInteger(storedExpected) &&
      storedExpected >= 0 &&
      storedExpected !== pageCount
    )
      throw new Error('The Graph Pancake V3 poolCount conflicts with resumable progress')

    const rows = page.liquidityPools ?? []
    if (rows.length > PAGE_SIZE)
      throw new Error('The Graph returned an oversized Pancake V3 page')
    let previousId = after
    const candidates = rows.map((row) => {
      const id = address(row.id, 'pool id')
      if (id <= previousId)
        throw new Error('The Graph Pancake V3 page is not strictly ordered by pool id')
      previousId = id
      const createdBlock = integer(
        row.createdBlockNumber,
        'pool createdBlockNumber',
      )
      if (
        createdBlock < PANCAKE_V3_START_BLOCK ||
        createdBlock > snapshotBlock
      )
        throw new Error(`The Graph pool ${id} has invalid creation block`)
      return { id, createdBlock }
    })

    // Large nested Graph pages are unreliable on the decentralized query
    // route. Treat Graph rows only as candidates and source every executable
    // identity field from the candidate contract itself.
    const identityRows = await mc(
      candidates.flatMap((row) => [
        {
          abi: poolIdentityAbi,
          address: row.id as `0x${string}`,
          functionName: 'token0',
        },
        {
          abi: poolIdentityAbi,
          address: row.id as `0x${string}`,
          functionName: 'token1',
        },
        {
          abi: poolIdentityAbi,
          address: row.id as `0x${string}`,
          functionName: 'fee',
        },
        {
          abi: poolIdentityAbi,
          address: row.id as `0x${string}`,
          functionName: 'tickSpacing',
        },
      ]),
    )
    const parsed = candidates.map((row, index) => {
      const token0 = String(ok<string>(identityRows[index * 4]) ?? '').toLowerCase()
      const token1 = String(ok<string>(identityRows[index * 4 + 1]) ?? '').toLowerCase()
      const fee = ok<number>(identityRows[index * 4 + 2])
      const spacing = ok<number>(identityRows[index * 4 + 3])
      if (!ADDRESS.test(token0) || !ADDRESS.test(token1))
        throw new Error(`Pancake V3 pool ${row.id} did not return valid token addresses`)
      if (token0 >= token1)
        throw new Error(`Pancake V3 pool ${row.id} has non-canonical token order`)
      if (
        fee === undefined ||
        !Number.isSafeInteger(fee) ||
        fee <= 0 ||
        fee >= 1_000_000
      )
        throw new Error(`Pancake V3 pool ${row.id} returned an invalid fee tier`)
      if (
        spacing === undefined ||
        !Number.isSafeInteger(spacing) ||
        spacing === 0
      )
        throw new Error(`Pancake V3 pool ${row.id} returned invalid tick spacing`)
      return { ...row, token0, token1, fee, spacing }
    })

    const missingFees = [...new Set(parsed.map((row) => row.fee))].filter(
      (fee) => !tickSpacingByFee.has(fee),
    )
    if (missingFees.length) {
      const spacingRows = await mc(
        missingFees.map((fee) => ({
          abi: factoryVerifyAbi,
          address: ADDR.CL_FACTORY,
          functionName: 'feeAmountTickSpacing',
          args: [fee],
        })),
      )
      missingFees.forEach((fee, index) => {
        const spacing = ok<number>(spacingRows[index])
        if (
          spacing === undefined ||
          !Number.isSafeInteger(spacing) ||
          spacing === 0
        )
          throw new Error(`official Pancake V3 factory rejected fee tier ${fee}`)
        tickSpacingByFee.set(fee, spacing)
      })
    }
    for (const row of parsed)
      if (tickSpacingByFee.get(row.fee) !== row.spacing)
        throw new Error(
          `Pancake V3 pool ${row.id} tick spacing conflicts with the official factory`,
        )

    const factoryRows = await mc(
      parsed.map((row) => ({
        abi: factoryVerifyAbi,
        address: ADDR.CL_FACTORY,
        functionName: 'getPool',
        args: [row.token0, row.token1, row.fee],
      })),
    )
    parsed.forEach((row, index) => {
      const canonical = ok<string>(factoryRows[index])?.toLowerCase()
      if (canonical !== row.id)
        throw new Error(
          `The Graph Pancake V3 pool ${row.id} failed official factory verification`,
        )
    })

    const nextDownloaded = downloaded + parsed.length
    if (nextDownloaded > pageCount)
      throw new Error('The Graph Pancake V3 snapshot contains more rows than factory.poolCount')
    const nextAfter = parsed.length ? parsed.at(-1)!.id : after
    tx(() => {
      for (const row of parsed) {
        const existing = poolRow(row.id)
        if (
          existing &&
          (existing.proto !== 'pancakev3' ||
            existing.token0 !== row.token0 ||
            existing.token1 !== row.token1 ||
            existing.fee_ppm !== row.fee ||
            existing.tick_spacing !== row.spacing)
        )
          throw new Error(
            `existing pool ${row.id} conflicts with verified Pancake V3 snapshot`,
          )
        if (existing)
          setPoolSnapshotGeneration(row.id, 'pancakev3', rowGeneration)
        else if (
          insertPool({
            address: row.id,
            proto: 'pancakev3',
            token0: row.token0,
            token1: row.token1,
            feePpm: row.fee,
            tickSpacing: row.spacing,
            createdBlock: row.createdBlock,
            snapshotGeneration: rowGeneration,
            addedTs: 0,
          })
        )
          added++
      }
      kvSet('pancake_v3_snapshot_import_pool_count', String(pageCount))
      kvSet('pancake_v3_snapshot_import_after', nextAfter)
      kvSet('pancake_v3_snapshot_import_downloaded', String(nextDownloaded))
    })
    downloaded = nextDownloaded
    after = nextAfter
    if (parsed.length < PAGE_SIZE) break
  }

  if (expectedCount === null || expectedCount <= 0 || downloaded !== expectedCount)
    throw new Error(
      `The Graph Pancake V3 snapshot is incomplete: downloaded ${downloaded}/${expectedCount ?? '?'} pools`,
    )

  // The 88k+ download can outlive a finalized-chain reorg. Never swap a
  // generation that is no longer canonical at the publication boundary.
  await assertCanonicalSnapshot(snapshotBlock, snapshotHash)

  tx(() => {
    deletePoolsOutsideSnapshotGeneration('pancakev3', rowGeneration)
    const publishedCount =
      poolCounts().find((row) => row.proto === 'pancakev3')?.n ?? 0
    if (publishedCount !== downloaded)
      throw new Error(
        `Pancake V3 snapshot replacement retained ${publishedCount}/${downloaded} pools`,
      )
    kvSet('pancake_v3_snapshot_source', 'thegraph')
    kvSet('pancake_v3_snapshot_block', String(snapshotBlock))
    kvSet('pancake_v3_snapshot_block_hash', snapshotHash)
    kvSet('pancake_v3_snapshot_subgraph_id', subgraphId)
    kvSet('pancake_v3_snapshot_deployment', snapshotDeployment)
    kvSet('pancake_v3_snapshot_pool_count', String(downloaded))
    kvSet('pancake_v3_snapshot_row_generation', rowGeneration)
    kvSet('pancake_v3_snapshot_complete', '1')
    kvSet('pancake_v3_cursor', String(snapshotBlock))
  })

  return {
    added,
    block: snapshotBlock,
    blockHash: snapshotHash,
    downloaded,
    deployment: snapshotDeployment,
  }
}
