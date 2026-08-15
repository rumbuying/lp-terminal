import { GOV } from '../config/addresses'
import type { TokenInfo } from '../types'
import { useTokenUsd } from './useTokenUsd'

// null on a chain with no ve(3,3) protocol — useTokenUsd stays disabled
const UP_TOKEN: TokenInfo | null = GOV ? { address: GOV.UP, symbol: 'UP', decimals: 18 } : null

/** USD value of 1 UP (display only) via the shared venue pricer — dexscreener's
 *  most-liquid pair first, fee-free Kyber unit quote as fallback. Shares the
 *  ['tokenUsd', UP] cache entry with the swap page, so UP is fetched once
 *  app-wide. Replaces the direct Kyber unit quote, which ran ~7% high by
 *  routing through an $8-liquidity stale pool (see lib/tokenPrice.ts). */
export function useUpPrice() {
  return useTokenUsd(UP_TOKEN)
}
