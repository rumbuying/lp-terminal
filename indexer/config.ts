// Indexer constants + tuning. Contract addresses come from the shared frontend
// config — src/config/addresses.ts and src/abi are pure modules and load fine
// under node/tsx. src/config/env.ts does NOT (import.meta.env is vite-only),
// which is why the public RPC is duplicated here instead of imported.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export { ADDR, UNI } from '../src/config/addresses'

export const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com'
export const BLOCKSCOUT = 'https://robinhoodchain.blockscout.com'
export const GT = 'https://api.geckoterminal.com/api/v2'

export const PORT = Number(process.env.INDEXER_PORT || 8787)
export const DB_PATH =
  process.env.INDEXER_DB || fileURLToPath(new URL('./data/index.db', import.meta.url))

/** positive-number env override for a tuning knob; unset/0/garbage → default */
const envMs = (key: string, def: number): number => {
  const v = Number(process.env[key])
  return Number.isFinite(v) && v > 0 ? v : def
}

// Cadence philosophy: DISCOVERY and the dust sweeps are slow — they only keep
// the long tail honest, and none of it reaches a user until it ranks onto the
// POOLS tab. The `frontpage` tier is the fast one: it sweeps just the top-N
// pools by TVL (exactly what /api/pools?sort=tvl serves) so the on-screen data
// is timely — and only while someone is actually polling (gated on the last
// /api/pools hit) so an idle site costs nothing. All knobs take env overrides
// (docker-compose env) so cadence can be tuned without a code rebuild.
export const TUNE = {
  // --- discovery + background sweeps (slow) ---
  tailMs: envMs('TAIL_MS', 1_800_000), // factory tail + v2 allPairsLength poll (new pools may lag up to 30min)
  hotSweepMs: envMs('HOT_SWEEP_MS', 600_000), // "might rise onto the homepage" set (≥$10k TVL / GT-active / <1h)
  fullSweepMs: envMs('ACTIVE_SWEEP_MS', 14_400_000), // ACTIVE pools (≥$100 TVL or <48h old), every 4h
  censusMs: envMs('CENSUS_MS', 86_400_000), // full-catalog dust census (~114k pools and growing), daily
  statsMs: envMs('STATS_MS', 300_000), // GeckoTerminal enrichment cycle (external HTTP, off the RPC queue)
  // --- frontpage tier: the pools the POOLS tab actually shows, swept fast ---
  frontpageMs: envMs('FRONTPAGE_MS', 15_000), // sweep cadence for the on-screen top-N
  frontpageN: envMs('FRONTPAGE_N', 64), // how many top-TVL pools count as "on the homepage"
  frontpageGateMs: envMs('FRONTPAGE_GATE_MS', 90_000), // skip the sweep if /api/pools has been idle this long
  // --- event tail: reread only the pools that emitted a swap/liquidity event ---
  logtailMs: envMs('LOGTAIL_MS', 12_000), // how often to pull new logs and reread the pools that changed
  logtailMaxBlocks: envMs('LOGTAIL_MAX_BLOCKS', 5_000), // cap the span per pull so a backlog catches up in bounded chunks
  // --- fixed knobs ---
  gtPaceMs: 2_600, // ≥2.6s between GT calls (free tier: 30/min)
  batch: 400, // calls per multicall aggregate
  batchGapMs: 40, // pause between aggregates (gentle on the RPC)
  hotTvlUsd: 10_000, // pools at/above this TVL are always in the hot set
  minDepthUsd: 300, // min CREDIBLE-side USD depth to propagate a price through a pool
  maxUncredibleRatio: 25, // a pool-priced side may claim at most this × the credible side before TVL clamps to 2× credible
  // --- pricing safety rails (see state.ts header) ---
  maxPriceHops: 3, // how far a price may travel from its GT/anchor seed
  maxAbsTick: 700_000, // |tick| past this is a broken init, not a market (v3 MAX_TICK = 887272)
  minTokenUsd: 1e-18, // plausibility band for any price we store, serve or propagate
  maxTokenUsd: 1e9,
  maxSideOverDepth: 100, // a pool-priced side may claim at most this × the credible depth behind its price
  maxPoolTvlUsd: 1e9, // above this a TVL figure is corrupt, not a whale: never ranked, never swept fast
}

/** repo-root .env `RPC` (SECRET — never log/print it). Fallback: key-free public RPC. */
export function rpcUrl(): string {
  const env = process.env.RPC?.trim()
  if (env) return env
  try {
    const text = readFileSync(new URL('../../.env', import.meta.url), 'utf8')
    const m = text.match(/^\s*RPC\s*=\s*(\S+)\s*$/m)
    if (m) return m[1]
  } catch {
    /* no repo .env — public RPC below */
  }
  return PUBLIC_RPC
}

/** Extra Alchemy key is indexer-only; shared paid/public RPC remains fallback. */
export function rpcUrls(): string[] {
  const extraKey = process.env.EXTRA_ALCHEMY_RPC_KEY?.trim()
  const dedicated = extraKey
    ? `https://robinhood-mainnet.g.alchemy.com/v2/${extraKey}`
    : undefined
  const shared = rpcUrl()
  return dedicated && dedicated !== shared ? [dedicated, shared] : [shared]
}

export const now = () => Math.floor(Date.now() / 1000)

/** terminal-style timestamped log line */
export const log = (...a: unknown[]) =>
  console.log(new Date().toISOString().slice(11, 19), ...a)

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
