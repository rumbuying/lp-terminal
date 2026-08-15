// The catalog, asked which markets a token has — rather than asked for a page
// and then filtered down to the ones that happened to be on it.
//
// A market chip used to narrow rows already fetched: the tab requested the top
// pools by TVL, kept the ones whose token was a launchpad mint, and showed the
// two that survived. The chips name PROVEN properties of a token, and the set
// of tokens with a property is a question about the whole catalog, so it is
// asked of the catalog. This module is the client half of that.
//
// Nothing here trusts the server's membership claim. It says which tokens to
// ask about; the browser still re-proves each one against the chain before it
// wears an issuer's or a launchpad's mark, exactly as it does on a flat list.
import { getAddress, type Address, type Hex, type PublicClient } from 'viem'
import { ACTIVE_IS_BUILD, CHAIN } from '../config/chains'
import { indexerPoolGroupsPath } from '../config/chains/routes'
import { ENV } from '../config/env'
import type { Pool, TokenInfo } from '../types'
import type { PoolStat } from './poolstats'
import { fetchCatalog } from './catalogFetch'
import {
  indexAddressPools,
  indexTokenTable,
  type ApiPool23,
  type ApiPoolV4,
  type ApiResponse,
  type UniV4IndexRow,
} from './uniIndex'
import { v4IndexRowsWithState } from './uniV4Pools'

const V4 = CHAIN.uniV4

/**
 * What the catalog can rank a token's whole book by.
 *
 * Deliberately the same four the flat table sorts pools by, minus rewards:
 * emissions are a property of one pool's gauge, and a token is not one pool.
 */
export type PoolGroupSort = 'tvl' | 'vol' | 'fees' | 'feeApr'

export type PoolGroup = {
  /** the token this group is about — the one whose origin the chain proved */
  token: Address
  /** how many markets it has in total, which is usually more than `pools` holds */
  poolCount: number
  tvlUsd: number | null
  vol24hUsd: number | null
  /**
   * Summed over the pools whose fee rate is knowable — `feePools` of
   * `poolCount`. A dynamic-fee pool has no fixed rate and a hooked one may
   * route part of the fee out of sight, so neither is guessed at.
   */
  fees24hUsd: number | null
  feePools: number
  /** the deepest few, verified and executable like any other catalog row */
  pools: Pool[]
}

export type PoolGroupCatalog = {
  origin: string
  sort: PoolGroupSort
  groups: PoolGroup[]
  tokens: Record<string, TokenInfo>
  stats: Record<string, PoolStat>
  /**
   * Every group under this chip, not just this page — and `null` on a
   * continuation, where the server deliberately does not recount a total that
   * cannot change under a cursor. The hook carries the first page's figure.
   */
  count: number | null
  nextCursor: string | null
}

type ApiGroup = {
  token: string
  poolCount: number
  tvlUsd: number | null
  vol24hUsd: number | null
  fees24hUsd: number | null
  feePools: number
  pools: Array<ApiPool23 | ApiPoolV4>
}

type ApiGroupResponse = ApiResponse & {
  origin?: string
  sort?: string
  groups?: ApiGroup[]
}

export type PoolGroupQuery = {
  origin: string
  sort?: PoolGroupSort
  /** groups per page */
  limit?: number
  /** pools carried inside each group */
  poolsPerGroup?: number
  minTvl?: number
  after?: string | null
}

const GROUP_SORTS: readonly PoolGroupSort[] = ['tvl', 'vol', 'fees', 'feeApr']

const safeNonnegative = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * One page of groups, with every pool inside them proved against the chain.
 *
 * `null` means this deployment has no catalog for the selected chain — the
 * same routing fact `indexerPoolsPath` reports, and not an outage.
 */
export async function fetchPoolGroups(
  pc: PublicClient,
  query: PoolGroupQuery,
  signal?: AbortSignal,
): Promise<PoolGroupCatalog | null> {
  const path = indexerPoolGroupsPath(CHAIN.key, ENV.chainGateway, ACTIVE_IS_BUILD)
  if (!path) return null

  const url = new URL(path, location.origin)
  url.searchParams.set('origin', query.origin)
  if (query.sort) url.searchParams.set('sort', query.sort)
  if (query.limit) url.searchParams.set('limit', String(query.limit))
  if (query.poolsPerGroup) url.searchParams.set('pools', String(query.poolsPerGroup))
  if (query.minTvl && query.minTvl > 0) url.searchParams.set('min_tvl', String(query.minTvl))
  if (query.after) url.searchParams.set('after', query.after)

  const response = await fetchCatalog(url, {}, signal)
  if (!response.ok) throw new Error(`pool groups ${response.status}`)
  const body = (await response.json()) as ApiGroupResponse
  if (!body?.ready || body.chainId !== CHAIN.id) return null
  if (body.chain && body.chain.key !== CHAIN.key) return null

  const apiGroups = Array.isArray(body.groups) ? body.groups : []
  const tokens = indexTokenTable(body.tokens)

  // Every group's address-keyed rows in one pass, so the shared parser sees the
  // same shape it sees on a flat page and there is one definition of what a
  // renderable pool is.
  const addressRows = apiGroups.flatMap((group) =>
    (group.pools ?? []).filter((pool): pool is ApiPool23 => pool.proto !== 'univ4'),
  )
  const { pools: addressPools, stats } = indexAddressPools(addressRows, tokens)
  const byKey = new Map<string, Pool>(
    addressPools.map((pool) => [pool.address.toLowerCase(), pool]),
  )

  // And every group's v4 rows in ONE StateView round trip. A v4 row is a
  // candidate until the singleton confirms its live state, and batching that
  // across groups is what keeps opening a chip to one request instead of one
  // per token.
  const v4Rows: UniV4IndexRow[] = []
  const seenPoolIds = new Set<string>()
  for (const group of apiGroups)
    for (const pool of group.pools ?? []) {
      if (pool.proto !== 'univ4') continue
      const id = pool.poolId?.toLowerCase()
      if (!id || seenPoolIds.has(id)) continue
      seenPoolIds.add(id)
      const row = v4RowOf(pool)
      if (row) v4Rows.push(row)
    }
  if (v4Rows.length) {
    const verified = await v4IndexRowsWithState(pc, v4Rows, tokens, signal)
    for (const pool of verified.pools) byKey.set(pool.poolId!.toLowerCase(), pool)
    // A v4-only currency has never appeared in the address catalog, so the
    // chain read above is where its symbol and decimals come from at all.
    Object.assign(tokens, verified.tokens)
  }
  for (const group of apiGroups)
    for (const pool of group.pools ?? []) {
      if (pool.proto !== 'univ4') continue
      const id = pool.poolId?.toLowerCase()
      if (!id || !byKey.has(id)) continue
      stats[id] = {
        vol24hUsd: safeNonnegative(pool.vol24hUsd),
        liqUsd: safeNonnegative(pool.tvlUsd) ?? safeNonnegative(pool.gtLiqUsd),
        source: pool.statsSource === 'geckoterminal' ? 'geckoterminal' : 'chain',
      }
    }

  const groups: PoolGroup[] = []
  for (const group of apiGroups) {
    const token = tokens[group.token?.toLowerCase() ?? '']?.address
    // A group whose own token we could not verify metadata for is dropped, not
    // rendered nameless — the row IS the token, so an unnamed one says nothing.
    if (!token) continue
    groups.push({
      token,
      poolCount: Math.max(0, Number(group.poolCount) || 0),
      tvlUsd: safeNonnegative(group.tvlUsd),
      vol24hUsd: safeNonnegative(group.vol24hUsd),
      fees24hUsd: safeNonnegative(group.fees24hUsd),
      feePools: Math.max(0, Number(group.feePools) || 0),
      pools: (group.pools ?? [])
        .map((pool) =>
          byKey.get((pool.proto === 'univ4' ? pool.poolId : pool.address)?.toLowerCase() ?? ''),
        )
        .filter((pool): pool is Pool => pool !== undefined),
    })
  }

  const rawCursor = typeof body.nextCursor === 'string' ? body.nextCursor : null
  return {
    origin: typeof body.origin === 'string' ? body.origin : query.origin,
    sort: GROUP_SORTS.includes(body.sort as PoolGroupSort)
      ? (body.sort as PoolGroupSort)
      : 'tvl',
    groups,
    tokens,
    stats,
    count: typeof body.count === 'number' ? Math.max(0, body.count) : null,
    nextCursor: rawCursor && rawCursor !== query.after ? rawCursor : null,
  }
}

const HEX64 = /^0x[0-9a-f]{64}$/

/** An index row, or null when the payload does not describe a v4 pool at all. */
function v4RowOf(pool: ApiPoolV4): UniV4IndexRow | null {
  const poolId = pool.poolId?.toLowerCase()
  if (!poolId || !HEX64.test(poolId)) return null
  const tickSpacing = Number(pool.tickSpacing)
  if (!Number.isSafeInteger(tickSpacing) || tickSpacing <= 0 || tickSpacing > 32_767) return null
  try {
    const address = getAddress(pool.address)
    // Every v4 pool lives at the singleton. A row claiming otherwise is not a
    // v4 pool of this deployment, whatever it calls itself.
    if (!V4 || address.toLowerCase() !== V4.POOL_MANAGER.toLowerCase()) return null
    const token0 = getAddress(pool.token0)
    const token1 = getAddress(pool.token1)
    if (token0.toLowerCase() >= token1.toLowerCase()) return null
    return { address, poolId: poolId as Hex, token0, token1, tickSpacing, hooks: getAddress(pool.hooks) }
  } catch {
    return null
  }
}
