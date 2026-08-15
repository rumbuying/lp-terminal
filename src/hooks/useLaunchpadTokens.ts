import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import { isAddress, type Address, type PublicClient } from 'viem'
import { CHAIN_ID } from '../config/addresses'
import { CHAIN } from '../config/chains'
import { readLaunchpadToken, type LaunchpadToken } from '../lib/launchpadToken'

/** what a token turned out to be, or absent once proven to be nobody's */
export type LaunchpadTokenMap = ReadonlyMap<string, LaunchpadToken>

/**
 * The proofs so far, and the two ways an answer can be missing.
 *
 * Absence is ambiguous, and the filter built on this HIDES rows — so the two
 * ambiguities are reported rather than collapsed into "not proven":
 *
 *  · `pending` — still asking. Without it, "no launchpad markets here" and
 *    "the reads are in flight" render as the same empty table.
 *  · `unread` — asked, and the read failed after its retries. This is the
 *    dangerous one: `readLaunchpadToken` throws rather than returning null
 *    precisely so a dropped packet is not mistaken for a measurement, and a
 *    caller that then hid the row anyway would have thrown that away. A rule
 *    that EXCLUDES on the absence of proof must fail open on these.
 */
export type LaunchpadProofs = {
  proven: LaunchpadTokenMap
  pending: number
  /** lowercased addresses whose proof could not be read at all */
  unread: ReadonlySet<string>
}

const NONE: LaunchpadTokenMap = new Map()
const NO_UNREAD: ReadonlySet<string> = new Set()
const NOTHING: LaunchpadProofs = { proven: NONE, pending: 0, unread: NO_UNREAD }

/**
 * Which of these tokens the launchpad's own factory deployed, and what each one
 * says about itself.
 *
 * Cached with no expiry for the same reason `useStockIssuers` is: the answer is
 * a property of deployed code. A CREATE2 address cannot start belonging to a
 * different factory, and the metadata document is returned by a `pure` getter
 * reading immutables — so a token answered once is answered for the session, and
 * the same token appearing on another surface costs nothing.
 *
 * One query per ADDRESS rather than one per list, so a re-sort or a filter
 * keystroke re-reads nothing, and addresses are deduplicated because pairs share
 * sides — a page of launchpad markets is mostly the same quote token.
 */
export function useLaunchpadTokens(addresses: readonly (string | undefined)[]): LaunchpadProofs {
  const client = usePublicClient({ chainId: CHAIN_ID })
  const launchpad = CHAIN.launchpad

  const unique = useMemo(() => {
    if (!launchpad) return [] // nothing to prove on this chain
    const seen = new Set<string>()
    for (const a of addresses) {
      if (!a) continue
      const k = a.toLowerCase()
      if (isAddress(k, { strict: false })) seen.add(k)
    }
    return [...seen].sort() // stable order keeps the query set from resubscribing
  }, [addresses, launchpad])

  const results = useQueries({
    queries: unique.map((address) => ({
      queryKey: ['launchpadToken', CHAIN.key, address],
      enabled: !!client,
      staleTime: Infinity,
      gcTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      // Load-bearing against the cache above, exactly as in useStockIssuers:
      // `readLaunchpadToken` REJECTS on a failed read rather than reporting "not
      // a launchpad token", so a dropped packet is retried instead of being
      // written into a cache with no expiry. Were it to resolve null, one
      // transient failure would hide a genuine market from its own filter for
      // the rest of the session.
      retry: 2,
      queryFn: () => readLaunchpadToken(client as PublicClient, address as Address, launchpad),
      meta: { excludeFromTransactionInvalidation: true },
    })),
  })

  const pending = results.reduce((n, r) => n + (r.isPending ? 1 : 0), 0)
  // one character per query: proven / measured-nobody / unread. This IS the
  // memo's input, so it is also what decides when the memo re-runs.
  const settled = results.map((r) => (r.data ? 'y' : r.isError ? '?' : 'n')).join('')

  return useMemo(() => {
    if (unique.length === 0) return NOTHING
    const map = new Map<string, LaunchpadToken>()
    const unread = new Set<string>()
    results.forEach((r, i) => {
      if (r.data) map.set(unique[i], r.data)
      else if (r.isError) unread.add(unique[i])
    })
    return { proven: map, pending, unread }
    // `results` is a fresh array each render; its useful content is which
    // queries have settled and what they said, and that only moves when one does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unique, pending, settled])
}

/** both sides of a pair — what a pool row and the trade panel beside it need */
export function useLaunchpadPair(
  token0: string | undefined,
  token1: string | undefined,
): [LaunchpadToken | null, LaunchpadToken | null] {
  const pair = useMemo(() => [token0, token1], [token0, token1])
  const { proven } = useLaunchpadTokens(pair)
  return [
    token0 ? (proven.get(token0.toLowerCase()) ?? null) : null,
    token1 ? (proven.get(token1.toLowerCase()) ?? null) : null,
  ]
}
