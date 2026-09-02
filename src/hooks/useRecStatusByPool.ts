import { useQuery } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { CHAIN } from '../config/chains'
import { executorRecommendations, savedExecutorAccessToken } from '../lib/executorClient'
import { loadRecInputs, type RecInputs } from '../lib/recInputs'
import { recStatusByPool, type RecStatusEntry } from '../lib/recStatus'
import type { RecommendationMode } from '../../shared/recommendation/types'

export type RecStatusData = {
  /** the inputs the badges are priced at — surfaced so the rank tab can label them */
  inputs: RecInputs
  byPool: Map<string, RecStatusEntry>
}

/**
 * The recommender's current output, as seen from the POOL RANK tab: which
 * ranked pools are recommended, watchlisted or gated right now. Uses the same
 * saved read-only session as the recommender page and the same last-used
 * capital/risk basis, so the badge agrees with what the user saw there. The
 * executor caches responses for 5 minutes, so this costs one cache-hit per
 * mode — no extra model work.
 */
export function useRecStatusByPool() {
  const { address: user } = useAccount()
  const token = savedExecutorAccessToken(user)
  return useQuery({
    queryKey: ['rec-status', CHAIN.key, user?.toLowerCase() ?? ''],
    enabled: token !== '',
    retry: 1,
    staleTime: 4 * 60_000,
    refetchInterval: 5 * 60_000,
    queryFn: async (): Promise<RecStatusData> => {
      const inputs = loadRecInputs(CHAIN.key)
      const modes: RecommendationMode[] = ['fees', 'rewards']
      const responses = await Promise.all(modes.map((mode) =>
        executorRecommendations(token, { capitalUsd: inputs.capitalUsd, mode, risk: inputs.risk, limit: 10 })))
      return { inputs, byPool: recStatusByPool({ fees: responses[0], rewards: responses[1] }) }
    },
  })
}
