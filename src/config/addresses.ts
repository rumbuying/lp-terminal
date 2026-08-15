import type { Address } from 'viem'
import { CHAIN } from './chains'
import type { GovAddresses } from './chains'

/**
 * Façade over the active chain's configuration (config/chains/).
 *
 * These are the names the app has always imported; the per-chain modules are
 * where the values live. Which chain answers is settled once, at startup, from
 * the link / this browser / the build, in that order — see config/chains/index.ts.
 * Every export below is therefore a module constant for the life of the page,
 * and switching chains is a page load.
 */

export const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as Address

/** the buy side the swap tab opens on — pinned by address, never by symbol */
export const DEFAULT_BUY = CHAIN.defaultBuy

/** the chain's home DEX: UP33 on Robinhood, PancakeSwap on BSC */
export const ADDR = CHAIN.addr

/** the official Uniswap deployment on this chain */
export const UNI = CHAIN.uni

/**
 * ve(3,3) governance, or null on a chain that has none. Read it through
 * `requireGov()` inside modules that only run when FEATURES.emissions is true.
 */
export const GOV: GovAddresses | null = CHAIN.gov

export function requireGov(): GovAddresses {
  if (!CHAIN.gov) throw new Error(`${CHAIN.key} has no ve(3,3) protocol`)
  return CHAIN.gov
}

/** intermediate hops tried when no direct pool exists */
export const CONNECTORS = CHAIN.connectors

export const EXPLORER = CHAIN.explorer.url
export const WEEK = CHAIN.week
export const CHAIN_ID = CHAIN.id
