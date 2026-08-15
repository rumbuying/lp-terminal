import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { clPoolAbi } from '../abi'
import { CHAIN_ID } from '../config/addresses'
import { publicRpcClient } from '../lib/publicRpcClient'

export type LiveSlot0 = { sqrtPriceX96: bigint; tick: number }

/**
 * Fast, targeted price feed: polls ONLY slot0 of the given CL pools (one
 * multicall) every `intervalMs`. Used where fill/price must feel live (range
 * orders) without re-running the full pool enumeration at that rate.
 *
 * A 4-second tick is the app's highest-frequency read; it rides the chain's
 * official public RPC (lib/publicRpcClient.ts) so the fastest poll is also
 * the one the terminal never pays for.
 */
export function useLiveSlot0(pools: Address[], intervalMs = 4_000) {
  const key = pools
    .map((a) => a.toLowerCase())
    .sort()
    .join(',')
  return useQuery({
    queryKey: ['liveSlot0', CHAIN_ID, key],
    enabled: pools.length > 0,
    refetchInterval: intervalMs,
    staleTime: 0,
    retry: false,
    queryFn: async () => {
      const res = (await publicRpcClient.multicall({
        contracts: pools.map((a) => ({
          abi: clPoolAbi,
          address: a,
          functionName: 'slot0',
        })) as never,
      })) as { status: string; result?: readonly [bigint, number, ...unknown[]] }[]
      const out: Record<string, LiveSlot0> = {}
      pools.forEach((a, i) => {
        const r = res[i]
        if (r?.status === 'success' && r.result) {
          out[a.toLowerCase()] = { sqrtPriceX96: r.result[0], tick: Number(r.result[1]) }
        }
      })
      return out
    },
  })
}
