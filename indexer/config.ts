// Indexer constants + tuning. Contract addresses and chain identity come from
// the shared frontend config — src/config/chains, src/config/addresses.ts and
// src/abi are pure modules that load fine under node/tsx, and the chain
// selector reads process.env.CHAIN there just as vite reads import.meta.env.
// src/config/env.ts does NOT load here (import.meta.env is vite-only).
//
// One indexer instance serves one chain. The default DB filename is isolated by
// chain, and store.ts durably binds every DB (including INDEXER_DB overrides)
// to this identity before any catalog work starts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export { ADDR, UNI } from '../src/config/addresses';
import { CHAIN } from '../src/config/chains';

export { CHAIN };
/** Uniswap v4 singleton deployment, null on chains where it is unsupported. */
export const V4 = CHAIN.uniV4;

export const PUBLIC_RPC = CHAIN.publicRpc;
export const BLOCKSCOUT = CHAIN.explorer.url;
export const GT = 'https://api.geckoterminal.com/api/v2';
/** Official Uniswap v3 factory deployment block; avoids scanning pre-deployment history. */
export const UNI_V3_START_BLOCK = CHAIN.id === 56 ? 12_369_621 : 0;
/** Official PancakeSwap v3 factory deployment block on BSC. */
export const PANCAKE_V3_START_BLOCK = 26_956_207;

export const PORT = Number(process.env.INDEXER_PORT || 8787);
const configuredFinality = Number(process.env.INDEXER_FINALITY_BLOCKS);
export const INDEXER_FINALITY_BLOCKS =
  Number.isSafeInteger(configuredFinality) && configuredFinality >= 0 ? configuredFinality : CHAIN.id === 56 ? 20 : 12;
export const DB_CHAIN_IDENTITY = {
  chainKey: CHAIN.key,
  chainId: CHAIN.id,
} as const;
export const DB_CHAIN_TOKEN = `${CHAIN.key}:${CHAIN.id}`;
export const DB_PATH =
  process.env.INDEXER_DB || fileURLToPath(new URL(`./data/index.${CHAIN.key}-${CHAIN.id}.db`, import.meta.url));

/**
 * Operators may deliberately run a concentrated-liquidity-only catalog. This
 * is different from an unavailable V2 provider: disabled venues are omitted
 * from public results and readiness instead of leaving the whole index warm.
 */
export function v2IndexEnabled(value: string | undefined): boolean {
  return value?.trim() !== '1';
}

export const INDEX_V2 = v2IndexEnabled(process.env.INDEXER_DISABLE_V2);

/**
 * A pre-identity DB with rows cannot be safely attributed to a chain. Operators
 * may claim a known-good legacy DB once by setting the exact target identity,
 * e.g. INDEXER_ADOPT_LEGACY_DB=robinhood:4663. A typo or stale value is fatal.
 */
export function allowLegacyDbAdoption(value = process.env.INDEXER_ADOPT_LEGACY_DB): boolean {
  const token = value?.trim();
  if (!token) return false;
  if (token !== DB_CHAIN_TOKEN) {
    throw new Error(`INDEXER_ADOPT_LEGACY_DB=${token} does not match configured chain ${DB_CHAIN_TOKEN}`);
  }
  return true;
}

/** positive-number env override for a tuning knob; unset/0/garbage → default */
const envMs = (key: string, def: number): number => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : def;
};

// Cadence philosophy: discovery, shared landing state and HTTP traffic are
// independent lifecycles. CDN hits never reach this process, so request-driven
// scheduling would eventually stop refreshing the very snapshots being served.
// Keep a small top set current on a fixed budget and hydrate the long tail only
// when it is new, useful or explicitly requested. All knobs take env overrides
// so cadence can be tuned without a code rebuild.
export const TUNE = {
  // --- discovery + background sweeps (slow) ---
  tailMs: envMs('TAIL_MS', 300_000), // factory tail + v2 allPairsLength poll (new pools may lag up to 5min)
  // The v4 directory's own cadence, used ONLY where that directory is built
  // from RPC logs. The Graph path keeps tailMs: each of its runs re-proves a
  // pinned snapshot against the gateway, so polling it harder buys latency
  // with someone else's quota. An RPC tail costs two eth_getLogs over the
  // blocks since its cursor, which on a launchpad chain minting a token every
  // half-minute is worth paying every minute rather than every five.
  //
  // It is a separate loop rather than extra topics on logtail because the two
  // have opposite failure rules: logtail SKIPS to head when it falls more than
  // logtailMaxBlocks behind (state has the sweeps as a longstop), while a
  // directory that skips a range never learns those pools existed.
  v4TailMs: envMs('V4_TAIL_MS', 60_000),
  hotSweepMs: envMs('HOT_SWEEP_MS', 600_000), // "might rise onto the homepage" set (≥$10k TVL / GT-active / <1h)
  fullSweepMs: envMs('ACTIVE_SWEEP_MS', 14_400_000), // ACTIVE pools (≥$100 TVL or <48h old), every 4h
  censusMs: envMs('CENSUS_MS', 86_400_000), // daily full-state longstop for small catalogs only
  statsMs: envMs('STATS_MS', 300_000), // GeckoTerminal enrichment cycle (external HTTP, off the RPC queue)
  analyticsMs: envMs('ANALYTICS_MS', 60_000), // recommendation tick/state samples
  analyticsN: envMs('ANALYTICS_N', 80), // bounded address and v4 cohorts per chain
  repriceMs: envMs('REPRICE_MS', 86_400_000), // giant-catalog full price graph, isolated in a worker
  // One Graph request refreshes only the featured v4 landing set. The pinned
  // 162k-row identity directory is never re-downloaded on this cadence.
  v4StatsMs: envMs('V4_STATS_MS', 600_000),
  // Pool ranking reference table. Half-day cadence on purpose: the table is a
  // quality ranking, not a market feed, and each cycle spends ~30 paced
  // GeckoTerminal OHLCV calls. Served from kv, so restarts keep the last table.
  poolRankMs: envMs('POOL_RANK_MS', 43_200_000),
  // Recommendation candidates snapshot. The payload is computed OFF the API
  // event loop in a worker thread and served as a ready-made body; the sync
  // handler costs ~30s at steady state and used to freeze every endpoint
  // behind it when it ran per-request. The executor re-scores on a 5-minute
  // cache, so a 2-minute snapshot is strictly fresher than what it consumed.
  recommendationCandidatesMs: envMs('RECOMMENDATION_CANDIDATES_MS', 120_000),
  // Proving where a token came from. A brisk cadence and a wide batch because
  // this is a BACKFILL that ends: every answer is recorded, so the candidate
  // set drains (387 tokens on the BSC catalog — two ticks) and the steady state
  // only sees what newly got deep enough to matter.
  stockOriginMs: envMs('STOCK_ORIGIN_MS', 120_000),
  stockOriginN: envMs('STOCK_ORIGIN_N', 256),
  // --- frontpage tier: the pools the POOLS tab actually shows, swept fast ---
  frontpageMs: envMs('FRONTPAGE_MS', 60_000), // fixed shared refresh for the on-screen top-N
  frontpageN: envMs('FRONTPAGE_N', 64), // how many top-TVL pools count as "on the homepage"
  hydrationDemandN: envMs('HYDRATION_DEMAND_N', 48), // API-requested missing rows per frontpage tick
  hydrationDemandMax: envMs('HYDRATION_DEMAND_MAX', 4_096), // durable queue hard bound
  recentHydrationN: envMs('RECENT_HYDRATION_N', 16), // newest unhydrated rows get a starvation-free quota
  landingCandidateN: envMs('LANDING_CANDIDATE_N', 2_048), // per indexed source; final sort stays bounded
  targetedStateStaleMs: envMs('TARGETED_STATE_STALE_MS', 30_000), // exact pool lookup requests a shared refresh
  apiPoolCacheEntries: envMs('API_POOL_CACHE_ENTRIES', 256), // serialized response LRU hard bound
  apiPoolCacheMs: envMs('API_POOL_CACHE_MS', 60_000), // aligned with the edge freshness budget
  apiPoolCacheStaleMs: envMs('API_POOL_CACHE_STALE_MS', 3_600_000), // last-good origin fallback window
  // --- event tail: reread only the pools that emitted a swap/liquidity event ---
  // These two carry an invariant between them: a tick covers
  // `logtailMs x block rate` blocks, so `logtailMaxBlocks` has to exceed that
  // or every tick permanently gives up the difference. At the defaults, 60s on
  // a ~10-blocks/second chain is 600 blocks against a 5,000 cap — 8x of room.
  // Raising LOGTAIL_MS is what crosses the line (600s put production at 6,000),
  // and logtailWindow() logs the shortfall rather than absorbing it silently.
  logtailMs: envMs('LOGTAIL_MS', 60_000), // fixed shared event refresh; BSC remains disabled by default
  logtailMaxBlocks: envMs('LOGTAIL_MAX_BLOCKS', 5_000), // most blocks one pull may span
  // BSC's common Sync/Swap topics occur across the entire chain; an addressless
  // log query is both expensive and rejected by common BSC providers. Its
  // fixed 60s frontpage sweep already keeps visible rows fresh.
  logtailEnabled: process.env.LOGTAIL_ENABLED === '1' || (process.env.LOGTAIL_ENABLED !== '0' && CHAIN.id !== 56),
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
};

/**
 * Explicit `RPC` (SECRET — never log/print it), then the chain's public RPC.
 * The workspace .env predates multi-chain support and documents its RPC as
 * Robinhood-only, so a BSC process must never inherit that endpoint implicitly.
 */
export function rpcUrl(): string {
  const env = process.env.RPC?.trim();
  if (env) return env;
  if (CHAIN.key !== 'robinhood') return PUBLIC_RPC;
  try {
    const text = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
    const m = text.match(/^\s*RPC\s*=\s*(\S+)\s*$/m);
    if (m) return m[1];
  } catch {
    /* no repo .env — public RPC below */
  }
  return PUBLIC_RPC;
}

/**
 * Public BSC endpoint used by the keyless indexer. Keep this list restricted to
 * providers that support historical eth_getLogs: mixing a fast current-state
 * endpoint that rejects archive reads into the rotator can make the adaptive
 * log scanner incorrectly conclude that even a one-block request is invalid.
 * Every endpoint is chain-id checked before the indexer is allowed to write.
 */
export const BSC_PUBLIC_INDEXER_RPCS = [
  'https://rpc-bnb.blockmachine.io',
] as const;

/**
 * Ordered, de-duplicated RPCs used by the indexer (SECRET — never log them).
 *
 * `INDEXER_RPC_PRIMARY` opts into strict quota isolation: the browser-facing
 * `RPC`/`RPC_UPSTREAM` is then excluded entirely, while an optional dedicated
 * Alchemy endpoint and `INDEXER_RPC_FALLBACK` still provide indexer-only HA.
 * Without an explicit primary, retain the legacy dedicated → shared → fallback
 * order so existing deployments keep working unchanged.
 */
export function rpcUrls(): string[] {
  const primary = process.env.INDEXER_RPC_PRIMARY?.trim();
  const extraKey = process.env.EXTRA_ALCHEMY_RPC_KEY?.trim();
  // Alchemy names its networks per chain; only the chains we have a subdomain
  // for get a dedicated endpoint, the rest fall through to the shared RPC.
  const alchemyNet: Record<number, string> = {
    4663: 'robinhood-mainnet',
    56: 'bnb-mainnet',
  };
  const net = alchemyNet[CHAIN.id];
  const dedicated = extraKey && net ? `https://${net}.g.alchemy.com/v2/${extraKey}` : undefined;
  const secondary = process.env.INDEXER_RPC_FALLBACK?.trim();
  const explicitShared = process.env.RPC?.trim();
  const shared = explicitShared
    ? [rpcUrl()]
    : CHAIN.id === 56
      ? [...BSC_PUBLIC_INDEXER_RPCS]
      : [rpcUrl()];
  const candidates = primary
    ? [primary, dedicated, secondary]
    : [dedicated, ...shared, secondary];
  const present = candidates.filter((url): url is string => typeof url === 'string' && url.length > 0);
  return [...new Set(present)];
}

export const now = () => Math.floor(Date.now() / 1000);

/** terminal-style timestamped log line */
export const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
