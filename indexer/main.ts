// LP Terminal pool indexer — catalog (factory events/enumeration) +
// on-chain state sweeps + GT enrichment, served over a tiny read-only API.
// Run: `npm run indexer` (tsx). Data defaults to a chain-specific SQLite file.
//
// Boot: catalog backfill → bounded useful seed → GT cycle → reprice → ready.
// Loops: logtail 60s (reread pools that emitted events) · frontpage 60s
//        (fixed top-N + on-demand hydration) · factory tail 5min · hot 10min
//        · active 4h · GT stats 5min (off the RPC queue). Multi-million
//        catalogs never receive a repeating full-state census.
// The API starts listening immediately; `ready:false` in responses tells the
// frontend to keep using its client-side fallback until the first pass lands.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { CHAIN, INDEX_V2, V4, log, now, PORT, sleep, TUNE } from './config';
import { RpcChainMismatchError, safeError, usingPrivateRpc, verifyRpcChain } from './rpc';
import { backfillV3, syncV2, tailV3 } from './catalog';
import {
  computeTvlFor,
  computeV4Tvl,
  ensurePoolTokenMeta,
  ensureTokenMeta,
  reprice,
  sweepAllState,
  sweepState,
} from './state';
import { statsCycle } from './stats';
import { runStockOriginSweep } from './stockOrigin';
import { logtail } from './logtail';
import {
  activeAddrs,
  bootstrapAddrs,
  clPoolCount,
  databaseIdentity,
  db,
  enqueueHydrationDemand,
  frontpageAddrs,
  hydrationDemandCount,
  hotAddrs,
  kvGet,
  kvSet,
  poolCount,
  poolCounts,
  rebuildSolverConnectorRank,
  recentUnhydratedAddrs,
  settleHydrationDemand,
  takeHydrationDemand,
  tx,
  v4PoolCount,
} from './store';
import { startApi } from './api';
import { backfillV4, ensureV4TokenMeta, refreshV4FeaturedStats, tailV4 } from './v4Subgraph';
import { backfillV4Rpc, tailV4Rpc } from './v4Rpc';
import { tailV4Positions } from './v4Positions';
import { syncUp33Cl } from './up33';
import { POOL_RANK_ENABLED, runPoolRankCycle } from './poolRank';
import { refreshRecommendationSamples } from './recommendation';

/**
 * Whether this chain has a v4 pool DIRECTORY at all — from a subgraph, or from
 * the scoped RPC scan that stands in where none is published.
 */
const HAS_V4_DIRECTORY = !!(V4?.poolSubgraph || V4?.rpcDirectory);
/** Whether this chain's v4 position OWNERSHIP is indexed by a Transfer replay. */
const HAS_V4_POSITION_INDEX = !!V4?.positionRpcIndex;
import { CoalescingScheduler } from './coalescingScheduler';

let refreshQueue = Promise.resolve();

const positiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

// Small catalogs retain the original complete-before-ready semantics. A
// multi-million-row directory primes a bounded useful set, then enriches only
// top/hot/recent/API-requested rows. Identity completeness remains independent.
const PROGRESSIVE_CATALOG_THRESHOLD = positiveInt(process.env.INDEXER_PROGRESSIVE_CATALOG_THRESHOLD, 250_000);
// INDEXER_CENSUS_PAGE_SIZE is accepted only as an upgrade bridge. Large
// catalogs no longer run a repeating full-state census; this limit caps each
// useful tier (hot, active, stats and exact/on-demand hydration work).
const PROGRESSIVE_TIER_LIMIT = positiveInt(
  process.env.INDEXER_PROGRESSIVE_TIER_LIMIT ?? process.env.INDEXER_CENSUS_PAGE_SIZE,
  1_000,
);
const BOOTSTRAP_POOL_LIMIT = positiveInt(process.env.INDEXER_BOOTSTRAP_POOL_LIMIT, 256);
let progressiveCatalog = false;

const REPRICE_WORKER_KIND = 'lp-terminal-full-reprice';

// The ranked connector projection costs a full scan of the priced catalog, so
// it stays off until it has been measured against a real database and until a
// solver actually consumes it. Nothing else reads the projection, so the flag
// only decides whether it is kept current.
const CONNECTOR_RANK_ENABLED = process.env.INDEXER_CONNECTOR_RANK === '1';

type ConnectorRankOutcome =
  | { ok: true; rows: number; tokens: number; ms: number }
  | { ok: false; error: string };
type RepriceResult = {
  priced: number;
  tvlPools: number;
  connectorRank: ConnectorRankOutcome | null;
};
type RepriceWorkerMessage = { ok: true; result: RepriceResult } | { ok: false; error: string };

function runRepriceWorkerThread(): Promise<RepriceResult> {
  return new Promise((resolve, reject) => {
    // A Worker resolves its entry point before an inherited tsx hook is
    // reliably active on Node 22. Start from a native module which registers
    // tsx first, then imports this TypeScript entry point.
    const worker = new Worker(new URL('./tsxWorker.mjs', import.meta.url), {
      workerData: { kind: REPRICE_WORKER_KIND, entry: import.meta.url },
    });
    let settled = false;
    worker.once('message', (message: RepriceWorkerMessage) => {
      settled = true;
      if (message.ok) resolve(message.result);
      else reject(new Error(message.error));
    });
    worker.once('error', (error) => {
      if (!settled) reject(error);
    });
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`reprice worker exited before publishing a result (code ${code})`));
    });
  });
}

async function runFullReprice(trigger: string): Promise<RepriceResult> {
  const started = now();
  const startedMs = Date.now();
  tx(() => {
    kvSet('reprice_busy', '1');
    kvSet('reprice_started_at', String(started));
    kvSet('reprice_trigger', trigger);
    kvSet('reprice_error', '');
    kvSet('reprice_error_at', '');
  });
  try {
    const result = await runRepriceWorkerThread();
    const rank = result.connectorRank;
    tx(() => {
      kvSet('reprice_completed_at', String(now()));
      kvSet('reprice_duration_ms', String(Date.now() - startedMs));
      kvSet('reprice_priced_tokens', String(result.priced));
      kvSet('reprice_tvl_pools', String(result.tvlPools));
      kvSet('reprice_catalog_count', String(poolCount()));
      kvSet('reprice_error', '');
      // A failed rebuild rolls back, taking its own provenance stamps with it,
      // so the error can only be recorded from outside that transaction.
      if (rank !== null) {
        kvSet('connector_rank_error', rank.ok ? '' : rank.error);
        kvSet('connector_rank_error_at', rank.ok ? '' : String(now()));
      }
    });
    if (rank?.ok)
      log(`[connectors] ranked ${rank.rows} edges over ${rank.tokens} tokens in ${(rank.ms / 1000).toFixed(1)}s`);
    else if (rank) log('[connectors] ranking failed:', rank.error);
    return result;
  } catch (error) {
    tx(() => {
      kvSet('reprice_error', safeError(error));
      kvSet('reprice_error_at', String(now()));
    });
    throw error;
  } finally {
    kvSet('reprice_busy', '0');
  }
}

const fullRepriceScheduler = new CoalescingScheduler(runFullReprice);
function requestFullReprice(trigger: string): Promise<RepriceResult> {
  tx(() => {
    kvSet('reprice_requested_at', String(now()));
    kvSet('reprice_requested_trigger', trigger);
  });
  return fullRepriceScheduler.request(trigger);
}

function recordClTieredPolicy(): void {
  tx(() => {
    kvSet('cl_hydration_policy', 'tiered-on-demand');
    kvSet('cl_hydration_target_count', String(clPoolCount()));
    // Retire strict-bootstrap provenance from an older seed. Completeness of
    // official catalog cursors remains the READY gate; permissionless token
    // behaviour never is.
    kvSet('cl_bootstrap_complete', '0');
  });
}

function recordV4TailError(error: string | null): void {
  tx(() => {
    kvSet('v4_tail_error', error ?? '');
    kvSet('v4_tail_error_at', error === null ? '' : String(now()));
  });
}

function recordV4PositionsTailError(error: string | null): void {
  tx(() => {
    kvSet('v4_positions_tail_error', error ?? '');
    kvSet('v4_positions_tail_error_at', error === null ? '' : String(now()));
  });
}

function recordV23TailError(error: string | null): void {
  const at = String(now());
  tx(() => {
    kvSet('v23_tail_error', error ?? '');
    kvSet('v23_tail_error_at', error === null ? '' : at);
    if (error === null) kvSet('v23_tail_success_at', at);
  });
}

async function refreshV23CatalogTail(): Promise<{
  freshV3: string[];
  v2Delta: Awaited<ReturnType<typeof syncV2>>;
}> {
  try {
    const freshV3 = await tailV3();
    const v2Delta = INDEX_V2 ? await syncV2() : { added: 0, fresh: [] };
    // Catalog identity is current at this point. State/metadata enrichment is a
    // separate, progressive concern and must not keep topology degraded.
    recordV23TailError(null);
    return { freshV3, v2Delta };
  } catch (error) {
    recordV23TailError(safeError(error));
    throw error;
  }
}

function enqueueRefresh(fn: () => Promise<void>): Promise<void> {
  const run = refreshQueue.then(fn, fn);
  refreshQueue = run;
  return run;
}

/**
 * setTimeout-chained loop. `queued` (default) routes the tick through the shared
 * RPC queue so state sweeps neither overlap nor get dropped. Stats runs
 * off-queue: it hits GeckoTerminal over HTTP (not the RPC) with ~30 calls paced
 * ≥2.6s apart, so enqueuing it would pin the queue for over a minute and starve
 * the frontpage sweep. It touches the DB only in synchronous transactions,
 * which JS's single thread already serializes against the sweeps' writes.
 */
function loop(name: string, ms: number, fn: () => Promise<void>, queued = true): void {
  const tick = async () => {
    try {
      await (queued ? enqueueRefresh(fn) : fn());
    } catch (e) {
      log(`[${name}] error:`, safeError(e));
    }
    setTimeout(tick, ms);
  };
  setTimeout(tick, ms);
}

const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
  const t0 = Date.now();
  const r = await fn();
  return [r, Date.now() - t0];
};

let v23TailLoopStarted = false;

async function runV23Tail(): Promise<void> {
  const { freshV3, v2Delta } = await refreshV23CatalogTail();
  const freshUp33 = await syncUp33Cl();
  const fresh = [...freshV3, ...v2Delta.fresh, ...freshUp33];
  const added = freshV3.length + v2Delta.added + freshUp33.length;
  if (!added) return;
  log(`[v23-tail] ${added} new address-keyed pools`);
  await ensurePoolTokenMeta(fresh);
  await sweepState(fresh);
  computeTvlFor(fresh);
}

function startV23TailLoop(): void {
  if (v23TailLoopStarted) return;
  v23TailLoopStarted = true;
  // Identity freshness is an independent solver contract. Do not queue it
  // behind V4 bootstrap or display enrichment.
  loop('v23-tail', TUNE.tailMs, runV23Tail, false);
}

async function initialRefresh(): Promise<void> {
  let freshUp33: string[] = [];
  // Each chain's v2 venues complete first. On BSC this independently resumes
  // both the official Uniswap and Pancake allPairs arrays. V3 then performs its
  // chain-specific bootstrap/catch-up (BSC: Graph snapshot + bounded RPC tail).
  if (kvGet('solver_v23_boot_ready') !== '1') {
    try {
      if (INDEX_V2) {
        const [v2Delta, msV2] = await timed(syncV2);
        if (v2Delta.added) log(`[catalog] v2 venue sync: +${v2Delta.added} pairs (${(msV2 / 1000).toFixed(0)}s)`);
      }
      const [addedV3, msV3] = await timed(backfillV3);
      if (addedV3 > 0 || !kvGet('v3_boot_logged')) {
        log(`[catalog] v3 venue bootstrap done: +${addedV3} pools (${(msV3 / 1000).toFixed(0)}s)`);
        kvSet('v3_boot_logged', '1');
      }
      freshUp33 = await syncUp33Cl();
      // A persisted tail failure is cleared only after both address-keyed
      // catalog families have been re-proved during this boot.
      recordV23TailError(null);
      kvSet('solver_v23_boot_ready', '1');
    } catch (error) {
      recordV23TailError(safeError(error));
      throw error;
    }
  }
  startV23TailLoop();
  if (HAS_V4_DIRECTORY) {
    const [addedV4, msV4] = await timed(V4?.rpcDirectory ? backfillV4Rpc : backfillV4);
    recordV4TailError(null);
    kvSet('solver_v4_boot_ready', '1');
    if (addedV4 > 0 || !kvGet('v4_boot_logged')) {
      log(`[catalog] univ4 bootstrap done: +${addedV4} candidate pools (${(msV4 / 1000).toFixed(0)}s)`);
      kvSet('v4_boot_logged', '1');
    }
    const metaV4 = await ensureV4TokenMeta();
    if (metaV4) log(`[tokens] v4 metadata fetched for ${metaV4} currencies`);
    // Featured stats come from The Graph, so they stay with the Graph
    // directory; an RPC directory simply has no volume/TVL feed to refresh.
    if (V4?.poolSubgraph)
      await refreshV4FeaturedStats()
        .then((count) => log(`[stats] univ4 featured Graph refresh: ${count} pools`))
        .catch((error) => log('[stats] univ4 featured refresh failed:', safeError(error)));
  }
  if (HAS_V4_POSITION_INDEX) {
    // Ownership is a best-effort reader concern, never a catalog readiness gate:
    // the first full Transfer replay is a long scan, so it must not block boot.
    // The periodic `v4-positions` tail owns the scan; the endpoint answers empty
    // until the replay is caught up.
    log('[catalog] univ4 position ownership index enabled; backfill runs on the v4-positions tail');
  }
  const counts = poolCounts().map((c) => `${c.proto}=${c.n}`);
  if (HAS_V4_DIRECTORY) counts.push(`univ4=${v4PoolCount()}`);
  log('[catalog]', counts.join(' '));

  const totalPools = poolCount();
  progressiveCatalog = totalPools > PROGRESSIVE_CATALOG_THRESHOLD;
  if (progressiveCatalog) {
    if (CHAIN.id === 56) recordClTieredPolicy();

    // GT's bounded top lists identify useful pools without ever admitting an
    // identity (the factory-built catalog remains the gate in stats.ts).
    await statsCycle().catch((e) => log('[stats] market cycle failed:', safeError(e)));
    const seeds = [...new Set([
      ...bootstrapAddrs(Math.max(BOOTSTRAP_POOL_LIMIT, TUNE.frontpageN)),
      ...freshUp33,
    ])];
    const [metaN, msMeta] = await timed(() => ensurePoolTokenMeta(seeds));
    if (metaN) log(`[tokens] boot metadata fetched for ${metaN} tokens (${(msMeta / 1_000).toFixed(1)}s)`);
    const [swept, msSweep] = await timed(() => sweepState(seeds));
    log(`[sweep] boot seed ${swept}/${seeds.length} pools (${(msSweep / 1_000).toFixed(1)}s)`);
    if (seeds.length && !swept) log('[sweep] boot seeds were unreadable; catalog READY will rely on demand hydration');
    log(
      `[catalog] tiered enrichment enabled (${totalPools} pools > ${PROGRESSIVE_CATALOG_THRESHOLD}); ` +
        `bounded sets capped at ${PROGRESSIVE_TIER_LIMIT}`,
    );
  } else {
    const [metaN, msMeta] = await timed(ensureTokenMeta);
    if (metaN) log(`[tokens] metadata fetched for ${metaN} tokens (${(msMeta / 1000).toFixed(0)}s)`);

    const [{ done: swept, total }, msSweep] = await timed(sweepAllState);
    log(`[sweep] full ${swept}/${total} pools (${(msSweep / 1000).toFixed(0)}s)`);
    if (total && !swept) throw new Error('initial state sweep updated no pools');

    await statsCycle().catch((e) => log('[stats] market cycle failed:', safeError(e)));
  }
  const pr = await requestFullReprice('boot');
  log(`[price] ${pr.priced} tokens priced · tvl on ${pr.tvlPools} pools`);
  await refreshRecommendationSamples()
    .then((sampled) => log(`[analytics] sampled ${sampled.addressPools} address pools + ${sampled.v4Pools} v4 pools`))
    .catch((error) => log('[analytics] initial sample failed:', safeError(error)));

  kvSet('ready', '1');
  kvSet('snapshot_asof', String(now()));
  kvSet('boot_error', '');
  log(`READY — http://localhost:${PORT}/api/health`);
}

function startLoops(): void {
  // Shared event freshness is fixed-cadence: CDN hits cannot drive a reliable
  // origin-side demand signal.
  if (TUNE.logtailEnabled) loop('logtail', TUNE.logtailMs, logtail);
  // Keep the shared landing set fresh even absent a trade, and drain the
  // bounded hydration queue populated by exact/recent catalog rows.
  loop('frontpage', TUNE.frontpageMs, async () => {
    const top = frontpageAddrs(TUNE.frontpageN);
    const demand = takeHydrationDemand(TUNE.hydrationDemandN);
    const recent = recentUnhydratedAddrs(TUNE.recentHydrationN);
    enqueueHydrationDemand(recent, TUNE.hydrationDemandMax);
    const hydration = [...new Set([...demand, ...recent])];
    const targets = [...new Set([...hydration, ...top])];
    if (!targets.length) return;
    try {
      // HTTP only enqueues official catalog identities. The background loop
      // performs the safety-sensitive chain reads in this exact order.
      await ensurePoolTokenMeta(hydration);
      await sweepState(targets);
      computeTvlFor(targets);
    } finally {
      if (hydration.length) {
        const result = settleHydrationDemand(hydration);
        if (result.retry)
          log(`[hydrate] ${result.ready} ready, ${result.retry} retry ` + `(${hydrationDemandCount()} queued)`);
      }
    }
  });
  if (HAS_V4_DIRECTORY)
    loop('v4-tail', V4?.rpcDirectory ? TUNE.v4TailMs : TUNE.tailMs, async () => {
      try {
        const freshV4 = await (V4?.rpcDirectory ? tailV4Rpc() : tailV4());
        if (freshV4.length) {
          log(`[tail] ${freshV4.length} new univ4 pools`);
        }
        // Retry missing metadata even when the Initialize overlap no longer
        // reports the pool as newly inserted. Otherwise one transient ERC-20
        // read failure could leave that pool undiscoverable until a restart.
        const metaV4 = await ensureV4TokenMeta();
        if (metaV4) log(`[tokens] v4 metadata fetched for ${metaV4} currencies`);
        recordV4TailError(null);
      } catch (error) {
        recordV4TailError(safeError(error));
        throw error;
      }
    });
  // Off the shared queue: the first replay is a long scan and must not stall
  // the frontpage/sweep/tail work queued behind it (same reasoning as stats).
  if (HAS_V4_POSITION_INDEX)
    loop('v4-positions', TUNE.v4TailMs, async () => {
      try {
        const applied = await tailV4Positions();
        if (applied) log(`[tail] ${applied} v4 position ownership changes`);
        recordV4PositionsTailError(null);
      } catch (error) {
        recordV4PositionsTailError(safeError(error));
        throw error;
      }
    }, false);
  loop('hot', TUNE.hotSweepMs, async () => {
    const hot = hotAddrs(progressiveCatalog ? PROGRESSIVE_TIER_LIMIT : undefined);
    await sweepState(hot);
    computeTvlFor(hot);
  });
  loop('active', TUNE.fullSweepMs, async () => {
    const addrs = activeAddrs(progressiveCatalog ? PROGRESSIVE_TIER_LIMIT : undefined);
    const [swept, ms] = await timed(() => sweepState(addrs));
    if (progressiveCatalog) {
      computeTvlFor(addrs);
      log(`[sweep] active ${swept}/${addrs.length} pools (${(ms / 1000).toFixed(0)}s)`);
    } else {
      const p = await requestFullReprice('active');
      log(
        `[sweep] active ${swept}/${addrs.length} pools (${(ms / 1000).toFixed(0)}s) · ${p.priced} tokens priced · tvl on ${p.tvlPools}`,
      );
    }
  });
  loop('analytics', TUNE.analyticsMs, async () => {
    const sampled = await refreshRecommendationSamples();
    if (sampled.addressPools || sampled.v4Pools)
      log(`[analytics] sampled ${sampled.addressPools} address pools + ${sampled.v4Pools} v4 pools`);
  });
  // A repeating keyset census over BSC's multi-million identity directory took
  // longer than its nominal interval and spent millions of reads on dust. Large
  // catalogs retain every identity but hydrate only bounded useful tiers.
  if (!progressiveCatalog)
    loop('census', TUNE.censusMs, async () => {
      const [{ done: swept, total }, ms] = await timed(sweepAllState);
      const p = await requestFullReprice('census');
      log(`[sweep] census ${swept}/${total} pools (${(ms / 1000).toFixed(0)}s) · tvl on ${p.tvlPools}`);
      if (total && !swept) throw new Error('census state sweep updated no pools');
      kvSet('snapshot_asof', String(now()));
    });
  if (progressiveCatalog)
    loop(
      'reprice',
      TUNE.repriceMs,
      async () => {
        const result = await requestFullReprice('periodic');
        log(`[price] worker complete: ${result.priced} tokens priced · ` + `tvl on ${result.tvlPools} pools`);
      },
      false,
    );
  loop(
    'stats',
    TUNE.statsMs,
    async () => {
      const matched = await statsCycle();
      if (progressiveCatalog) computeTvlFor(matched.slice(0, PROGRESSIVE_TIER_LIMIT));
      else await requestFullReprice('stats');
    },
    false, // off the RPC queue — paced GT HTTP must not block the frontpage sweep
  );
  if (V4?.poolSubgraph)
    loop(
      'v4-stats',
      TUNE.v4StatsMs,
      async () => {
        const count = await refreshV4FeaturedStats();
        // Immediately, in the same tick: the quantities that just landed are
        // this figure's only input besides prices, and the API ranks on it.
        const priced = computeV4Tvl();
        log(`[stats] univ4 featured Graph refresh: ${count} pools · tvl on ${priced}`);
      },
      false,
    );
  // Off the RPC queue: one storage read per token, and it must not sit in front
  // of the frontpage sweep. Absent entirely on a chain that can prove no
  // issuer, rather than present and answering "nobody" about everything.
  if (CHAIN.stockIssuers.length)
    loop('stock', TUNE.stockOriginMs, () => runStockOriginSweep(TUNE.stockOriginN).then(), false);
  // Pool ranking reference table: fixed half-day cadence, off the RPC queue
  // (its own budget is ~30 paced GT OHLCV calls plus two small multicalls).
  // The first pass lands shortly after READY so a fresh deployment does not
  // serve an empty ranking for half a day; a run that overlaps the boot's own
  // work is harmless — the cycle guards itself against concurrent execution.
  if (POOL_RANK_ENABLED) {
    const cycle = async (): Promise<void> => {
      try {
        await runPoolRankCycle();
      } catch (e) {
        // runPoolRankCycle records its error in kv; log only.
        log('[pool-rank] cycle failed:', safeError(e));
      }
    };
    setTimeout(() => void cycle(), 120_000);
    loop('pool-rank', TUNE.poolRankMs, cycle, false);
  }
}

async function boot(): Promise<void> {
  log(
    `lp-indexer starting — chain: ${CHAIN.key}:${CHAIN.id} · db: ${databaseIdentity.status} ·`,
    usingPrivateRpc ? 'rpc: private (.env)' : 'rpc: public',
    INDEX_V2 ? '· v2: enabled' : '· v2: disabled',
  );
  // A reused seed may have ready=1 from its previous clean boot. Clear it
  // before exposing the API so an unreachable/wrong RPC cannot serve stale
  // catalog state as healthy while this boot retries.
  kvSet('ready', '0');
  kvSet('solver_v23_boot_ready', '0');
  kvSet('solver_v4_boot_ready', '0');
  kvSet('boot_error', '');
  startApi();

  for (;;) {
    try {
      await verifyRpcChain();
      await enqueueRefresh(initialRefresh);
      startLoops();
      return;
    } catch (e) {
      const error = safeError(e);
      kvSet('boot_error', error);
      // A reachable endpoint explicitly reporting another chain is not a
      // transient outage. Never start discovery or retry against it.
      if (e instanceof RpcChainMismatchError) throw e;
      const retryMs = 60_000; // fixed short retry — independent of the (slow) hot cadence
      log(`[boot] error; retrying in ${retryMs / 1_000}s:`, error);
      await sleep(retryMs);
    }
  }
}

/**
 * The connector ranking's only input is tvl_usd, which the reprice above has
 * just rewritten. Rebuilding it here makes the projection exactly as fresh as
 * its input with no second staleness clock, keeps a multi-second write
 * transaction off the serving event loop, and stops the two long writers from
 * contending for the database lock.
 *
 * A ranking failure is reported rather than thrown: prices have already
 * committed by this point and are the reprice's actual product, while a stale
 * ranking only costs the solver a candidate it might have considered.
 */
function rebuildConnectorRankInWorker(): ConnectorRankOutcome | null {
  if (!CONNECTOR_RANK_ENABLED) return null;
  const startedMs = Date.now();
  try {
    const meta = rebuildSolverConnectorRank();
    return { ok: true, rows: meta.rows, tokens: meta.tokens, ms: Date.now() - startedMs };
  } catch (error) {
    return { ok: false, error: safeError(error) };
  }
}

async function workerEntry(): Promise<void> {
  if (!parentPort) throw new Error('reprice worker has no parent port');
  try {
    const result = reprice();
    parentPort.postMessage({
      ok: true,
      result: { ...result, connectorRank: rebuildConnectorRankInWorker() },
    } satisfies RepriceWorkerMessage);
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: safeError(error),
    } satisfies RepriceWorkerMessage);
  } finally {
    db.close();
    parentPort.close();
  }
}

if (!isMainThread && (workerData as { kind?: string } | null)?.kind === REPRICE_WORKER_KIND) {
  void workerEntry();
} else {
  if (kvGet('reprice_busy') === '1') {
    kvSet('reprice_busy', '0');
    kvSet('reprice_error', 'previous reprice worker was interrupted');
    kvSet('reprice_error_at', String(now()));
  }
  process.on('SIGINT', () => {
    log('shutting down');
    db.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    db.close();
    process.exit(0);
  });

  boot().catch((e) => {
    log('FATAL boot:', safeError(e));
    process.exit(1);
  });
}
