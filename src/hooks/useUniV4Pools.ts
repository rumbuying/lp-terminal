import { useMemo } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import type { PublicClient } from 'viem'
import { CHAIN_ID } from '../config/addresses'
import {
  shouldAutoRefreshUniPoolCatalog,
  V4_INDEXER_WARMING_MAX_RETRIES,
  V4_INDEXER_WARMING_RETRY_DELAY_MS,
  V4_POOL_CATALOG_QUERY_META,
  V4_POOL_CATALOG_QUERY_POLICY,
  V4_POOL_CATALOG_QUERY_ROOT,
} from '../config/query'
import {
  fetchV4PoolCatalog,
  HAS_V4_POOL_CATALOG,
  mergeV4CatalogPages,
  V4IndexerWarmingError,
  type V4CatalogPreference,
  type UniV4PoolCatalog,
} from '../lib/uniV4Pools'

/**
 * Self-hosted v4 index catalog with a deliberate direct-Graph fallback. There
 * is no polling interval. A focus/remount refreshes StateView after five minutes;
 * the write path also rereads executable state before depositing.
 */
export function useUniV4Pools(query: string, enabled = true) {
  const pc = usePublicClient({ chainId: CHAIN_ID })
  type PageParam = {
    after: string | null
    source: V4CatalogPreference
    catalogBlock: number | null
    catalogGeneration: string | null
  }
  const result = useInfiniteQuery({
    queryKey: [V4_POOL_CATALOG_QUERY_ROOT, CHAIN_ID, query.trim().toLowerCase()],
    meta: V4_POOL_CATALOG_QUERY_META,
    enabled: enabled && HAS_V4_POOL_CATALOG && !!pc,
    // Keep a multi-page snapshot frozen: otherwise TanStack replays its first
    // `auto` page and retained source-pinned continuation pages, which could
    // mix an indexer recovery into a Graph cursor traversal.
    ...V4_POOL_CATALOG_QUERY_POLICY,
    refetchOnWindowFocus: (catalogQuery) => shouldAutoRefreshUniPoolCatalog(catalogQuery.state.data),
    refetchOnMount: (catalogQuery) => shouldAutoRefreshUniPoolCatalog(catalogQuery.state.data),
    refetchOnReconnect: (catalogQuery) => shouldAutoRefreshUniPoolCatalog(catalogQuery.state.data),
    // A capable indexer explicitly says when its initial 162k snapshot is still
    // warming. Keep the first load pending and recheck; ordinary API/RPC errors
    // stay no-retry and can surface/fall back according to their source.
    retry: (failureCount, error) =>
      error instanceof V4IndexerWarmingError && failureCount < V4_INDEXER_WARMING_MAX_RETRIES,
    retryDelay: V4_INDEXER_WARMING_RETRY_DELAY_MS,
    initialPageParam: {
      after: null,
      source: 'auto',
      catalogBlock: null,
      catalogGeneration: null,
    } as PageParam,
    queryFn: ({ pageParam }) =>
      fetchV4PoolCatalog(
        pc as PublicClient,
        query,
        undefined,
        pageParam.after,
        pageParam.source,
        pageParam.catalogBlock,
        pageParam.catalogGeneration,
      ),
    getNextPageParam: (lastPage: UniV4PoolCatalog): PageParam | undefined =>
      lastPage.nextCursor
        ? {
            after: lastPage.nextCursor,
            source: lastPage.source,
            catalogBlock: lastPage.catalogBlock,
            catalogGeneration: lastPage.catalogGeneration,
          }
        : undefined,
  })

  const data = useMemo<UniV4PoolCatalog | undefined>(() => {
    return result.data ? mergeV4CatalogPages(result.data.pages) : undefined
  }, [result.data])

  return { ...result, data }
}
