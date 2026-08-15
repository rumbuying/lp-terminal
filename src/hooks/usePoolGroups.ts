import { useMemo } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import type { PublicClient } from 'viem'
import { CHAIN_ID } from '../config/addresses'
import {
  POOL_GROUPS_QUERY_META,
  POOL_GROUPS_QUERY_POLICY,
  POOL_GROUPS_QUERY_ROOT,
  shouldAutoRefreshUniPoolCatalog,
} from '../config/query'
import {
  fetchPoolGroups,
  type PoolGroupCatalog,
  type PoolGroupSort,
} from '../lib/poolGroups'

/** Groups per page, and how many markets each one carries with it. */
export const POOL_GROUPS_PAGE = 40
export const POOLS_PER_GROUP = 5

/**
 * One row per token whose origin this chain has proven, ranked and paged by the
 * catalog rather than by whatever a page of pools happened to contain.
 *
 * `enabled` is false while no origin chip is selected — ALL is a flat list of
 * markets and has no grouping to do.
 */
export function usePoolGroups(
  origin: string | null,
  sort: PoolGroupSort,
  minTvl: number,
  enabled = true,
) {
  const pc = usePublicClient({ chainId: CHAIN_ID })
  const result = useInfiniteQuery({
    queryKey: [POOL_GROUPS_QUERY_ROOT, CHAIN_ID, origin ?? '', sort, minTvl],
    meta: POOL_GROUPS_QUERY_META,
    enabled: enabled && !!origin && !!pc,
    ...POOL_GROUPS_QUERY_POLICY,
    // Same rule as the flat directory: refresh freely while one page is
    // retained, then freeze the cursor history so a refetch cannot replay a
    // traversal against a catalog that has moved underneath it.
    refetchOnWindowFocus: (query) => shouldAutoRefreshUniPoolCatalog(query.state.data),
    refetchOnMount: (query) => shouldAutoRefreshUniPoolCatalog(query.state.data),
    refetchOnReconnect: (query) => shouldAutoRefreshUniPoolCatalog(query.state.data),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchPoolGroups(
        pc as PublicClient,
        {
          origin: origin ?? '',
          sort,
          limit: POOL_GROUPS_PAGE,
          poolsPerGroup: POOLS_PER_GROUP,
          minTvl,
          after: pageParam,
        },
        signal,
      ),
    getNextPageParam: (lastPage: PoolGroupCatalog | null) => lastPage?.nextCursor ?? undefined,
  })

  const data = useMemo<PoolGroupCatalog | undefined>(() => {
    const pages = result.data?.pages.filter((page): page is PoolGroupCatalog => page !== null)
    if (!pages?.length) return undefined
    const byToken = new Map<string, PoolGroupCatalog['groups'][number]>()
    for (const page of pages)
      for (const group of page.groups) byToken.set(group.token.toLowerCase(), group)
    const last = pages.at(-1)!
    return {
      origin: pages[0].origin,
      sort: pages[0].sort,
      groups: [...byToken.values()],
      tokens: Object.assign({}, ...pages.map((page) => page.tokens)),
      stats: Object.assign({}, ...pages.map((page) => page.stats)),
      // The landing page is the only one that carries a total, by design.
      count: pages[0].count,
      nextCursor: last.nextCursor,
    }
  }, [result.data])

  return { ...result, data }
}
