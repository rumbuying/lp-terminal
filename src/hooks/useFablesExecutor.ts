import { useQuery } from '@tanstack/react-query'
import { executorFablesStrategies } from '../lib/executorClient'

/** The executor's Fables strategy list on a 15s cadence. Multiple observers
 *  (overview totals, strategy cards) share one query. */
export function useFablesExecutorStrategies(accessToken: string | undefined) {
  return useQuery({
    queryKey: ['fables-executor-strategies', accessToken ? 'authed' : 'anon'],
    enabled: !!accessToken,
    refetchInterval: 15_000,
    staleTime: 10_000,
    retry: 2,
    queryFn: () => executorFablesStrategies(accessToken!),
  })
}
