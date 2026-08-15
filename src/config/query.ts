import { QueryClient } from '@tanstack/react-query'

export const UNI_POOL_CATALOG_QUERY_ROOT = 'uniPools'
export const UNI_POOL_CATALOG_QUERY_META = {
  excludeFromTransactionInvalidation: true,
} as const

/** Shared public pool snapshots are refreshed on demand, never by an idle timer. */
export const PUBLIC_POOL_QUERY_POLICY = {
  staleTime: 5 * 60_000,
  gcTime: 30 * 60_000,
  refetchInterval: false,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
  retry: false,
} as const

export const UNI_POOL_CATALOG_QUERY_POLICY = PUBLIC_POOL_QUERY_POLICY

/** Header block height stays lightweight and independent from pool discovery. */
export const HEADER_BLOCK_QUERY_POLICY = {
  staleTime: 60_000,
  gcTime: 5 * 60_000,
  refetchInterval: false,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
  retry: false,
} as const

/**
 * TanStack refetches every retained page of an infinite query. Permit stale
 * focus/reconnect refreshes while the landing page is the only retained page,
 * then freeze cursor history until the filter/query key changes.
 */
export function shouldAutoRefreshUniPoolCatalog(data: unknown): boolean {
  const pages = (data as { pages?: unknown } | null | undefined)?.pages
  return !Array.isArray(pages) || pages.length <= 1
}

/**
 * The legacy browser catalog is a first-load compatibility path, not an outage
 * refresher. Once TanStack has last-good data, an indexer error must leave that
 * snapshot in place instead of multiplying a full RPC scan across every user.
 */
export function shouldUseInitialPoolCatalogFallback(
  cachedData: unknown,
  pageParam: unknown,
): boolean {
  return cachedData === undefined && pageParam === null
}

/**
 * The v4 directory is an infinite indexer query (with a metered Graph outage
 * fallback). Transactions invalidate most app state, but invalidating this root
 * would make TanStack refetch every loaded cursor page sequentially. Its own
 * policy refreshes stale StateView snapshots on focus without polling.
 */
export const V4_POOL_CATALOG_QUERY_ROOT = 'uniV4Pools'
export const V4_POOL_CATALOG_QUERY_META = {
  excludeFromTransactionInvalidation: true,
} as const
export const V4_POOL_CATALOG_QUERY_POLICY = {
  staleTime: 5 * 60_000,
  gcTime: 30 * 60_000,
  refetchInterval: false,
  retry: false,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
} as const

/**
 * The grouped catalog — one row per origin-proven token, with its markets.
 *
 * Its own root because it answers a different question from the flat directory
 * and is fetched only while an origin chip is selected. Same freshness policy:
 * a shared public snapshot, refreshed on demand rather than by an idle timer.
 */
export const POOL_GROUPS_QUERY_ROOT = 'poolGroups'
export const POOL_GROUPS_QUERY_META = {
  excludeFromTransactionInvalidation: true,
} as const
export const POOL_GROUPS_QUERY_POLICY = PUBLIC_POOL_QUERY_POLICY

/** A warming deployment is retried slowly enough not to become a browser herd. */
export const V4_INDEXER_WARMING_RETRY_DELAY_MS = 30_000
export const V4_INDEXER_WARMING_MAX_RETRIES = 60

export function shouldInvalidateAfterTransaction(meta?: Record<string, unknown>): boolean {
  return meta?.excludeFromTransactionInvalidation !== true
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 8_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})
