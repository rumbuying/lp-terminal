// Venue USD pricing from dexscreener pair rows (pure — fetch lives in poolstats).
// Why not an aggregator unit-quote: selling 1 token routes through whichever
// venue shows the best mid, and on a thin chain that is systematically a stale
// dust pool nobody arbitrages (measured on UP: kyber $0.150 via an $8-liquidity
// v4 pool vs $0.140 on the two $250k pools). Every token except ETH ran high.
// The most-liquid pair's trade-derived price is the honest mark.

import { CHAIN } from '../config/chains'

export type DsPair = {
  chainId?: string
  priceUsd?: string | number
  priceNative?: string | number
  liquidity?: { usd?: number | string }
  baseToken?: { address?: string }
  quoteToken?: { address?: string }
}

/** dust pools sit at stale prices — never price a token off one */
export const DS_MIN_LIQ_USD = 100

/** USD price of `token` from its most-liquid pair on this chain, or null when no
 *  pair above the dust floor prices it. Quote-side tokens derive via
 *  priceUsd / priceNative (USD per quote unit). */
export function pickDsTokenUsd(pairs: DsPair[], token: string): number | null {
  const t = token.toLowerCase()
  let best: { liq: number; price: number } | null = null
  for (const p of pairs) {
    if (p?.chainId !== CHAIN.slugs.dexscreener) continue
    const liq = Number(p?.liquidity?.usd)
    if (!Number.isFinite(liq) || liq < DS_MIN_LIQ_USD) continue
    const pu = Number(p?.priceUsd)
    const pn = Number(p?.priceNative)
    let price: number | null = null
    if (p?.baseToken?.address?.toLowerCase() === t && pu > 0) price = pu
    else if (p?.quoteToken?.address?.toLowerCase() === t && pu > 0 && pn > 0) price = pu / pn
    if (price !== null && (!best || liq > best.liq)) best = { liq, price }
  }
  return best?.price ?? null
}
