import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

// env FIRST, then imports (connectorRank.test.ts's pattern). The archive dir
// resolves under the repo — point it at the tmp tree via the DB path's dir.
const tmp = mkdtempSync(join(tmpdir(), 'lp-terminal-emerging-archive-'));
const previous = { chain: process.env.CHAIN, db: process.env.INDEXER_DB };
process.env.CHAIN = 'robinhood';
process.env.INDEXER_DB = join(tmp, 'catalog.db');

const store = await import('./store');
const emergingStore = await import('./emergingStore');
const { runEmergingRetentionSweep, getEmergingObservability } = await import('./emergingArchive');

after(() => {
  store.db.close();
  if (previous.chain === undefined) delete process.env.CHAIN;
  else process.env.CHAIN = previous.chain;
  if (previous.db === undefined) delete process.env.INDEXER_DB;
  else process.env.INDEXER_DB = previous.db;
  rmSync(tmp, { recursive: true, force: true });
});

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const DAY = 86_400;
const t = Math.floor(Date.now() / 1000);

function seedEvent(blockTs: number, n: number) {
  emergingStore.commitEmergingScanBatch({
    streamKey: 'cl-pools',
    events: [{
      txHash: `0x${(0xa000 + n).toString(16)}`, logIndex: n,
      blockNumber: 900_000 + n, blockHash: '0xh', txIndex: 0, blockTs,
      contract: addr(1), kind: 'swap', poolKey: null, token: null,
      payload: { amount0: '1', amount1: '-1', sqrtPriceX96: '1' },
    }],
    cursorBlockNumber: 900_000 + n, cursorBlockHash: '0xh', cursorBlockTs: blockTs, at: t,
  });
}

test('retention: expired events are ARCHIVED AND VERIFIED before deletion; fresh rows stay', () => {
  seedEvent(t - 40 * DAY, 1); // expired
  seedEvent(t - 40 * DAY, 2); // expired
  seedEvent(t - 1 * DAY, 3);  // fresh
  // availableAt is stamped at insert time; age the two old rows to expired.
  store.db.prepare('UPDATE emerging_chain_events SET available_at = ? WHERE tx_hash IN (?, ?)')
    .run(t - 40 * DAY, '0xa001', '0xa002');

  const r = runEmergingRetentionSweep();
  assert.equal(r.archivedEvents, 2);
  assert.equal(r.prunedEvents, 2, 'pruned only after the archive verified');
  assert.equal(r.verified, true);
  assert.equal(emergingStore.emergingEventCounts().canonical, 1, 'the fresh event stays live');

  // The archive artifact exists under the data tree and re-reads as NDJSON.
  const dir = join(tmp, '..', 'does-not-matter'); // archive resolves repo-side
  void dir;
  const state = store.db
    .prepare("SELECT v FROM kv WHERE k LIKE 'emerging_archive:%'")
    .get() as { v: string } | undefined;
  assert.ok(state, 'the archive manifest is recorded with its hash');
  const manifest = JSON.parse(state!.v) as { file: string; rows: number };
  assert.ok(existsSync(manifest.file));
  assert.equal(manifest.rows, 2);
  const lines = readFileSync(manifest.file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
});

test('retention: minute buckets past 7 days are pruned outright (derived, not primary)', () => {
  store.db.prepare(
    'INSERT INTO pool_minute_buckets(pool_key, minute_ts, complete, aggregate_version, swap_count) VALUES (?, ?, 1, 1, 0)',
  ).run(`${4663}:univ3:${addr(9)}`, t - 8 * DAY);
  store.db.prepare(
    'INSERT INTO pool_minute_buckets(pool_key, minute_ts, complete, aggregate_version, swap_count) VALUES (?, ?, 1, 1, 0)',
  ).run(`${4663}:univ3:${addr(9)}`, t - 1 * DAY);
  const r = runEmergingRetentionSweep();
  assert.equal(r.prunedBuckets, 1);
  const left = store.db
    .prepare('SELECT COUNT(*) AS n FROM pool_minute_buckets')
    .get() as { n: number };
  assert.equal(left.n, 1, 'only the fresh bucket remains');
});

test('observability: the §10.2 counters read from the same ledger', () => {
  const obs = getEmergingObservability() as Record<string, unknown>;
  assert.equal(obs.phase, undefined, 'no phase field: observability is not the API envelope');
  assert.ok('discovery' in obs && 'streams' in obs && 'diskFreeFraction' in obs);
  assert.ok(typeof obs.eventsCanonical === 'number');
});

test('archive dir: retention wrote under indexer/data (gitignored)', () => {
  const files = readdirSync('indexer/data/emerging/archive');
  assert.ok(files.length >= 1);
});
