import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import type { PublicClient } from 'viem'
import { clPoolAbi, uniV3PoolAbi } from '../abi'
import { CHAIN_ID } from '../config/addresses'
import {
  distributionDomain,
  initializedTicksFromBitmap,
  type TickLiquidityDelta,
} from '../lib/liquidityDistribution'
import type { ClPool } from '../types'

type McResult = { status: 'success' | 'failure'; result?: unknown }

export function useLiquidityDistribution(pool: ClPool, selectedLower: number, selectedUpper: number) {
  const client = usePublicClient({ chainId: CHAIN_ID })
  const domain = distributionDomain(pool.tick, pool.tickSpacing, selectedLower, selectedUpper)

  return {
    domain,
    query: useQuery<TickLiquidityDelta[]>({
      queryKey: ['liquidityDistribution', pool.protocol, pool.address.toLowerCase(), domain.wordLow, domain.wordHigh],
      enabled: !!client,
      staleTime: 20_000,
      refetchInterval: 30_000,
      queryFn: async () => {
        const pc = client as PublicClient
        const abi = pool.protocol === 'univ3' ? uniV3PoolAbi : clPoolAbi
        const words = Array.from({ length: domain.wordHigh - domain.wordLow + 1 }, (_, i) => domain.wordLow + i)
        const bitmapResults = (await pc.multicall({
          allowFailure: true,
          contracts: words.map((word) => ({
            abi,
            address: pool.address,
            functionName: 'tickBitmap',
            args: [word],
          })) as never,
        })) as McResult[]
        if (bitmapResults.some((result) => result.status !== 'success'))
          throw new Error('incomplete tick bitmap response')
        const initialized = bitmapResults.flatMap((result, index) =>
          result.status === 'success'
            ? initializedTicksFromBitmap(words[index], result.result as bigint, pool.tickSpacing)
            : [],
        )
        if (initialized.length === 0) return []

        const tickResults = (await pc.multicall({
          allowFailure: true,
          contracts: initialized.map((tick) => ({
            abi,
            address: pool.address,
            functionName: 'ticks',
            args: [tick],
          })) as never,
        })) as McResult[]
        if (tickResults.some((result) => result.status !== 'success'))
          throw new Error('incomplete initialized tick response')

        return tickResults.flatMap((result, index) => {
          if (result.status !== 'success' || !Array.isArray(result.result)) return []
          const liquidityNet = result.result[1]
          return typeof liquidityNet === 'bigint' ? [{ tick: initialized[index], liquidityNet }] : []
        })
      },
    }),
  }
}
