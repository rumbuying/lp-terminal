import { useQuery } from '@tanstack/react-query'
import type { RemoteChain } from '../config/bridge'
import { fetchBridgeTokens } from '../lib/bridge/tokens'

/** discovered same-token bridge routes for one remote — support surfaces move
 *  rarely, so this is cached long and refetched lazily */
export function useBridgeTokens(remote: RemoteChain) {
  return useQuery({
    queryKey: ['bridgeTokens', remote.chain.id],
    staleTime: 60 * 60_000,
    gcTime: 4 * 60 * 60_000,
    retry: 2,
    queryFn: ({ signal }) => fetchBridgeTokens(remote, signal),
  })
}
