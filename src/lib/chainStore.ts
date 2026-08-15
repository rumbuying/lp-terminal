// Browser storage for the things that mean something DIFFERENT on each chain.
//
// Three of these are money bugs rather than untidiness:
//  - a custom RPC is a node for ONE chain, and it is the highest-priority
//    transport in the app. Pointed at the other chain it does not error — it
//    answers eth_call with a valid, EMPTY result.
//  - token metadata is keyed by ADDRESS, and addresses collide across chains
//    (deterministic deploys land unrelated tokens on the same one). A cached
//    `decimals` from the wrong chain misprices every amount rendered from it.
//  - range-order tags are keyed by tokenId, and ids are unique only per
//    position manager: Robinhood's #1234 and BSC's #1234 both exist, and each
//    would wear the other's "selling 500 USDG" label.
//
// Preferences about the PERSON rather than the chain — theme, language,
// autostake — stay unscoped on purpose. Nobody wants a different theme per
// chain. In-flight BRIDGE transfers stay unscoped too: each entry names its own
// originChainId and destChainId, and they are polled through provider APIs
// rather than through a chain's RPC.
//
// react-query needs no equivalent. Its cache is not persisted and a switch is a
// full page load (lib/chainPref.ts), so the cache is gone before the new
// chain's first render.
import { BUILD_CHAIN, CHAIN } from '../config/chains'

/** the same storage key, scoped to the chain on screen */
export function chainKey(base: string): string {
  return `${base}@${CHAIN.key}`
}

// Everything written before the switcher existed was written by a build of this
// origin, and that build served BUILD_CHAIN — so that is the namespace it
// belongs in. Adoption REMOVES the legacy entry, so it happens at most once.
//
// At module load rather than from a boot hook in main.tsx: config/wagmi reads
// the custom RPC while it is still initialising, which is during the import
// graph, before any statement in main.tsx runs.
const LEGACY_KEYS = ['up33.rpcUrl.v1', 'up33.limitOrders.v1', 'up33:tokens:v2']
const LEGACY_PREFIXES = ['up33.pendingSwaps.v2']

/** A browser origin keeps its own localStorage even when multiple hosts serve
 * the same bundle, so pre-switcher ownership is an origin fact, not build env. */
export function legacyStorageChain(hostname: string | null | undefined, buildChain: string): string {
  const host = (hostname ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (host === 'bsc.lp-terminal.xyz') return 'bsc'
  if (host === 'lp-terminal.xyz' || host === 'up33-terminal.xyz') return 'robinhood'
  return buildChain
}

/** takes its store, because the walk below mutates the thing it is walking and
 *  that is the part worth pinning down in a test */
export function adoptLegacyInto(store: Storage, chain: string): void {
  const adopt = (from: string, to: string): void => {
    const v = store.getItem(from)
    if (v === null) return
    // a scoped entry already there is the newer one — the legacy copy just goes
    if (store.getItem(to) === null) store.setItem(to, v)
    store.removeItem(from)
  }
  for (const base of LEGACY_KEYS) adopt(base, `${base}@${chain}`)
  for (const base of LEGACY_PREFIXES) {
    const legacy = `${base}.`
    const scoped = `${base}@${chain}.`
    // collect before mutating: removeItem reindexes the store mid-walk, and
    // `store.key(i)` would then skip whatever slid into slot i
    const found: string[] = []
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i)
      if (k?.startsWith(legacy)) found.push(k)
    }
    for (const k of found) adopt(k, scoped + k.slice(legacy.length))
  }
}

if (typeof window !== 'undefined') {
  try {
    adoptLegacyInto(localStorage, legacyStorageChain(window.location.hostname, BUILD_CHAIN.key))
  } catch {
    /* storage unavailable — the scoped keys simply start empty */
  }
}
