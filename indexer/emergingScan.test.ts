import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

// env FIRST, then imports: emergingScan transitively opens store.ts's DB at
// import time, so the tmp INDEXER_DB must be in place before the module graph
// loads (connectorRank.test.ts's pattern).
const tmp = mkdtempSync(join(tmpdir(), 'lp-terminal-emerging-scan-'));
const previous = { chain: process.env.CHAIN, db: process.env.INDEXER_DB };
process.env.CHAIN = 'robinhood';
process.env.INDEXER_DB = join(tmp, 'catalog.db');

const { nextWindow, findCommonAncestor, buildTrackedSet, buildStreams, eventBlockTs } = await import('./emergingScan');
const store = await import('./store');
const emergingStore = await import('./emergingStore');

after(() => {
  store.db.close();
  if (previous.chain === undefined) delete process.env.CHAIN;
  else process.env.CHAIN = previous.chain;
  if (previous.db === undefined) delete process.env.INDEXER_DB;
  else process.env.INDEXER_DB = previous.db;
  rmSync(tmp, { recursive: true, force: true });
});

test('nextWindow: halve on rejection, grow on success, capped', () => {
  assert.equal(nextWindow(5_000, false, 50_000), 2_500);
  assert.equal(nextWindow(2_500, true, 50_000), 5_000);
  assert.equal(nextWindow(40_000, true, 50_000), 50_000);
  assert.equal(nextWindow(50_000, true, 50_000), 50_000, 'cap is a ceiling, never exceeded');
  assert.equal(nextWindow(1, false, 50_000), 1, 'single-block floor for the fail-closed check');
});

test('findCommonAncestor: first provable match walking back, case-insensitive', () => {
  const current = [
    { block: 99, hash: '0xaaa' },
    { block: 98, hash: '0xbbb' },
    { block: 97, hash: '0xccc' },
  ];
  const stored = new Map([[97, '0xCCC']]);
  assert.equal(findCommonAncestor(current, stored), 97);
});

test('findCommonAncestor: no provable reference → null (fail closed, §4.2)', () => {
  const current = [{ block: 99, hash: '0xaaa' }, { block: 98, hash: '0xbbb' }];
  assert.equal(findCommonAncestor(current, new Map()), null);
  // A stored hash that MISMATCHES the current chain is not a proof either —
  // the walk keeps going and, finding nothing provable, reports null.
  assert.equal(findCommonAncestor(current, new Map([[98, '0xdifferent']])), null);
});

test('eventBlockTs: log blockTimestamp dates at insert; garbage stays NULL', () => {
  // The production-proven shape: viem hands the RPC's hex field through as bigint.
  assert.equal(eventBlockTs(0x6aaef588n), 0x6aaef588);
  // Some providers/shapes hand the raw hex string through instead.
  assert.equal(eventBlockTs('0x6aaef588'), 0x6aaef588);
  assert.equal(eventBlockTs(1_789_836_867), 1_789_836_867);
  // Absent field (providers without it) → null: the §4.4 backfill owns dating.
  assert.equal(eventBlockTs(undefined), null);
  assert.equal(eventBlockTs(null), null);
  // Garbage shapes must never become a wrong timestamp (§3.1).
  assert.equal(eventBlockTs('undefined'), null);
  assert.equal(eventBlockTs(0n), null, 'block 0 timestamp is not a fact');
  assert.equal(eventBlockTs(-5), null);
});

// --- tracked-set + scan-cursor behaviour on the tmp DB ---

const chainId = 4663;
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const poolId = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

function admitPool(venue: 'univ3' | 'up33-cl' | 'univ4', id: string, baseToken: string | null): string {
  const poolKey = venue === 'univ4'
    ? `${chainId}:univ4:${id}`
    : `${chainId}:${venue}:${id}`;
  store.upsertEmergingDiscovery({
    poolKey, venue, canonicalId: id,
    token0: addr(1), token1: baseToken ?? addr(2),
    baseToken, quoteIsUsdg: false,
    poolCreatedAt: 1_000, tokenCreatedAt: null, launchAt: null,
    firstSeenAt: 2_000, origin: 'test',
  });
  store.recordEmergingTransition({
    poolKey, fromState: 'discovered', toState: 'queued',
    reason: null, admittedRank: 1, occurredAt: 3_000,
  });
  return poolKey;
}

test('buildStreams: one filter per family, attribution maps exact (§4.2)', () => {
  const v3 = admitPool('univ3', addr(0x11), null);
  const v4 = admitPool('univ4', poolId(0x22), addr(0x33));
  const set = buildTrackedSet();
  assert.deepEqual([...set.clPoolKeyByAddress.values()], [v3]);
  assert.deepEqual([...set.v4PoolKeyById.values()], [v4]);
  assert.deepEqual(set.tokens.map((t: string) => t.toLowerCase()), [addr(0x33)]);

  const streams = buildStreams(set);
  assert.equal(streams.length, 3);
  const cl = streams.find((s: { key: string }) => s.key === 'cl-pools')!;
  assert.deepEqual(cl.address, [addr(0x11)]);
  const v4s = streams.find((s: { key: string }) => s.key === 'v4-pools')!;
  assert.deepEqual(v4s.topics, [null, [poolId(0x22)]], 'topic1 filter carries the tracked PoolIds');
  const tokens = streams.find((s: { key: string }) => s.key === 'tokens')!;
  assert.equal(tokens.address.length, 1);
});

test('scan batch: events + cursor commit atomically, re-reads are idempotent', () => {
  const poolKey = admitPool('univ3', addr(0x44), null);
  const events = Array.from({ length: 3 }, (_, i) => ({
    txHash: `0x${(0xaa + i).toString(16)}`,
    logIndex: i,
    blockNumber: 100,
    blockHash: '0xhash100',
    txIndex: 0,
    blockTs: null,
    contract: addr(0x44),
    kind: 'swap' as const,
    poolKey,
    token: null,
    payload: { amount0: '1' },
  }));
  const first = emergingStore.commitEmergingScanBatch({
    streamKey: 'cl-pools', events,
    cursorBlockNumber: 100, cursorBlockHash: '0xhash100', cursorBlockTs: 5_000, at: 9_000,
  });
  assert.equal(first, 3);
  // The overlap re-read: identical logs insert NOTHING, cursor stays put.
  const second = emergingStore.commitEmergingScanBatch({
    streamKey: 'cl-pools', events,
    cursorBlockNumber: 100, cursorBlockHash: '0xhash100', cursorBlockTs: 5_000, at: 9_001,
  });
  assert.equal(second, 0);
  const cursor = emergingStore.getEmergingCursor('cl-pools');
  assert.equal(cursor!.blockNumber, 100);
  assert.equal(cursor!.blockHash, '0xhash100');
  assert.equal(cursor!.completeThroughTs, 5_000);
  assert.equal(emergingStore.emergingEventCounts().canonical, 3);
});

test('reorg rewind: orphans archived (canonical=0), ancestor rows kept, cursor reset', () => {
  const poolKey = admitPool('univ3', addr(0x55), null);
  const mkEvent = (block: number, hash: string, i: number) => ({
    txHash: `0x${(0xbb + i).toString(16)}`,
    logIndex: i,
    blockNumber: block,
    blockHash: hash,
    txIndex: 0,
    blockTs: null,
    contract: addr(0x55),
    kind: 'swap' as const,
    poolKey,
    token: null,
    payload: {},
  });
  // Canonical history at 90 (kept), orphaned reorg block 91 (archived).
  emergingStore.commitEmergingScanBatch({
    streamKey: 'cl-pools',
    events: [mkEvent(90, '0xgood', 10)],
    cursorBlockNumber: 90, cursorBlockHash: '0xgood', cursorBlockTs: 4_000, at: 9_100,
  });
  emergingStore.commitEmergingScanBatch({
    streamKey: 'cl-pools',
    events: [mkEvent(91, '0xorphan', 11)],
    cursorBlockNumber: 91, cursorBlockHash: '0xorphan', cursorBlockTs: null, at: 9_101,
  });
  const archived = emergingStore.rewindEmergingStream({
    streamKey: 'cl-pools',
    ancestorBlockNumber: 90,
    ancestorBlockHash: '0xgood',
    at: 9_102,
  });
  // Archive is GLOBAL by block height (§4.2: a reorg replaces chain blocks,
  // not streams) — it sweeps this test's orphan at 91 AND the earlier test's
  // events at block 100 (3 rows).
  assert.equal(archived, 4);
  const kept = emergingStore.listEmergingPoolEvents(poolKey, 0, 1_000);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].blockNumber, 90);
  const counts = emergingStore.emergingEventCounts();
  // 1 orphan from this test + 3 rows the earlier batch test had above block 90.
  assert.equal(counts.archived, 4, '§4.3: orphans stay in the archive, never deleted');
  const cursor = emergingStore.getEmergingCursor('cl-pools');
  assert.equal(cursor!.blockNumber, 90);
  assert.equal(cursor!.status, 'active', 'cursor reset also clears the status');
  assert.equal(cursor!.completeThroughTs, null, 'completeness claim is withdrawn after a rewind');
});

test('stream status: data_gap/reorg_repair persist without touching the watermark', () => {
  emergingStore.setEmergingStreamStatus('cl-pools', 'data_gap', 9_200);
  const cursor = emergingStore.getEmergingCursor('cl-pools');
  assert.equal(cursor!.status, 'data_gap');
  assert.equal(cursor!.blockNumber, 90, 'the watermark itself is untouched');
});

test('v4DepthCalls: every multicall carries an ARRAY abi viem can encode', async () => {
  // Production regression (2026-09-21): the sweep passed single ABI ITEMS
  // (objects) as `abi`, so viem's `abi.filter` threw and every v4 depth
  // multicall chunk was dropped for two days.
  const { encodeFunctionData } = await import('viem');
  const { v4DepthCalls, V4_STATEVIEW_ABI } = await import('./emergingScan');
  assert.ok(Array.isArray(V4_STATEVIEW_ABI));
  const stateView = '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b' as const;
  const rows = [{ poolKey: '0x01', poolId: `0x${'ab'.repeat(32)}` }, { poolKey: '0x02', poolId: `0x${'cd'.repeat(32)}` }];
  const calls = v4DepthCalls(rows, stateView);
  assert.equal(calls.length, rows.length * 2);
  for (const call of calls) {
    assert.ok(Array.isArray(call.abi), 'abi must be the full array, never a single item');
    // The truest check: viem must accept the call shape end to end.
    encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args });
  }
});

test('parseV4DepthResults: unwraps mc {status,result} wrappers, skips failures', async () => {
  // Production regression (2026-09-21, c816171): the persistence loop treated
  // the mc wrapper itself as the decoded tuple, so every row failed the shape
  // check and the v4 depth cache never refreshed.
  const { parseV4DepthResults } = await import('./emergingScan');
  const rows = [{ poolKey: '0x01' }, { poolKey: '0x02' }, { poolKey: '0x03' }];
  const results = [
    { status: 'success', result: [123456789n, 20, 0, 0] },   // slot0 for rows[0]
    { status: 'success', result: 987654321n },               // liquidity for rows[0]
    { status: 'failure' },                                   // slot0 missing for rows[1]
    { status: 'success', result: 42n },
    { status: 'success', result: ['not-bigint', 1, 0, 0] },  // garbage slot0
    { status: 'success', result: 7n },
  ];
  const parsed = parseV4DepthResults(rows, results as never, 1700);
  assert.deepEqual(parsed, [
    { poolKey: '0x01', sqrtPrice: '123456789', liquidity: '987654321', updated: 1700 },
  ]);
});
