import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

// --- pure core (no DB) ---
const {
  formatEmergingPoolKey,
  parseEmergingPoolKey,
  isValidCanonicalId,
  youngCutoffBlock,
  ageTransition,
  planAdmission,
} = await import('./emergingCore');

const chainId = 4663;
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const poolId = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

test('poolKey: v4 uses the bytes32 PoolId, never an address shape', () => {
  const key = formatEmergingPoolKey({ chainId, venue: 'univ4', canonicalId: poolId(1) });
  assert.equal(key, `${chainId}:univ4:${poolId(1)}`);
  assert.equal(formatEmergingPoolKey({ chainId, venue: 'univ4', canonicalId: addr(1) }), null,
    'a 20-byte id must not masquerade as a PoolId (§3.1)');
  assert.equal(isValidCanonicalId('univ4', addr(1)), false);
});

test('poolKey: v3/UP33 use the lowercase address, uppercase rejected', () => {
  assert.equal(
    formatEmergingPoolKey({ chainId, venue: 'up33-cl', canonicalId: addr(2) }),
    `${chainId}:up33-cl:${addr(2)}`,
  );
  assert.equal(
    formatEmergingPoolKey({ chainId, venue: 'univ3', canonicalId: addr(2).toUpperCase() }),
    `${chainId}:univ3:${addr(2).toLowerCase()}`,
  );
});

test('poolKey: round-trip and tamper rejection', () => {
  const key = formatEmergingPoolKey({ chainId, venue: 'univ3', canonicalId: addr(3) })!;
  assert.deepEqual(parseEmergingPoolKey(key), { chainId, venue: 'univ3', canonicalId: addr(3) });
  assert.equal(parseEmergingPoolKey(`${chainId}:univ2:${addr(3)}`), null, 'v2 is out of scope (§2)');
  assert.equal(parseEmergingPoolKey(`${chainId}:univ3:${addr(3)}x`), null);
  assert.equal(parseEmergingPoolKey('not-a-key'), null);
});

test('youngCutoffBlock: head minus the age window at the measured block time', () => {
  // 7d = 604800s; at 2s blocks that is 302400 blocks.
  assert.equal(youngCutoffBlock(1_000_000, 7, 2), 697_600);
  // Rounding is away from the head (ceil), so the window never over-admits.
  assert.equal(youngCutoffBlock(1_000_001, 7, 3), 1_000_001 - Math.ceil(604_800 / 3));
});

test('ageTransition: young on either birth, aged only on evidence, unknown without any', () => {
  const t = 1_000_000;
  const window = 7;
  assert.equal(ageTransition({ poolCreatedAt: t - 6 * 86_400, tokenCreatedAt: null }, t, window), 'young');
  assert.equal(ageTransition({ poolCreatedAt: null, tokenCreatedAt: t - 1 * 86_400 }, t, window), 'young');
  assert.equal(ageTransition({ poolCreatedAt: t - 8 * 86_400, tokenCreatedAt: null }, t, window), 'aged');
  assert.equal(
    ageTransition({ poolCreatedAt: t - 8 * 86_400, tokenCreatedAt: t - 2 * 86_400 }, t, window),
    'young',
    'either birth inside the window keeps the pool young',
  );
  assert.equal(ageTransition({ poolCreatedAt: null, tokenCreatedAt: null }, t, window), 'unknown',
    'no birth evidence is unknown — never aged, never young (§3.1)');
});

const ledgerRow = (n: number, over: Partial<Parameters<typeof planAdmission>[0]['rows'][number]> = {}) => ({
  poolKey: `${chainId}:univ3:${addr(n)}`,
  state: 'discovered' as const,
  reason: null,
  poolCreatedAt: 1_000_000_000,
  tokenCreatedAt: null,
  pinnedUntil: null,
  admittedRank: null,
  firstSeenAt: 2_000_000,
  ...over,
});

const membersEqual = (actual: string[], expected: string[], message?: string) =>
  assert.deepEqual([...actual].sort(), [...expected].sort(), message);

test('admission: stable FIFO order, capacity cap, deferred queue backfills in order', () => {
  const rows = Array.from({ length: 5 }, (_, i) => ledgerRow(i + 1, { firstSeenAt: 2_000_000 + i }));
  const plan = planAdmission({ rows, nowSec: 2_000_050, maxAgeDays: 7, capacity: 2 });
  assert.deepEqual(plan.admit, [rows[0].poolKey, rows[1].poolKey], 'earliest firstSeenAt wins');
  membersEqual(plan.defer, [rows[2].poolKey, rows[3].poolKey, rows[4].poolKey]);
  assert.equal(plan.capacity, 2);
  assert.deepEqual(plan.ageOut, []);
});

test('admission: firstSeenAt ties break by poolKey, deterministically', () => {
  const rows = [ledgerRow(0x21), ledgerRow(0x20), ledgerRow(0x22)];
  const plan = planAdmission({ rows, nowSec: 2_000_050, maxAgeDays: 7, capacity: 1 });
  assert.deepEqual(plan.admit, [`${chainId}:univ3:${addr(0x20)}`]);
});

test('admission: aged-out rows free capacity for the deferred queue', () => {
  // FIFO retention: earlier-discovered tracked rows hold their slots until
  // they age out; freed slots backfill from the deferred queue in order.
  const aged = ledgerRow(1, { poolCreatedAt: 0, firstSeenAt: 1, admittedRank: 1, state: 'queued' });
  const tracked = ledgerRow(3, { admittedRank: 2, state: 'queued', firstSeenAt: 2_000_000 });
  const deferred = ledgerRow(2, { firstSeenAt: 2_000_001, reason: 'capacity_deferred' });
  const plan = planAdmission({
    rows: [aged, tracked, deferred],
    nowSec: 2_000_050,
    maxAgeDays: 7,
    capacity: 2,
  });
  assert.deepEqual(plan.ageOut, [aged.poolKey]);
  assert.deepEqual(plan.admit, [deferred.poolKey], 'the freed slot backfills from the queue');
  assert.deepEqual(plan.defer, []);
  assert.equal(plan.capacity, 2);
});

test('admission: pinned rows are never evicted and outrank capacity (§4.1)', () => {
  const pinned = ledgerRow(1, {
    admittedRank: 1,
    pinnedUntil: 2_000_100,
    state: 'tracking',
    firstSeenAt: 2_000_099,
  });
  const waiting = [ledgerRow(2), ledgerRow(3)];
  const plan = planAdmission({
    rows: [pinned, ...waiting],
    nowSec: 2_000_050,
    maxAgeDays: 7,
    capacity: 1,
  });
  assert.deepEqual(plan.admit, [], 'capacity is 1 and the pin holds it');
  membersEqual(plan.defer, waiting.map((r) => r.poolKey));
  assert.deepEqual(plan.ageOut, []);
  assert.equal(plan.capacity, 1);
});

test('admission: expired pins no longer hold capacity', () => {
  const expiredPin = ledgerRow(1, { admittedRank: 1, pinnedUntil: 2_000_000, firstSeenAt: 1 });
  const waiting = ledgerRow(2, { firstSeenAt: 2 });
  const plan = planAdmission({
    rows: [expiredPin, waiting],
    nowSec: 2_000_050,
    maxAgeDays: 7,
    capacity: 1,
  });
  // The expired pin is still the earliest discovery, so FIFO retention keeps
  // it; nothing is admitted and nothing is displaced.
  assert.deepEqual(plan.admit, []);
  membersEqual(plan.defer, [waiting.poolKey]);
});

// --- store half (tmp DB, connectorRank.test.ts pattern) ---
const tmp = mkdtempSync(join(tmpdir(), 'lp-terminal-emerging-'));
const previous = { chain: process.env.CHAIN, db: process.env.INDEXER_DB };
process.env.CHAIN = 'robinhood';
process.env.INDEXER_DB = join(tmp, 'catalog.db');

const store = await import('./store');

after(() => {
  store.db.close();
  if (previous.chain === undefined) delete process.env.CHAIN;
  else process.env.CHAIN = previous.chain;
  if (previous.db === undefined) delete process.env.INDEXER_DB;
  else process.env.INDEXER_DB = previous.db;
  rmSync(tmp, { recursive: true, force: true });
});

const KEY = `${chainId}:univ3:${addr(9)}`;

test('store: discovery upsert is idempotent and first_seen_at never re-dates', () => {
  const first = store.upsertEmergingDiscovery({
    poolKey: KEY, venue: 'univ3', canonicalId: addr(9),
    token0: addr(1), token1: addr(2), baseToken: null, quoteIsUsdg: false,
    poolCreatedAt: null, tokenCreatedAt: null, launchAt: null,
    firstSeenAt: 1_111, origin: 'v23-tail',
  });
  assert.equal(first, true);
  const again = store.upsertEmergingDiscovery({
    poolKey: KEY, venue: 'univ3', canonicalId: addr(9),
    token0: addr(1), token1: addr(2), baseToken: null, quoteIsUsdg: true,
    poolCreatedAt: 2_222, tokenCreatedAt: 2_222, launchAt: 2_222,
    firstSeenAt: 3_333, origin: 'v23-tail',
  });
  assert.equal(again, false, 'a re-read must not duplicate or re-date the row');
  const row = store.listEmergingActive().find((r) => r.poolKey === KEY)!;
  assert.equal(row.firstSeenAt, 1_111);
  assert.equal(row.state, 'discovered');
});

test('store: age evidence fills NULLs only — null never overwrites (§3.1)', () => {
  store.recordEmergingAges(KEY, {
    baseToken: null, quoteIsUsdg: false,
    poolCreatedAt: 5_555, tokenCreatedAt: null, launchAt: null,
  }, 10_000);
  let row = store.listEmergingActive().find((r) => r.poolKey === KEY)!;
  assert.equal(row.poolCreatedAt, 5_555);
  assert.equal(row.tokenCreatedAt, null);

  store.recordEmergingAges(KEY, {
    baseToken: addr(7), quoteIsUsdg: true,
    poolCreatedAt: null, tokenCreatedAt: 6_666, launchAt: 6_666,
  }, 10_001);
  row = store.listEmergingActive().find((r) => r.poolKey === KEY)!;
  assert.equal(row.poolCreatedAt, 5_555, 'earlier evidence wins; NULL is not a newer answer');
  assert.equal(row.tokenCreatedAt, 6_666);
  assert.equal(row.token0, addr(1), 'identity fields untouched by age updates');
});

test('store: transitions append events atomically with the row update', () => {
  store.recordEmergingTransition({
    poolKey: KEY, fromState: 'discovered', toState: 'queued',
    reason: null, admittedRank: 42, occurredAt: 11_000,
  });
  let row = store.listEmergingActive().find((r) => r.poolKey === KEY)!;
  assert.equal(row.state, 'queued');
  assert.equal(row.admittedRank, 42);
  const events = store.db
    .prepare('SELECT from_state, to_state, reason FROM emerging_observation_events WHERE pool_key = ? ORDER BY seq')
    .all(KEY) as Array<{ from_state: string; to_state: string; reason: string | null }>;
  assert.equal(events.length, 2, 'discovered insert event + this transition');
  // node:sqlite rows are null-prototype objects — compare field by field.
  assert.equal(events[0].from_state, null);
  assert.equal(events[0].to_state, 'discovered');
  assert.equal(events[1].from_state, 'discovered');
  assert.equal(events[1].to_state, 'queued');
  assert.equal(events[1].reason, null);
});

test('store: aged_out rows leave the active set but keep their history', () => {
  store.recordEmergingTransition({
    poolKey: KEY, fromState: 'queued', toState: 'aged_out',
    reason: 'age_exceeded', admittedRank: null, occurredAt: 12_000,
  });
  assert.equal(store.listEmergingActive().find((r) => r.poolKey === KEY), undefined);
  const counts = store.emergingCounts();
  assert.equal(counts.aged_out, 1);
  const events = store.db
    .prepare('SELECT to_state FROM emerging_observation_events WHERE pool_key = ? ORDER BY seq')
    .all(KEY) as Array<{ to_state: string }>;
  assert.equal(events.length, 3, 'the ledger keeps the row and all its events (§4.3)');
});
