// Uniswap v3 pool discovery for the POOLS tab.
//
// Why not RPC enumeration: the factory has thousands of PoolCreated events
// (mostly dust-TVL 1%-tier meme pools) and both public RPC (query timeout) and
// Alchemy (10k-block getLogs cap ≈ 1100+ requests) make in-browser scans
// unrealistic. There is also no official Uniswap subgraph for Robinhood Chain
// (official Graph deployments are mainnet-only as of 2026-07).
//
// So discovery is token-centric via DexScreener (same-origin proxied in
// server builds — KYBERSWAP_AGGREGATOR_API_BASE_URL=/kyber — since
// browser-direct calls die on restricted networks; direct otherwise), and
// every candidate is VERIFIED on-chain before display:
// the pool's own token0/token1/fee must round-trip through factory.getPool to
// the same address — an API can suggest pools, it can never substitute one.
import { getAddress, zeroAddress, type Address, type PublicClient } from 'viem'
import { CHAIN } from '../config/chains'
import { erc20Abi, uniV3FactoryAbi, uniV3PoolAbi } from '../abi'
import { ADDR, UNI } from '../config/addresses'
import { ENV } from '../config/env'
import { loadTokenCache, saveTokenCache } from '../hooks/usePools'
import type { PoolStat } from './poolstats'
import type { ClPool, TokenInfo } from '../types'
import { awaitCatalogTask, fetchCatalog } from './catalogFetch'

const DS = ENV.proxied ? '/dexscreener' : 'https://api.dexscreener.com'
const CAP = 30 // top pools by TVL per query — keeps the verify multicall small

type DsPair = {
  chainId?: string
  dexId?: string
  labels?: string[]
  pairAddress?: string
  volume?: { h24?: number }
  liquidity?: { usd?: number }
}

export type UniBrowse = {
  pools: ClPool[]
  tokens: Record<string, TokenInfo>
  stats: Record<string, PoolStat> // lowercase pool address
  candidates: number // dexscreener v3 matches before cap + on-chain verify
  dropped: number // candidates that failed factory.getPool verification
}

// Which venue a candidate belongs to. Both slots are Uniswap-v3-shaped
// wherever `dexIds.home` is set (the chain config guarantees it), so one
// hydration ABI covers them; only the vouching factory and the protocol tag
// differ.
const VENUES: { dexId: string; protocol: 'univ3' | 'home'; factory: Address }[] = [
  { dexId: CHAIN.slugs.dexIds.uni, protocol: 'univ3', factory: UNI.V3_FACTORY },
  ...(CHAIN.slugs.dexIds.home
    ? [{ dexId: CHAIN.slugs.dexIds.home, protocol: 'home' as const, factory: ADDR.CL_FACTORY }]
    : []),
]

export const venueOf = (p: DsPair | undefined) => VENUES.find((v) => v.dexId === p?.dexId)

/**
 * DexScreener's version labels are a HINT, and an inconsistent one: on BSC,
 * Uniswap's v3 pools carry no label at all while its v2 pairs are labelled
 * ['v2'], and on Robinhood those same v3 pools are labelled ['v3']. Requiring
 * the 'v3' label therefore drops the single deepest pool on the chain.
 *
 * So reject only what CLAIMS to be a version this path cannot read, and let
 * factory.getPool be the gate it already is — a v2 pair that slips through has
 * no fee()/tickSpacing() to hydrate and never reaches the pool list.
 */
const NOT_V3 = ['v2', 'v4']
export function looksLikeV3(p: DsPair | undefined): boolean {
  const labels = (p?.labels ?? []).map((l) => String(l).toLowerCase())
  return labels.includes('v3') || !labels.some((l) => NOT_V3.includes(l))
}

function v3PairsOf(json: unknown): DsPair[] {
  const arr = Array.isArray(json) ? json : ((json as { pairs?: DsPair[] })?.pairs ?? [])
  return arr.filter((p) => p?.chainId === CHAIN.slugs.dexscreener && !!venueOf(p) && looksLikeV3(p))
}

async function dsJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const r = await fetchCatalog(DS + path, {}, signal)
  if (!r.ok) throw new Error(`dexscreener ${r.status}`)
  return r.json()
}

async function optionalDsJson(path: string, signal?: AbortSignal): Promise<unknown | null> {
  try {
    return await dsJson(path, signal)
  } catch (error) {
    if (signal?.aborted) throw error
    return null
  }
}

/** dexscreener candidates for a query: token address, pool address, or symbol text */
async function candidatesFor(query: string, signal?: AbortSignal): Promise<DsPair[]> {
  const q = query.trim()
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
    // token address first (the common case), then pool-address lookup
    const byToken = v3PairsOf(
      await optionalDsJson(`/token-pairs/v1/${CHAIN.slugs.dexscreener}/${q}`, signal),
    )
    if (byToken.length) return byToken
    return v3PairsOf(
      await optionalDsJson(`/latest/dex/pairs/${CHAIN.slugs.dexscreener}/${q}`, signal),
    )
  }
  return v3PairsOf(
    await optionalDsJson(`/latest/dex/search?q=${encodeURIComponent(q)}`, signal),
  )
}

type McRes = { status: 'success' | 'failure'; result?: unknown }
const ok = <T,>(r: McRes | undefined): T | undefined =>
  r && r.status === 'success' ? (r.result as T) : undefined

/**
 * Discover + on-chain-verify concentrated-liquidity pools across the chain's
 * v3-shaped venues. `query` empty = the wrapped native (hub token). Returns
 * ready-to-render ClPool objects, each tagged with the venue whose factory
 * vouched for it, and no gauge fields (discovery covers no ve(3,3) protocol).
 */
export async function fetchUniBrowse(
  pc: PublicClient,
  query: string,
  signal?: AbortSignal,
): Promise<UniBrowse> {
  const raw = await candidatesFor(query || ADDR.WNATIVE, signal)
  signal?.throwIfAborted()

  // dedupe, rank by TVL, cap
  const seen = new Map<string, DsPair>()
  for (const p of raw) {
    const a = p.pairAddress?.toLowerCase()
    if (a && !seen.has(a)) seen.set(a, p)
  }
  const ranked = [...seen.values()].sort(
    (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
  )
  const picks = ranked.slice(0, CAP)

  const stats: Record<string, PoolStat> = {}
  for (const p of picks) {
    const vol = Number(p.volume?.h24)
    const liq = Number(p.liquidity?.usd)
    stats[p.pairAddress!.toLowerCase()] = {
      vol24hUsd: Number.isFinite(vol) ? vol : null,
      liqUsd: Number.isFinite(liq) ? liq : null,
      source: 'dexscreener',
    }
  }

  // hydrate pool state from the pool contracts themselves
  const addrs = picks.map((p) => getAddress(p.pairAddress!))
  const det = (await awaitCatalogTask(
    pc.multicall({
      contracts: addrs.flatMap((a) => [
        { abi: uniV3PoolAbi, address: a, functionName: 'token0' },
        { abi: uniV3PoolAbi, address: a, functionName: 'token1' },
        { abi: uniV3PoolAbi, address: a, functionName: 'fee' },
        { abi: uniV3PoolAbi, address: a, functionName: 'tickSpacing' },
        { abi: uniV3PoolAbi, address: a, functionName: 'slot0' },
        { abi: uniV3PoolAbi, address: a, functionName: 'liquidity' },
      ]) as never,
    }),
    signal,
  )) as McRes[]
  signal?.throwIfAborted()

  type Hyd = {
    addr: Address
    protocol: 'univ3' | 'home'
    factory: Address
    token0: Address
    token1: Address
    fee: number
    ts: number
    s0: readonly [bigint, number]
    liq: bigint
  }
  const hyd: Hyd[] = []
  addrs.forEach((a, i) => {
    const token0 = ok<Address>(det[i * 6])
    const token1 = ok<Address>(det[i * 6 + 1])
    const fee = ok<number>(det[i * 6 + 2])
    const ts = ok<number>(det[i * 6 + 3])
    const s0 = ok<readonly [bigint, number]>(det[i * 6 + 4])
    const liq = ok<bigint>(det[i * 6 + 5])
    const venue = venueOf(picks[i])
    if (!token0 || !token1 || fee === undefined || ts === undefined || !s0 || !venue) return
    hyd.push({
      addr: a,
      protocol: venue.protocol,
      factory: venue.factory,
      token0,
      token1,
      fee,
      ts,
      s0,
      liq: liq ?? 0n,
    })
  })

  // authenticity gate: the OFFICIAL factory FOR THAT VENUE must map
  // (token0, token1, fee) back to this exact address, else it's a fork/spoof
  // pool and gets dropped. Checking against the wrong venue's factory would
  // reject every honest pool of the other one, so the address travels with the
  // candidate rather than being a constant.
  const gp = (await awaitCatalogTask(
    pc.multicall({
      contracts: hyd.map((h) => ({
        abi: uniV3FactoryAbi,
        address: h.factory,
        functionName: 'getPool',
        args: [h.token0, h.token1, h.fee],
      })) as never,
    }),
    signal,
  )) as McRes[]
  const verified = hyd.filter((h, i) => {
    const mapped = ok<Address>(gp[i])
    return !!mapped && mapped !== zeroAddress && mapped.toLowerCase() === h.addr.toLowerCase()
  })

  // token metadata (shared localStorage cache with the UP33 pool scan)
  const cache = loadTokenCache()
  const tokens: Record<string, TokenInfo> = {}
  const missing: Address[] = []
  for (const h of verified) {
    for (const t of [h.token0, h.token1]) {
      const k = t.toLowerCase()
      if (tokens[k]) continue
      if (cache[k]) tokens[k] = cache[k]
      else if (!missing.some((m) => m.toLowerCase() === k)) missing.push(t)
    }
  }
  if (missing.length) {
    const meta = (await awaitCatalogTask(
      pc.multicall({
        contracts: missing.flatMap((t) => [
          { abi: erc20Abi, address: t, functionName: 'symbol' },
          { abi: erc20Abi, address: t, functionName: 'decimals' },
        ]) as never,
      }),
      signal,
    )) as McRes[]
    missing.forEach((t, j) => {
      const info: TokenInfo = {
        address: t,
        symbol: ok<string>(meta[j * 2]) ?? t.slice(0, 6) + '…',
        decimals: ok<number>(meta[j * 2 + 1]) ?? 18,
      }
      tokens[t.toLowerCase()] = info
      cache[t.toLowerCase()] = info
    })
    saveTokenCache(cache)
  }

  const pools: ClPool[] = verified.map((h) => ({
    kind: 'cl',
    protocol: h.protocol,
    address: h.addr,
    token0: h.token0,
    token1: h.token1,
    tickSpacing: h.ts,
    feePpm: h.fee, // univ3 fee unit == ppm
    unstakedFeePpm: 0, // no ve(3,3) levy — LPs keep 100% of fees
    sqrtPriceX96: h.s0[0],
    tick: h.s0[1],
    liquidity: h.liq,
    stakedLiquidity: 0n,
    gauge: null,
    gaugeAlive: false,
    weight: 0n,
    rewardRate: 0n,
    periodFinish: 0n,
  }))

  return { pools, tokens, stats, candidates: ranked.length, dropped: hyd.length - verified.length }
}
