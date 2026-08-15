import {
  encodePacked,
  getAddress,
  getCreate2Address,
  keccak256,
  type Address,
  type Hex,
} from 'viem'
import { CHAIN } from '../config/chains'
import { CONNECTORS } from '../config/addresses'
import type { V2Position } from '../types'

/**
 * v2 pair addresses, derived rather than looked up.
 *
 * A v2 factory deploys every pair with CREATE2 from a fixed salt and a fixed
 * creation code, so the address is a pure function of (factory, token0,
 * token1) — no RPC, no index, no API. That does two jobs here.
 *
 * As DISCOVERY it names pairs nobody has told us about, which is the only way
 * to find v2 LP on a chain with no holder-balance endpoint to ask.
 *
 * As VERIFICATION it is the stronger job. Whatever proposes a candidate pair —
 * DexScreener, a subgraph, a pasted address — recomputing the address from the
 * tokens it CLAIMS to hold proves it really is that factory's pair for that
 * pair of tokens. A spoofed "PancakeSwap LP" contract cannot pass, because it
 * would have to live at an address only the real factory can deploy to. Same
 * principle uniBrowse applies through factory.getPool, minus the round trip.
 */
export type V2SweepVenue = {
  protocol: 'univ2' | 'home'
  factory: Address
  initCodeHash: Hex
  dexId: string
  /** the pair's LP fee, in bps — the two venues on a chain do not share one */
  feeBps: number
}

/**
 * The venues this chain can sweep. Empty where the chain has a holder-balance
 * API instead: enumerating what a wallet actually holds beats guessing which
 * pairs to ask it about, and a sweep only ever sees its candidate list.
 *
 * The fee is taken from the venue's own config rather than restated, so it
 * cannot drift from the fee the swap path validates against.
 */
export const V2_SWEEP_VENUES: readonly V2SweepVenue[] = CHAIN.v2Sweep.map((v) => ({
  ...v,
  factory: getAddress(v.factory),
  feeBps: v.protocol === 'home' ? (CHAIN.homeV2?.feePpm ?? 0) / 100 : 30,
}))

export const HAS_V2_SWEEP = V2_SWEEP_VENUES.length > 0

/** tokens sorted the way a v2 factory sorts them before hashing the salt */
export function sortTokens(a: Address, b: Address): readonly [Address, Address] {
  return a.toLowerCase() < b.toLowerCase() ? [getAddress(a), getAddress(b)] : [getAddress(b), getAddress(a)]
}

/** `keccak256(0xff, factory, keccak256(token0, token1), initCodeHash)` */
export function v2PairAddress(venue: V2SweepVenue, a: Address, b: Address): Address {
  const [token0, token1] = sortTokens(a, b)
  return getCreate2Address({
    from: venue.factory,
    salt: keccak256(encodePacked(['address', 'address'], [token0, token1])),
    bytecodeHash: venue.initCodeHash,
  })
}

/**
 * Does `pair` really belong to `venue`, holding exactly these two tokens?
 *
 * The only way to answer yes is for the address to be the one CREATE2 would
 * have produced — which no contract other than the factory's own deployment
 * can occupy.
 */
export function isVenuePair(
  venue: V2SweepVenue,
  pair: Address,
  a: Address,
  b: Address,
): boolean {
  try {
    return v2PairAddress(venue, a, b).toLowerCase() === pair.toLowerCase()
  } catch {
    // a malformed address from an external source is simply not a match
    return false
  }
}

export type V2Candidate = {
  venue: V2SweepVenue
  address: Address
  token0: Address
  token1: Address
}

/**
 * The keyless floor of the candidate set: every pair among the chain's
 * connectors, on every sweep venue.
 *
 * These need no external source at all, so a wallet holding the chain's most
 * ordinary LP (the stable against the wrapped native, say) stays visible even
 * when every data API is unreachable.
 */
export function connectorCandidates(): V2Candidate[] {
  const out: V2Candidate[] = []
  for (const venue of V2_SWEEP_VENUES) {
    for (let i = 0; i < CONNECTORS.length; i++) {
      for (let j = i + 1; j < CONNECTORS.length; j++) {
        const [token0, token1] = sortTokens(CONNECTORS[i], CONNECTORS[j])
        out.push({ venue, address: v2PairAddress(venue, token0, token1), token0, token1 })
      }
    }
  }
  return out
}

/** the sweep venue a DexScreener dexId belongs to, if any */
export function sweepVenueOf(dexId: string | undefined): V2SweepVenue | undefined {
  return V2_SWEEP_VENUES.find((v) => v.dexId === dexId)
}

/**
 * One row per pair, when two readers each found part of the same position.
 *
 * A wallet reader answers "how much LP does this address hold" and a farm
 * reader answers "how much has it deposited" — different questions about
 * different custody, so the two amounts ADD rather than override. What makes
 * that safe is that each reader leaves the other's field at zero: the sweep
 * never reports stakedLp, the farm never reports walletLp.
 *
 * The underlying is recomputed instead of summed. Both rows took their share
 * against the same reserves, so adding their amounts would be right only while
 * the shares are, and recomputing from total LP is right by construction.
 */
export function mergeV2ByPair(rows: readonly V2Position[]): V2Position[] {
  const byPair = new Map<string, V2Position>()
  for (const row of rows) {
    const key = row.pool.address.toLowerCase()
    const prev = byPair.get(key)
    if (!prev) {
      byPair.set(key, row)
      continue
    }
    const walletLp = prev.walletLp + row.walletLp
    const stakedLp = prev.stakedLp + row.stakedLp
    const lp = walletLp + stakedLp
    const ts = prev.pool.totalSupply
    byPair.set(key, {
      ...prev,
      walletLp,
      stakedLp,
      earned: prev.earned + row.earned,
      claimable0: prev.claimable0 + row.claimable0,
      claimable1: prev.claimable1 + row.claimable1,
      amount0: ts > 0n ? (lp * prev.pool.reserve0) / ts : 0n,
      amount1: ts > 0n ? (lp * prev.pool.reserve1) / ts : 0n,
      farm: prev.farm ?? row.farm,
    })
  }
  return [...byPair.values()]
}
