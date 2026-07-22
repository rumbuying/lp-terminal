import { useQuery } from '@tanstack/react-query'
import { erc20Abi, type Address } from 'viem'
import { getBalance, readContract } from 'wagmi/actions'
import { NATIVE_SENTINEL } from '../config/bridge'
import { asConfiguredChain, wagmiConfig } from '../config/wagmi'

/** wallet balance of one token on one configured chain (bridge origin side —
 *  reads go through that chain's public transport, not the wallet) */
export function useBridgeBalance(user: Address | undefined, chainId: number, token: Address) {
  return useQuery({
    queryKey: ['bridgeBal', chainId, token.toLowerCase(), user],
    enabled: !!user,
    refetchInterval: 15_000,
    retry: false,
    queryFn: async (): Promise<bigint> => {
      const cid = asConfiguredChain(chainId)
      if (token.toLowerCase() === NATIVE_SENTINEL.toLowerCase()) {
        return (await getBalance(wagmiConfig, { address: user!, chainId: cid })).value
      }
      return readContract(wagmiConfig, {
        abi: erc20Abi,
        address: token,
        functionName: 'balanceOf',
        args: [user!],
        chainId: cid,
      })
    },
  })
}
