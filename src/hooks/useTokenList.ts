import { mergeSwapTokens } from '../lib/swapTokens'
import type { TokenInfo } from '../types'
import { usePools } from './usePools'
import { useUniPools } from './useUniPools'

type SwapTokenList = {
  tokens: TokenInfo[]
  loading: boolean
  up33Loading: boolean
  up33Error: Error | null
  uniswapSource: 'index' | 'fallback' | null
  uniswapError: Error | null
}

/** Tokens backed by a discovered UP33 or sufficiently liquid Uniswap pool. */
export function useTokenList(): SwapTokenList {
  const up33 = usePools()
  const uniswap = useUniPools('', 1_000)

  // Merging is pure and lives in lib/swapTokens, which is also where the
  // native fold is explained: the Uniswap catalog names the coin `address(0)`
  // on every v4 pool, and the picker is a list of things a wallet can spend.
  const tokens = mergeSwapTokens([up33.data?.tokens, uniswap.data?.tokens])

  return {
    tokens,
    loading: up33.isLoading || uniswap.isLoading,
    up33Loading: up33.isLoading,
    up33Error: up33.error,
    uniswapSource: uniswap.data?.source ?? null,
    uniswapError: uniswap.error,
  }
}
