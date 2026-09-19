// Emerging-pool discovery ledger — the IO half (docs/EMERGING-POOL-LP-PRD.zh-CN.md
// §4.1, EMG-A01). The pure admission/identity math lives in emergingCore.ts.
//
// Discovery consumes DURABLE sources only — the v4_pools and pools catalog
// tables behind their own cursors — never an in-process fresh list, so a
// restart reconciles anything it missed (§4.1). Source rows enter the ledger
// idempotently; admission is a pure plan over the active rows; every state
// change commits with its append-only event.
//
// What this module deliberately does NOT do: no event scanning (A02), no
// tick/fee checkpoints or minute buckets (A05), no gating (B). UP33 rows
// carry no birth block in the catalog today, so their ages stay NULL here —
// age evidence is filled only by its own source, never guessed (§3.1), and
// A02's PoolCreated streams are what will name them.
import { formatEmergingPoolKey } from './emergingCore';
import { admissionAllowed } from './emergingArchive';
import { CHAIN, EMERGING_TUNE, now, sleep } from './config';
import { pc } from './rpc';
import {
  db,
  enqueueHydrationDemand,
  isLaunchpadToken,
  kvGet,
  kvSet,
  listEmergingActive,
  recordEmergingAges,
  recordEmergingTransition,
  upsertEmergingDiscovery,
  type EmergingLedgerRow,
} from './store';
import { planAdmission, type LedgerRow } from './emergingCore';
import { EMERGING_THRESHOLDS } from './emergingPolicy';

const quietDemoteSeconds = EMERGING_THRESHOLDS.quietDemoteSeconds;

export const emergingObserveEnabled = (): boolean => EMERGING_TUNE.enabled;

const CURSOR_KEYS = {
  v4: 'emerging_cursor:v4-directory',
  v23: 'emerging_cursor:v23-tail',
} as const;
const ADMISSION_SEQ_KEY = 'emerging_admission_seq';

const usdg = CHAIN.addr.STABLE.toLowerCase();

/** Birth-timestamp cache; block → unix sec, survives within a process. */
const blockTs = new Map<number, number>();

async function blockTimestamp(block: number): Promise<number | null> {
  const cached = blockTs.get(block);
  if (cached !== undefined) return cached;
  try {
    const ts = Number((await pc.getBlock({ blockNumber: BigInt(block) })).timestamp);
    blockTs.set(block, ts);
    return ts;
  } catch {
    return null;
  }
}

/** A source cursor advanced only after its rows are committed (§4.2's
 *  watermark discipline, applied to discovery consumption). */
const sourceCursor = (key: string): number => Number(kvGet(key) ?? 0);

type SourceRow = {
  poolKey: string | null;
  venue: 'up33-cl' | 'univ3' | 'univ4';
  canonicalId: string;
  token0: string | null;
  token1: string | null;
  poolCreatedBlock: number | null;
};

function rowToUpsert(row: SourceRow, seenAt: number): Parameters<typeof upsertEmergingDiscovery>[0] | null {
  const poolKey = row.poolKey;
  if (!poolKey) return null;
  return {
    poolKey,
    venue: row.venue,
    canonicalId: row.canonicalId,
    token0: row.token0,
    token1: row.token1,
    baseToken: null,
    quoteIsUsdg: false,
    poolCreatedAt: null,
    tokenCreatedAt: null,
    launchAt: null,
    firstSeenAt: seenAt,
    origin: row.venue === 'univ4' ? 'v4-directory' : 'v23-tail',
  };
}

/**
 * One discovery sweep. Returns the counters the log line and (later, A06)
 * observability surface consume. Every step is bounded: source reads by the
 * overlap watermark, RPC by the per-sweep block-timestamp budget.
 */
export async function runEmergingDiscoverySweep(): Promise<{
  discovered: number;
  admitted: number;
  deferred: number;
  agedOut: number;
  blockTsFetches: number;
  demoted: number;
}> {
  const seenAt = now();
  const counters = { discovered: 0, admitted: 0, deferred: 0, agedOut: 0, blockTsFetches: 0, demoted: 0 };

  // --- consume durable discovery sources ---
  const overlap = seenAt - EMERGING_TUNE.sourceOverlapSec;
  const v4Cursor = sourceCursor(CURSOR_KEYS.v4);
  const v4Rows = (
    db_v4PoolsAfter(v4Cursor > overlap ? v4Cursor : overlap)
  );
  const v23Cursor = sourceCursor(CURSOR_KEYS.v23);
  const v23Rows = db_poolsAfter(v23Cursor > overlap ? v23Cursor : overlap);

  for (const row of [...v4Rows, ...v23Rows]) {
    const upsert = rowToUpsert(row, seenAt);
    if (!upsert) continue;
    // The upsert commits the row and its birth event atomically.
    if (upsertEmergingDiscovery(upsert)) counters.discovered++;
  }

  // --- age evidence, within the per-sweep budget ---
  let fetchBudget = EMERGING_TUNE.blockTsFetchesPerSweep;
  const fetchTs = async (block: number): Promise<number | null> => {
    if (blockTs.has(block)) return blockTs.get(block) ?? null;
    if (fetchBudget <= 0) return null;
    fetchBudget--;
    counters.blockTsFetches++;
    const ts = await blockTimestamp(block);
    if (ts !== null) await sleep(120); // gentle on the RPC
    return ts;
  };

  for (const row of v4Rows) {
    if (row.poolKey === null) continue;
    const poolCreatedAt = row.poolCreatedBlock !== null ? await fetchTs(row.poolCreatedBlock) : null;
    // Base/launch evidence only when the venue can PROVE a new token (§3.1):
    // exactly one side is a launchpad-minted token, and USDG-quote means the
    // other side is the audited stable. Anything less stays NULL/false.
    const b0 = row.token0 !== null && isLaunchpadToken(row.token0);
    const b1 = row.token1 !== null && isLaunchpadToken(row.token1);
    const baseToken = b0 !== b1 ? (b0 ? row.token0 : row.token1) : null;
    let tokenCreatedAt: number | null = null;
    if (baseToken !== null) {
      const launchBlock = db_launchpadTokenBlock(baseToken);
      if (launchBlock !== null) tokenCreatedAt = await fetchTs(launchBlock);
    }
    const quoteIsUsdg =
      baseToken !== null &&
      ((b0 && row.token1?.toLowerCase() === usdg) || (b1 && row.token0?.toLowerCase() === usdg));
    if (poolCreatedAt !== null || tokenCreatedAt !== null || baseToken !== null) {
      recordEmergingAges(row.poolKey, {
        baseToken,
        quoteIsUsdg,
        poolCreatedAt,
        tokenCreatedAt,
        launchAt: tokenCreatedAt,
      }, seenAt);
    }
  }
  for (const row of v23Rows) {
    if (row.poolKey === null || row.poolCreatedBlock === null) continue;
    const poolCreatedAt = await fetchTs(row.poolCreatedBlock);
    if (poolCreatedAt !== null) {
      recordEmergingAges(row.poolKey, {
        baseToken: null, quoteIsUsdg: false,
        poolCreatedAt, tokenCreatedAt: null, launchAt: null,
      }, seenAt);
    }
  }

  // --- admission plan over the active rows (capacity collapses to zero when
  // the §4.5 disk guard says the filesystem is nearly full) ---
  const active = listEmergingActive();

  // --- quiet demotion (变更记录 2026-09-19): tracked pools with zero
  // observed swaps quietDemoteSeconds after first seeing yield their slot.
  // Pinned pools are exempt; nothing is deleted — the row keeps its history
  // and rejoins the queue behind fresh discoveries. ---
  if (active.length) {
    const traded = new Set(
      (db.prepare(`
        SELECT DISTINCT pool_key AS k FROM emerging_chain_events
        WHERE canonical = 1 AND kind IN ('swap', 'v4raw') AND pool_key IS NOT NULL`)
        .all() as Array<{ k: string }>).map((r) => r.k),
    )
    for (const r of active) {
      if (r.admittedRank === null || r.pinnedUntil !== null) continue
      if (seenAt - r.firstSeenAt < quietDemoteSeconds) continue
      if (traded.has(r.poolKey)) continue
      recordEmergingTransition({
        poolKey: r.poolKey, fromState: r.state, toState: 'queued',
        reason: 'quiet_demoted', admittedRank: null, occurredAt: seenAt,
      })
      counters.demoted = (counters.demoted ?? 0) + 1
    }
  }

  const plan = planAdmission({
    rows: active.map((r): LedgerRow & { firstSeenAt: number } => ({
      poolKey: r.poolKey,
      state: r.state as LedgerRow['state'],
      reason: (r.reason ?? null) as LedgerRow['reason'],
      poolCreatedAt: r.poolCreatedAt,
      tokenCreatedAt: r.tokenCreatedAt,
      pinnedUntil: r.pinnedUntil,
      admittedRank: r.admittedRank,
      firstSeenAt: r.firstSeenAt,
    })),
    nowSec: seenAt,
    maxAgeDays: EMERGING_TUNE.trackMaxAgeDays,
    capacity: admissionAllowed() ? EMERGING_TUNE.trackMaxPools : 0,
  });

  const activeByKey = new Map(active.map((r) => [r.poolKey, r]));
  let nextRank = Number(kvGet(ADMISSION_SEQ_KEY) ?? 0);

  for (const poolKey of plan.ageOut) {
    const r = activeByKey.get(poolKey);
    if (!r || r.state === 'aged_out') continue;
    recordEmergingTransition({
      poolKey, fromState: r.state, toState: 'aged_out',
      reason: 'age_exceeded', admittedRank: null, occurredAt: seenAt,
    });
    counters.agedOut++;
  }
  for (const poolKey of plan.admit) {
    const r = activeByKey.get(poolKey);
    if (!r || r.admittedRank !== null) continue;
    nextRank++;
    recordEmergingTransition({
      poolKey, fromState: r.state, toState: 'queued',
      reason: null, admittedRank: nextRank, occurredAt: seenAt,
    });
    counters.admitted++;
  }
  for (const poolKey of plan.defer) {
    const r = activeByKey.get(poolKey);
    if (!r) continue;
    const deferredAlready = r.admittedRank === null && r.reason === 'capacity_deferred';
    if (deferredAlready) continue;
    recordEmergingTransition({
      poolKey, fromState: r.state, toState: 'queued',
      reason: 'capacity_deferred', admittedRank: null, occurredAt: seenAt,
    });
    counters.deferred++;
  }
  kvSet(ADMISSION_SEQ_KEY, String(nextRank));

  // --- advance watermarks only after everything committed ---
  const maxAdded = (rows: Array<{ addedTs: number }>): number =>
    rows.reduce((m, r) => Math.max(m, r.addedTs), 0);
  if (v4Rows.length) kvSet(CURSOR_KEYS.v4, String(Math.max(v4Cursor, maxAdded(v4Rows))));
  if (v23Rows.length) kvSet(CURSOR_KEYS.v23, String(Math.max(v23Cursor, maxAdded(v23Rows))));

  // Any ledger movement invalidates API cursor pages (§8.1's generation).
  if (counters.discovered || counters.admitted || counters.deferred || counters.agedOut) {
    const gen = kvGet('emerging_generation');
    kvSet('emerging_generation', String(Number(gen ?? '0') + 1));
  }

  // The observation page names tokens — queue metadata hydration for every
  // young-set token so symbols fill in within minutes of admission.
  const hydrate = new Set<string>();
  for (const row of [...v4Rows, ...v23Rows]) {
    if (row.token0) hydrate.add(row.token0);
    if (row.token1) hydrate.add(row.token1);
  }
  for (const r of active) {
    if (r.token0) hydrate.add(r.token0);
    if (r.token1) hydrate.add(r.token1);
  }
  enqueueHydrationDemand([...hydrate], 2_000);

  return counters;
}

// --- source queries (kept beside the sweep so their watermarks stay honest) ---

function db_v4PoolsAfter(afterTs: number): Array<SourceRow & { addedTs: number }> {
  return (v4PoolsAfterQ.all(afterTs) as Array<{
    pool_id: string; currency0: string; currency1: string;
    created_block: number | null; added_ts: number;
  }>).map((r) => ({
    poolKey: formatEmergingPoolKey({ chainId: CHAIN.id, venue: 'univ4', canonicalId: r.pool_id }),
    venue: 'univ4' as const,
    canonicalId: r.pool_id,
    token0: r.currency0,
    token1: r.currency1,
    poolCreatedBlock: r.created_block,
    addedTs: r.added_ts,
  }));
}

function db_poolsAfter(afterTs: number): Array<SourceRow & { addedTs: number }> {
  return (poolsAfterQ.all(afterTs) as Array<{
    address: string; proto: string; token0: string; token1: string;
    created_block: number | null; added_ts: number;
  }>).map((r) => {
    const venue = r.proto === 'univ3' ? 'univ3' : 'up33-cl';
    return {
      poolKey: formatEmergingPoolKey({ chainId: CHAIN.id, venue, canonicalId: r.address }),
      venue,
      canonicalId: r.address,
      token0: r.token0,
      token1: r.token1,
      poolCreatedBlock: r.created_block,
      addedTs: r.added_ts,
    };
  });
}

function db_launchpadTokenBlock(token: string): number | null {
  const r = launchpadBlockQ.get(token) as { created_block: number } | undefined;
  return r?.created_block ?? null;
}

const v4PoolsAfterQ = db.prepare(
  `SELECT pool_id, currency0, currency1, created_block, added_ts
   FROM v4_pools WHERE added_ts > ? ORDER BY added_ts ASC`,
);
const poolsAfterQ = db.prepare(
  `SELECT address, proto, token0, token1, created_block, added_ts
   FROM pools WHERE proto IN ('up33cl', 'univ3') AND added_ts > ? ORDER BY added_ts ASC`,
);
const launchpadBlockQ = db.prepare(
  'SELECT created_block FROM v4_launchpad_tokens WHERE address = ?',
);
