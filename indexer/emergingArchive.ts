// Emerging retention, archive and resource guards (docs/EMERGING-POOL-LP-PRD
// .zh-CN.md §4.5, EMG-A06).
//
// Retention is asymmetric by provenance:
//   - minute buckets are DERIVED (recomputable from events whose retention
//     strictly contains theirs) — pruned outright past 7 days;
//   - raw chain events are PRIMARY — exported to a checksummed NDJSON archive
//     and verified read-back BEFORE any deletion, per §4.5's "删原始前验证归
//     档可读、哈希和依赖完整";
//   - the discovery/observation ledger is the §4.1 account of what was seen
//     and admitted — kept ≥365 days, never archived away.
//
// Resource guard (§4.5): below 20% free disk the pipeline stops ADMITTING new
// pools (tracking keeps running); below 10% it stops non-essential writes
// (aggregation continues — it is what freshness claims rest on — but the
// admission queue and event scans pause). Existing pinned/experiment data is
// never a deletion candidate in either state.
import { createHash } from 'node:crypto';
import { statfsSync, unlinkSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHAIN, EMERGING_TUNE, log, now } from './config';
import { db, kvGet, kvSet } from './store';

const ARCHIVE_DIR = resolve('indexer/data/emerging/archive');
const EVENTS_RETENTION_SEC = 30 * 86_400;
const MINUTES_RETENTION_SEC = 7 * 86_400;

/** Free-disk fraction of the DB's filesystem, or null when unmeasurable. */
export function diskFreeFraction(): number | null {
  try {
    const fsStat = statfsSync(resolve('indexer/data'));
    const total = Number(fsStat.blocks);
    const free = Number(fsStat.bavail);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(free) || free < 0) return null;
    return free / total;
  } catch {
    return null;
  }
}

/** §4.5: <20% free → no new admissions (pins and existing tracking hold). */
export function admissionAllowed(): boolean {
  const free = diskFreeFraction();
  return free === null || free >= 0.2;
}

/** §4.5: <10% free → non-essential writes stop and an alert is warranted. */
export function essentialWritesOnly(): boolean {
  const free = diskFreeFraction();
  return free !== null && free < 0.1;
}

export type RetentionResult = {
  prunedBuckets: number;
  archivedEvents: number;
  prunedEvents: number;
  verified: boolean;
};

/**
 * One retention pass. The archive is written and RE-READ (hash + row count
 * verified) before the corresponding rows are deleted; a verification failure
 * leaves the live rows untouched — pruning never outruns provable archiving.
 */
export function runEmergingRetentionSweep(): RetentionResult {
  const t = now();
  const result: RetentionResult = { prunedBuckets: 0, archivedEvents: 0, prunedEvents: 0, verified: false };

  // Derived minute buckets: prune outright.
  result.prunedBuckets = Number(
    db.prepare('DELETE FROM pool_minute_buckets WHERE minute_ts < ?').run(t - MINUTES_RETENTION_SEC).changes,
  );

  // Primary events: archive → verify → delete.
  const cutoff = t - EVENTS_RETENTION_SEC;
  const rows = db
    .prepare(`SELECT chain_id, tx_hash, log_index, block_number, block_hash, tx_index,
                     block_ts, contract, kind, pool_key, token, payload,
                     observed_at, available_at, canonical
              FROM emerging_chain_events WHERE available_at < ?`)
    .all(cutoff) as Array<Record<string, unknown>>;
  if (rows.length) {
    const ndjson = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const hash = createHash('sha256').update(ndjson).digest('hex');
    const file = resolve(ARCHIVE_DIR, `events-${CHAIN.key}-${t}.ndjson`);
    mkdirSync(ARCHIVE_DIR, { recursive: true });
    writeFileSync(file, ndjson);
    const readBack = readFileSync(file, 'utf8');
    const readHash = createHash('sha256').update(readBack).digest('hex');
    const readCount = readBack.trim() === '' ? 0 : readBack.trim().split('\n').length;
    result.verified = readHash === hash && readCount === rows.length;
    if (!result.verified) {
      try { unlinkSync(file); } catch { /* leave the corrupt artifact for inspection */ }
      log(`[emerging-retention] archive verification FAILED (${rows.length} rows kept live)`);
      return result;
    }
    kvSet(`emerging_archive:${hash}`, JSON.stringify({ file, rows: rows.length, ts: t }));
    result.archivedEvents = rows.length;
    result.prunedEvents = Number(
      db.prepare('DELETE FROM emerging_chain_events WHERE available_at < ?').run(cutoff).changes,
    );
  }
  return result;
}

/** §10.2 observability: the counters an operator (or alert) reads first. */
export function getEmergingObservability(): Record<string, unknown> {
  const counts = db
    .prepare('SELECT state, COUNT(*) AS n FROM emerging_discovery GROUP BY state')
    .all() as Array<{ state: string; n: number }>;
  const cursors = db
    .prepare('SELECT stream_key, block_number, complete_through_ts, status FROM emerging_scan_cursors WHERE chain_id = ?')
    .all(CHAIN.id) as Array<Record<string, unknown>>;
  const events = db
    .prepare('SELECT canonical, COUNT(*) AS n FROM emerging_chain_events GROUP BY canonical')
    .all() as Array<{ canonical: number; n: number }>;
  return {
    generatedAt: now(),
    diskFreeFraction: diskFreeFraction(),
    admissionAllowed: admissionAllowed(),
    essentialWritesOnly: essentialWritesOnly(),
    discovery: Object.fromEntries(counts.map((r) => [r.state, r.n])),
    trackMaxPools: EMERGING_TUNE.trackMaxPools,
    streams: cursors,
    eventsCanonical: events.find((e) => e.canonical === 1)?.n ?? 0,
    eventsArchived: events.find((e) => e.canonical === 0)?.n ?? 0,
    lastGeneration: kvGet('emerging_generation') ?? '0',
  };
}
