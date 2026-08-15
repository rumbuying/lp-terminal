import { ADDR, GOV, NATIVE } from '../config/addresses'
import { CHAIN } from '../config/chains'
import { identityKey } from '../config/chains/knownTokens'
import type { TokenInfo } from '../types'

/**
 * The chain's own coin and its dollar, described without asking anyone.
 *
 * The swap form normally picks its sides out of the discovered token list, but
 * the trade panel beside a market has to open on a specific input the moment a
 * row is clicked — before that list has necessarily loaded, and for a token
 * that may be minutes old and in no catalog yet. Both of these are declared in
 * the chain config, so they need no discovery to be described.
 */
export const NATIVE_TOKEN: TokenInfo = {
  address: NATIVE,
  symbol: CHAIN.nativeCurrency.symbol,
  decimals: CHAIN.nativeCurrency.decimals,
  native: true,
}

export const STABLE_TOKEN: TokenInfo = {
  address: ADDR.STABLE,
  symbol: CHAIN.stable.symbol,
  decimals: CHAIN.stable.decimals,
}

/**
 * What to spend when buying `buy`.
 *
 * The native coin, which is what somebody arriving at a market already holds —
 * except when the market IS the native coin or its wrapper, where spending it
 * would name the same asset on both sides (or quietly turn the form into a
 * wrap). The chain's dollar takes over there.
 */
export function spendSideFor(buy: TokenInfo | null): TokenInfo {
  if (!buy) return NATIVE_TOKEN
  const a = buy.address.toLowerCase()
  const isCoin = !!buy.native || a === NATIVE.toLowerCase() || a === ADDR.WNATIVE.toLowerCase()
  return isCoin ? STABLE_TOKEN : NATIVE_TOKEN
}

/**
 * The chain's own assets, in the order the picker leads with them. Everything
 * else sorts by symbol behind these.
 */
export const PICKER_PINNED: readonly string[] = [
  NATIVE,
  ADDR.WNATIVE,
  ...(GOV ? [GOV.UP] : []),
  ADDR.STABLE,
].map((a) => a.toLowerCase())

/**
 * One row per coin, from however many catalogs discovered them.
 *
 * The coin itself is always present and always first, described from the chain
 * config rather than waiting on a catalog. Later sources overwrite earlier
 * ones under the same identity, which is what lets a discovered token carry
 * better metadata than a pinned stub.
 *
 * THE FOLD IS THE POINT. A v4 catalog reports the chain's coin as
 * `address(0)`, so merging by raw address put a SECOND coin in the picker —
 * one wearing the ⚠ mark, and carrying an address no wallet will spend, since
 * the balance and swap paths know the coin only as the sentinel. Keying on
 * `identityKey` folds the two names, and the folded row is re-addressed to the
 * sentinel so what the form receives is spendable.
 */
export function mergeSwapTokens(
  sources: ReadonlyArray<Record<string, TokenInfo> | undefined>,
  pinned: readonly string[] = PICKER_PINNED,
): TokenInfo[] {
  const nativeKey = identityKey(NATIVE)
  const map = new Map<string, TokenInfo>([[nativeKey, NATIVE_TOKEN]])
  for (const source of sources)
    for (const [address, token] of Object.entries(source ?? {})) {
      const key = identityKey(address)
      map.set(key, key === nativeKey ? { ...token, address: NATIVE, native: true } : token)
    }

  // everything unpinned ranks equal, and equal ranks fall through to the symbol
  const rank = (t: TokenInfo) => {
    const i = pinned.indexOf(t.address.toLowerCase())
    return i === -1 ? pinned.length : i
  }
  return [...map.values()].sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol))
}

/** Pick the first preferred output that is present and differs from the input. */
export function defaultSwapOutput(
  tokens: readonly TokenInfo[],
  input: TokenInfo | null,
  preferredAddresses: readonly string[],
): TokenInfo | null {
  const inputAddress = input?.address.toLowerCase()
  const byAddress = new Map(tokens.map((token) => [token.address.toLowerCase(), token]))

  for (const address of preferredAddresses) {
    const token = byAddress.get(address.toLowerCase())
    if (token && token.address.toLowerCase() !== inputAddress) return token
  }

  return tokens.find((token) => token.address.toLowerCase() !== inputAddress) ?? null
}
