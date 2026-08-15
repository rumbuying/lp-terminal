import { identityKey, type KnownToken } from '../config/chains/knownTokens'

/**
 * Is this token wearing a symbol that belongs to a different contract?
 *
 * Returns the token it is claiming to be, or null. The comparison is exact and
 * case-insensitive: exact because `Cake-LP` and `USDT.z` are honest, distinct
 * names that a prefix or substring test would wrongly accuse, and
 * case-insensitive because impersonation routinely varies only in case
 * (`AAPLx` against `AAPLX`, `NVDAB` against `NVDAB`, and PancakeSwap's own
 * token spells itself `Cake`).
 *
 * WHAT THIS DOES NOT KNOW. It reads a name against a list, which is a far
 * weaker instrument than the issuer proof in `stockToken.ts` — that one derives
 * an answer from the contract's own bytecode, while this one can only say the
 * name is taken. Two consequences worth stating rather than papering over:
 *
 *  - A token can be perfectly honest and still match. Colliding on a ticker is
 *    not fraud, and the wording this feeds must accuse nobody: the fact is
 *    "this symbol belongs to a different address on this chain", and intent is
 *    not ours to report.
 *  - A near-miss slips through completely. A symbol built from lookalike
 *    characters — a Cyrillic С, or the live BSC token calling itself `BNB𝕏` —
 *    is a different string and matches nothing here. Folding confusables would
 *    widen the net and would also start catching honest names, so the gap is
 *    left open and known rather than closed badly.
 *
 * A symbol absent from the list carries NO opinion in either direction. Most
 * tokens are not impersonating anything, and silence is the right answer for
 * them; see knownTokens.ts for why the list is deliberately short.
 *
 * The address is folded through `identityKey` before it is compared, so a v4
 * pool naming the chain's coin `address(0)` is measured as the coin. Without
 * that, the reserved entry for BNB — which is filed under the sentinel — makes
 * the genuine coin, in a canonical native-keyed pool, the loudest impostor on
 * the page.
 */
export function squattedSymbol(
  known: readonly KnownToken[],
  token: { symbol: string; address: string },
): KnownToken | null {
  const symbol = token.symbol.trim().toLowerCase()
  if (!symbol) return null
  const address = identityKey(token.address)
  for (const k of known) {
    if (k.symbol.toLowerCase() !== symbol) continue
    // the real one wearing its own name is the whole point of the list
    return k.address.toLowerCase() === address ? null : k
  }
  return null
}

/** does either side of this pair wear a name it does not own? */
export function pairSquats(
  known: readonly KnownToken[],
  token0: { symbol: string; address: string },
  token1: { symbol: string; address: string },
): boolean {
  return squattedSymbol(known, token0) !== null || squattedSymbol(known, token1) !== null
}
