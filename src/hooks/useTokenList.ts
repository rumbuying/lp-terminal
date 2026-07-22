import type { Address } from 'viem'
import { ADDR, NATIVE } from '../config/addresses'
import type { TokenInfo } from '../types'
import { usePools } from './usePools'
import { useUniPools } from './useUniPools'

const PINNED: string[] = [NATIVE, ADDR.WETH, ADDR.UP, ADDR.USDG].map((a) => a.toLowerCase())

type SwapTokenList = {
  tokens: TokenInfo[]
  up33Loading: boolean
  up33Error: Error | null
  uniswapSource: 'index' | 'fallback' | null
  uniswapError: Error | null
}

/** Tokens backed by a discovered UP33 or sufficiently liquid Uniswap pool. */
export function useTokenList(): SwapTokenList {
  const up33 = usePools()
  const uniswap = useUniPools('', 1_000)

  const map = new Map<string, TokenInfo>()
  map.set(NATIVE.toLowerCase(), {
    address: NATIVE as Address,
    symbol: 'ETH',
    decimals: 18,
    native: true,
  })
  if (up33.data) {
    for (const [k, t] of Object.entries(up33.data.tokens)) map.set(k, t)
  }
  if (uniswap.data) {
    for (const [k, t] of Object.entries(uniswap.data.tokens)) map.set(k, t)
  }

  const list = [...map.values()]
  list.sort((a, b) => {
    const ai = PINNED.indexOf(a.address.toLowerCase())
    const bi = PINNED.indexOf(b.address.toLowerCase())
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
    return a.symbol.localeCompare(b.symbol)
  })
  return {
    tokens: list,
    up33Loading: up33.isPending,
    up33Error: up33.error,
    uniswapSource: uniswap.data?.source ?? null,
    uniswapError: uniswap.error,
  }
}
