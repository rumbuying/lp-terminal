// What an RPC-sourced v4 directory admits.
//
// The directory exists because this chain publishes no subgraph, and it has to
// stay small enough to build from logs. Three rules do that, and they cover the
// ways a v4 pool becomes worth listing:
//
//  1. a LAUNCHED token on either side. This is the long tail — thousands of
//     tokens, each with a handful of pools, all of them on the rungs their
//     launchpad migrates into.
//
//  2. an ISSUED SHARE on either side. Same shape as the launchpad rule and for
//     the same reason: the origin is proven, and a tokenized equity is quoted
//     against whatever the issuer's venue lists it in. Without this rule the
//     stock chips can never show a v4 pool at all — a share is not a launchpad
//     mint, and its quote side is rarely another core token, so neither of the
//     other two rules ever reaches one.
//
//  3. CORE tokens on BOTH sides. This is the routing backbone, and it exists
//     because v4 enforces no fee ladder: the busiest ETH/USDG pool on this
//     chain is keyed (460, 9), and WETH/USDG is (200, 4). No rung shortlist
//     can guess those, so the only way to reach them is to observe them.
//
// The asymmetry between the origin rules and the core rule is the whole design.
// "Either side is core" would admit 238,878 of this chain's 257,283 pools,
// because the native coin is currency0 in 110k of them — every launch pairs
// against it. "Both sides core" admits 514, of which 450 are hookless and
// reachable. Measured 2026-08-05 over every Initialize log on the chain. The
// origin rules stay safe on one side because their membership is small and
// earned: a token is in it only after the chain proved where it came from.
import { zeroAddress } from 'viem'
import { CHAIN, V4 } from './config'
import { isLaunchpadToken, isStockToken } from './store'

/**
 * The tokens this chain routes THROUGH, in v4's own terms.
 *
 * Derived from the chain config rather than listed again here, so a chain that
 * gains a connector gains its v4 backbone pools with it. The native coin is
 * address(0) in a PoolKey — v4 pools the coin directly, and a native-keyed
 * pool is a different pool from its wrapped twin, so both belong.
 */
let core: ReadonlySet<string> | null = null

/** Built on first use, so a chain with no RPC directory never assembles one. */
export function v4DirectoryCore(): ReadonlySet<string> {
  if (!core)
    core = new Set(
      [
        zeroAddress,
        CHAIN.addr.WNATIVE,
        CHAIN.addr.STABLE,
        CHAIN.defaultBuy,
        ...CHAIN.connectors,
      ].map((address) => address.toLowerCase()),
    )
  return core
}

/**
 * Whether a pool belongs in an RPC-sourced directory.
 *
 * Chains whose directory is a subgraph declare no `rpcDirectory` and admit
 * everything, exactly as before — the subgraph already bounded the set.
 */
export function inV4DirectoryScope(currency0: string, currency1: string): boolean {
  if (!V4?.rpcDirectory) return true
  const c0 = currency0.toLowerCase()
  const c1 = currency1.toLowerCase()
  if (provenOrigin(c0) || provenOrigin(c1)) return true
  const known = v4DirectoryCore()
  return known.has(c0) && known.has(c1)
}

/** Whether this chain has proven where a token came from, by either route. */
export function provenOrigin(address: string): boolean {
  const a = address.toLowerCase()
  return isLaunchpadToken(a) || isStockToken(a)
}
