import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'lp-terminal-connector-rank-'));
const previous = { chain: process.env.CHAIN, db: process.env.INDEXER_DB };
process.env.CHAIN = 'bsc';
process.env.INDEXER_DB = join(tmp, 'catalog.db');

const {
  db,
  SOLVER_CONNECTOR_RANK_K,
  SOLVER_PROTO_BIT,
  rebuildSolverConnectorRank,
  solverConnectorCandidates,
  solverConnectorRankMeta,
  solverConnectorSide,
} = await import('./store');

after(() => {
  db.close();
  if (previous.chain === undefined) delete process.env.CHAIN;
  else process.env.CHAIN = previous.chain;
  if (previous.db === undefined) delete process.env.INDEXER_DB;
  else process.env.INDEXER_DB = previous.db;
  rmSync(tmp, { recursive: true, force: true });
});

const token = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const ALL_PROTOCOLS = Object.values(SOLVER_PROTO_BIT).reduce(
  (mask, bit) => mask | (1 << bit),
  0,
);

let nextPool = 0;
function addPool(
  proto: keyof typeof SOLVER_PROTO_BIT,
  token0: string,
  token1: string,
  tvl: number | null,
  approx = false,
): string {
  const address = token(0x9000_0000 + ++nextPool);
  db.prepare(
    `INSERT INTO pools(address, proto, token0, token1, fee_ppm, created_block, added_ts)
     VALUES (?, ?, ?, ?, 3000, 1, 1)`,
  ).run(address, proto, token0, token1);
  db.prepare(
    `INSERT INTO pool_state(address, proto, reserve0, reserve1, tvl_usd, tvl_approx, updated)
     VALUES (?, ?, '0', '0', ?, ?, 1)`,
  ).run(address, proto, tvl, approx ? 1 : 0);
  return address;
}

function reset(): void {
  db.exec('DELETE FROM pools');
  db.exec('DELETE FROM pool_state');
  db.exec('DELETE FROM solver_connector_rank');
}

const A = token(0xa);
const B = token(0xb);

test('an edge carries every protocol on it and the best pool decides its TVL', () => {
  reset();
  const C = token(0xc);
  // Same pair through three venues at different depths. The ranking must report
  // their union, the deepest figure, and that figure's own approximation flag —
  // not an OR over the group, which would mark an exact best pool approximate.
  addPool('univ2', A, C, 10_000, true);
  addPool('univ3', A, C, 50_000, false);
  addPool('pancakev2', A, C, 20_000, true);
  addPool('univ2', B, C, 90_000, false);

  rebuildSolverConnectorRank();

  const row = db
    .prepare('SELECT * FROM solver_connector_rank WHERE token = ? AND neighbor = ?')
    .get(A, C) as { tvl_usd: number; proto_mask: number; approx: number };
  assert.equal(row.tvl_usd, 50_000);
  assert.equal(
    row.proto_mask,
    (1 << SOLVER_PROTO_BIT.univ2) |
      (1 << SOLVER_PROTO_BIT.univ3) |
      (1 << SOLVER_PROTO_BIT.pancakev2),
  );
  assert.equal(row.approx, 0);

  // Every edge is stored in both directions, because either endpoint may be the
  // one a request ranks from.
  const mirror = db
    .prepare('SELECT tvl_usd FROM solver_connector_rank WHERE token = ? AND neighbor = ?')
    .get(C, A) as { tvl_usd: number };
  assert.equal(mirror.tvl_usd, 50_000);
});

test('a hub keeps its deepest K neighbours and reports the floor it stopped at', () => {
  reset();
  // One more neighbour than the budget, with TVL increasing by address, so the
  // single edge that must be dropped is the one the ranking should rank last.
  for (let i = 0; i <= SOLVER_CONNECTOR_RANK_K; i += 1)
    addPool('univ2', A, token(0x1000 + i), 100 + i);

  const meta = rebuildSolverConnectorRank();
  const side = solverConnectorSide(A);
  assert.equal(side.ranked, SOLVER_CONNECTOR_RANK_K);
  assert.equal(side.truncated, true);
  // The dropped edge is the shallowest, so the retained floor sits one above it.
  assert.equal(side.floorUsd, 101);
  assert.equal(
    db
      .prepare('SELECT 1 AS present FROM solver_connector_rank WHERE token = ? AND neighbor = ?')
      .get(A, token(0x1000)),
    undefined,
  );

  // Each neighbour still holds A in its own single-entry list.
  assert.equal(meta.tokens, SOLVER_CONNECTOR_RANK_K + 2);
  assert.equal(solverConnectorSide(token(0x1001)).truncated, false);
});

test('candidates are ranked by the thinner leg and never include the endpoints', () => {
  reset();
  const deep = token(0xd1);
  const shallowOnB = token(0xd2);
  const onlyA = token(0xd3);
  addPool('univ2', A, deep, 500_000);
  addPool('univ2', B, deep, 400_000);
  // Deeper than `deep` on A's side, but the thin B leg governs what a two-hop
  // route through it can carry, so it must rank below.
  addPool('univ2', A, shallowOnB, 900_000);
  addPool('univ2', B, shallowOnB, 1_000);
  addPool('univ2', A, onlyA, 800_000);
  // The direct pair is not a connector.
  addPool('univ2', A, B, 700_000);

  rebuildSolverConnectorRank();
  const candidates = solverConnectorCandidates(A, B, ALL_PROTOCOLS, 16);

  assert.deepEqual(
    candidates.map((candidate) => candidate.token),
    [deep, shallowOnB],
  );
  assert.equal(candidates[0].bottleneckUsd, 400_000);
  assert.equal(candidates[0].aTvlUsd, 500_000);
  assert.equal(candidates[0].bTvlUsd, 400_000);
  assert.equal(candidates[1].bottleneckUsd, 1_000);
  assert.ok(!candidates.some((candidate) => candidate.token === onlyA));
});

test('a protocol scope must be satisfied on both legs', () => {
  reset();
  const pancakeOnly = token(0xe1);
  const mixed = token(0xe2);
  addPool('pancakev2', A, pancakeOnly, 100_000);
  addPool('pancakev2', B, pancakeOnly, 100_000);
  addPool('univ2', A, mixed, 90_000);
  addPool('pancakev2', B, mixed, 90_000);
  rebuildSolverConnectorRank();

  const uniOnly = 1 << SOLVER_PROTO_BIT.univ2;
  // `mixed` has a Uni leg on A but only Pancake on B, so a Uni-only scope
  // cannot route through it and it must not be offered.
  assert.deepEqual(
    solverConnectorCandidates(A, B, uniOnly, 16).map((c) => c.token),
    [],
  );

  const both = uniOnly | (1 << SOLVER_PROTO_BIT.pancakev2);
  const offered = solverConnectorCandidates(A, B, both, 16);
  assert.deepEqual(
    offered.map((c) => c.token),
    [pancakeOnly, mixed],
  );
  // Each leg reports its own protocols. `mixed` is routable as a Uniswap hop
  // into a Pancake hop, so intersecting the two masks would wrongly deny it.
  assert.equal(offered[1].aProtocolMask, uniOnly);
  assert.equal(offered[1].bProtocolMask, 1 << SOLVER_PROTO_BIT.pancakev2);
});

test('a rebuild that fails leaves the previous ranking and its provenance intact', () => {
  reset();
  const stable = token(0xf1);
  addPool('univ2', A, stable, 300_000);
  addPool('univ2', B, stable, 300_000);
  const published = rebuildSolverConnectorRank();
  assert.equal(published.rows, 4);

  // Fail the rebuild partway through its own INSERT. The DELETE that precedes
  // it has already run by then, so surviving this is the whole atomicity claim.
  const doomed = token(0xf2);
  addPool('univ2', A, doomed, 400_000);
  addPool('univ2', B, doomed, 400_000);
  db.exec(`
    CREATE TEMP TRIGGER connector_rank_abort_probe
    BEFORE INSERT ON solver_connector_rank
    WHEN NEW.neighbor = '${doomed}'
    BEGIN SELECT RAISE(ABORT, 'connector rank abort probe'); END;
  `);
  try {
    assert.throws(() => rebuildSolverConnectorRank(), /abort probe/);
  } finally {
    db.exec('DROP TRIGGER temp.connector_rank_abort_probe');
  }

  // The previous ranking is still served, still described by its own build.
  assert.deepEqual(solverConnectorRankMeta(), published);
  assert.deepEqual(
    solverConnectorCandidates(A, B, ALL_PROTOCOLS, 16).map((c) => c.token),
    [stable],
  );

  // And the next rebuild publishes cleanly, so the failure left no write lock
  // or half-open transaction behind.
  assert.equal(rebuildSolverConnectorRank().rows, 8);
});

test('an unpriced or self-referential pool contributes no candidate', () => {
  reset();
  const unpriced = token(0x51);
  addPool('univ2', A, unpriced, null);
  addPool('univ2', B, unpriced, 100_000);
  addPool('univ2', A, A, 100_000);
  rebuildSolverConnectorRank();

  assert.deepEqual(solverConnectorCandidates(A, B, ALL_PROTOCOLS, 16), []);
  assert.equal(solverConnectorSide(A).ranked, 0);
});

test('the staged build leaves nothing behind, and survives what a kill left', () => {
  reset();
  const shared = token(0x61);
  addPool('univ2', A, shared, 100_000);
  addPool('univ2', B, shared, 100_000);
  const stagePath = `${process.env.INDEXER_DB}.rankstage`;

  assert.equal(rebuildSolverConnectorRank().rows, 4);
  assert.equal(existsSync(stagePath), false, 'a successful rebuild must not leave staging behind');

  // A rebuild killed mid-scan leaves a staging file with a rank table already
  // in it. The next rebuild has to discard it rather than fail on CREATE TABLE.
  const orphan = new DatabaseSync(stagePath);
  orphan.exec('CREATE TABLE rank(token TEXT, neighbor TEXT)');
  orphan.exec("INSERT INTO rank VALUES ('0xdead', '0xbeef')");
  orphan.close();
  assert.equal(existsSync(stagePath), true);

  assert.equal(rebuildSolverConnectorRank().rows, 4);
  assert.equal(existsSync(stagePath), false);
  assert.deepEqual(
    solverConnectorCandidates(A, B, ALL_PROTOCOLS, 16).map((c) => c.token),
    [shared],
  );
});

test('a failed rebuild leaves no staging file either', () => {
  reset();
  const doomed = token(0x62);
  addPool('univ2', A, doomed, 100_000);
  addPool('univ2', B, doomed, 100_000);
  const stagePath = `${process.env.INDEXER_DB}.rankstage`;
  db.exec(`
    CREATE TEMP TRIGGER connector_rank_stage_abort_probe
    BEFORE INSERT ON solver_connector_rank
    WHEN NEW.neighbor = '${doomed}'
    BEGIN SELECT RAISE(ABORT, 'staged abort probe'); END;
  `);
  try {
    assert.throws(() => rebuildSolverConnectorRank(), /staged abort probe/);
  } finally {
    db.exec('DROP TRIGGER temp.connector_rank_stage_abort_probe');
  }
  assert.equal(existsSync(stagePath), false);
});

test('the intersection probes both lists by primary key rather than scanning', () => {
  // The 31.7s live intersection this projection replaces was slow because it
  // scanned. If the planner ever stops using the primary key on both sides the
  // performance claim is gone, so pin it.
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT a.neighbor FROM solver_connector_rank a
       JOIN solver_connector_rank b ON b.token = ? AND b.neighbor = a.neighbor
       WHERE a.token = ?`,
    )
    .all('0x1', '0x2') as { detail: string }[];
  const details = plan.map((row) => row.detail).join('\n');
  assert.match(details, /SEARCH a USING PRIMARY KEY/);
  assert.match(details, /SEARCH b USING PRIMARY KEY/);
  assert.doesNotMatch(details, /SCAN/);
});
