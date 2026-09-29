import { useQuery } from '@tanstack/react-query'
import { parseUnits, zeroAddress, type Address } from 'viem'
import { ADDR, CHAIN_ID } from '../config/addresses'
import { kyberUsdValue } from '../lib/kyber'
import { fetchDsTokenUsd, fetchDsTokenUsdMap } from '../lib/poolstats'
import type { TokenInfo } from '../types'

/** USD price of 1 whole token (display only).
 *  Primary: dexscreener's most-liquid pair on this chain — the venue price where
 *  the volume actually is. Fallback for tokens dexscreener hasn't indexed: a
 *  fee-free Kyber unit quote, which cherry-picks the best stale mid across
 *  venues and runs high on everything but ETH (measured +7% on UP). */
export function useTokenUsd(token: TokenInfo | null) {
  const addr = token?.address
  return useQuery({
    queryKey: ['tokenUsd', CHAIN_ID, addr?.toLowerCase()],
    enabled: !!token,
    refetchInterval: 60_000,
    staleTime: 50_000,
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        // native ETH trades as WETH on every venue dexscreener tracks
        return await fetchDsTokenUsd(token!.native ? ADDR.WNATIVE : addr!, signal)
      } catch {
        const against = addr!.toLowerCase() === ADDR.STABLE.toLowerCase() ? ADDR.WNATIVE : ADDR.STABLE
        return kyberUsdValue(addr!, against, parseUnits('1', token!.decimals), signal)
      }
    },
  })
}

const usdMapKey = (address: Address) =>
  address.toLowerCase() === zeroAddress ? ADDR.WNATIVE.toLowerCase() : address.toLowerCase()

/** Same key normalization useTokenUsdMap applies — for callers reading the map. */
export const tokenUsdMapKey = usdMapKey

/** USD prices for a batch of whole tokens (display only). One dexscreener
 *  batch per unique address set; v4-style native (zero address) is priced
 *  through WNATIVE. Missing keys = no fresh anchor — callers degrade. */
export function useTokenUsdMap(addresses: (Address | undefined)[]) {
  const keys = [...new Set(addresses.filter((a): a is Address => !!a).map(usdMapKey))].sort()
  return useQuery({
    queryKey: ['dsTokenUsdMap', CHAIN_ID, keys.join(',')],
    enabled: keys.length > 0,
    staleTime: 50_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: ({ signal }) => fetchDsTokenUsdMap(keys, signal),
  })
}

export function tokenUsdOf(map: Record<string, number> | undefined, address: Address | undefined): number | null {
  if (!address) return null
  const price = map?.[usdMapKey(address)]
  return typeof price === 'number' && Number.isFinite(price) ? price : null
}

