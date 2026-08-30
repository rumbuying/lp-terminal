// Typed client for the pool-indexer API (indexer/, same-origin /api).
//
// The indexer owns the full address-keyed Uniswap/Pancake v2+v3 catalog and the
// PoolId-keyed Uniswap v4 catalog. V2/V3 identities come from their official
// factories; v4 PoolIds/currencies/hooks are bootstrapped from its subgraph and
// served from the local database. V4 executable state is intentionally NOT
// trusted here: uniV4Pools rereads StateView and proves the PoolId/PoolKey round
// trip before a row becomes an actionable ClPool.
//
// V2/V3 returns null when the API is unavailable and lets uniBrowse use its
// existing discovery fallback. V4 has an explicit ready/warming/unavailable
// result: a capable warming index is retried and is never bypassed through its
// metered Graph compatibility path.
import { getAddress, zeroAddress, type Address, type Hex } from 'viem'
import { CHAIN_ID } from '../config/addresses'
import { ACTIVE_IS_BUILD, CHAIN } from '../config/chains'
import { indexerPoolsPath } from '../config/chains/routes'
import { ENV } from '../config/env'
import type { PoolStat } from './poolstats'
import type { Pool, TokenInfo } from '../types'
import { fetchCatalog } from './catalogFetch'
import { clampWidth } from './format'

export type V23CatalogProto = 'univ2' | 'univ3' | 'pancakev2' | 'pancakev3'
export type V23CatalogFilter =
  | V23CatalogProto
  | 'pancakev2,pancakev3'
  | 'univ3,pancakev3'

export type ApiPool23 = {
  proto: V23CatalogProto
  address: string
  token0: string
  token1: string
  feePpm: number
  tickSpacing: number | null
  sqrtPriceX96: string | null
  tick: number | null
  liquidity: string | null
  reserve0: string
  reserve1: string
  totalSupply: string | null
  stateReady: boolean
  tvlUsd: number | null
  vol5mUsd?: number | null
  vol1hUsd?: number | null
  vol6hUsd?: number | null
  vol24hUsd: number | null
  txns24h: number | null
  gtLiqUsd: number | null
  statsSource: string | null
}

export type ApiPoolV4 = {
  proto: 'univ4'
  /** Every v4 row lives at the singleton PoolManager. */
  address: string
  poolId: string
  token0: string
  token1: string
  tickSpacing: number
  hooks: string
  /** the indexer's ranked depth: its own derivation, or the aggregator's reading */
  tvlUsd?: number | string | null
  tvlApprox?: boolean
  vol24hUsd?: number | string | null
  txns24h?: number | null
  gtLiqUsd?: number | string | null
  statsSource?: string | null
  rawTvl0: number | string | null
  rawTvl1: number | string | null
  rawDays: {
    date: number
    volume0: number | string | null
    volume1: number | string | null
  }[]
}

type ApiPool = ApiPool23 | ApiPoolV4

export type ApiResponse = {
  /** which chain this catalog is about; required at the client trust boundary */
  chainId?: number
  ready: boolean
  /** structured deployment identity; required at the client trust boundary */
  chain?: { key: string; id: number }
  totals: Record<string, number>
  count: number
  /** `count` is a floor, not the total: the search matched more than the indexer counts. */
  countCapped?: boolean
  nextCursor: string | null
  /** V2/V3 insertion high-water mark; absent on a rolling old indexer. */
  catalogSeq?: string | null
  subgraphBlock?: number | null
  /** Finalized V4 tail block that freezes every page in one traversal. */
  catalogBlock?: number | null
  /** Published V4 snapshot generation shared by every page in a traversal. */
  catalogGeneration?: string | null
  /** Explicit capability/readiness marker; absent on the pre-v4 indexer. */
  catalogs?: { univ4?: { supported?: boolean; ready?: boolean } }
  pools: ApiPool[]
  tokens: Record<
    string,
    {
      address: string
      symbol: string
      decimals: number
      /** Present for v2/v3 chain-read metadata; v4 Graph display rows omit it. */
      metaOk?: boolean
      priceUsd: number | null
    }
  >
}

export type UniIndexData = {
  pools: Pool[]
  tokens: Record<string, TokenInfo>
  stats: Record<string, PoolStat>
  total: number // server-side matches before the page limit
  totalCapped?: boolean // `total` is a floor: the search matched more than the indexer counts
  indexed: number // whole address-keyed catalog size (Uniswap/Pancake v2+v3)
  nextCursor: string | null // null = complete; first continuation starts at address zero
  catalogSeq?: string | null
  catalogGeneration?: string | null
}

export type UniV4IndexRawStat = {
  tvl0: number | null
  tvl1: number | null
  days: { date: number; volume0: number | null; volume1: number | null }[]
}

/**
 * An index row whose syntax and deployment identity are valid, but which is
 * not executable yet. StateView must still prove its fee key and live state.
 */
export type UniV4IndexRow = {
  address: Address
  poolId: Hex
  token0: Address
  token1: Address
  tickSpacing: number
  hooks: Address
}

export type UniV4IndexData = {
  rows: UniV4IndexRow[]
  tokens: Record<string, TokenInfo>
  rawStats: Record<string, UniV4IndexRawStat>
  /**
   * What the indexer says each pool is worth and how much traded, keyed by
   * PoolId. Separate from rawStats because rawStats is the MATERIAL — token
   * quantities and daily amounts — and this is the conclusion drawn from it.
   * Keeping both is what lets the browser check the server rather than trust it.
   */
  stats: Record<string, PoolStat>
  matched: number
  indexed: number
  nextCursor: string | null
  subgraphBlock: number | null
  catalogBlock: number
  catalogGeneration: Hex
}

export type UniV4IndexResult =
  { status: 'ready'; data: UniV4IndexData } | { status: 'warming' } | { status: 'unavailable' }

const zeroBase = {
  gauge: null,
  gaugeAlive: false,
  weight: 0n,
  rewardRate: 0n,
  periodFinish: 0n,
} as const
const HEX40 = /^0x[0-9a-f]{40}$/
const HEX64 = /^0x[0-9a-f]{64}$/
const V23_PROTOCOLS = new Set<V23CatalogProto>(['univ2', 'univ3', 'pancakev2', 'pancakev3'])

/**
 * DexScreener's compatibility path proves fee-keyed V3 candidates against
 * their configured factories. BSC may therefore request both official
 * Uniswap V3 and Pancake V3 while a full index is warming; no V2 protocol is
 * ever substituted through this path.
 */
export function canUseUniV3Fallback(proto: V23CatalogFilter | undefined): boolean {
  return (
    proto === undefined ||
    proto === 'univ3' ||
    (proto === 'univ3,pancakev3' && CHAIN.id === 56 && !!CHAIN.slugs.dexIds.home)
  )
}

/**
 * Whether a catalog is about the chain on screen.
 *
 * Identity is fail-closed: an old response without chainId is indistinguishable
 * from a wrong namespace returning a syntactically valid catalog.
 */
export function catalogMatchesChain(chainId: number | undefined, active: number): boolean {
  return chainId === active
}

class IndexCatalogConflictError extends Error {}

async function fetchIndexResponse(
  query: string,
  minTvl: number,
  proto: V23CatalogFilter | 'univ4' | undefined,
  limit: number,
  after: string | null,
  catalogBlock: number | null = null,
  catalogGeneration: string | null = null,
  catalogSeq: string | null = null,
  bypassHttpCache = false,
  throwOnConflict = false,
  signal?: AbortSignal,
): Promise<ApiResponse | null> {
  // The canonical gateway routes each selected chain to its own catalog. Other
  // deployments have one /api proxy, so keep their wrong-chain guard.
  const poolsPath = indexerPoolsPath(CHAIN.key, ENV.chainGateway, ACTIVE_IS_BUILD)
  if (!poolsPath) return null
  let j: ApiResponse
  try {
    const u = new URL(poolsPath, location.origin)
    const q = query.trim()
    if (q) u.searchParams.set('q', q)
    if (minTvl > 0) u.searchParams.set('min_tvl', String(minTvl))
    if (proto) u.searchParams.set('proto', proto)
    u.searchParams.set('limit', String(limit))
    if (after) u.searchParams.set('after', after)
    if (catalogBlock !== null) u.searchParams.set('catalog_block', String(catalogBlock))
    if (catalogGeneration !== null) u.searchParams.set('catalog_generation', catalogGeneration)
    if (catalogSeq !== null) u.searchParams.set('catalog_seq', catalogSeq)
    const r = await fetchCatalog(
      u,
      bypassHttpCache ? { cache: 'no-store' } : {},
      signal,
    )
    if (r.status === 409) {
      if (throwOnConflict) throw new IndexCatalogConflictError('catalog changed')
      return null
    }
    if (!r.ok) return null
    j = (await r.json()) as ApiResponse
  } catch (error) {
    if (error instanceof IndexCatalogConflictError) throw error
    if (signal?.aborted) throw error
    return null
  }
  if (!j || !Array.isArray(j.pools)) return null
  // Same-origin routing mistakes and mismatched indexer configuration both
  // produce valid-looking pool identities for the wrong chain.
  if (!j.chain || j.chain.key !== CHAIN.key || j.chain.id !== CHAIN_ID) return null
  if (!catalogMatchesChain(j.chainId, CHAIN_ID)) return null
  return j
}

export async function fetchUniIndex(
  query: string,
  minTvl: number,
  proto?: V23CatalogFilter,
  limit = 120,
  after: string | null = null,
  catalogSeq: string | null = null,
  catalogGeneration: string | null = null,
  bypassHttpCache = false,
  signal?: AbortSignal,
): Promise<UniIndexData | null> {
  let j: ApiResponse | null
  try {
    j = await fetchIndexResponse(
      query,
      minTvl,
      proto,
      limit,
      after,
      null,
      catalogGeneration,
      catalogSeq,
      bypassHttpCache,
      true,
      signal,
    )
  } catch (error) {
    if (!(error instanceof IndexCatalogConflictError) || after === null) throw error
    // Return a fresh landing page as the next retained infinite-query page.
    // mergeUniIndexPages then discards every page from the superseded fence.
    return fetchUniIndex(query, minTvl, proto, limit, null, null, null, true, signal)
  }
  if (!j?.ready) return null

  const responseCatalogSeq =
    typeof j.catalogSeq === 'string' && /^(0|[1-9]\d*)$/.test(j.catalogSeq)
      ? j.catalogSeq
      : null
  const responseCatalogGeneration =
    typeof j.catalogGeneration === 'string' && /^(0|[1-9]\d*)$/.test(j.catalogGeneration)
      ? j.catalogGeneration
      : null
  const completeFence = responseCatalogSeq !== null && responseCatalogGeneration !== null
  if ((responseCatalogSeq === null) !== (responseCatalogGeneration === null)) return null
  if (
    after !== null &&
    catalogSeq !== null &&
    catalogGeneration !== null &&
    (!completeFence ||
      responseCatalogSeq !== catalogSeq ||
      responseCatalogGeneration !== catalogGeneration)
  )
    return fetchUniIndex(query, minTvl, proto, limit, null, null, null, true, signal)

  // Four explicit keys are the capability marker for the unified directory.
  // An older indexer silently ignores a new Pancake proto; treating that as a
  // valid response would label an Uniswap-only page as a complete venue result.
  if ([...V23_PROTOCOLS].some((value) => !Object.hasOwn(j.totals ?? {}, value))) return null
  const requested = proto ? new Set(proto.split(',') as V23CatalogProto[]) : null
  if (requested && [...requested].some((value) => !V23_PROTOCOLS.has(value))) return null
  const addressRows = j.pools.filter((pool): pool is ApiPool23 => pool.proto !== 'univ4')
  if (
    addressRows.some((pool) => !V23_PROTOCOLS.has(pool.proto)) ||
    (requested && addressRows.some((pool) => !requested.has(pool.proto)))
  )
    return null

  const tokens = indexTokenTable(j.tokens)
  const { pools, stats } = indexAddressPools(addressRows, tokens)

  // V4 has its own PoolId cursor and count; keep it out of the shared
  // address-keyed V2/V3 directory total.
  const indexed =
    (j.totals?.univ2 ?? 0) +
    (j.totals?.univ3 ?? 0) +
    (j.totals?.pancakev2 ?? 0) +
    (j.totals?.pancakev3 ?? 0)
  const rawCursor = typeof j.nextCursor === 'string' ? j.nextCursor.toLowerCase() : ''
  const nextCursor =
    HEX40.test(rawCursor) && (!after || rawCursor > after.toLowerCase()) ? rawCursor : null
  return {
    pools,
    tokens,
    stats,
    total: j.count,
    totalCapped: j.countCapped === true,
    indexed,
    nextCursor,
    catalogSeq: responseCatalogSeq,
    catalogGeneration: responseCatalogGeneration,
  }
}

const safeNonnegative = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

const safeInteger = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : null
}

/**
 * Verified token metadata from one catalog page's token table.
 *
 * The table also carries fallback rows for contracts whose decimals call
 * failed. Those rows remain useful for catalog diagnostics, but must never
 * determine transaction amounts, so an unverified one is dropped here rather
 * than downstream.
 *
 * Shared with the grouped catalog, which returns the same table for a different
 * question. Two parsers would be two chances to disagree about what a token is.
 */
export function indexTokenTable(raw: ApiResponse['tokens']): Record<string, TokenInfo> {
  const tokens: Record<string, TokenInfo> = {}
  for (const t of Object.values(raw ?? {})) {
    if (t?.metaOk !== true) continue
    try {
      const address = getAddress(t.address)
      const decimals = t.decimals
      const symbol = typeof t.symbol === 'string' ? t.symbol.trim() : ''
      if (
        typeof decimals !== 'number' ||
        !Number.isSafeInteger(decimals) ||
        decimals < 0 ||
        decimals > 255
      )
        continue
      tokens[address.toLowerCase()] = {
        address,
        symbol: clampWidth(symbol || `${address.slice(0, 6)}…`, 32),
        decimals,
      }
    } catch {
      // Preserve the rest of the catalog page while withholding pools that
      // depend on malformed or unverified token metadata.
    }
  }
  return tokens
}

/**
 * Executable pools from one catalog page's rows, with the stats beside them.
 *
 * A row whose tokens are not both verified, or whose on-chain state did not
 * arrive, is dropped rather than rendered — the catalog is a directory, and a
 * row that cannot be transacted has no business offering to be.
 *
 * Shared with the grouped catalog for the same reason as the token table above.
 */
export function indexAddressPools(
  addressRows: readonly ApiPool23[],
  tokens: Record<string, TokenInfo>,
): { pools: Pool[]; stats: Record<string, PoolStat> } {
  const uint = (value: unknown): bigint | null => {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
    try {
      return BigInt(value)
    } catch {
      return null
    }
  }

  const pools: Pool[] = []
  const stats: Record<string, PoolStat> = {}
  for (const p of addressRows) {
    let address: Address
    let token0: Address
    let token1: Address
    try {
      address = getAddress(p.address)
      token0 = getAddress(p.token0)
      token1 = getAddress(p.token1)
    } catch {
      continue
    }
    if (!tokens[token0.toLowerCase()] || !tokens[token1.toLowerCase()]) continue
    if (p.stateReady !== true) continue

    const base = { address, token0, token1, ...zeroBase }
    if (p.proto === 'univ3' || p.proto === 'pancakev3') {
      const sqrtPriceX96 = uint(p.sqrtPriceX96)
      const liquidity = uint(p.liquidity)
      const tick = typeof p.tick === 'number' && Number.isSafeInteger(p.tick) ? p.tick : null
      const tickSpacing =
        typeof p.tickSpacing === 'number' &&
        Number.isSafeInteger(p.tickSpacing) &&
        p.tickSpacing > 0
          ? p.tickSpacing
          : null
      if (sqrtPriceX96 === null || sqrtPriceX96 === 0n || liquidity === null) continue
      if (tick === null || tickSpacing === null) continue
      pools.push({
        ...base,
        kind: 'cl',
        protocol: p.proto === 'pancakev3' ? 'home' : 'univ3',
        tickSpacing,
        feePpm: p.feePpm, // univ3 fee unit == ppm
        unstakedFeePpm: 0, // no ve(3,3) levy
        sqrtPriceX96,
        tick,
        liquidity,
        stakedLiquidity: 0n,
      })
    } else {
      const reserve0 = uint(p.reserve0)
      const reserve1 = uint(p.reserve1)
      const totalSupply = uint(p.totalSupply)
      if (reserve0 === null || reserve1 === null || totalSupply === null) continue
      pools.push({
        ...base,
        kind: 'v2',
        protocol: p.proto === 'pancakev2' ? 'home' : 'univ2',
        stable: false,
        reserve0,
        reserve1,
        totalSupply,
        gaugeTotalSupply: 0n,
        feeBps: Math.round(p.feePpm / 100), // 3000 ppm -> 30 bps (0.30%)
      })
    }
    stats[address.toLowerCase()] = {
      vol5mUsd: p.vol5mUsd ?? null,
      vol1hUsd: p.vol1hUsd ?? null,
      vol6hUsd: p.vol6hUsd ?? null,
      vol24hUsd: p.vol24hUsd,
      liqUsd: p.tvlUsd ?? p.gtLiqUsd, // chain-derived TVL first, GT reserve as backstop
      source: p.statsSource === 'geckoterminal' ? 'geckoterminal' : 'chain',
    }
  }
  return { pools, stats }
}

function mapIndexTokens(raw: ApiResponse['tokens']): Record<string, TokenInfo> {
  const tokens: Record<string, TokenInfo> = {}
  for (const t of Object.values(raw ?? {})) {
    try {
      const address = getAddress(t.address)
      if (address === zeroAddress) {
        tokens[zeroAddress] = {
          address,
          symbol: CHAIN.nativeCurrency.symbol,
          decimals: CHAIN.nativeCurrency.decimals,
          native: true,
        }
        continue
      }
      const decimals = safeInteger(t.decimals)
      const symbol = typeof t.symbol === 'string' ? t.symbol.trim() : ''
      tokens[address.toLowerCase()] = {
        address,
        symbol: clampWidth(symbol || `${address.slice(0, 6)}…`, 32),
        decimals: decimals !== null && decimals >= 0 && decimals <= 255 ? decimals : 18,
      }
    } catch {
      // A malformed metadata row must not discard the rest of the page. Its
      // pool is filtered below unless both currencies can still be described.
    }
  }
  return tokens
}

/**
 * Fetch one v4 identity/raw-accounting page from the self-hosted indexer.
 *
 * `unavailable` means the caller may deliberately use The Graph fallback;
 * `warming` means this deployment explicitly owns v4 but is not ready and must
 * not be bypassed. A healthy, ready empty page is authoritative.
 */
export async function fetchUniV4Index(
  query: string,
  limit = 120,
  after: string | null = null,
  catalogBlock: number | null = null,
  catalogGeneration: string | null = null,
): Promise<UniV4IndexResult> {
  const j = await fetchIndexResponse(
    query,
    0,
    'univ4',
    limit,
    after,
    catalogBlock,
    catalogGeneration,
  )
  if (!j || j.catalogs?.univ4 === undefined) return { status: 'unavailable' }
  if (j.catalogs.univ4.supported === false) return { status: 'unavailable' }
  // Unlike v2/v3 rolling compatibility, every API new enough to advertise v4
  // also emits deployment identity. Require it so a proxy mistake can never
  // turn a foreign chain's PoolIds into candidates for this StateView.
  if (j.chain?.id !== CHAIN_ID && j.chainId !== CHAIN_ID) return { status: 'unavailable' }
  if (j.ready !== true || j.catalogs.univ4.ready !== true) return { status: 'warming' }
  const v4 = CHAIN.uniV4
  if (!v4) return { status: 'unavailable' }

  const byId = new Map<string, UniV4IndexRow>()
  const rawStats: Record<string, UniV4IndexRawStat> = {}
  const stats: Record<string, PoolStat> = {}
  for (const p of j.pools) {
    if (p.proto !== 'univ4') continue
    try {
      const poolId = p.poolId.toLowerCase()
      if (!HEX64.test(poolId)) continue
      const address = getAddress(p.address)
      if (address.toLowerCase() !== v4.POOL_MANAGER.toLowerCase()) continue
      const token0 = getAddress(p.token0)
      const token1 = getAddress(p.token1)
      if (token0.toLowerCase() >= token1.toLowerCase()) continue
      const hooks = getAddress(p.hooks)
      const tickSpacing = safeInteger(p.tickSpacing)
      if (tickSpacing === null || tickSpacing <= 0 || tickSpacing > 32_767) continue

      byId.set(poolId, {
        address,
        poolId: poolId as Hex,
        token0,
        token1,
        tickSpacing,
        hooks,
      })
      const tvl0 = safeNonnegative(p.rawTvl0)
      const tvl1 = safeNonnegative(p.rawTvl1)
      const days = Array.isArray(p.rawDays)
        ? p.rawDays.slice(0, 8).flatMap((day) => {
            const date = safeInteger(day?.date)
            if (date === null || date < 0) return []
            return [
              {
                date,
                volume0: safeNonnegative(day.volume0),
                volume1: safeNonnegative(day.volume1),
              },
            ]
          })
        : []
      // Long-tail index rows intentionally carry no cached accounting. Do not
      // turn that absence into a synthetic zero-volume stat downstream.
      if (
        tvl0 !== null ||
        tvl1 !== null ||
        days.some((day) => day.volume0 !== null || day.volume1 !== null)
      )
        rawStats[poolId] = { tvl0, tvl1, days }
      const liqUsd = safeNonnegative(p.tvlUsd) ?? safeNonnegative(p.gtLiqUsd)
      const vol24hUsd = safeNonnegative(p.vol24hUsd)
      // Same rule as the address-keyed rows above: an absent figure is absent,
      // never a synthetic zero, because a zero sorts and reads as a measurement.
      if (liqUsd !== null || vol24hUsd !== null)
        stats[poolId] = {
          vol24hUsd,
          liqUsd,
          source: p.statsSource === 'geckoterminal' ? 'geckoterminal' : 'chain',
        }
    } catch {
      // One poisoned/malformed row cannot invalidate the complete index page.
    }
  }

  const rawCursor = typeof j.nextCursor === 'string' ? j.nextCursor.toLowerCase() : ''
  const nextCursor =
    HEX64.test(rawCursor) && (!after || rawCursor > after.toLowerCase()) ? rawCursor : null
  const indexed = safeInteger(j.totals?.univ4) ?? 0
  const matched = safeInteger(j.count) ?? 0
  const subgraphBlock = safeInteger(j.subgraphBlock)
  const responseCatalogBlock = safeInteger(j.catalogBlock)
  const responseCatalogGeneration =
    typeof j.catalogGeneration === 'string' ? j.catalogGeneration.toLowerCase() : ''
  // A catalog capable of V4 but lacking a finalized traversal fence belongs
  // to the previous API generation. Treat it as unavailable so continuation
  // pages never silently cross snapshots while Initialize logs are arriving.
  if (responseCatalogBlock === null || responseCatalogBlock <= 0) return { status: 'unavailable' }
  if (catalogBlock !== null && responseCatalogBlock !== catalogBlock)
    return { status: 'unavailable' }
  if (!HEX64.test(responseCatalogGeneration)) return { status: 'unavailable' }
  if (catalogGeneration !== null && responseCatalogGeneration !== catalogGeneration.toLowerCase())
    return { status: 'unavailable' }
  return {
    status: 'ready',
    data: {
      rows: [...byId.values()],
      tokens: mapIndexTokens(j.tokens),
      rawStats,
      stats,
      matched: Math.max(0, matched),
      indexed: Math.max(0, indexed),
      nextCursor,
      subgraphBlock: subgraphBlock !== null && subgraphBlock >= 0 ? subgraphBlock : null,
      catalogBlock: responseCatalogBlock,
      catalogGeneration: responseCatalogGeneration as Hex,
    },
  }
}

/**
 * Merge the useful TVL landing page with deterministic address-cursor pages.
 * Cursor pages intentionally overlap page one, so address de-duplication is a
 * correctness requirement rather than an optimisation. Updating an existing
 * Map value retains the landing page's useful order while refreshing its data.
 */
export function mergeUniIndexPages(pages: readonly UniIndexData[]): UniIndexData {
  const latest = pages.at(-1)
  const catalogSeq = latest?.catalogSeq ?? null
  const catalogGeneration = latest?.catalogGeneration ?? null
  const selected = pages.filter(
    (page) =>
      (page.catalogSeq ?? null) === catalogSeq &&
      (page.catalogGeneration ?? null) === catalogGeneration,
  )
  const byAddress = new Map<string, Pool>()
  const tokens: Record<string, TokenInfo> = {}
  const stats: Record<string, PoolStat> = {}
  // Continuation SQL deliberately avoids recounting a multi-million-row
  // frozen snapshot. Preserve the landing page's count metadata for this
  // fence instead of allowing live tail totals to drift while browsing.
  const total = selected[0]?.total ?? 0
  const totalCapped = selected[0]?.totalCapped ?? false
  const indexed = selected[0]?.indexed ?? 0
  for (const page of selected) {
    for (const pool of page.pools) byAddress.set(pool.address.toLowerCase(), pool)
    Object.assign(tokens, page.tokens)
    Object.assign(stats, page.stats)
  }
  return {
    pools: [...byAddress.values()],
    tokens,
    stats,
    total,
    totalCapped,
    indexed,
    nextCursor: latest?.nextCursor ?? null,
    catalogSeq,
    catalogGeneration,
  }
}
