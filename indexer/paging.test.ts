import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'lp-terminal-paging-'));
process.env.INDEXER_DB = join(dir, 'test.db');

const {
  db,
  bootstrapAddrs,
  clPoolCount,
  clPoolRowsPage,
  enqueueHydrationDemand,
  explainMissingClMetaPlan,
  explainRecentUnhydratedPlan,
  hydrationDemandCount,
  hotAddrs,
  insertPool,
  missingClMetaTokenCount,
  missingClMetaTokensPage,
  missingMetaTokensPage,
  poolRowsPage,
  recentUnhydratedAddrs,
  setTvl,
  settleHydrationDemand,
  takeHydrationDemand,
  tx,
  upsertState,
  upsertStats,
  upsertTokenMeta,
} = await import('./store');

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');

test('catalog and missing-token keyset pages are ordered, bounded and complete', () => {
  const poolAddresses = [5, 1, 4, 2, 3].map((n) => A(0x100 + n));
  for (let i = 0; i < poolAddresses.length; i++) {
    insertPool({
      address: poolAddresses[i],
      proto: 'univ2',
      token0: A(0x200 + i),
      token1: A(0x300 + (i % 2)),
      feePpm: 3_000,
    });
  }

  const seenPools: string[] = [];
  let cursor = '';
  for (;;) {
    const page = poolRowsPage(cursor, 2);
    assert.ok(page.length <= 2);
    if (!page.length) break;
    seenPools.push(...page.map((p) => p.address));
    cursor = page[page.length - 1].address;
  }
  assert.deepEqual(seenPools, [...poolAddresses].sort());

  const expectedTokens = [
    ...new Set(Array.from({ length: 5 }, (_, i) => A(0x200 + i)).concat(A(0x300), A(0x301))),
  ].sort();
  const seenTokens: string[] = [];
  cursor = '';
  for (;;) {
    const page = missingMetaTokensPage(cursor, 2);
    assert.ok(page.length <= 2);
    if (!page.length) break;
    seenTokens.push(...page);
    cursor = page[page.length - 1];
  }
  assert.deepEqual(seenTokens, expectedTokens);

  upsertTokenMeta(expectedTokens[2], 'KNOWN', 18, true);
  assert.deepEqual(
    missingMetaTokensPage('', 20),
    expectedTokens.filter((address) => address !== expectedTokens[2]),
  );

  // A failed/defaulted read remains eligible for a later bounded census cycle.
  upsertTokenMeta(expectedTokens[1], '0x0000…', 18, false);
  assert.ok(missingMetaTokensPage('', 20).includes(expectedTokens[1]));
});

test('CL keyset helpers include both V3 venues and exclude V2 rows', () => {
  const uniV3 = A(0xc01);
  const v2Between = A(0xc02);
  const pancakeV3 = A(0xc03);
  const tokens = [A(0xd01), A(0xd02), A(0xd03)];
  insertPool({
    address: uniV3,
    proto: 'univ3',
    token0: tokens[0],
    token1: tokens[1],
    feePpm: 500,
    tickSpacing: 10,
  });
  insertPool({
    address: v2Between,
    proto: 'pancakev2',
    token0: A(0xe01),
    token1: A(0xe02),
    feePpm: 2_500,
  });
  insertPool({
    address: pancakeV3,
    proto: 'pancakev3',
    token0: tokens[1],
    token1: tokens[2],
    feePpm: 2_500,
    tickSpacing: 50,
  });

  assert.equal(clPoolCount(), 2);
  assert.deepEqual(
    clPoolRowsPage('', 10).map((row) => row.address),
    [uniV3, pancakeV3],
  );
  assert.deepEqual(missingClMetaTokensPage('', 10), tokens);
  assert.equal(missingClMetaTokenCount(), 3);

  upsertTokenMeta(tokens[1], 'KNOWN', 18, true);
  assert.deepEqual(missingClMetaTokensPage('', 10), [tokens[0], tokens[2]]);
  assert.equal(missingClMetaTokenCount(), 2);

  const plan = explainMissingClMetaPlan();
  assert.ok(plan.some((line) => line.includes('idx_pools_cl_token0')));
  assert.ok(plan.some((line) => line.includes('idx_pools_cl_token1')));
  assert.ok(!plan.some((line) => line.includes('TEMP B-TREE')));
  assert.ok(!plan.some((line) => /^SCAN pools(?:\s|$)/.test(line)));
});

test('large-catalog boot/hot selectors stay capped and prioritize useful rows', () => {
  const top = A(0x901);
  const gt = A(0x902);
  const fallback = A(0x903);
  for (const [i, address] of [top, gt, fallback].entries())
    insertPool({
      address,
      proto: 'pancakev2',
      token0: A(0xa00 + i * 2),
      token1: A(0xa01 + i * 2),
      feePpm: 2_500,
    });
  upsertState(top, { reserve0: 1n, reserve1: 1n, totalSupply: 1n });
  setTvl(top, 50_000, false);
  upsertStats(gt, 10_000, 20, 40_000, 'geckoterminal');

  assert.deepEqual(bootstrapAddrs(2), [top, gt]);
  assert.equal(hotAddrs(1).length, 1);
  assert.deepEqual(hotAddrs(1), [top]);
  assert.equal(bootstrapAddrs(0).length, 0);
});

test('recent and API-demand hydration stay bounded and failed rows back off', () => {
  const older = A(0xf01);
  const newest = A(0xf02);
  const ready = A(0xf03);
  const t0 = A(0xf10);
  const t1 = A(0xf11);
  for (const address of [older, newest, ready])
    insertPool({
      address,
      proto: 'pancakev2',
      token0: t0,
      token1: t1,
      feePpm: 2_500,
    });
  const future = Math.floor(Date.now() / 1_000) + 10_000;
  db.prepare('UPDATE pools SET added_ts = ? WHERE address = ?').run(future + 1, older);
  db.prepare('UPDATE pools SET added_ts = ? WHERE address = ?').run(future + 2, newest);
  db.prepare('UPDATE pools SET added_ts = ? WHERE address = ?').run(future + 3, ready);

  assert.deepEqual(recentUnhydratedAddrs(1), [ready]);
  enqueueHydrationDemand([older, newest, ready], 2);
  assert.equal(hydrationDemandCount(), 2);
  assert.equal(takeHydrationDemand(10).length, 2);

  // One row becomes safe and leaves the queue; one remains durable with a
  // future next_attempt and is excluded from both demand and recent quotas.
  upsertTokenMeta(t0, 'T0', 18, true);
  upsertTokenMeta(t1, 'T1', 18, true);
  upsertState(older, { reserve0: 1n, reserve1: 2n, totalSupply: 3n });
  const result = settleHydrationDemand([newest, older]);
  assert.deepEqual(result, { ready: 1, retry: 1 });
  assert.equal(hydrationDemandCount(), 1);
  assert.deepEqual(takeHydrationDemand(10), []);
  assert.ok(!recentUnhydratedAddrs(10).includes(newest));

  db.prepare('UPDATE hydration_demand SET next_attempt = 0 WHERE address = ?').run(newest);
  assert.deepEqual(takeHydrationDemand(10), [newest]);
  assert.ok(recentUnhydratedAddrs(10).includes(newest));
});

test('recent hydration materializes a bounded live-row window', () => {
  const token0 = A(0x10f10);
  const token1 = A(0x10f11);
  const pools = Array.from({ length: 65 }, (_, index) => A(0x11000 + index));
  upsertTokenMeta(token0, 'T0', 18, true);
  upsertTokenMeta(token1, 'T1', 18, true);

  for (const [index, address] of pools.entries()) {
    insertPool({
      address,
      proto: 'pancakev2',
      token0,
      token1,
      feePpm: 2_500,
    });
    db.prepare('UPDATE pools SET added_ts = ? WHERE address = ?').run(
      3_000_000_000 + index,
      address,
    );
    if (index > 0)
      upsertState(address, { reserve0: 1n, reserve1: 2n, totalSupply: 3n });
  }

  // limit=1 examines exactly the newest 64 candidates. The older incomplete
  // row must not turn this recovery hint back into an unbounded catalog scan.
  assert.deepEqual(recentUnhydratedAddrs(1), []);
  const newest = pools[pools.length - 1];
  db.prepare('DELETE FROM pool_state WHERE address = ?').run(newest);
  assert.deepEqual(recentUnhydratedAddrs(1), [newest]);

  const snapshot = A(0x12000);
  insertPool({
    address: snapshot,
    proto: 'univ3',
    token0,
    token1,
    feePpm: 500,
    tickSpacing: 10,
    addedTs: 0,
  });
  assert.ok(!recentUnhydratedAddrs(10_000).includes(snapshot));

  const plan = explainRecentUnhydratedPlan();
  assert.ok(plan.some((line) => line.includes('MATERIALIZE recent')));
  assert.ok(plan.some((line) => line.includes('idx_pools_added')));
  assert.ok(!plan.some((line) => /^SCAN pools(?:\s|$)/.test(line)));

  tx(() => {
    for (let index = 0; index < 4_097; index++)
      insertPool({
        address: A(0x20000 + index),
        proto: 'pancakev2',
        token0,
        token1,
        feePpm: 2_500,
        addedTs: 4_000_000_000 + index,
      });
  });
  assert.equal(recentUnhydratedAddrs(100_000).length, 4_096);
});
