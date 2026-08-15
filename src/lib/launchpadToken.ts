import type { Address, PublicClient } from 'viem'
import { launchpadFactoryAbi, launchpadTokenAbi } from '../abi'
import {
  launcherRelease,
  type LaunchpadConfig,
  type LaunchpadId,
  type LaunchpadReleaseId,
} from '../config/chains/launchpad'
import { mc, ok } from './multicall'

/**
 * What a launchpad token turned out to be, once the factory vouched for it.
 *
 * `release` separates the ways a token reaches the same factory: a sale run
 * through one of the launchpad's LiquidityLaunchers (which is then the token's
 * `creator`, and names the generation), or a mint served straight from the
 * factory by a wallet. Both are genuinely the launchpad's tokens — a sale had a
 * market built for it.
 */
export type LaunchpadToken = {
  launchpad: LaunchpadId
  /** the address that called the factory; the sale contract for a launched token */
  creator: Address
  /** which launcher generation ran the sale, or null for a mint off the factory */
  release: LaunchpadReleaseId | null
  /** the token's own claims, from its `tokenURI` document — empty where absent */
  description: string
  website: string
  /** image URI verbatim, still in whatever scheme the token wrote (often ipfs://) */
  image: string
}

/** the document a launchpad token returns from `tokenURI()` */
export type TokenUriDoc = { description: string; website: string; image: string }

const DATA_JSON_B64 = /^data:application\/json;base64,/i
const DATA_JSON = /^data:application\/json[^,]*,/i

function decodeBase64Utf8(b64: string): string | null {
  try {
    // atob yields one byte per code unit; the documents carry emoji, so the
    // bytes have to be re-read as UTF-8 rather than used as a string directly
    const binary = atob(b64)
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

/**
 * Read a `tokenURI()` document, without ever leaving the chain to do it.
 *
 * Only `data:` URIs are read. A token that points its metadata at a URL is
 * making a claim this function cannot check and will not fetch on its behalf —
 * the document would then be whatever a server felt like returning at render
 * time, which is a different (and weaker) thing from what the contract says.
 *
 * Every field is optional and defaults to empty: the shape is the token's, and
 * a missing description is not a reason to discard a perfectly good image.
 */
export function parseTokenUri(uri: string | undefined): TokenUriDoc | null {
  if (!uri) return null
  let json: string | null = null
  if (DATA_JSON_B64.test(uri)) json = decodeBase64Utf8(uri.replace(DATA_JSON_B64, ''))
  else if (DATA_JSON.test(uri)) {
    try {
      json = decodeURIComponent(uri.replace(DATA_JSON, ''))
    } catch {
      json = null
    }
  }
  if (!json) return null
  try {
    const parsed: unknown = JSON.parse(json)
    // an array is `typeof 'object'` too, and would sail through as a document
    // with three empty fields — which is a claim, and not one that was made
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const doc = parsed as Record<string, unknown>
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
    const out = {
      description: str(doc.description),
      website: str(doc.website),
      image: str(doc.image),
    }
    // a document that names nothing is the same as no document
    return out.description || out.website || out.image ? out : null
  } catch {
    return null
  }
}

/**
 * The token's `website`, if it is somewhere a browser should be sent.
 *
 * This string is written by whoever deployed the token and it is about to
 * become an `href` on a page with a connected wallet, so it is treated the way
 * lib/dexscreener.ts treats a pool address: `https:` and nothing else. That
 * rejects `javascript:`, `data:`, protocol-relative `//evil.tld` and every
 * scheme a wallet might be persuaded to answer. A claim that does not survive
 * this is dropped, and the caller links the launchpad itself instead.
 */
export function safeWebsite(claimed: string | undefined): string | null {
  if (!claimed) return null
  try {
    const url = new URL(claimed)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * Did this factory deploy this token?
 *
 * The comparison is the proof, so it is spelled out as its own function: the
 * factory recomputed an address from the candidate's self-reported identity,
 * and CREATE2 makes that address reachable by nobody else. A token that reports
 * someone else's name and symbol therefore hashes to someone else's address —
 * which is exactly the case this rejects.
 */
export function create2Proves(predicted: string | undefined, address: string): boolean {
  return !!predicted && predicted.toLowerCase() === address.toLowerCase()
}

/**
 * The launchpad behind one token, read in the order that costs the least.
 *
 * One batched call asks for the token's whole identity at once. An ordinary
 * ERC-20 answers `name`/`symbol`/`decimals` and reverts on `creator` and
 * `graffiti`, so it is rejected right there and never costs the second call —
 * which matters because a pools page asks this about every token on it and
 * almost all of them are ordinary. Only a contract that answered all five is
 * worth handing to the factory.
 *
 * THROWS when the read itself fails, and returns null only for a token that
 * answered and did not match. Callers cache the answer forever — a deployed
 * contract cannot change its mind about any of this — so the two outcomes must
 * not be confused: a dropped packet resolving to `null` would leave a genuine
 * launchpad token unmarked and unfindable for the rest of the session.
 */
export async function readLaunchpadToken(
  client: PublicClient,
  address: Address,
  launchpad: LaunchpadConfig | null,
): Promise<LaunchpadToken | null> {
  if (!launchpad) return null
  const token = { address, abi: launchpadTokenAbi } as const
  const [name, symbol, decimals, creator, graffiti, uri] = await mc(client, [
    { ...token, functionName: 'name' },
    { ...token, functionName: 'symbol' },
    { ...token, functionName: 'decimals' },
    { ...token, functionName: 'creator' },
    { ...token, functionName: 'graffiti' },
    { ...token, functionName: 'tokenURI' },
  ])

  const identity = {
    name: ok<string>(name),
    symbol: ok<string>(symbol),
    decimals: ok<number>(decimals),
    creator: ok<Address>(creator),
    graffiti: ok<`0x${string}`>(graffiti),
  }
  if (
    identity.name === undefined ||
    identity.symbol === undefined ||
    identity.decimals === undefined ||
    identity.creator === undefined ||
    identity.graffiti === undefined
  )
    return null

  const [predicted] = await mc(client, [
    {
      address: launchpad.tokenFactory,
      abi: launchpadFactoryAbi,
      functionName: 'getUERC20Address',
      args: [identity.name, identity.symbol, identity.decimals, identity.creator, identity.graffiti],
    },
  ])
  if (!create2Proves(ok<Address>(predicted), address)) return null

  const doc = parseTokenUri(ok<string>(uri))
  return {
    launchpad: launchpad.id,
    creator: identity.creator,
    release: launcherRelease(identity.creator, launchpad),
    description: doc?.description ?? '',
    website: doc?.website ?? '',
    image: doc?.image ?? '',
  }
}
