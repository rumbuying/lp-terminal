import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { ACTIVE_IS_BUILD, CHAIN } from '../config/chains'
import { indexerApiPath } from '../config/chains/routes'
import { ENV } from '../config/env'
import type { TokenUsdMap } from '../lib/apr'

export type TokenPriceMark = {
  priceUsd: number | null
  depthUsd: number
  source: string | null
  updatedAt: number | null
}

export type { TokenUsdMap } from '../lib/apr'

type PriceResponse = {
  ready?: boolean
  prices?: Record<string, TokenPriceMark>
}

export async function fetchTokenPrices(addresses: string[], signal?: AbortSignal): Promise<Record<string, TokenPriceMark>> {
  const unique = [...new Set(addresses.map((address) => address.toLowerCase()))].sort()
  if (!unique.length) return {}
  const pricesPath = indexerApiPath('prices', CHAIN.key, ENV.chainGateway, ACTIVE_IS_BUILD)
  if (!pricesPath) return {}

  // Stay below common reverse-proxy request-line limits for unusually large
  // wallets while still collapsing normal position inventories to one call.
  const chunks: string[][] = []
  for (let i = 0; i < unique.length; i += 100) chunks.push(unique.slice(i, i + 100))
  const responses = await Promise.all(
    chunks.map(async (chunk) => {
      const url = new URL(pricesPath, location.origin)
      url.searchParams.set('addresses', chunk.join(','))
      const response = await fetch(url, { signal })
      if (!response.ok) throw new Error(`prices ${response.status}`)
      return (await response.json()) as PriceResponse
    }),
  )
  return Object.assign({}, ...responses.map((response) => response.prices ?? {}))
}

/** One cached indexer request for the unique assets in the connected wallet's LPs. */
export function useTokenPrices(addresses: Address[]) {
  const key = [...new Set(addresses.map((address) => address.toLowerCase()))].sort()
  return useQuery<Record<string, TokenPriceMark>>({
    queryKey: ['tokenPrices', key.join(',')],
    enabled: key.length > 0,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 2,
    placeholderData: (previous) => previous,
    queryFn: ({ signal }) => fetchTokenPrices(key, signal),
  })
}

/** Strip confidence metadata for valuation math; invalid/null marks stay absent. */
export function tokenUsdMapOf(marks: Record<string, TokenPriceMark> | undefined): TokenUsdMap {
  const prices: TokenUsdMap = {}
  for (const [address, mark] of Object.entries(marks ?? {})) {
    if (mark.priceUsd !== null && Number.isFinite(mark.priceUsd) && mark.priceUsd > 0)
      prices[address.toLowerCase()] = mark.priceUsd
  }
  return prices
}
