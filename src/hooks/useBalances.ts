import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { erc20Abi } from '../abi'
import { CHAIN_ID, NATIVE } from '../config/addresses'
import { publicRpcClient } from '../lib/publicRpcClient'

/** balances for a set of tokens (NATIVE sentinel included). key = lowercase addr */
export function useBalances(user?: Address, tokens: Address[] = []) {
  const key = tokens
    .map((t) => t.toLowerCase())
    .sort()
    .join(',')
  return useQuery({
    queryKey: ['balances', CHAIN_ID, user, key],
    enabled: !!user && tokens.length > 0,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
    queryFn: async () => {
      // Wallet-scoped, minute-cadence, read-only — the same public-RPC contract
      // as the positions scan (lib/publicRpcClient.ts): the user's own IP
      // allowance pays for the user's own balances.
      const client = publicRpcClient
      const out: Record<string, bigint> = {}
      const erc20s = tokens.filter((t) => t.toLowerCase() !== NATIVE.toLowerCase())
      const hasNative = tokens.length !== erc20s.length
      const res = (await client.multicall({
        contracts: erc20s.map((t) => ({
          abi: erc20Abi,
          address: t,
          functionName: 'balanceOf',
          args: [user!],
        })) as never,
      })) as { status: string; result?: unknown }[]
      erc20s.forEach((t, i) => {
        out[t.toLowerCase()] =
          res[i]?.status === 'success' ? (res[i].result as bigint) : 0n
      })
      if (hasNative) out[NATIVE.toLowerCase()] = await client.getBalance({ address: user! })
      return out
    },
  })
}
