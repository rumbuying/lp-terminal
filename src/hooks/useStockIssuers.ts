import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import { isAddress, type Address } from 'viem'
import { CHAIN_ID } from '../config/addresses'
import { CHAIN } from '../config/chains'
import type { StockIssuerId } from '../config/chains/stockIssuers'
import { readStockIssuer } from '../lib/stockToken'

/** what a token turned out to be, or `null` once proven to be nobody's */
export type StockIssuerMap = ReadonlyMap<string, StockIssuerId>

const NONE: StockIssuerMap = new Map()

/**
 * Which of these tokens the chain itself vouches for, and for whom.
 *
 * The answer is a property of the deployed contract and cannot change while
 * this tab is open — a contract's runtime code is fixed and its ERC-1967 anchor
 * is written once at construction — so every query here is permanently fresh.
 * A token verified on the POOLS tab is already answered when the same token
 * appears in SWAP.
 *
 * One query per ADDRESS rather than one per list: the caller's list churns with
 * every filter keystroke and sort, while an address's answer never does. Keying
 * on the address means a re-filter re-reads nothing, and the transport folds
 * whatever genuinely is new into a single batched request.
 *
 * Addresses are deduplicated because pairs share sides — a pools page carrying
 * 150 rows names far fewer than 300 distinct tokens, and USDT alone appears in
 * most of them.
 */
export function useStockIssuers(addresses: readonly (string | undefined)[]): StockIssuerMap {
  const client = usePublicClient({ chainId: CHAIN_ID })
  const anchors = CHAIN.stockIssuers

  const unique = useMemo(() => {
    if (anchors.length === 0) return [] // nothing to prove on this chain
    const seen = new Set<string>()
    for (const a of addresses) {
      if (!a) continue
      const k = a.toLowerCase()
      if (isAddress(k, { strict: false })) seen.add(k)
    }
    return [...seen].sort() // stable order keeps the query set from resubscribing
  }, [addresses, anchors])

  const results = useQueries({
    queries: unique.map((address) => ({
      queryKey: ['stockIssuer', CHAIN.key, address],
      enabled: !!client,
      // The chain cannot change its mind about this, so neither do we.
      staleTime: Infinity,
      gcTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      // Load-bearing against the infinite cache above. `readStockIssuer`
      // REJECTS on a failed read rather than returning "no issuer", so a
      // dropped packet lands in error state — retried, and never written into a
      // cache that has no expiry. Were it to resolve `null` instead, one
      // transient failure would leave a genuine share unmarked for the whole
      // session, which is precisely the claim the mark's absence makes.
      retry: 2,
      queryFn: () => readStockIssuer(client!, address as Address, anchors),
      meta: { excludeFromTransactionInvalidation: true },
    })),
  })

  return useMemo(() => {
    if (unique.length === 0) return NONE
    const map = new Map<string, StockIssuerId>()
    results.forEach((r, i) => {
      if (r.data) map.set(unique[i], r.data)
    })
    return map
    // `results` is a fresh array each render; its useful content is the data,
    // which only moves when a query settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unique, results.map((r) => r.data ?? '').join(',')])
}

/** the issuer for one token, for surfaces that only ever show one at a time */
export function useStockIssuer(address: string | undefined): StockIssuerId | null {
  const one = useMemo(() => [address], [address])
  const map = useStockIssuers(one)
  return address ? (map.get(address.toLowerCase()) ?? null) : null
}

/**
 * Both sides of a pair — what a pool row, a position card and the swap form all
 * actually need.
 *
 * Called per ROW rather than once over the whole catalog, and that is a cost
 * decision as much as a structural one: work is then proportional to the rows
 * that exist, so nothing is spent on a catalog page the user paged past and
 * nothing has to be capped (a cap would silently leave real stock rows
 * unmarked, which reads as "this one is fake"). Rows sharing a token — and on a
 * stablecoin-quoted table that is most of them — share the one query behind it.
 */
export function useStockIssuerPair(
  token0: string | undefined,
  token1: string | undefined,
): [StockIssuerId | null, StockIssuerId | null] {
  const pair = useMemo(() => [token0, token1], [token0, token1])
  const map = useStockIssuers(pair)
  return [
    token0 ? (map.get(token0.toLowerCase()) ?? null) : null,
    token1 ? (map.get(token1.toLowerCase()) ?? null) : null,
  ]
}
