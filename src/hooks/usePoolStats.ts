import { useQuery } from '@tanstack/react-query'
import { fetchDexscreener, fetchPoolStats } from '../lib/poolstats'
import { usePools } from './usePools'
import type { Pool } from '../types'

/** rolling volume windows / liquidity USD (DexScreener; Goldsky v2 remains 24h-only) */
export function usePoolStats() {
  const pools = usePools()
  return useQuery({
    queryKey: ['poolStats'],
    enabled: !!pools.data,
    refetchInterval: 60_000,
    staleTime: 45_000,
    retry: 1,
    queryFn: () => fetchPoolStats(pools.data!.pools),
  })
}

/** Stats for the small set of UP33 pools represented in the connected wallet. */
export function useHeldPoolStats(pools: Pool[]) {
  const key = [...new Set(pools.map((pool) => pool.address.toLowerCase()))].sort().join(',')
  return useQuery({
    queryKey: ['heldPoolStats', key],
    enabled: pools.length > 0,
    refetchInterval: 60_000,
    staleTime: 45_000,
    retry: 1,
    placeholderData: (previous) => previous,
    queryFn: () => fetchPoolStats(pools),
  })
}

/**
 * DexScreener backstop for pools the primary stats miss — GeckoTerminal only
 * tracks its listed subset of the uniswap catalog (measured: 53 of the top-200
 * TVL rows), and dexscreener's CL batch skips pairs it never picked up. A pool
 * that still lacks volume/liquidity after the primary merge gets one more
 * chance here; pools absent from dexscreener too just keep their honest "—".
 */
export function useDsFallbackStats(addrs: string[]) {
  return useQuery({
    queryKey: ['dsFallback', addrs.join(',')],
    enabled: addrs.length > 0,
    refetchInterval: 60_000,
    staleTime: 45_000,
    retry: 1,
    queryFn: async () => (await fetchDexscreener(addrs)).stats,
  })
}
