import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { usePublicClient } from 'wagmi'
import type { Address, PublicClient } from 'viem'
import { CHAIN_ID } from '../config/addresses'
import { swapFee } from '../config/env'
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

type SolverQueryState = { dataUpdateCount: number; errorUpdateCount: number }
type SolverQuery = { state: SolverQueryState }
const manualRefreshes = new WeakMap<object, number>()
const manualRefreshGate = new ManualRefreshGate()
const manualRefreshCount = (query: object): number => manualRefreshes.get(query) ?? 0
const canAutoRefreshSolver = (query: SolverQuery): boolean =>
  solverQuoteCanAutoRefresh(query.state, manualRefreshCount(query))

export type SolverQuoteResult = {
  quote: SolverQuote
  /** solver-reported full-size rate vs its same-block 1% executable fair price */
  impactBps: number | null
  /** share-weighted venue fee across the route — autoSlippage's volatility prior */
  venueFeeBps: number
}

export function useSolverQuote(tokenIn?: Address, tokenOut?: Address, amountIn?: bigint) {
  const queryClient = useQueryClient()
  const [, rerenderManualRefresh] = useState(0)
  const enabled =
    !!tokenIn &&
    !!tokenOut &&
    !!amountIn &&
    amountIn > 0n &&
    erc20Of(tokenIn).toLowerCase() !== erc20Of(tokenOut).toLowerCase()

  const queryKey = ['solverQuote', CHAIN_ID, tokenIn, tokenOut, amountIn?.toString()] as const
  const query = useQuery<SolverQuoteResult>({
    queryKey,
    enabled: (query) => enabled && canAutoRefreshSolver(query),
    refetchInterval: (query) =>
      solverQuoteRefetchInterval(query.state, manualRefreshCount(query)),
    refetchOnMount: canAutoRefreshSolver,
    refetchOnReconnect: canAutoRefreshSolver,
    retry: false,
    queryFn: async () => {
      // the slippageBps here only shapes minAmountOutNet, which display
      // ignores — execution re-quotes with the user's chosen tolerance
      const main = await fetchSolverQuote({
        tokenIn: tokenIn!,
        tokenOut: tokenOut!,
        amountIn: amountIn!,
        slippageBps: 50,
      })
      return {
        quote: main,
        impactBps: main.priceImpactBps,
        venueFeeBps: solverVenueFeeBps(main),
      }
    },
  })
  const queryRecord = queryClient.getQueryCache().find({ queryKey, exact: true })
  const manualRefetch: typeof query.refetch = async (options) => {
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
    ...query,
    refetch: manualRefetch,
    autoRefreshExhausted: queryRecord
      ? solverQuoteAutoRefreshExhausted(
          queryRecord.state,
          manualRefreshCount(queryRecord),
        )
      : false,
  }
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

  return useQuery({
    queryKey: [
      'directQuote',
      CHAIN_ID,
      tokenIn,
      tokenOut,
      amountIn?.toString(),
      up33State,
    ],
    enabled,
    refetchInterval: DIRECT_QUOTE_REFRESH_MS,
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
}
