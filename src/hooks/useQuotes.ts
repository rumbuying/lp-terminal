import { useQuery, useQueryClient, type QueryKey, type UseQueryResult } from '@tanstack/react-query'
import { useState } from 'react'
import { usePublicClient } from 'wagmi'
import type { Address, PublicClient } from 'viem'
import { CHAIN_ID } from '../config/addresses'
import { ENV, swapFee } from '../config/env'
import { FEATURES } from '../config/features'
import { erc20Of, quoteDirectCandidates } from '../lib/directSwap'
import { fetchSolverQuote, solverVenueFeeBps, type SolverQuote } from '../lib/solver'
import {
  ManualRefreshGate,
  SOLVER_QUOTE_REFRESH_MS,
  solverQuoteAutoRefreshExhausted,
  solverQuoteCanAutoRefresh,
  solverQuoteRefetchInterval,
} from '../lib/solverRefresh'
import { usePools } from './usePools'

export const DIRECT_QUOTE_REFRESH_MS = SOLVER_QUOTE_REFRESH_MS

type QuoteQueryState = { dataUpdateCount: number; errorUpdateCount: number }
type QuoteQuery = { state: QuoteQueryState }
const manualRefreshes = new WeakMap<object, number>()
const manualRefreshGate = new ManualRefreshGate()
const manualRefreshCount = (query: object): number => manualRefreshes.get(query) ?? 0
const canAutoRefresh = (query: QuoteQuery): boolean =>
  solverQuoteCanAutoRefresh(query.state, manualRefreshCount(query))

/**
 * The auto-refresh budget wiring shared by BOTH quote queries. Solver and
 * direct venues follow one freshness policy: a venue polling past the budget
 * on its own would quietly stand in for the frozen one, and the refresh CTA
 * (which waits for every usable quote to expire) could never appear. A manual
 * refetch is credited back so it spends none of the automatic budget, and
 * exhaustion is exposed for that CTA.
 */
function useBudgetedRefresh<TData, TError>(
  queryKey: QueryKey,
  query: UseQueryResult<TData, TError>,
  manualRefetchEnabled = true,
): { refetch: UseQueryResult<TData, TError>['refetch']; autoRefreshExhausted: boolean } {
  const queryClient = useQueryClient()
  const [, rerenderManualRefresh] = useState(0)
  const queryRecord = queryClient.getQueryCache().find({ queryKey, exact: true })
  const refetch: UseQueryResult<TData, TError>['refetch'] = async (options) => {
    // TanStack deliberately lets `refetch()` run disabled queries. Preserve the
    // chain capability/URL gate for manual refreshes too, otherwise a BSC tab
    // can still call a build-wide Robinhood solver override.
    if (!manualRefetchEnabled) return query
    const record = queryClient.getQueryCache().find({ queryKey, exact: true })
    if (!record) return query.refetch(options)

    return manualRefreshGate.run(record, async () => {
      const settledBefore = record.state.dataUpdateCount + record.state.errorUpdateCount
      const result = await query.refetch(options)
      const settledAfter = record.state.dataUpdateCount + record.state.errorUpdateCount
      if (settledBefore > 0 && settledAfter > settledBefore) {
        manualRefreshes.set(record, manualRefreshCount(record) + 1)
        rerenderManualRefresh((version) => version + 1)
      }
      return result
    })
  }
  return {
    refetch,
    autoRefreshExhausted: queryRecord
      ? solverQuoteAutoRefreshExhausted(queryRecord.state, manualRefreshCount(queryRecord))
      : false,
  }
}

export type SolverQuoteResult = {
  quote: SolverQuote
  /** solver-reported full-size rate vs its same-block 1% executable fair price */
  impactBps: number | null
  /** share-weighted venue fee across the route — autoSlippage's volatility prior */
  venueFeeBps: number
}

export function useSolverQuote(
  tokenIn?: Address,
  tokenOut?: Address,
  amountIn?: bigint,
  account?: Address,
) {
  const enabled =
    FEATURES.solver &&
    ENV.solverUrl.length > 0 &&
    !!tokenIn &&
    !!tokenOut &&
    !!amountIn &&
    amountIn > 0n &&
    erc20Of(tokenIn).toLowerCase() !== erc20Of(tokenOut).toLowerCase()

  const queryKey = [
    'solverQuote',
    CHAIN_ID,
    tokenIn,
    tokenOut,
    amountIn?.toString(),
    account,
  ] as const
  const query = useQuery<SolverQuoteResult>({
    queryKey,
    enabled: (query) => enabled && canAutoRefresh(query),
    refetchInterval: (query) =>
      solverQuoteRefetchInterval(query.state, manualRefreshCount(query)),
    refetchOnMount: canAutoRefresh,
    refetchOnReconnect: canAutoRefresh,
    retry: false,
    queryFn: async () => {
      // the slippageBps here only shapes minAmountOutNet, which display
      // ignores — execution re-quotes with the user's chosen tolerance
      const main = await fetchSolverQuote({
        tokenIn: tokenIn!,
        tokenOut: tokenOut!,
        amountIn: amountIn!,
        slippageBps: 50,
        // Connected users must rank a quote the solver has accepted for
        // execution. Disconnected browsing deliberately remains display-only.
        ...(account ? { recipient: account, sender: account } : {}),
      })
      return {
        quote: main,
        impactBps: main.priceImpactBps,
        venueFeeBps: solverVenueFeeBps(main),
      }
    },
  })
  const budgeted = useBudgetedRefresh(queryKey, query, enabled)
  return { ...query, ...budgeted }
}

export function useDirectQuote(tokenIn?: Address, tokenOut?: Address, amountIn?: bigint) {
  const client = usePublicClient({ chainId: CHAIN_ID })
  const pools = usePools()
  const up33State = pools.error ? 'up33-failed' : pools.data ? 'up33-ready' : 'up33-pending'
  const enabled =
    !!client &&
    !!tokenIn &&
    !!tokenOut &&
    !!amountIn &&
    amountIn > 0n &&
    erc20Of(tokenIn).toLowerCase() !== erc20Of(tokenOut).toLowerCase()

  const queryKey = [
    'directQuote',
    CHAIN_ID,
    tokenIn,
    tokenOut,
    amountIn?.toString(),
    up33State,
  ] as const
  const query = useQuery({
    queryKey,
    enabled: (query) => enabled && canAutoRefresh(query),
    refetchInterval: (query) =>
      solverQuoteRefetchInterval(query.state, manualRefreshCount(query)),
    refetchOnMount: canAutoRefresh,
    refetchOnReconnect: canAutoRefresh,
    retry: false,
    queryFn: () => {
      const fee = swapFee()
      return quoteDirectCandidates(
        client as PublicClient,
        pools.error ? null : (pools.data?.pools ?? null),
        tokenIn!,
        tokenOut!,
        amountIn!,
        fee.bps,
      )
    },
  })
  const budgeted = useBudgetedRefresh(queryKey, query)
  return { ...query, ...budgeted }
}
