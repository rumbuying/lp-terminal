import { useQuery } from '@tanstack/react-query'
import { parseUnits } from 'viem'
import { ADDR } from '../config/addresses'
import { kyberUsdValue } from '../lib/kyber'
import { fetchDsTokenUsd } from '../lib/poolstats'
import type { TokenInfo } from '../types'

/** USD price of 1 whole token (display only).
 *  Primary: dexscreener's most-liquid robinhood pair — the venue price where
 *  the volume actually is. Fallback for tokens dexscreener hasn't indexed: a
 *  fee-free Kyber unit quote, which cherry-picks the best stale mid across
 *  venues and runs high on everything but ETH (measured +7% on UP). */
export function useTokenUsd(token: TokenInfo | null) {
  const addr = token?.address
  return useQuery({
    queryKey: ['tokenUsd', addr?.toLowerCase()],
    enabled: !!token,
    refetchInterval: 60_000,
    staleTime: 50_000,
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        // native ETH trades as WETH on every venue dexscreener tracks
        return await fetchDsTokenUsd(token!.native ? ADDR.WETH : addr!, signal)
      } catch {
        const against = addr!.toLowerCase() === ADDR.USDG.toLowerCase() ? ADDR.WETH : ADDR.USDG
        return kyberUsdValue(addr!, against, parseUnits('1', token!.decimals), signal)
      }
    },
  })
}
