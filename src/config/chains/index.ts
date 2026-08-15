import { storedChainKey, urlChainKey } from '../../lib/chainPref'
import { bscConfig } from './bsc'
import { robinhoodConfig } from './robinhood'
import { chainGatewayEnabled, chainServedHere } from './routes'
import type { ChainConfig } from './types'

export type { ChainConfig, GovAddresses, HomeDexAddresses, UniAddresses } from './types'

export const CHAINS: Record<string, ChainConfig> = {
  bsc: bscConfig,
  robinhood: robinhoodConfig,
}

/** where the terminal lands when neither a link, a browser nor a build says otherwise */
const DEFAULT_KEY = 'bsc'

/**
 * The config a key names, or null. The only way a string becomes a chain.
 *
 * `Object.hasOwn` rather than a plain lookup, because keys arrive from the query
 * string: `CHAINS['__proto__']` returns Object.prototype — truthy, not a chain,
 * and enough to hand every downstream `CHAIN.addr.…` an undefined.
 */
export function chainByKey(key: string | null | undefined): ChainConfig | null {
  const k = (key ?? '').trim()
  return k && Object.hasOwn(CHAINS, k) ? CHAINS[k] : null
}

/**
 * Vite replaces `import.meta.env.CHAIN` at build time (envPrefix includes
 * CHAIN); under node — tests, the indexer, scripts — that object does not
 * exist, so `process.env.CHAIN` carries the same choice.
 */
function buildKey(): string {
  const fromVite = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?.CHAIN
  const fromNode = typeof process !== 'undefined' && process.env ? process.env.CHAIN : undefined
  return (fromVite ?? fromNode ?? '').trim()
}

const built = chainByKey(buildKey() || DEFAULT_KEY)
if (!built) {
  throw new Error(
    `CHAIN=${buildKey()} is not a configured chain — expected one of ${Object.keys(CHAINS).join(', ')}`,
  )
}

/**
 * The chain this BUILD targets — the local-development RPC/indexer identity and
 * the default for a first visit without a URL or stored preference.
 *
 * The canonical gateway selects service paths independently at runtime;
 * `CHAIN=` remains the safe local and compatibility-host default.
 */
export const BUILD_CHAIN: ChainConfig = built

/**
 * Whether this deployment is the canonical gateway, decided here so exactly one
 * module owns the capability check. `config/env.ts` re-exports it and cannot
 * define it: it already imports CHAIN from this file, and the reverse import
 * would close a cycle.
 */
function gatewayHost(): string {
  const fromVite = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?.VITE_CHAIN_GATEWAY_HOST
  const fromNode =
    typeof process !== 'undefined' && process.env
      ? process.env.VITE_CHAIN_GATEWAY_HOST
      : undefined
  return (fromVite ?? fromNode ?? '').trim()
}

export const CHAIN_GATEWAY: boolean = chainGatewayEnabled(
  gatewayHost(),
  typeof window !== 'undefined' ? window.location.hostname : null,
)

const fromLink = chainByKey(urlChainKey())
const remembered = fromLink ? null : chainByKey(storedChainKey())

/**
 * A REMEMBERED chain this deployment cannot serve is dropped.
 *
 * Honouring it puts every bare visit into the degraded state — no catalog, no
 * v4 directory, a v3-only fallback where the market table belongs — with
 * nothing on screen to say the data lives on another host. Nobody chose that;
 * they chose the chain once, somewhere it worked.
 *
 * A LINK still wins, because `?chain=` is someone asking right now, and the
 * selector sends those to a host that can answer (components/ChainControl).
 */
const fromStore =
  remembered && chainServedHere(remembered.key, CHAIN_GATEWAY, built.key) ? remembered : null

/**
 * Where the active chain came from, which decides what boot may write down.
 *
 * `build` is the one that has to stay inert: a chain nobody asked for must not
 * be recorded anywhere, or `CHAIN=` in the build environment stops being able to move the
 * people who never chose. See main.tsx.
 */
export const CHAIN_SOURCE: 'link' | 'stored' | 'build' = fromLink
  ? 'link'
  : fromStore
    ? 'stored'
    : 'build'

/**
 * The chain the user is LOOKING at: a link names it, else this browser
 * remembers it, else the build decides.
 *
 * A bad key here is ignored rather than thrown on, and the asymmetry with
 * BUILD_CHAIN above is deliberate: `CHAIN=` is ours, so a typo in it should
 * fail loudly; `?chain=` is the user's, and a typo in a pasted link should not
 * white-screen the terminal.
 *
 * Every chain module ships in every bundle — the lookup is a runtime one, so
 * rollup cannot drop the branch not taken. That costs a few hundred bytes and
 * buys a selector that works identically under node, where the tests, the
 * indexer and the scripts read this same config with no URL and no storage to
 * consult: both readers answer '' there, so the active chain is the built one.
 */
export const CHAIN: ChainConfig = fromLink ?? fromStore ?? built

/**
 * Whether the active chain matches the local build identity. The canonical
 * gateway uses explicit namespaces; this guard remains for local `.env` RPC
 * and every single-chain compatibility proxy, which must not leak across chains.
 */
export const ACTIVE_IS_BUILD = CHAIN.key === BUILD_CHAIN.key
