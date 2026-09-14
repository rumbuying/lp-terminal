// The indexer's complete UP33 home CL registry, as a top-up for the browser's
// bounded factory scan.
//
// `fetchPools` enumerates CLFactory.allPools straight from the chain because
// home rows need reads the indexer does not carry (voter weights) and must not
// depend on the indexer being up. That scan is bounded by a browser RPC
// budget, and the registry outgrew the budget: pools past its head — exactly
// where newly created Robinhood markets sit — silently vanished from the
// POOLS page while the rank table (subgraph-fed) kept showing them. The
// indexer already enumerates the registry in full and sweeps its state
// (indexer/up33.ts, state.ts), so /api/up33/pools is the completion source.
//
// The rule is the same one the catalog feeds follow, and the reverse of the
// scan's: rows the scan already read from the chain always win; the registry
// only fills what the scan's budget cut off. A registry row whose first state
// sweep has not landed (stateReady=false) is not merged — it has no price and
// no liquidity to render yet, and the next tail sweep names it within minutes;
// inventing a zero-price row would be worse than a short wait.
import { getAddress, type Address } from 'viem'
import { CHAIN_ID } from '../config/addresses'
import { ACTIVE_IS_BUILD, CHAIN } from '../config/chains'
import { indexerApiPath } from '../config/chains/routes'
import { ENV } from '../config/env'
import type { ClPool, Pool, TokenInfo } from '../types'
import { fetchCatalog } from './catalogFetch'

export type Up33RegistryPool = {
  address: string
  token0: string
  token1: string
  feePpm: number | null
  unstakedFeePpm: number | null
  tickSpacing: number | null
  gauge: string | null
  pairIndex: number | null
  sqrtPriceX96: string | null
  tick: number | null
  liquidity: string | null
  stakedLiquidity: string | null
  rewardRate: string | null
  periodFinish: number | null
  gaugeAlive: boolean
  stateUpdated: number | null
  stateReady: boolean
}

export type Up33RegistryData = {
  chainId: number
  ready: boolean
  chain: { key: string; id: number }
  pools: Up33RegistryPool[]
  tokens: Record<string, { address: string; symbol: string; decimals: number }>
}

const uint = (value: string | null): bigint | null => {
  if (value === null || !/^\d+$/.test(value)) return null
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

const ZERO_GAUGE = '0x' + '0'.repeat(40)

const checksumOrThrow = (value: string): Address => getAddress(value)

/**
 * Fetch the registry. Null — never a throw — means "no top-up available":
 * a deployment that does not serve this chain's indexer, an old indexer
 * mid-deploy (404), a timeout, or a body that fails the chain guard. Every
 * one of those leaves the browser scan's own result standing.
 */
export async function fetchUp33Registry(
  signal?: AbortSignal,
  timeoutMs = 10_000,
): Promise<Up33RegistryData | null> {
  const path = indexerApiPath('up33/pools', CHAIN.key, ENV.chainGateway, ACTIVE_IS_BUILD)
  if (!path) return null
  let j: Up33RegistryData
  try {
    const u = new URL(path, location.origin)
    // The endpoint answers with max-age=60 and the registry only changes at
    // the tail-sweep cadence, so the browser's HTTP cache may serve a recent
    // body — this top-up rides along with every home scan and must not turn
    // into a full re-download of the registry each time.
    const r = await fetchCatalog(u, {}, signal, timeoutMs)
    if (!r.ok) return null
    j = (await r.json()) as Up33RegistryData
  } catch (error) {
    if (signal?.aborted) throw error
    return null
  }
  if (!Array.isArray(j?.pools)) return null
  // Same-origin routing mistakes and mismatched indexer configuration both
  // produce valid-looking pool identities for the wrong chain.
  if (!j.chain || j.chain.key !== CHAIN.key || j.chain.id !== CHAIN_ID) return null
  if (j.chainId !== CHAIN_ID) return null
  return j
}

/**
 * Append the registry rows the scan's budget cut off. Head rows win by
 * address; registry-only rows become ordinary home CL pools, carrying the
 * sweep's state (price, liquidity, gauge) and — via `tokens` — the metadata
 * search and rendering need. Rows without sweep state or token metadata are
 * held back: they are minutes old, and the next sweep names them.
 */
export function mergeUp33Registry(
  scanned: { pools: Pool[]; tokens: Record<string, TokenInfo> },
  registry: Up33RegistryData | null,
): { pools: Pool[]; tokens: Record<string, TokenInfo>; added: number } {
  const tokens = { ...scanned.tokens }
  const pools = [...scanned.pools]
  if (!registry) return { pools, tokens, added: 0 }
  const seen = new Set(pools.map((p) => p.address.toLowerCase()))
  let added = 0
  for (const row of registry.pools) {
    try {
      if (seen.has(row.address.toLowerCase())) continue
      if (!row.stateReady) continue
      const sqrtPriceX96 = uint(row.sqrtPriceX96)
      const liquidity = uint(row.liquidity)
      if (sqrtPriceX96 === null || sqrtPriceX96 === 0n || liquidity === null) continue
      if (typeof row.tick !== 'number' || !Number.isSafeInteger(row.tick)) continue
      if (typeof row.feePpm !== 'number' || !Number.isSafeInteger(row.feePpm)) continue
      const address = checksumOrThrow(row.address)
      const token0 = checksumOrThrow(row.token0)
      const token1 = checksumOrThrow(row.token1)
      const meta = [row.token0, row.token1].map((t) => registry.tokens[t.toLowerCase()])
      if (!meta[0] || !meta[1]) continue
      const tokenInfo = meta.map((m, i): TokenInfo => {
        const checksummed = i === 0 ? token0 : token1
        return { address: checksummed, symbol: m.symbol, decimals: m.decimals }
      })
      for (const [i, t] of [row.token0, row.token1].entries()) {
        const k = t.toLowerCase()
        // The scan's own chain reads stay authoritative for metadata too.
        if (!tokens[k]) tokens[k] = tokenInfo[i]
      }
      const stakedLiquidity = uint(row.stakedLiquidity) ?? 0n
      const gauge = row.gauge && row.gauge !== ZERO_GAUGE ? checksumOrThrow(row.gauge) : null
      const cl: ClPool = {
        kind: 'cl',
        protocol: 'home',
        address,
        token0,
        token1,
        tickSpacing: typeof row.tickSpacing === 'number' ? row.tickSpacing : 0,
        feePpm: row.feePpm,
        unstakedFeePpm: typeof row.unstakedFeePpm === 'number' ? row.unstakedFeePpm : 0,
        sqrtPriceX96,
        tick: row.tick,
        liquidity,
        stakedLiquidity,
        gauge,
        gaugeAlive: row.gaugeAlive === true,
        // Voter weights live only in the browser's own scan; a registry row
        // has none, so it sorts below every voted pool rather than pretending.
        weight: 0n,
        rewardRate: uint(row.rewardRate) ?? 0n,
        periodFinish: typeof row.periodFinish === 'number' ? BigInt(row.periodFinish) : 0n,
      }
      pools.push(cl)
      seen.add(row.address.toLowerCase())
      added++
    } catch {
      // A malformed row is one missing row, not a failed merge.
    }
  }
  return { pools, tokens, added }
}
