// Outbound links to a pair's DexScreener chart.
//
// This is the app's only navigation to a third-party origin whose path is built
// from data the app did not author — pool addresses arrive from the indexer API
// and from chain reads — so the URL is assembled defensively:
//
//   · origin and chain slug are compile-time constants, so no field of any API
//     response can move where the link points;
//   · the one variable segment must be exactly a 20-byte hex address or the
//     builder returns null and the caller renders no link at all. That rejects
//     `javascript:`/`data:` payloads, protocol-relative `//evil.tld`, path
//     traversal, and the `?` / `#` / `@` tricks that re-target a URL by
//     appending to it;
//   · the segment is percent-encoded anyway. A no-op for valid hex, but it
//     keeps the guarantee if anyone ever loosens the pattern.
//
// Callers render the result as a real <a rel="noreferrer noopener">, never
// window.open() or a location assignment: the browser gets to apply its own
// scheme checks, the target page gets no Referer (these URLs sit beside a
// connected wallet) and no window.opener handle back into this tab.

/** dexscreener's chain slug for Robinhood Chain — the same one every API path
 *  in lib/poolstats.ts and lib/uniBrowse.ts already uses */
const DS_PAIR_BASE = 'https://dexscreener.com/robinhood/'

/** a 20-byte hex address and nothing else: no whitespace, prefix or tail */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** DexScreener pair page for `pool`, or null when `pool` is not an address */
export function dsPairUrl(pool: string): string | null {
  if (!ADDRESS.test(pool)) return null
  return DS_PAIR_BASE + encodeURIComponent(pool)
}
