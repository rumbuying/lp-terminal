import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { Address } from 'viem'
import { resolveIntent, type BridgeIntent } from '../config/bridge'
import { bridgeFee } from '../config/env'
import { quoteAcross } from '../lib/bridge/across'
import { quotePortal } from '../lib/bridge/portal'
import { quoteRelay } from '../lib/bridge/relay'
import type { BridgeProviderId, BridgeQuote } from '../lib/bridge/types'

// network providers per refresh; Relay's keyless budget is 50 quotes/min
export const BRIDGE_QUOTE_REFRESH_MS = 25_000

export type BridgeQuoteQueries = Record<BridgeProviderId, UseQueryResult<BridgeQuote>>

/** independent per-provider queries so the fast quote renders while the slow
 *  one (Across composed routes can take >30s) is still working. Only providers
 *  the discovered token route supports are enabled; the portal "quote" is a
 *  local 1:1 construction (no request, no refresh needed). */
export function useBridgeQuotes(intent: BridgeIntent | null, user?: Address): BridgeQuoteQueries {
  const leg = intent ? resolveIntent(intent) : null
  const on = (p: BridgeProviderId) => !!intent && intent.amount > 0n && intent.token.providers.includes(p)
  const baseKey = [
    intent?.dir,
    intent?.token.symbol,
    intent?.remote.chain.id,
    intent?.amount.toString(),
    user ?? 'anon',
  ]
  const relay = useQuery({
    queryKey: ['bridgeQuote', 'relay', ...baseKey],
    enabled: on('relay'),
    refetchInterval: BRIDGE_QUOTE_REFRESH_MS,
    retry: false,
    queryFn: ({ signal }) => quoteRelay(leg!, intent!.amount, bridgeFee(), user ?? null, signal),
  })
  const across = useQuery({
    queryKey: ['bridgeQuote', 'across', ...baseKey],
    enabled: on('across'),
    refetchInterval: BRIDGE_QUOTE_REFRESH_MS,
    retry: false,
    queryFn: ({ signal }) => quoteAcross(leg!, intent!.amount, bridgeFee(), user ?? null, signal),
  })
  const portal = useQuery({
    queryKey: ['bridgeQuote', 'portal', ...baseKey],
    enabled: on('portal'),
    staleTime: Infinity, // lossless 1:1 — nothing to refresh
    retry: false,
    queryFn: () => quotePortal(leg!, intent!.amount),
  })
  return { relay, across, portal }
}

/** higher destination output wins — same-token routes pay out the same asset,
 *  so the canonical 1:1 quote leads whenever it is available */
export function bestProvider(q: BridgeQuoteQueries, ids: BridgeProviderId[]): BridgeProviderId | null {
  let best: BridgeProviderId | null = null
  for (const id of ids) {
    const d = q[id].data
    if (!d) continue
    if (best === null || d.outputAmount > q[best].data!.outputAmount) best = id
  }
  return best
}
