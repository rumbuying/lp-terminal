import { useMemo } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import type { PublicClient } from 'viem'
import { CHAIN_ID } from '../config/addresses'
import {
  shouldAutoRefreshUniPoolCatalog,
  shouldUseInitialPoolCatalogFallback,
  UNI_POOL_CATALOG_QUERY_META,
  UNI_POOL_CATALOG_QUERY_POLICY,
  UNI_POOL_CATALOG_QUERY_ROOT,
} from '../config/query'
import { fetchUniBrowse } from '../lib/uniBrowse'
import {
  canUseUniV3Fallback,
  fetchUniIndex,
  mergeUniIndexPages,
  type UniIndexData,
  type V23CatalogFilter,
} from '../lib/uniIndex'

export type UniPoolsData = UniIndexData & {
  dropped: number // fallback only: spoof candidates dropped by factory.getPool
  source: 'index' | 'fallback'
  capped: boolean
}

type V23PageParam = {
  after: string
  catalogSeq: string | null
  catalogGeneration: string | null
}

const CATALOG_LOAD_TIMEOUT_MS = 15_000

/**
 * Unified address-keyed pool browser — `query`: token address / pool address /
 * symbol / "sym0/sym1"; '' = whole catalog by TVL. Primary source is the
 * pool-indexer API (full official Uniswap/Pancake v2+v3 catalogs). The guarded
 * client fallback proves only Uniswap v3, so protocol filters that ask for V2
 * or Pancake fail visibly instead of being replaced by the wrong venue.
 */
export function useUniPools(
  query: string,
  minTvl: number,
  proto?: V23CatalogFilter,
  enabled = true,
) {
  const pc = usePublicClient({ chainId: CHAIN_ID })
  const result = useInfiniteQuery({
    queryKey: [
      UNI_POOL_CATALOG_QUERY_ROOT,
      CHAIN_ID,
      query.trim().toLowerCase(),
      minTvl,
      proto ?? 'all',
    ],
    meta: UNI_POOL_CATALOG_QUERY_META,
    enabled: enabled && !!pc,
    ...UNI_POOL_CATALOG_QUERY_POLICY,
    // A stale single-page snapshot refreshes on focus/reconnect. Once LOAD MORE
    // retains cursor history, freeze it so TanStack cannot replay every page.
    refetchOnWindowFocus: (catalogQuery) => shouldAutoRefreshUniPoolCatalog(catalogQuery.state.data),
    refetchOnMount: (catalogQuery) => shouldAutoRefreshUniPoolCatalog(catalogQuery.state.data),
    refetchOnReconnect: (catalogQuery) => shouldAutoRefreshUniPoolCatalog(catalogQuery.state.data),
    initialPageParam: null as V23PageParam | null,
    queryFn: async ({ pageParam, client, queryKey, signal }): Promise<UniPoolsData> => {
      const indexSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(CATALOG_LOAD_TIMEOUT_MS),
      ])
      const idx = await fetchUniIndex(
        query,
        minTvl,
        proto,
        120,
        pageParam?.after ?? null,
        pageParam?.catalogSeq ?? null,
        pageParam?.catalogGeneration ?? null,
        false,
        indexSignal,
      )
      if (idx) return { ...idx, dropped: 0, source: 'index', capped: idx.nextCursor !== null }
      // A continuation belongs to an already-proven index response. Never mix
      // a DexScreener fallback page into its deterministic address traversal.
      if (pageParam !== null) throw new Error('pool indexer cursor page unavailable')
      // Background failures keep TanStack's last-good catalog. Browser-wide
      // discovery is allowed only on a true first load, never as an outage poll.
      if (!shouldUseInitialPoolCatalogFallback(client.getQueryData(queryKey), pageParam))
        throw new Error('pool indexer unavailable; showing cached catalog')
      if (!canUseUniV3Fallback(proto))
        throw new Error(`${proto ?? 'selected protocol'} requires the pool indexer`)
      // The index and compatibility discovery are two independent network
      // attempts. Reusing the index deadline here can abort the fallback the
      // instant it starts after a slow/warming sidecar response.
      const fallbackSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(CATALOG_LOAD_TIMEOUT_MS),
      ])
      const legacy = await fetchUniBrowse(pc as PublicClient, query, fallbackSignal)
      return {
        pools: legacy.pools,
        tokens: legacy.tokens,
        stats: legacy.stats,
        total: legacy.candidates,
        indexed: 0,
        dropped: legacy.dropped,
        source: 'fallback',
        capped: false,
        nextCursor: null,
      }
    },
    getNextPageParam: (lastPage: UniPoolsData) =>
      lastPage.source === 'index' && lastPage.nextCursor
        ? {
            after: lastPage.nextCursor,
            catalogSeq: lastPage.catalogSeq ?? null,
            catalogGeneration: lastPage.catalogGeneration ?? null,
          }
        : undefined,
  })

  const data = useMemo<UniPoolsData | undefined>(() => {
    if (!result.data) return undefined
    const first = result.data.pages[0]
    if (!first || first.source === 'fallback') return first
    const merged = mergeUniIndexPages(result.data.pages)
    return {
      ...merged,
      dropped: 0,
      source: 'index',
      capped: merged.nextCursor !== null,
    }
  }, [result.data])

  return { ...result, data }
}
