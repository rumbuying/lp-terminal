import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

// env FIRST, then imports. INDEXER_EMERGING_OBSERVE=1 exercises the enabled
// path; the disabled path is the default env and gets its own assertion via
// the compile-time canCreateStrategy contract instead of a second import.
const tmp = mkdtempSync(join(tmpdir(), 'lp-terminal-emerging-api-'));
const previous = {
  chain: process.env.CHAIN,
  db: process.env.INDEXER_DB,
  observe: process.env.INDEXER_EMERGING_OBSERVE,
};
process.env.CHAIN = 'robinhood';
process.env.INDEXER_DB = join(tmp, 'catalog.db');
process.env.INDEXER_EMERGING_OBSERVE = '1';

const store = await import('./store');
const { getEmergingPools, getEmergingPool } = await import('./emergingApi');

after(() => {
  store.db.close();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

const chainId = 4663;
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

function admit(venue: 'univ3' | 'up33-cl' | 'univ4', id: string, opts: { deferred?: boolean } = {}) {
  const poolKey = `${chainId}:${venue}:${id}`;
  store.upsertEmergingDiscovery({
    poolKey, venue, canonicalId: id,
    token0: addr(1), token1: addr(0x5fd), baseToken: null, quoteIsUsdg: false,
    poolCreatedAt: 1_000, tokenCreatedAt: null, launchAt: null,
    firstSeenAt: 2_000, origin: 'test',
  });
  store.recordEmergingTransition({
    poolKey, fromState: 'discovered', toState: 'queued',
    reason: opts.deferred ? 'capacity_deferred' : null,
    admittedRank: opts.deferred ? null : 1,
    occurredAt: 3_000,
  });
  return poolKey;
}

test('API: list serves the §8.1 contract with canCreateStrategy hard-false', () => {
  const key = admit('univ3', addr(0x81));
  const env = getEmergingPools(new URLSearchParams('limit=50'));
  assert.equal(env.schemaVersion, 1);
  assert.equal(env.phase, 'observe');
  assert.equal(env.ready, true);
  const view = env.pools.find((p) => p.poolKey === key)!;
  assert.equal(view.canCreateStrategy, false, 'the A/B/C compile-time contract');
  assert.equal(view.venue, 'univ3');
  assert.equal(view.dataQuality.status, 'partial', 'no complete minute yet — honest, not zero');
  assert.deepEqual(view.gates, {}, 'gate research fields render as unregistered defaults');
  assert.equal(view.behaviorRisk, 'unknown');
  assert.equal(view.signal.state, 'observing');
  assert.equal(view.thresholdVersion, '0');
});

test('API: filters and stable poolKey pagination with a generation cursor', () => {
  for (let i = 0x90; i < 0x96; i++) admit('univ3', addr(i));
  admit('univ4', `0x${'ab'.repeat(32)}`);
  admit('univ3', addr(0x97), { deferred: true });

  const page1 = getEmergingPools(new URLSearchParams('limit=3'));
  assert.equal(page1.pools.length, 3);
  assert.ok(page1.nextCursor !== null);
  assert.ok(page1.pools[0].poolKey < page1.pools[1].poolKey, 'poolKey-ordered');

  const page2 = getEmergingPools(new URLSearchParams(`limit=3&cursor=${encodeURIComponent(page1.nextCursor!)}`));
  assert.equal(page2.generation, page1.generation, 'same generation → the slice is stable');
  assert.ok(page2.pools.every((p) => p.poolKey > page1.pools[2].poolKey));

  const v4Only = getEmergingPools(new URLSearchParams(`venue=univ4`));
  assert.equal(v4Only.pools.length, 1);
  assert.equal(v4Only.pools[0].dataQuality.status, 'unsupported', '§4.4: shapes unproven — unsupported, never zeros');
  assert.deepEqual(v4Only.pools[0].dataQuality.missingStreams, ['v4-decode']);

  const deferred = getEmergingPools(new URLSearchParams('status=queued'));
  assert.ok(deferred.pools.length >= 2);
  assert.ok(deferred.pools.some((p) => p.observation.reasons.includes('capacity_deferred')));
});

test('API: a stale generation cursor is a 409-style conflict', () => {
  const staleCursor = `999999:${chainId}:univ3:${addr(0x81)}`;
  assert.throws(
    () => getEmergingPools(new URLSearchParams(`cursor=${encodeURIComponent(staleCursor)}`)),
    /stale/,
  );
});

test('API: single-pool lookup validates the key shape', () => {
  const good = admit('up33-cl', addr(0xa0));
  const single = getEmergingPool(good);
  assert.equal(single.pools.length, 1);
  assert.equal(single.pools[0].venue, 'up33-cl');
  assert.throws(() => getEmergingPool('not-a-key'), /malformed/);
  assert.throws(() => getEmergingPool(`${chainId}:univ2:${addr(0xa1)}`), /malformed/,
    'v2 keys are out of scope (§2)');
});

test('API: the response never carries a pool outside the observation states', () => {
  const env = getEmergingPools(new URLSearchParams('limit=200'));
  for (const p of env.pools) {
    assert.ok(['discovered', 'queued', 'backfilling', 'tracking', 'aged_out'].includes(p.observation.state));
    assert.equal(p.signal.state, 'observing', 'B-stage signals do not exist yet');
  }
});
