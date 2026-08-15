import { erc20Abi, getAddress, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { CHAIN } from '../config/chains'
import { ADDR } from '../config/addresses'
import type { ClPool, TokenInfo } from '../types'
import { awaitCatalogTask } from './catalogFetch'
import { clampWidth } from './format'
import { mc, ok, type McRes } from './multicall'
import type { PoolStat } from './poolstats'
import { GraphError, graphQuery, subgraphUrl } from './thegraph'
import { fetchUniV4Index, type UniV4IndexData, type UniV4IndexRow } from './uniIndex'
import { V4_DYNAMIC_FEE_FLAG, v4PoolId, v4StateViewAbi, type V4PoolKey } from './uniV4'

/**
 * Full Uniswap v4 pool catalog for the active chain.
 *
 * The self-hosted indexer answers WHICH PoolIds/currencies exist and supplies
 * per-pool raw token accounting; its own The Graph snapshot is never queried
 * by the browser during normal operation. A direct Graph query remains a
 * deliberate compatibility/outage fallback. Neither source is trusted with
 * executable identity:
 * the live deployment mutates Pool.feeTier to the latest all-in swap fee (for
 * example a 500-ppm PoolKey can read 625 after protocol fee), so using it in a
 * key silently hashes to another pool. StateView supplies the current LP fee;
 * the exact key is whichever of {static lpFee, dynamic flag} hashes back to the
 * indexed PoolId. Rows that cannot prove that round trip are dropped. ERC-20
 * decimals from either directory are likewise ignored until a batched chain
 * read proves the amount-encoding metadata for every currency on the page.
 *
 * USD fields are also not used. Permissionless token prices can poison them;
 * raw token TVL/volume is converted later from the terminal's BNB/USDT anchors.
 */

const V4 = CHAIN.uniV4
export const HAS_V4_POOL_CATALOG = V4 !== null

const GRAPH_CACHE_TTL_MS = 10 * 60_000
const DEFAULT_LIMIT = 120
const MAX_LIMIT = 200
const MAX_CREDIBLE_TVL_USD = 1_000_000_000
const MAX_CREDIBLE_VOL24_USD = 10_000_000_000
const HEX40 = /^0x[0-9a-f]{40}$/
const HEX64 = /^0x[0-9a-f]{64}$/
const FIRST_POOL_CURSOR = `0x${'0'.repeat(64)}`

type GraphToken = {
  id: string
  symbol: string
  decimals: string
}

type GraphDay = {
  date: number
  volumeToken0: string
  volumeToken1: string
}

export type V4GraphPool = {
  id: string
  token0: GraphToken
  token1: GraphToken
  tickSpacing: string
  hooks: string
  totalValueLockedToken0: string
  totalValueLockedToken1: string
  poolDayData: GraphDay[]
}

type GraphMeta = {
  block?: { number?: number }
  hasIndexingErrors?: boolean
}

type GraphBase = {
  _meta?: GraphMeta
  poolManagers?: { poolCount: string }[]
}

type GraphFront = GraphBase & {
  stable0: V4GraphPool[]
  stable1: V4GraphPool[]
  native0: V4GraphPool[]
  native1: V4GraphPool[]
  wrapped0: V4GraphPool[]
  wrapped1: V4GraphPool[]
  active: V4GraphPool[]
}

type GraphSearch = GraphBase & { pools: V4GraphPool[] }

export type V4RawPoolStat = {
  tvl0: number | null
  tvl1: number | null
  days: { date: number; volume0: number | null; volume1: number | null }[]
}

export type UniV4PoolCatalog = {
  pools: ClPool[]
  tokens: Record<string, TokenInfo>
  rawStats: Record<string, V4RawPoolStat>
  /**
   * What the indexer concluded, keyed by PoolId. Empty on the Graph fallback
   * path, which has no server to conclude anything — v4PoolStats derives the
   * same figures from rawStats there, and from rawStats here too whenever the
   * server left one out.
   */
  stats: Record<string, PoolStat>
  /** PoolManager.poolCount — the whole indexed directory, not this page. */
  indexed: number
  /** query-matched candidates in all pages loaded so far, before chain validation */
  matched: number
  /** another cursor page is available */
  capped: boolean
  /** last raw Graph id when another cursor page exists */
  nextCursor: string | null
  subgraphBlock: number | null
  /** Finalized index tail block shared by every page; null for Graph fallback. */
  catalogBlock: number | null
  /** Published index snapshot generation; null for Graph fallback. */
  catalogGeneration: Hex | null
  /** Locks all continuation pages to the same directory source. */
  source: 'index' | 'fallback'
}

const emptyCatalog = (): UniV4PoolCatalog => ({
  pools: [],
  tokens: {},
  rawStats: {},
  stats: {},
  indexed: 0,
  matched: 0,
  capped: false,
  nextCursor: null,
  subgraphBlock: null,
  catalogBlock: null,
  catalogGeneration: null,
  source: 'fallback',
})

/** Merge retained cursor pages without ever crossing directory sources. */
export function mergeV4CatalogPages(
  pages: readonly UniV4PoolCatalog[],
): UniV4PoolCatalog | undefined {
  const source = pages[0]?.source
  if (!source) return undefined
  const catalogBlock = pages[0]?.catalogBlock ?? null
  const catalogGeneration = pages[0]?.catalogGeneration ?? null
  const selected = pages.filter(
    (page) =>
      page.source === source &&
      (source === 'fallback' ||
        (page.catalogBlock === catalogBlock &&
          page.catalogGeneration === catalogGeneration)),
  )
  const byId = new Map<string, ClPool>()
  const tokens: Record<string, TokenInfo> = {}
  const rawStats: Record<string, V4RawPoolStat> = {}
  const stats: Record<string, PoolStat> = {}
  let indexed = 0
  let matched = 0
  let subgraphBlock: number | null = null
  for (const page of selected) {
    for (const pool of page.pools) byId.set((pool.poolId ?? pool.address).toLowerCase(), pool)
    Object.assign(tokens, page.tokens)
    Object.assign(rawStats, page.rawStats)
    Object.assign(stats, page.stats)
    indexed = Math.max(indexed, page.indexed)
    matched = source === 'index' ? Math.max(matched, page.matched) : matched + page.matched
    if (page.subgraphBlock !== null)
      subgraphBlock = subgraphBlock === null
        ? page.subgraphBlock
        : Math.max(subgraphBlock, page.subgraphBlock)
  }
  const last = selected.at(-1)
  return {
    pools: [...byId.values()],
    tokens,
    rawStats,
    stats,
    indexed,
    matched,
    capped: !!last && last.nextCursor !== null,
    nextCursor: last?.nextCursor ?? null,
    subgraphBlock,
    catalogBlock,
    catalogGeneration,
    source,
  }
}

type CachedCatalog = UniV4PoolCatalog & {
  /** Graph rows whose StateView or mandatory token-decimals proof must retry. */
  _stateRetryRows: V4GraphPool[]
}
type Cached = { at: number; value: CachedCatalog }
const MAX_GRAPH_CACHE_ENTRIES = 128
const cache = new Map<string, Cached>()
const inflight = new Map<string, Promise<CachedCatalog>>()
const indexCache = new Map<string, { at: number; value: UniV4PoolCatalog }>()
/** Only entries whose decimals have succeeded through the active chain RPC. */
const verifiedTokenCache = new Map<string, TokenInfo>()

function cacheLookup(key: string): Cached | undefined {
  const now = Date.now()
  const hit = cache.get(key)
  // Preserve this key even when expired: the request path may still use it as a
  // last-good fallback if Graph is temporarily unavailable. Every unrelated
  // expired search/cursor page can be reclaimed immediately.
  for (const [candidate, entry] of cache) {
    if (candidate !== key && now - entry.at >= GRAPH_CACHE_TTL_MS) cache.delete(candidate)
  }
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
  }
  return hit
}

function cacheStore(key: string, value: Cached): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > MAX_GRAPH_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** tests and an explicit manual refresh can discard the metered-query cache. */
export function resetV4PoolCatalogCache(): void {
  cache.clear()
  inflight.clear()
  indexCache.clear()
  verifiedTokenCache.clear()
}

function indexCacheStore(key: string, value: UniV4PoolCatalog): void {
  indexCache.delete(key)
  indexCache.set(key, { at: Date.now(), value })
  while (indexCache.size > MAX_GRAPH_CACHE_ENTRIES) {
    const oldest = indexCache.keys().next().value as string | undefined
    if (oldest === undefined) break
    indexCache.delete(oldest)
  }
}

const POOL_FIELDS = `
  id
  token0 { id symbol decimals }
  token1 { id symbol decimals }
  tickSpacing
  hooks
  totalValueLockedToken0
  totalValueLockedToken1
  poolDayData(
    first: 2
    orderBy: date
    orderDirection: desc
    where: { date_gte: $sinceDay }
  ) { date volumeToken0 volumeToken1 }
`

const FRONT_QUERY = `query V4PoolFront(
  $perAnchor: Int!
  $activeFirst: Int!
  $stable: String!
  $native: String!
  $wrapped: String!
  $sinceDay: Int!
) {
  _meta { block { number } hasIndexingErrors }
  poolManagers(first: 1) { poolCount }
  stable0: pools(first: $perAnchor, orderBy: totalValueLockedToken0, orderDirection: desc,
    where: { token0: $stable, liquidity_gt: "0" }) { ${POOL_FIELDS} }
  stable1: pools(first: $perAnchor, orderBy: totalValueLockedToken1, orderDirection: desc,
    where: { token1: $stable, liquidity_gt: "0" }) { ${POOL_FIELDS} }
  native0: pools(first: $perAnchor, orderBy: totalValueLockedToken0, orderDirection: desc,
    where: { token0: $native, liquidity_gt: "0" }) { ${POOL_FIELDS} }
  native1: pools(first: $perAnchor, orderBy: totalValueLockedToken1, orderDirection: desc,
    where: { token1: $native, liquidity_gt: "0" }) { ${POOL_FIELDS} }
  wrapped0: pools(first: $perAnchor, orderBy: totalValueLockedToken0, orderDirection: desc,
    where: { token0: $wrapped, liquidity_gt: "0" }) { ${POOL_FIELDS} }
  wrapped1: pools(first: $perAnchor, orderBy: totalValueLockedToken1, orderDirection: desc,
    where: { token1: $wrapped, liquidity_gt: "0" }) { ${POOL_FIELDS} }
  active: pools(first: $activeFirst, orderBy: txCount, orderDirection: desc,
    where: { liquidity_gt: "0" }) { ${POOL_FIELDS} }
}`

const searchHead = (vars: string) => `query V4PoolSearch(${vars}, $first: Int!, $sinceDay: Int!) {
  _meta { block { number } hasIndexingErrors }
  poolManagers(first: 1) { poolCount }
`

const searchTail = `}`

type SearchSpec = { query: string; variables: Record<string, unknown> }

/** Pure query classifier, exported so address/poolId/pair behavior is pinned. */
export function v4PoolSearchSpec(raw: string): {
  kind: 'front' | 'all' | 'pool' | 'token' | 'pair' | 'symbol'
  terms: string[]
} {
  const q = raw.trim().toLowerCase().slice(0, 96)
  if (!q) return { kind: 'front', terms: [] }
  if (q === '*') return { kind: 'all', terms: [] }
  if (HEX64.test(q)) return { kind: 'pool', terms: [q] }
  if (HEX40.test(q)) return { kind: 'token', terms: [q] }
  if (q.includes('/')) {
    const [a, b] = q.split('/', 2).map((s) => s.trim()).filter(Boolean)
    if (a && b) return { kind: 'pair', terms: [a, b] }
  }
  return { kind: 'symbol', terms: [q] }
}

function searchDocument(spec: ReturnType<typeof v4PoolSearchSpec>): SearchSpec {
  if (spec.kind === 'pool') {
    return {
      query: `${searchHead('$q: ID!')} pools(first: $first, where: { id: $q }) { ${POOL_FIELDS} } ${searchTail}`,
      variables: { q: spec.terms[0] },
    }
  }
  if (spec.kind === 'all' || spec.kind === 'front') {
    return {
      query: `${searchHead('$after: ID!')} pools(first: $first, orderBy: id, orderDirection: asc,
        where: { id_gt: $after }
      ) { ${POOL_FIELDS} } ${searchTail}`,
      variables: {},
    }
  }
  if (spec.kind === 'token') {
    return {
      query: `${searchHead('$q: String!, $after: ID!')} pools(first: $first, orderBy: id, orderDirection: asc,
        where: { and: [{ id_gt: $after }, { or: [{ token0: $q }, { token1: $q }] }] }
      ) { ${POOL_FIELDS} } ${searchTail}`,
      variables: { q: spec.terms[0] },
    }
  }
  if (spec.kind === 'pair') {
    return {
      // The schema has no exact-equality nocase operator. Requiring both a
      // nocase prefix and suffix is the narrowest server-side equivalent, and
      // exactPairRow below remains the final equality check. Do not enumerate
      // lower/upper spellings: canonical symbols such as slisBNB would vanish.
      query: `${searchHead('$a: String!, $b: String!, $after: ID!')} pools(first: $first, orderBy: id, orderDirection: asc,
        where: { and: [
          { id_gt: $after }
          { or: [
            { token0_: { symbol_starts_with_nocase: $a, symbol_ends_with_nocase: $a } }
            { token1_: { symbol_starts_with_nocase: $a, symbol_ends_with_nocase: $a } }
          ] }
          { or: [
            { token0_: { symbol_starts_with_nocase: $b, symbol_ends_with_nocase: $b } }
            { token1_: { symbol_starts_with_nocase: $b, symbol_ends_with_nocase: $b } }
          ] }
        ] }
      ) { ${POOL_FIELDS} } ${searchTail}`,
      variables: { a: spec.terms[0], b: spec.terms[1] },
    }
  }
  return {
    query: `${searchHead('$q: String!, $after: ID!')} pools(first: $first, orderBy: id, orderDirection: asc,
      where: { and: [
        { id_gt: $after }
        { or: [
          { token0_: { symbol_contains_nocase: $q } }
          { token1_: { symbol_contains_nocase: $q } }
        ] }
      ] }
    ) { ${POOL_FIELDS} } ${searchTail}`,
    variables: { q: spec.terms[0] },
  }
}

type Candidate = {
  row: V4GraphPool
  id: Hex
  currency0: Address
  currency1: Address
  tickSpacing: number
  hooks: Address
}

function int(value: unknown): number | null {
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : null
}

function nonnegative(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function stateNeedsRetry(state: readonly McRes[], i: number): boolean {
  const slot0 = ok<readonly [bigint, number, number, number]>(state[i * 2])
  const liquidity = ok<bigint>(state[i * 2 + 1])
  const lpFee = int(slot0?.[3])
  return (
    !slot0 ||
    slot0[0] <= 0n ||
    liquidity === undefined ||
    lpFee === null ||
    lpFee < 0 ||
    lpFee > 1_000_000
  )
}

function candidateOf(row: V4GraphPool): Candidate | null {
  try {
    const id = row.id.toLowerCase()
    if (!HEX64.test(id)) return null
    const currency0 = getAddress(row.token0.id)
    const currency1 = getAddress(row.token1.id)
    const hooks = getAddress(row.hooks)
    const tickSpacing = int(row.tickSpacing)
    if (currency0.toLowerCase() >= currency1.toLowerCase()) return null
    if (tickSpacing === null || tickSpacing <= 0 || tickSpacing > 32_767) return null
    return { row, id: id as Hex, currency0, currency1, tickSpacing, hooks }
  } catch {
    return null
  }
}

type TokenDisplayHint = { address?: Address; symbol?: unknown }

const nativeTokenInfo = (): TokenInfo => ({
  address: zeroAddress,
  symbol: CHAIN.nativeCurrency.symbol,
  decimals: CHAIN.nativeCurrency.decimals,
  native: true,
})

function displaySymbol(value: unknown, address: Address): string {
  const symbol = typeof value === 'string' ? value.trim() : ''
  return clampWidth(symbol || `${address.slice(0, 6)}…`, 32)
}

/**
 * Read every unique ERC-20 used by this page once. Directory metadata is only
 * a display hint: decimals do not become executable TokenInfo until the chain
 * has returned a valid value. A failed refresh may reuse this module's own
 * last-good proof because ERC-20 decimals are immutable; arbitrary caller or
 * indexer TokenInfo is never promoted into that cache.
 */
async function verifyPoolTokens(
  pc: PublicClient,
  pools: readonly ClPool[],
  hints: Readonly<Record<string, TokenDisplayHint>> = {},
): Promise<Pick<UniV4PoolCatalog, 'pools' | 'tokens'>> {
  const unique = new Map<string, Address>()
  for (const pool of pools) {
    unique.set(pool.token0.toLowerCase(), pool.token0)
    unique.set(pool.token1.toLowerCase(), pool.token1)
  }
  const erc = [...unique.values()].filter((address) => address !== zeroAddress)
  let meta: McRes[] = []
  try {
    meta = await mc(
      pc,
      erc.flatMap((address) => [
        { abi: erc20Abi, address, functionName: 'decimals' },
        { abi: erc20Abi, address, functionName: 'symbol' },
      ]),
    )
  } catch {
    // Per-call failures and a failed aggregate have the same safe result: only
    // an entry proved by an earlier chain read may remain actionable.
  }

  const verified = new Map<string, TokenInfo>()
  if (unique.has(zeroAddress)) verified.set(zeroAddress, nativeTokenInfo())
  erc.forEach((address, i) => {
    const key = address.toLowerCase()
    const cached = verifiedTokenCache.get(key)
    const decimals = int(ok<unknown>(meta[i * 2]))
    if (decimals === null || decimals < 0 || decimals > 255) {
      if (cached) verified.set(key, cached)
      return
    }
    const onchainSymbol = ok<unknown>(meta[i * 2 + 1])
    const hint = hints[key]
    const info: TokenInfo = {
      address,
      decimals,
      symbol: displaySymbol(onchainSymbol ?? cached?.symbol ?? hint?.symbol, address),
    }
    verifiedTokenCache.set(key, info)
    verified.set(key, info)
  })

  const safePools = pools.filter(
    (pool) => verified.has(pool.token0.toLowerCase()) && verified.has(pool.token1.toLowerCase()),
  )
  const used = new Set(safePools.flatMap((pool) => [pool.token0.toLowerCase(), pool.token1.toLowerCase()]))
  const tokens: Record<string, TokenInfo> = {}
  for (const key of used) {
    const info = verified.get(key)
    if (info) tokens[key] = info
  }
  return { pools: safePools, tokens }
}

function graphTokenHints(rows: readonly V4GraphPool[]): Record<string, TokenDisplayHint> {
  const hints: Record<string, TokenDisplayHint> = {}
  for (const row of rows) {
    for (const token of [row.token0, row.token1]) {
      try {
        const address = getAddress(token.id)
        hints[address.toLowerCase()] = { address, symbol: token.symbol }
      } catch {
        // candidateOf drops pools with malformed currency addresses.
      }
    }
  }
  return hints
}

type V4IdentityCandidate = Pick<Candidate, 'id' | 'currency0' | 'currency1' | 'tickSpacing' | 'hooks'>

/**
 * StateView gives the current LP fee but not the PoolKey's fee field. A static
 * pool hashes with that live fee; a dynamic pool hashes with the 0x800000 flag.
 * Exactly one must reproduce the indexed PoolId before the row is executable.
 */
function poolFromState(
  candidate: V4IdentityCandidate,
  slot0: readonly [bigint, number, number, number] | undefined,
  liquidity: bigint | undefined,
): ClPool | null {
  if (!V4 || !slot0 || slot0[0] <= 0n || liquidity === undefined) return null
  const lpFee = int(slot0[3])
  if (lpFee === null || lpFee < 0 || lpFee > 1_000_000) return null
  const keyWith = (fee: number): V4PoolKey => ({
    currency0: candidate.currency0,
    currency1: candidate.currency1,
    fee,
    tickSpacing: candidate.tickSpacing,
    hooks: candidate.hooks,
  })
  const staticKey = keyWith(lpFee)
  const dynamicKey = keyWith(V4_DYNAMIC_FEE_FLAG)
  const key =
    v4PoolId(staticKey).toLowerCase() === candidate.id
      ? staticKey
      : v4PoolId(dynamicKey).toLowerCase() === candidate.id
        ? dynamicKey
        : null
  if (!key) return null
  return {
    kind: 'cl',
    protocol: 'univ4',
    address: V4.POOL_MANAGER,
    poolId: candidate.id,
    hooks: candidate.hooks,
    token0: candidate.currency0,
    token1: candidate.currency1,
    tickSpacing: candidate.tickSpacing,
    feePpm: key.fee,
    lpFeePpm: lpFee,
    unstakedFeePpm: 0,
    sqrtPriceX96: slot0[0],
    tick: slot0[1],
    liquidity,
    stakedLiquidity: 0n,
    gauge: null,
    gaugeAlive: false,
    weight: 0n,
    rewardRate: 0n,
    periodFinish: 0n,
  }
}

/** Index rows remain inert until their corresponding StateView pair proves them. */
export function v4PoolsFromIndexRows(
  rows: readonly UniV4IndexRow[],
  state: readonly McRes[],
): ClPool[] {
  return rows.flatMap((row, i) => {
    const pool = poolFromState(
      {
        id: row.poolId.toLowerCase() as Hex,
        currency0: row.token0,
        currency1: row.token1,
        tickSpacing: row.tickSpacing,
        hooks: row.hooks,
      },
      ok<readonly [bigint, number, number, number]>(state[i * 2]),
      ok<bigint>(state[i * 2 + 1]),
    )
    return pool ? [pool] : []
  })
}

/**
 * Turn Graph candidates plus the corresponding (slot0, liquidity) result pairs
 * into identity-safe ClPools. Runtime callers still apply the token metadata
 * gate before exposing them. Exported for unit tests and smoke diagnostics.
 */
export function v4PoolsFromGraphRows(
  rows: readonly V4GraphPool[],
  state: readonly McRes[],
): Pick<UniV4PoolCatalog, 'pools' | 'tokens' | 'rawStats'> {
  if (!V4) return { pools: [], tokens: {}, rawStats: {} }
  const candidates = rows.map(candidateOf).filter((c): c is Candidate => c !== null)
  const pools: ClPool[] = []
  const tokens: Record<string, TokenInfo> = {}
  const rawStats: Record<string, V4RawPoolStat> = {}

  candidates.forEach((candidate, i) => {
    const slot0 = ok<readonly [bigint, number, number, number]>(state[i * 2])
    const liquidity = ok<bigint>(state[i * 2 + 1])
    const pool = poolFromState(candidate, slot0, liquidity)
    if (!pool) return

    // Native metadata is chain configuration, not an ERC-20 claim. Non-native
    // Graph metadata deliberately stays out of TokenInfo until verifyPoolTokens
    // proves decimals through RPC in the runtime catalog paths below.
    if (candidate.currency0 === zeroAddress || candidate.currency1 === zeroAddress)
      tokens[zeroAddress] = nativeTokenInfo()

    pools.push(pool)
    rawStats[candidate.id] = {
      tvl0: nonnegative(candidate.row.totalValueLockedToken0),
      tvl1: nonnegative(candidate.row.totalValueLockedToken1),
      days: (candidate.row.poolDayData ?? []).map((day) => ({
        date: int(day.date) ?? 0,
        volume0: nonnegative(day.volumeToken0),
        volume1: nonnegative(day.volumeToken1),
      })),
    }
  })
  return { pools, tokens, rawStats }
}

function graphCount(data: GraphBase): number {
  const n = int(data.poolManagers?.[0]?.poolCount)
  return n !== null && n >= 0 ? n : 0
}

function graphBlock(data: GraphBase): number | null {
  const n = int(data._meta?.block?.number)
  return n !== null && n >= 0 ? n : null
}

function assertHealthy(data: GraphBase): void {
  if (data._meta?.hasIndexingErrors) throw new GraphError('thegraph v4 subgraph has indexing errors')
}

function exactPairRow(row: V4GraphPool, terms: string[]): boolean {
  const a = row.token0.symbol.trim().toLowerCase()
  const b = row.token1.symbol.trim().toLowerCase()
  return (a === terms[0] && b === terms[1]) || (a === terms[1] && b === terms[0])
}

async function uncached(
  pc: PublicClient,
  rawQuery: string,
  limit: number,
  after: string | null,
): Promise<CachedCatalog> {
  if (!V4?.poolSubgraph) return { ...emptyCatalog(), _stateRetryRows: [] }
  const spec = v4PoolSearchSpec(rawQuery)
  const today = Math.floor(Date.now() / 86_400_000) * 86_400
  const sinceDay = today - 86_400
  let rows: V4GraphPool[]
  let base: GraphBase
  let nextCursor: string | null

  if (spec.kind === 'front' && after === null) {
    const perAnchor = Math.max(12, Math.ceil(limit / 6))
    const activeFirst = Math.max(20, Math.ceil(limit / 4))
    const data = await graphQuery<GraphFront>(
      subgraphUrl(V4.poolSubgraph),
      FRONT_QUERY,
      {
        perAnchor,
        activeFirst,
        stable: ADDR.STABLE.toLowerCase(),
        native: zeroAddress,
        wrapped: ADDR.WNATIVE.toLowerCase(),
        sinceDay,
      },
      20_000,
    )
    assertHealthy(data)
    base = data
    const feeds = [data.stable0, data.stable1, data.native0, data.native1, data.wrapped0, data.wrapped1, data.active]
    const byId = new Map<string, V4GraphPool>()
    for (const feed of feeds) for (const row of feed ?? []) byId.set(row.id.toLowerCase(), row)
    rows = [...byId.values()]
    // The useful landing page is not id-ordered. Its next page deliberately
    // starts the complete id cursor at zero; merge-by-PoolId removes overlap.
    nextCursor = FIRST_POOL_CURSOR
  } else {
    const pagedSpec: ReturnType<typeof v4PoolSearchSpec> =
      spec.kind === 'front' ? { kind: 'all', terms: [] } : spec
    const request = searchDocument(pagedSpec)
    const data = await graphQuery<GraphSearch>(
      subgraphUrl(V4.poolSubgraph),
      request.query,
      {
        ...request.variables,
        ...(pagedSpec.kind === 'pool' ? {} : { after: after ?? FIRST_POOL_CURSOR }),
        first: limit,
        sinceDay,
      },
      20_000,
    )
    assertHealthy(data)
    base = data
    const rawRows = data.pools ?? []
    rows = pagedSpec.kind === 'pair' ? rawRows.filter((row) => exactPairRow(row, pagedSpec.terms)) : rawRows
    const lastId = rawRows.at(-1)?.id.toLowerCase()
    nextCursor = rawRows.length >= limit && lastId && HEX64.test(lastId) ? lastId : null
  }

  const candidates = rows.map(candidateOf).filter((candidate): candidate is Candidate => candidate !== null)
  const state = await mc(
    pc,
    candidates.flatMap((candidate) => [
      { abi: v4StateViewAbi, address: V4.STATE_VIEW, functionName: 'getSlot0', args: [candidate.id] },
      { abi: v4StateViewAbi, address: V4.STATE_VIEW, functionName: 'getLiquidity', args: [candidate.id] },
    ]),
  )
  // v4PoolsFromGraphRows reparses in the same stable order; pass only rows that
  // produced candidates so state[i*2] remains aligned after malformed rows.
  const mapped = v4PoolsFromGraphRows(candidates.map((candidate) => candidate.row), state)
  const verified = await verifyPoolTokens(
    pc,
    mapped.pools,
    graphTokenHints(candidates.map((candidate) => candidate.row)),
  )
  const safeIds = new Set(verified.pools.map((pool) => pool.poolId!.toLowerCase()))
  const mappedIds = new Set(mapped.pools.map((pool) => pool.poolId!.toLowerCase()))
  const rawStats = Object.fromEntries(
    Object.entries(mapped.rawStats).filter(([id]) => safeIds.has(id)),
  )
  return {
    pools: verified.pools,
    tokens: verified.tokens,
    rawStats,
    // No indexer on this path, so nothing has concluded anything yet;
    // v4PoolStats derives it all from rawStats above.
    stats: {},
    indexed: graphCount(base),
    matched: rows.length,
    capped: nextCursor !== null,
    nextCursor,
    subgraphBlock: graphBlock(base),
    catalogBlock: null,
    catalogGeneration: null,
    source: 'fallback',
    // A failed StateView or mandatory decimals read is not evidence that the
    // Graph row is absent. Keep it so a cache hit retries chain proof without
    // spending another metered Graph query.
    _stateRetryRows: candidates
      .filter((candidate, i) =>
        stateNeedsRetry(state, i) ||
        (mappedIds.has(candidate.id) && !safeIds.has(candidate.id)),
      )
      .map((candidate) => candidate.row),
  }
}

/**
 * Refresh executable state without spending another metered Graph query.
 * Directory identity/raw accounting stays cached for ten minutes, while a
 * focus/remount after five minutes can update price, active liquidity and a
 * dynamic LP fee from StateView alone. Per-pool failures keep last-good state.
 */
async function refreshCatalogState(
  pc: PublicClient,
  value: CachedCatalog,
): Promise<CachedCatalog> {
  if (!V4 || (value.pools.length === 0 && value._stateRetryRows.length === 0)) return value
  const retryCandidates = value._stateRetryRows
    .map(candidateOf)
    .filter((candidate): candidate is Candidate => candidate !== null)
  const state = await mc(
    pc,
    [
      ...value.pools.flatMap((pool) => [
        { abi: v4StateViewAbi, address: V4.STATE_VIEW, functionName: 'getSlot0', args: [pool.poolId] },
        { abi: v4StateViewAbi, address: V4.STATE_VIEW, functionName: 'getLiquidity', args: [pool.poolId] },
      ]),
      ...retryCandidates.flatMap((candidate) => [
        { abi: v4StateViewAbi, address: V4.STATE_VIEW, functionName: 'getSlot0', args: [candidate.id] },
        { abi: v4StateViewAbi, address: V4.STATE_VIEW, functionName: 'getLiquidity', args: [candidate.id] },
      ]),
    ],
  )
  const retryOffset = value.pools.length * 2
  const retryState = state.slice(retryOffset)
  const recovered = v4PoolsFromGraphRows(
    retryCandidates.map((candidate) => candidate.row),
    retryState,
  )
  const byId = new Map<string, ClPool>()
  const refreshedPools = value.pools.map((pool, i) => {
    const slot0 = ok<readonly [bigint, number, number, number]>(state[i * 2])
    const liquidity = ok<bigint>(state[i * 2 + 1])
    const lpFee = int(slot0?.[3])
    if (!slot0 || slot0[0] <= 0n || liquidity === undefined || lpFee === null || lpFee < 0 || lpFee > 1_000_000)
      return pool
    return {
      ...pool,
      sqrtPriceX96: slot0[0],
      tick: slot0[1],
      liquidity,
      lpFeePpm: lpFee,
    }
  })
  for (const pool of refreshedPools) byId.set((pool.poolId ?? pool.address).toLowerCase(), pool)
  for (const pool of recovered.pools) byId.set((pool.poolId ?? pool.address).toLowerCase(), pool)
  const verified = await verifyPoolTokens(
    pc,
    [...byId.values()],
    {
      ...value.tokens,
      ...graphTokenHints(retryCandidates.map((candidate) => candidate.row)),
    },
  )
  const safeIds = new Set(verified.pools.map((pool) => pool.poolId!.toLowerCase()))
  const recoveredIds = new Set(recovered.pools.map((pool) => pool.poolId!.toLowerCase()))
  const allRawStats = { ...value.rawStats, ...recovered.rawStats }
  return {
    ...value,
    pools: verified.pools,
    tokens: verified.tokens,
    rawStats: Object.fromEntries(
      Object.entries(allRawStats).filter(([id]) => safeIds.has(id)),
    ),
    _stateRetryRows: retryCandidates
      .filter((candidate, i) =>
        stateNeedsRetry(retryState, i) ||
        (recoveredIds.has(candidate.id) && !safeIds.has(candidate.id)),
      )
      .map((candidate) => candidate.row),
  }
}

export async function fetchV4GraphPoolCatalog(
  pc: PublicClient,
  query: string,
  limit = DEFAULT_LIMIT,
  after: string | null = null,
): Promise<UniV4PoolCatalog> {
  if (!V4?.poolSubgraph) return emptyCatalog()
  const boundedLimit = Math.min(Math.max(Math.trunc(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const normalized = query.trim().toLowerCase().slice(0, 96)
  const normalizedAfter = after && HEX64.test(after.toLowerCase()) ? after.toLowerCase() : null
  const key = `${normalized}\u0000${boundedLimit}\u0000${normalizedAfter ?? ''}`
  const hit = cacheLookup(key)
  if (hit && Date.now() - hit.at < GRAPH_CACHE_TTL_MS) {
    const refreshed = await refreshCatalogState(pc, hit.value).catch(() => hit.value)
    cacheStore(key, { at: hit.at, value: refreshed })
    return refreshed
  }
  const running = inflight.get(key)
  if (running) return running

  const request = uncached(pc, normalized, boundedLimit, normalizedAfter)
  inflight.set(key, request)
  try {
    const value = await request
    cacheStore(key, { at: Date.now(), value })
    return value
  } catch (error) {
    // A transient Graph/RPC failure may use a stale last-good page; it must not
    // be cached as an authoritative empty directory.
    if (hit) return refreshCatalogState(pc, hit.value).catch(() => hit.value)
    throw error
  } finally {
    inflight.delete(key)
  }
}

async function refreshIndexCatalogState(
  pc: PublicClient,
  value: UniV4PoolCatalog,
): Promise<UniV4PoolCatalog> {
  if (!V4 || value.pools.length === 0) return value
  const state = await mc(
    pc,
    value.pools.flatMap((pool) => [
      { abi: v4StateViewAbi, address: V4.STATE_VIEW, functionName: 'getSlot0', args: [pool.poolId] },
      { abi: v4StateViewAbi, address: V4.STATE_VIEW, functionName: 'getLiquidity', args: [pool.poolId] },
    ]),
  )
  const pools = value.pools.flatMap((pool, i) => {
    const refreshed = poolFromState(
      {
        id: pool.poolId!,
        currency0: pool.token0,
        currency1: pool.token1,
        tickSpacing: pool.tickSpacing,
        hooks: pool.hooks ?? zeroAddress,
      },
      ok<readonly [bigint, number, number, number]>(state[i * 2]),
      ok<bigint>(state[i * 2 + 1]),
    )
    // A transport/per-call failure is not evidence that a previously proved
    // pool disappeared. A successful state that no longer proves its key is.
    return refreshed ? [refreshed] : stateNeedsRetry(state, i) ? [pool] : []
  })
  const verified = await verifyPoolTokens(pc, pools, value.tokens)
  const safeIds = new Set(verified.pools.map((pool) => pool.poolId!.toLowerCase()))
  return {
    ...value,
    pools: verified.pools,
    tokens: verified.tokens,
    rawStats: Object.fromEntries(
      Object.entries(value.rawStats).filter(([id]) => safeIds.has(id)),
    ),
  }
}

/**
 * Prove a batch of index rows against the singleton, in one round trip.
 *
 * A v4 index row is a CANDIDATE: it names a PoolId, and only StateView can say
 * whether that PoolId is live and what its current fee is. Every caller that
 * wants executable v4 pools out of index rows goes through here, so there is
 * one definition of what "proved" means — and one request, however many rows
 * and however many groups they came from.
 */
export async function v4IndexRowsWithState(
  pc: PublicClient,
  rows: readonly UniV4IndexRow[],
  tokenHints: Record<string, TokenInfo>,
  signal?: AbortSignal,
): Promise<{ pools: ClPool[]; tokens: Record<string, TokenInfo> }> {
  if (!V4 || !rows.length) return { pools: [], tokens: {} }
  const state = await awaitCatalogTask(
    mc(
      pc,
      rows.flatMap((row) => [
        { abi: v4StateViewAbi, address: V4.STATE_VIEW, functionName: 'getSlot0', args: [row.poolId] },
        { abi: v4StateViewAbi, address: V4.STATE_VIEW, functionName: 'getLiquidity', args: [row.poolId] },
      ]),
    ),
    signal,
  )
  // verifyPoolTokens returns the CHAIN's decimals, not the directory's. That is
  // the only metadata a v4 currency may be transacted on, and it is also the
  // only place a v4-only token's symbol comes from — the address catalog has
  // never seen it.
  return awaitCatalogTask(
    verifyPoolTokens(pc, v4PoolsFromIndexRows(rows, state), tokenHints),
    signal,
  )
}

async function indexCatalogPage(
  pc: PublicClient,
  page: UniV4IndexData,
  previous?: UniV4PoolCatalog,
): Promise<UniV4PoolCatalog> {
  if (!V4) throw new Error('uniswap v4 is not configured')
  const state = await mc(
    pc,
    page.rows.flatMap((row) => [
      { abi: v4StateViewAbi, address: V4.STATE_VIEW, functionName: 'getSlot0', args: [row.poolId] },
      { abi: v4StateViewAbi, address: V4.STATE_VIEW, functionName: 'getLiquidity', args: [row.poolId] },
    ]),
  )
  const byId = new Map(v4PoolsFromIndexRows(page.rows, state).map((pool) => [pool.poolId!.toLowerCase(), pool]))
  const lastGood = new Map((previous?.pools ?? []).map((pool) => [pool.poolId!.toLowerCase(), pool]))
  page.rows.forEach((row, i) => {
    if (!byId.has(row.poolId.toLowerCase()) && stateNeedsRetry(state, i)) {
      const stale = lastGood.get(row.poolId.toLowerCase())
      if (stale) byId.set(row.poolId.toLowerCase(), stale)
    }
  })
  if (page.rows.length > 0 && byId.size === 0 && page.rows.every((_, i) => stateNeedsRetry(state, i))) {
    throw new Error('uniswap v4 StateView unavailable')
  }
  const verified = await verifyPoolTokens(
    pc,
    [...byId.values()],
    { ...(previous?.tokens ?? {}), ...page.tokens },
  )
  const rawStats: Record<string, V4RawPoolStat> = {}
  const stats: Record<string, PoolStat> = {}
  for (const pool of verified.pools) {
    const id = pool.poolId!.toLowerCase()
    // A successful page is authoritative for the current featured generation.
    // Reusing an older value here would keep showing stale stats after a pool
    // drops out of the indexer's refreshed featured set.
    const raw = page.rawStats[id]
    if (raw) rawStats[id] = raw
    const stat = page.stats[id]
    if (stat) stats[id] = stat
  }
  return {
    pools: verified.pools,
    tokens: verified.tokens,
    rawStats,
    stats,
    indexed: page.indexed,
    matched: page.matched,
    capped: page.nextCursor !== null,
    nextCursor: page.nextCursor,
    subgraphBlock: page.subgraphBlock,
    catalogBlock: page.catalogBlock,
    catalogGeneration: page.catalogGeneration,
    source: 'index',
  }
}

export class V4IndexerWarmingError extends Error {}

export type V4CatalogPreference = 'auto' | 'index' | 'fallback'

/**
 * Indexer-first v4 catalog. A query snapshot never mixes sources: after the
 * first page, the hook pins every cursor page to the source that produced it.
 * Direct The Graph access is used only when the indexer is unavailable/old,
 * never while an explicitly capable v4 catalog is still warming.
 */
export async function fetchV4PoolCatalog(
  pc: PublicClient,
  query: string,
  limit = DEFAULT_LIMIT,
  after: string | null = null,
  preference: V4CatalogPreference = 'auto',
  catalogBlock: number | null = null,
  catalogGeneration: string | null = null,
): Promise<UniV4PoolCatalog> {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const normalized = query.trim().toLowerCase().slice(0, 96)
  const normalizedAfter = after && HEX64.test(after.toLowerCase()) ? after.toLowerCase() : null
  if (preference === 'fallback') {
    if (!V4?.poolSubgraph) throw new Error('uniswap v4 fallback catalog is not configured')
    return fetchV4GraphPoolCatalog(pc, normalized, boundedLimit, normalizedAfter)
  }

  const key = `${normalized}\u0000${boundedLimit}\u0000${normalizedAfter ?? ''}\u0000${catalogBlock ?? ''}\u0000${catalogGeneration ?? ''}`
  const hit = indexCache.get(key)?.value
  const result = await fetchUniV4Index(
    normalized,
    boundedLimit,
    normalizedAfter,
    catalogBlock,
    catalogGeneration,
  )
  if (result.status === 'ready') {
    try {
      const value = await indexCatalogPage(pc, result.data, hit)
      indexCacheStore(key, value)
      return value
    } catch (error) {
      if (hit) return refreshIndexCatalogState(pc, hit).catch(() => hit)
      throw error
    }
  }
  if (result.status === 'warming') {
    if (hit) return refreshIndexCatalogState(pc, hit).catch(() => hit)
    throw new V4IndexerWarmingError('uniswap v4 indexer is warming')
  }
  if (hit) return refreshIndexCatalogState(pc, hit).catch(() => hit)
  if (preference === 'index') throw new Error('uniswap v4 indexer unavailable')
  if (!V4?.poolSubgraph) throw new Error('uniswap v4 catalog unavailable')
  return fetchV4GraphPoolCatalog(pc, normalized, boundedLimit, normalizedAfter)
}

const isStable = (address: Address): boolean => address.toLowerCase() === ADDR.STABLE.toLowerCase()
const isNativeUnit = (address: Address): boolean =>
  address === zeroAddress || address.toLowerCase() === ADDR.WNATIVE.toLowerCase()

function usdPrice(address: Address, bnbUsd: number | null | undefined): number | null {
  if (isStable(address)) return 1
  if (isNativeUnit(address) && bnbUsd !== null && bnbUsd !== undefined && Number.isFinite(bnbUsd) && bnbUsd > 0)
    return bnbUsd
  return null
}

/**
 * Credible display stats from raw subgraph token quantities. One trusted side
 * bounds an unknown side at equal value (2×), matching the indexer's existing
 * anti-poisoning rule. Volume uses one anchored swap side, never the subgraph's
 * permissionless USD conversion and never cumulative Pool.volumeUSD.
 */
export function v4PoolStats(
  data: UniV4PoolCatalog | undefined,
  bnbUsd?: number | null,
  now = Math.floor(Date.now() / 1000),
): Record<string, PoolStat> {
  const out: Record<string, PoolStat> = {}
  if (!data) return out
  for (const pool of data.pools) {
    if (!pool.poolId) continue
    const id = pool.poolId.toLowerCase()
    // The server's own answer wins where it has one. It has to: a page can only
    // sort what it was sent, so ranking a catalog by depth means the ranking
    // and the number shown have to be the same number. Below is the same
    // arithmetic, kept because it is the ONLY source on the Graph fallback path
    // and the backstop for any pool the server could not price.
    const served = data.stats[id]
    const raw = data.rawStats[id]
    if (served) out[id] = served
    // Nothing left to derive, or nothing to derive it from.
    if (!raw || (served && served.liqUsd !== null && served.vol24hUsd !== null)) continue
    const p0 = usdPrice(pool.token0, bnbUsd)
    const p1 = usdPrice(pool.token1, bnbUsd)
    const v0 = raw.tvl0 !== null && p0 !== null ? raw.tvl0 * p0 : null
    const v1 = raw.tvl1 !== null && p1 !== null ? raw.tvl1 * p1 : null
    let liqUsd: number | null
    if (v0 !== null && v1 !== null) liqUsd = v0 + v1
    else if (v0 !== null) liqUsd = v0 * 2
    else if (v1 !== null) liqUsd = v1 * 2
    else liqUsd = null
    if (liqUsd !== null && (!Number.isFinite(liqUsd) || liqUsd < 0 || liqUsd >= MAX_CREDIBLE_TVL_USD)) liqUsd = null

    // Prefer the stable side when present, otherwise the native/WBNB side.
    let side: 0 | 1 | null = null
    let sidePrice: number | null = null
    if (isStable(pool.token0)) [side, sidePrice] = [0, 1]
    else if (isStable(pool.token1)) [side, sidePrice] = [1, 1]
    else if (p0 !== null) [side, sidePrice] = [0, p0]
    else if (p1 !== null) [side, sidePrice] = [1, p1]
    let vol24hUsd: number | null = null
    if (side !== null && sidePrice !== null) {
      // Day entities are ~12x smaller than 24 nested hour entities on the
      // default catalog query. Blend today's total with the portion of
      // yesterday needed to cover the preceding 24 hours. It is an estimate,
      // but it remains anchored in raw token quantities and keeps the metered
      // Graph request fast enough for an interactive directory.
      const today = Math.floor(now / 86_400) * 86_400
      const previousWeight = Math.max(0, Math.min(1, (86_400 - (now - today)) / 86_400))
      const sum = raw.days.reduce((total, day) => {
        const amount = side === 0 ? day.volume0 : day.volume1
        const weight = day.date === today ? 1 : day.date === today - 86_400 ? previousWeight : 0
        return amount === null ? total : total + amount * sidePrice! * weight
      }, 0)
      vol24hUsd = Number.isFinite(sum) && sum >= 0 && sum < MAX_CREDIBLE_VOL24_USD ? sum : null
    }
    // Field by field, because a server that priced the depth but had no volume
    // reading for a pool should not lose the volume this derivation can still
    // supply — and must not have its depth silently replaced by a second
    // opinion either.
    out[id] = {
      liqUsd: served?.liqUsd ?? liqUsd,
      vol24hUsd: served?.vol24hUsd ?? vol24hUsd,
      source: served && (served.liqUsd !== null || served.vol24hUsd !== null)
        ? served.source
        : 'subgraph',
    }
  }
  return out
}
