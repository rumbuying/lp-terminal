// Where a token came from, asked of the chain instead of of its name.
//
// The check itself lives in src/lib/stockToken.ts and is shared verbatim with
// the browser — deliberately, because the browser re-runs it on every row it
// displays and the two answers have to be the same answer. What this file adds
// is the part a browser cannot do: sweeping a whole catalog, once, and
// remembering.
//
// It exists because the pools page could only ever filter what it had already
// fetched. A stock chip narrowed one page of results rather than the catalog,
// so "bStock" showed four markets — the four that happened to be on that page.
// Deciding membership here is what lets the query ask for the right rows.
//
// WHY IT IS BOUNDED BY LIQUIDITY: a share is identified by its proxy, so there
// is no symbol to search for and no shortlist to work from — every token is a
// candidate until it is measured. 18,000 of them is not a sweep with an end.
// The floor is the one the pool list already hides below, which is what makes
// it safe: a token too shallow to be probed is too shallow to be on screen.
import type { Address } from 'viem'
import { readStockIssuer } from '../src/lib/stockToken'
import { CHAIN, log } from './config'
import { pc, safeError } from './rpc'
import { recordStockToken, unmeasuredStockCandidates } from './store'
import { admitV4Token } from './v4Rpc'

const ANCHORS = CHAIN.stockIssuers

/**
 * The same $1k the pool list draws as its dust line, and for the same reason.
 * Below it a token is neither browsable nor worth an RPC read.
 */
export const STOCK_PROBE_MIN_DEPTH_USD = 1_000

/** How many reads may be in flight at once — one slot each, so this is gentle. */
const CONCURRENCY = 8

export type StockSweep = {
  /** answered by the chain, either way */
  measured: number
  /** of those, the ones an issuer's proxy anchor claims */
  proven: number
  /** reads that failed; deliberately left with no answer on file */
  unread: number
  /** v4 pools admitted to the directory by the shares this sweep proved */
  admitted: number
}

/**
 * Ask the chain about the next batch of unmeasured tokens, deepest first.
 *
 * A failed read records nothing. That is the whole reason this cannot simply
 * treat an error as "no issuer": the answer is cached forever, so one dropped
 * packet would leave a genuine share permanently unmarked, sitting in a list
 * beside the impersonators it exists to be distinguished from. Leaving it
 * unmeasured costs one retry on the next tick.
 */
export async function sweepStockOrigins(limit: number): Promise<StockSweep> {
  const empty: StockSweep = { measured: 0, proven: 0, unread: 0, admitted: 0 }
  if (!ANCHORS.length || limit <= 0) return empty

  const addresses = unmeasuredStockCandidates(STOCK_PROBE_MIN_DEPTH_USD, limit)
  if (!addresses.length) return empty

  const result = { ...empty }
  const admitted: string[] = []
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, addresses.length) }, async () => {
      for (let i = next++; i < addresses.length; i = next++) {
        const address = addresses[i] as Address
        try {
          const issuer = await readStockIssuer(pc, address, ANCHORS)
          recordStockToken(address, issuer)
          result.measured++
          if (issuer) {
            result.proven++
            admitted.push(address)
          }
        } catch {
          result.unread++
        }
      }
    }),
  )

  // A share was minted long before anything here read its proxy, so proving it
  // widens the v4 directory BACKWARDS: its pools were skipped on the day they
  // were created and nothing else will ever look at them again. This is where
  // that history is claimed, one token at a time and only for tokens that just
  // became members. See v4Rpc.admitV4Token for why it is two log queries and
  // not a rescan.
  for (const address of admitted) {
    try {
      result.admitted += await admitV4Token(address)
    } catch (e) {
      // The proof is recorded either way. A failed backfill costs this token
      // its historical v4 pools until something scans again, and must not undo
      // the answer the chain already gave about who issued it.
      log(`[stock] v4 backfill failed for ${address}:`, safeError(e))
    }
  }
  return result
}

/** One sweep, logged, never fatal — the catalog is useful without this answer. */
export async function runStockOriginSweep(limit: number): Promise<StockSweep> {
  try {
    const swept = await sweepStockOrigins(limit)
    if (swept.measured || swept.unread)
      log(
        `[stock] ${swept.measured} tokens measured, ${swept.proven} issued` +
          (swept.admitted ? `, +${swept.admitted} v4 pools admitted` : '') +
          (swept.unread ? `, ${swept.unread} unread (retried next tick)` : ''),
      )
    return swept
  } catch (e) {
    log('[stock] origin sweep failed:', safeError(e))
    return { measured: 0, proven: 0, unread: 0, admitted: 0 }
  }
}
