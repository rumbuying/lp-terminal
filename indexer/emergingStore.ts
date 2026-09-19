// Persistence for emerging raw events, state checkpoints and scan cursors
// (docs/EMERGING-POOL-LP-PRD.zh-CN.md §4.2/§4.3, EMG-A02). Schema lives in
// store.ts with the rest of the migrations; this module is the only writer.
//
// The invariants the scanner depends on:
//  - event inserts are idempotent by (chain_id, tx_hash, log_index) — a page
//    re-read over an overlap never double-counts;
//  - a scan batch commits its events AND its cursor advance in ONE
//    transaction, so a crash can strand the last page's work but never
//    advance the cursor past uncommitted rows;
//  - a reorg archives (canonical=0) instead of deleting: §4.3 keeps orphaned
//    versions so the reorg itself stays auditable.
import { CHAIN, now } from './config';
import { db, tx } from './store';

export type EmergingEventKind =
  | 'swap'
  | 'mint'
  | 'burn'
  | 'v4raw'
  | 'transfer'

export type EmergingEventInsert = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  txIndex: number;
  blockTs: number | null;
  contract: string;
  kind: EmergingEventKind;
  poolKey: string | null;
  token: string | null;
  payload: Record<string, unknown>;
};

export type EmergingCursor = {
  streamKey: string;
  blockNumber: number;
  blockHash: string;
  completeThroughTs: number | null;
  status: 'active' | 'reorg_repair' | 'data_gap';
  lastScanAt: number;
};

const chainId = CHAIN.id;

const cursorGetQ = db.prepare(`
  SELECT stream_key AS streamKey, block_number AS blockNumber, block_hash AS blockHash,
         complete_through_ts AS completeThroughTs, status, last_scan_at AS lastScanAt
  FROM emerging_scan_cursors WHERE chain_id = ? AND stream_key = ?
`);
const cursorUpsertQ = db.prepare(`
  INSERT INTO emerging_scan_cursors(chain_id, stream_key, block_number, block_hash, last_scan_at, complete_through_ts, status)
  VALUES (?, ?, ?, ?, ?, ?, 'active')
  ON CONFLICT(chain_id, stream_key) DO UPDATE SET
    block_number = excluded.block_number,
    block_hash = excluded.block_hash,
    last_scan_at = excluded.last_scan_at,
    complete_through_ts = MAX(COALESCE(complete_through_ts, excluded.complete_through_ts), excluded.complete_through_ts),
    status = 'active'
`);
const eventInsertQ = db.prepare(`
  INSERT OR IGNORE INTO emerging_chain_events(
    chain_id, tx_hash, log_index, block_number, block_hash, tx_index, block_ts,
    contract, kind, pool_key, token, payload, observed_at, available_at, canonical
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
`);
// Strictly greater than the ancestor: the ancestor block itself is on BOTH
// chains (its hash is the reorg proof), so its events stay canonical.
const archiveQ = db.prepare(`
  UPDATE emerging_chain_events SET canonical = 0
  WHERE chain_id = ? AND canonical = 1 AND block_number > ?
`);
const cursorStatusQ = db.prepare(`
  UPDATE emerging_scan_cursors SET status = ?, last_scan_at = ?
  WHERE chain_id = ? AND stream_key = ?
`);
const cursorResetQ = db.prepare(`
  UPDATE emerging_scan_cursors
  SET block_number = ?, block_hash = ?, complete_through_ts = NULL, status = 'active', last_scan_at = ?
  WHERE chain_id = ? AND stream_key = ?
`);

export const getEmergingCursor = (streamKey: string): EmergingCursor | null =>
  (cursorGetQ.get(chainId, streamKey) as EmergingCursor | undefined) ?? null;

export const setEmergingStreamStatus = (streamKey: string, status: 'reorg_repair' | 'data_gap', at: number): void => {
  cursorStatusQ.run(status, at, chainId, streamKey);
};

/**
 * One atomic scan batch: the page's events land with the cursor that proves
 * them. `completeThroughTs` is the dated timestamp of the cursor block, so
 * downstream completeness (§4.4) is a chain-time claim, never wall-clock.
 */
export function commitEmergingScanBatch(args: {
  streamKey: string;
  events: EmergingEventInsert[];
  cursorBlockNumber: number;
  cursorBlockHash: string;
  cursorBlockTs: number | null;
  at: number;
}): number {
  const availableAt = now();
  let inserted = 0;
  tx(() => {
    for (const e of args.events) {
      const r = eventInsertQ.run(
        chainId, e.txHash.toLowerCase(), e.logIndex, e.blockNumber, e.blockHash.toLowerCase(),
        e.txIndex, e.blockTs, e.contract.toLowerCase(), e.kind,
        e.poolKey, e.token !== null ? e.token.toLowerCase() : null,
        JSON.stringify(e.payload), availableAt, availableAt,
      );
      inserted += Number(r.changes);
    }
    cursorUpsertQ.run(
      chainId, args.streamKey, args.cursorBlockNumber, args.cursorBlockHash.toLowerCase(),
      args.at, args.cursorBlockTs,
    );
  });
  return inserted;
}

/** Reset a stream to a proven common ancestor after a reorg, archiving every
 *  event at or beyond it. The archive write and the cursor reset commit
 *  together; derived consumers see cursor status flip through reorg_repair. */
export function rewindEmergingStream(args: {
  streamKey: string;
  ancestorBlockNumber: number;
  ancestorBlockHash: string;
  at: number;
}): number {
  let archived = 0;
  tx(() => {
    const r = archiveQ.run(chainId, args.ancestorBlockNumber);
    archived = Number(r.changes);
    cursorResetQ.run(args.ancestorBlockNumber, args.ancestorBlockHash, args.at, chainId, args.streamKey);
  });
  return archived;
}

export type EmergingChainEventRow = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  txIndex: number;
  blockTs: number | null;
  kind: EmergingEventKind;
  payload: string;
};

const eventsForPoolQ = db.prepare(`
  SELECT tx_hash AS txHash, log_index AS logIndex, block_number AS blockNumber,
         block_hash AS blockHash, tx_index AS txIndex, block_ts AS blockTs,
         kind, payload
  FROM emerging_chain_events
  WHERE chain_id = ? AND pool_key = ? AND canonical = 1
    AND block_number >= ? AND block_number <= ?
  ORDER BY block_number, tx_index, log_index
`);

export const listEmergingPoolEvents = (
  poolKey: string,
  fromBlock: number,
  toBlock: number,
): EmergingChainEventRow[] => eventsForPoolQ.all(chainId, poolKey, fromBlock, toBlock) as never;

const eventsForTokenQ = db.prepare(`
  SELECT tx_hash AS txHash, log_index AS logIndex, block_number AS blockNumber,
         block_hash AS blockHash, tx_index AS txIndex, block_ts AS blockTs,
         kind, payload, contract
  FROM emerging_chain_events
  WHERE chain_id = ? AND token = ? AND canonical = 1
    AND block_number >= ? AND block_number <= ?
  ORDER BY block_number, tx_index, log_index
`);

export const listEmergingTokenEvents = (
  token: string,
  fromBlock: number,
  toBlock: number,
): EmergingChainEventRow[] => eventsForTokenQ.all(chainId, token.toLowerCase(), fromBlock, toBlock) as never;

export const emergingEventCounts = (): { canonical: number; archived: number } => {
  const r = db
    .prepare('SELECT canonical, COUNT(*) AS n FROM emerging_chain_events WHERE chain_id = ? GROUP BY canonical')
    .all(chainId) as Array<{ canonical: number; n: number }>;
  return {
    canonical: r.find((x) => x.canonical === 1)?.n ?? 0,
    archived: r.find((x) => x.canonical === 0)?.n ?? 0,
  };
};

// --- state snapshots (written by A05; the store side lives here) ---

const snapshotUpsertQ = db.prepare(`
  INSERT INTO emerging_state_snapshots(
    pool_key, block_hash, snapshot_kind, block_number, block_ts, state, completeness, source, observed_at, available_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(pool_key, block_hash, snapshot_kind) DO NOTHING
`);

export function recordEmergingSnapshot(args: {
  poolKey: string;
  blockHash: string;
  snapshotKind: string;
  blockNumber: number;
  blockTs: number | null;
  state: Record<string, unknown>;
  completeness: 'complete' | 'partial';
  source: string;
}): void {
  const at = now();
  snapshotUpsertQ.run(
    args.poolKey, args.blockHash.toLowerCase(), args.snapshotKind, args.blockNumber,
    args.blockTs, JSON.stringify(args.state), args.completeness, args.source, at, at,
  );
}

const snapshotsForPoolQ = db.prepare(`
  SELECT block_number AS blockNumber, block_hash AS blockHash, snapshot_kind AS snapshotKind,
         block_ts AS blockTs, state, completeness, source
  FROM emerging_state_snapshots
  WHERE pool_key = ?
  ORDER BY block_number
`);

export const listEmergingSnapshots = (poolKey: string): Array<{
  blockNumber: number; blockHash: string; snapshotKind: string; blockTs: number | null;
  state: string; completeness: string; source: string;
}> => snapshotsForPoolQ.all(poolKey) as never;
