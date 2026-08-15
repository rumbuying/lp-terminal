import { zeroAddress, type Address } from 'viem'
import { CHAIN, type ChainConfig } from '../config/chains'
import { NATIVE_SENTINEL } from '../config/chains/knownTokens'

/**
 * Which side of a pair is the market, and which is what it is priced in.
 *
 * A pool is symmetric and the chain has no opinion — token0 and token1 are just
 * the two addresses in sorted order. A trader does have one: "SPCX/USDG" is a
 * market in SPCX, and USDG is the money. Everything the revamped POOLS page
 * does with a row depends on knowing which is which — which picture leads, which
 * token the swap form buys, which symbol names the row.
 *
 * The ranking is over the chain's OWN quote assets, in the order that makes
 * something quote-like: its dollar first, then its native coin and the wrapper
 * that stands in for it, then the connectors routing already hops through, then
 * any symbol the chain reserves. A token in none of those is a market, and
 * scores zero — which is the common case and the one this exists for.
 *
 * When both sides are quote assets the deeper-quote one becomes the quote, so
 * WETH/USDG reads as a WETH market rather than a USDG one. When NEITHER is, the
 * pair is two long-tail tokens and there is nothing to prefer, so token0 leads
 * and the answer stays stable across renders and reloads rather than being
 * decided by whichever list arrived first.
 */
export type QuoteAssets = {
  stable: Address
  wrappedNative: Address
  native: Address
  connectors: readonly Address[]
  reserved: readonly Address[]
}

export function quoteRank(token: string, assets: QuoteAssets): number {
  const a = token.toLowerCase()
  const eq = (b: string) => b.toLowerCase() === a
  if (eq(assets.stable)) return 4
  // The chain's coin answers to two names. v4 keys it as `address(0)` and pools
  // it directly (lib/uniV4.ts); everywhere else it is the 0xEeee… sentinel.
  // They are one asset, and a v4 ETH/<token> pool that failed to recognise its
  // own native side would call the COIN the market and the token the money.
  if (a === zeroAddress || eq(assets.native) || eq(assets.wrappedNative)) return 3
  if (assets.connectors.some(eq)) return 2
  if (assets.reserved.some(eq)) return 1
  return 0
}

/** 0 when token0 is the market, 1 when token1 is */
export function tradedSide(token0: string, token1: string, assets: QuoteAssets): 0 | 1 {
  return quoteRank(token1, assets) < quoteRank(token0, assets) ? 1 : 0
}

/** one chain's quote assets, read off its config rather than restated */
export function quoteAssetsOf(config: ChainConfig): QuoteAssets {
  return {
    stable: config.addr.STABLE,
    wrappedNative: config.addr.WNATIVE,
    native: NATIVE_SENTINEL,
    connectors: config.connectors,
    reserved: config.knownTokens.map((k) => k.address),
  }
}

/** the active chain's own quote assets — the argument every caller passes */
export const CHAIN_QUOTES: QuoteAssets = quoteAssetsOf(CHAIN)

/** `tradedSide` against the active chain */
export const pairSide = (token0: string, token1: string): 0 | 1 =>
  tradedSide(token0, token1, CHAIN_QUOTES)

/** the pair re-read as (market, money) */
export function orientPair<T>(token0: T, token1: T, side: 0 | 1): { target: T; quote: T } {
  return side === 0 ? { target: token0, quote: token1 } : { target: token1, quote: token0 }
}
