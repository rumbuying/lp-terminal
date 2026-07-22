// TVL/volume stats for SPECIFIC uniswap pools (the ones the user holds
// positions in), straight from the pool indexer's address search. Kept apart
// from useUniPools (catalog browse) so POSITIONS doesn't drag a 120-row page.
import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { fetchUniIndex } from '../lib/uniIndex'
import { fetchDexscreener, type PoolStat } from '../lib/poolstats'
import { poolStatWithFallback } from '../lib/poolStatFallback'

export function useUniPoolStats(addrs: Address[]) {
  const key = addrs
    .map((a) => a.toLowerCase())
    .sort()
    .join(',')
  return useQuery({
    queryKey: ['uniPoolStats', key],
    enabled: addrs.length > 0,
    refetchInterval: 60_000,
    staleTime: 50_000,
    queryFn: async () => {
      const out: Record<string, PoolStat> = {}
      await Promise.all(
        addrs.map(async (a) => {
          const r = await fetchUniIndex(a, 0, undefined, 4).catch(() => null)
          if (r) Object.assign(out, r.stats)
        }),
      )
      const gaps = addrs.filter((a) => {
        const stat = out[a.toLowerCase()]
        return !stat || stat.vol24hUsd == null || stat.liqUsd == null
      })
      const fallback = gaps.length ? await fetchDexscreener(gaps).catch(() => null) : null
      for (const address of gaps) {
        const key = address.toLowerCase()
        const merged = poolStatWithFallback(out[key], fallback?.stats[key])
        if (merged) out[key] = merged
      }
      return out
    },
  })
}
