import { keccak256, type Address, type Hex, type PublicClient } from 'viem'
import type { StockIssuerAnchor, StockIssuerId } from '../config/chains/stockIssuers'

/**
 * Does this token's own bytecode prove which issuer minted it?
 *
 * See config/chains/stockIssuers.ts for why both halves are required. In short:
 * the codehash pins WHICH code the address runs — code we have read, and which
 * does nothing but delegate — and the slot pins WHERE that code delegates to.
 * Matching one without the other proves nothing, so this deliberately has no
 * "close enough" branch.
 *
 * A `null` probe field means the read failed or the address has no code. That
 * is never treated as a match: an RPC hiccup must leave a token UNMARKED, not
 * marked as someone's. The whole point of the mark is that its absence is the
 * warning, so the failure direction has to be "unproven".
 */
export type StockProbe = {
  /** keccak256 of the address's runtime bytecode, or null when it has none */
  codehash: Hex | null
  /** slot value → 32-byte word, keyed by slot; missing/null when unread */
  slots: Readonly<Record<string, Hex | null>>
}

/** the low 20 bytes of a 32-byte storage word, as a lowercase address */
export function addressInSlot(word: Hex | null | undefined): string | null {
  if (!word) return null
  const hex = word.slice(2)
  if (hex.length !== 64) return null
  const addr = hex.slice(24)
  return /^0{40}$/.test(addr) ? null : `0x${addr}`.toLowerCase()
}

/** the issuer this probe proves, or null when nothing proves one */
export function matchStockIssuer(
  anchors: readonly StockIssuerAnchor[],
  probe: StockProbe,
): StockIssuerId | null {
  if (!probe.codehash) return null
  const codehash = probe.codehash.toLowerCase()
  for (const a of anchors) {
    if (a.proxyCodehash.toLowerCase() !== codehash) continue
    if (addressInSlot(probe.slots[a.slot.toLowerCase()]) !== a.anchor.toLowerCase()) continue
    return a.issuer
  }
  return null
}

/** every distinct ERC-1967 slot this chain's anchors actually read */
export function slotsToRead(anchors: readonly StockIssuerAnchor[]): Hex[] {
  return [...new Set(anchors.map((a) => a.slot.toLowerCase() as Hex))]
}

type CodeReader = Pick<PublicClient, 'getCode' | 'getStorageAt'>

/**
 * Read one address's proof material from the chain.
 *
 * One `eth_getCode` plus one `eth_getStorageAt` per distinct slot — two calls
 * on both chains today. The transport batches concurrent calls into a single
 * HTTP request (config/wagmi.ts sets `batch: true`), so a table of stock rows
 * costs one round trip rather than one per token.
 *
 * The answer is IMMUTABLE for an address: a deployed contract's runtime code
 * never changes, and the ERC-1967 anchor slot is written once at construction
 * and only moved by an upgrade the issuer itself performs. Callers cache it
 * forever rather than revalidating.
 *
 * Reads are settled individually so one failed slot cannot discard a codehash
 * that was fetched successfully — the matcher can then decide, and it decides
 * "unproven".
 */
export async function probeStockToken(
  client: CodeReader,
  address: Address,
  anchors: readonly StockIssuerAnchor[],
): Promise<StockProbe> {
  const slots = slotsToRead(anchors)
  const [codeR, ...slotR] = await Promise.allSettled([
    client.getCode({ address }),
    ...slots.map((slot) => client.getStorageAt({ address, slot })),
  ])
  const code = codeR.status === 'fulfilled' ? codeR.value : undefined
  return {
    // viem returns undefined for an address with no code; '0x' means the same
    codehash: code && code !== '0x' ? keccak256(code) : null,
    slots: Object.fromEntries(
      slots.map((slot, i) => {
        const r = slotR[i]
        return [slot, r?.status === 'fulfilled' ? (r.value ?? null) : null]
      }),
    ),
  }
}

/**
 * The issuer behind one address, read in the order that costs the least.
 *
 * The slots come first and the code is fetched only if one of them already
 * names an issuer's anchor. That ordering is what makes this affordable on a
 * pools page: a table of 150 rows is mostly ordinary tokens, and an ordinary
 * token's beacon slot is zero — so it is rejected by the cheapest read there
 * is and never costs a `getCode` at all. Only a contract already pointed at
 * Robinhood's, Binance's, Ondo's or Backed's anchor is worth hashing.
 *
 * Reversing the two would be equally correct and roughly twice the traffic,
 * since every token would pay for its bytecode to be shipped and hashed.
 *
 * The result is immutable for an address — see `probeStockToken` — so callers
 * cache it with no expiry. That is exactly why this THROWS when a read fails
 * rather than reporting "no issuer": the two are indistinguishable in the
 * return type, and a caller caching forever would turn one dropped RPC packet
 * into a genuine share that stays unmarked for the rest of the session, sitting
 * in a list beside the impersonators it is supposed to be distinguished from.
 * `null` therefore means measured-and-matched-nobody, and only that.
 *
 * A failed read is only fatal when it is the REASON nothing matched. If one
 * slot errored while another already named an issuer's anchor, that answer
 * stands — BSC reads two slots and any given token can only be anchored on one.
 */
export async function readStockIssuer(
  client: CodeReader,
  address: Address,
  anchors: readonly StockIssuerAnchor[],
): Promise<StockIssuerId | null> {
  if (anchors.length === 0) return null

  const slots = slotsToRead(anchors)
  const read = await Promise.allSettled(
    slots.map((slot) => client.getStorageAt({ address, slot })),
  )
  const values = Object.fromEntries(
    slots.map((slot, i) => {
      const r = read[i]
      return [slot, r.status === 'fulfilled' ? (r.value ?? null) : null]
    }),
  )

  const candidates = anchors.filter(
    (a) => addressInSlot(values[a.slot.toLowerCase()]) === a.anchor.toLowerCase(),
  )
  if (candidates.length === 0) {
    if (read.some((r) => r.status === 'rejected'))
      throw new Error(`stock issuer unread for ${address}: anchor slot read failed`)
    return null
  }

  // No `.catch` here either: this address IS pointed at an issuer's anchor, so
  // failing to read its code is the one case where giving up quietly would drop
  // a token that is very likely genuine.
  const code = await client.getCode({ address })
  return matchStockIssuer(candidates, {
    codehash: code && code !== '0x' ? keccak256(code) : null,
    slots: values,
  })
}
