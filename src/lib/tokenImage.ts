import { STOCK_ISSUERS, type StockIssuerId } from '../config/chains/stockIssuers'
import { identityKey, type KnownToken } from '../config/chains/knownTokens'
import type { LaunchpadToken } from './launchpadToken'

/**
 * A picture for a token, and the three places one is allowed to come from.
 *
 * A logo is a claim about identity, and it is a stronger claim than a symbol —
 * a string can at least be read, while a picture is recognised before it is
 * questioned. So the rule here is the same one the rest of the terminal keeps
 * about names: nothing is shown because a third party said so about a ticker.
 * An image is rendered only when something that has already been PROVEN about
 * the address supplies it.
 *
 *   1. The token's own `tokenURI` document, once the launchpad factory's CREATE2
 *      derivation has proven the token is that factory's (lib/launchpadToken.ts).
 *   2. The issuer's own CDN, once the token's bytecode and ERC-1967 anchor have
 *      proven which issuer minted it (lib/stockToken.ts).
 *   3. The chain's reserved-symbol list, which is already a statement that this
 *      exact address is the one right answer for that symbol.
 *
 * Anything else gets no picture. That silence is the same deliberate silence
 * TokenIdentity keeps: on a chain where twenty tokens call themselves CASHCAT,
 * a logo beside nineteen of them would be worse than none beside any.
 *
 * The URL still gets treated as hostile even so — it is about to become an
 * `<img src>`, and case (1) is written by whoever deployed the token.
 */

/** the gateway an `ipfs://` image is read through */
const IPFS_GATEWAY = 'https://ipfs.io/ipfs/'

/** CIDv0 (`Qm…`) or CIDv1 (base32, `b…`), and nothing exotic after it */
const IPFS_PATH = /^(?:ipfs:\/\/)?(?:ipfs\/)?((?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})(?:\/[\w.\-/]*)?)$/

/** an inline picture the document carries itself — no origin to reach at all */
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/

/**
 * The `https:` URL this image URI resolves to, or null when it resolves to
 * nothing we are willing to point a browser at.
 *
 * Deliberately narrow. `ipfs://` is rewritten onto one fixed gateway; a plain
 * `https:` URL passes; an inline `data:image` passes. Everything else — `http:`,
 * `javascript:`, protocol-relative `//host`, an unrecognised scheme, an empty
 * string — returns null and the caller renders the monogram instead. A token
 * gets to supply a picture, never a destination.
 */
export function resolveImageUri(uri: string | undefined): string | null {
  const raw = (uri ?? '').trim()
  if (!raw) return null
  if (DATA_IMAGE.test(raw)) return raw
  const ipfs = IPFS_PATH.exec(raw)
  if (ipfs) return IPFS_GATEWAY + ipfs[1]
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/** everything already known about a token's identity when its avatar renders */
export type TokenImageSources = {
  address: string
  issuer?: StockIssuerId | null
  launchpad?: LaunchpadToken | null
  knownTokens: readonly KnownToken[]
}

/**
 * The image for one token, or null where nothing has earned the right to show
 * one. Order is by strength of proof, and each source is asked about the exact
 * address rather than about the symbol.
 */
export function tokenImageUrl(src: TokenImageSources): string | null {
  const fromLaunchpad = resolveImageUri(src.launchpad?.image)
  if (fromLaunchpad) return fromLaunchpad

  const issuerLogo = src.issuer ? STOCK_ISSUERS[src.issuer].logo : undefined
  if (issuerLogo) {
    const fromIssuer = resolveImageUri(issuerLogo(src.address))
    if (fromIssuer) return fromIssuer
  }

  // The coin's own entry is filed under the sentinel, and a v4 pool hands this
  // its currency — `address(0)` on the native side. Same address, same logo.
  const addr = identityKey(src.address)
  const known = src.knownTokens.find((k) => k.address.toLowerCase() === addr)
  return known?.logo ? resolveImageUri(known.logo) : null
}

/**
 * The letters a token falls back to, and the hue they sit on.
 *
 * Derived from the ADDRESS, not the symbol: two tokens wearing one name are
 * exactly the case a monogram must not make look identical, and the address is
 * the only part of them that differs. The letters still come from the symbol —
 * they are a label, not a credential.
 */
export function monogram(symbol: string): string {
  const clean = symbol.replace(/[^\p{L}\p{N}]/gu, '')
  return (clean || symbol || '?').slice(0, 2).toUpperCase()
}

export function monogramHue(address: string): number {
  let h = 0
  for (const ch of address.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}
