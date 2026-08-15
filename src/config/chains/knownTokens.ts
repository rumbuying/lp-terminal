import { zeroAddress, type Address } from 'viem'

/**
 * The tokens whose SYMBOL is worth more than the token itself.
 *
 * A ticker is not owned by anybody, so "USDC" is a string any deployer can put
 * in their contract — and on BSC three of them do, alongside the real one.
 * Measured 2026-08-04 through the terminal's own catalog: USDC's genuine
 * deployment carries 6,105 pools and its three namesakes carry 40, 18 and 16;
 * USDT's carries 253,561 against namesakes with 78 and 67; WBNB's carries 2.4
 * million against 50, 44 and 8. On Robinhood Chain WETH's carries 387,119
 * against 109, 5 and 1.
 *
 * Listing the real address is what lets a name be checked instead of believed.
 * The claim made from this list is narrow and factual — this token calls itself
 * X, and the X on this chain is a different contract — so it is stated about
 * the ADDRESS and never about the deployer's intent. Plenty of tokens collide
 * with a ticker by accident.
 *
 * WHAT DOES NOT BELONG HERE, and why the list is short:
 *
 *  - A symbol with no unambiguous owner on the chain. BSC has a real "Wrapped
 *    Ether" at 0x4db5a66e with 105 pools and a correct price, distinct from
 *    Binance-pegged ETH — so WETH is deliberately unreserved there, because
 *    reserving it would flag a genuine token. Robinhood Chain has no canonical
 *    USDC or USDT at all (every claimant has one or two pools and no price),
 *    so neither is reserved and neither claimant is accused of anything.
 *  - Tokenized equities. Those are PROVEN from the issuer's own contract
 *    (stockIssuers.ts), which beats comparing an address against a list, and a
 *    list of every ticker on the market would go stale the day it was written.
 *
 * The bar for an entry is that the honest answer to "which one is the real X"
 * is a single address. Where it is not, nothing is reserved and nothing is
 * claimed — an unreserved symbol simply carries no opinion, which is the same
 * position the terminal took before this list existed.
 */
export type KnownToken = {
  /** the symbol as the token itself reports it, verbatim from `symbol()` */
  symbol: string
  /** the one contract that symbol means on this chain; NATIVE for the coin */
  address: Address
  /** cross-checked by scripts/chain-check.ts, so a mistyped address is caught */
  decimals: number
  /**
   * A picture for the one token that symbol means — optional, and only here.
   *
   * This list is already the answer to "which contract is the real X", so it is
   * the one place a logo can be attached to an address without asserting
   * anything new: the entry says which token it is, and the picture just shows
   * it. Every other token's image has to come from the token itself or from its
   * proven issuer, never from a lookup table keyed on a name.
   *
   * Absent is a fine state — the avatar falls back to the symbol's own letters,
   * and so does a URL that stops resolving. Nothing reads this except display.
   */
  logo?: string
}

/**
 * A logo on CoinGecko's image CDN, named by the path its own API returns.
 *
 * Written as a helper so the host appears once: every entry below is a path
 * copied verbatim from a lookup of that exact contract address, and the origin
 * is not something an entry gets to choose. The trailing cache-buster is part
 * of the path CoinGecko publishes — kept, not trimmed, because the URL without
 * it is not the URL that was checked.
 */
export const CG = (path: string) => `https://coin-images.coingecko.com/coins/images/${path}`

/**
 * Native-coin sentinel, mirroring config/addresses.ts.
 *
 * Restated rather than imported: this module is read by the chain configs
 * themselves, and addresses.ts is derived FROM those, so importing it here
 * would close a cycle. The chain-check guard asserts the two agree.
 */
export const NATIVE_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as Address

/**
 * The key an identity question is filed under.
 *
 * The chain's coin answers to two names. A v4 PoolKey calls it `address(0)`;
 * every list that can say what a token IS — the reserved symbols above, the
 * logos beside them, the swap picker — is keyed on the sentinel. Asking one
 * about the other gets back "unknown contract", which is how the real BNB, in
 * a real canonical BNB pool, came to be marked as not being BNB.
 *
 * The fold belongs here rather than at each caller because an address-keyed
 * lookup has no legitimate question to ask about `address(0)`: there is no
 * contract there to have an identity, so every such lookup wants the coin.
 * Teaching the call sites instead is the approach that already failed — one of
 * them was a half-remembered version of it sitting under its own explanatory
 * comment.
 *
 * POOL DATA IS THE OPPOSITE and keeps the zero: it is the value the PoolKey
 * hashes, a native-keyed pool is a different pool from its wrapped twin, and
 * naming it with the sentinel would name no pool at all.
 *
 * Lowercase, because every map and comparison downstream is.
 */
export function identityKey(address: string): string {
  const key = address.toLowerCase()
  return key === zeroAddress ? NATIVE_SENTINEL.toLowerCase() : key
}
