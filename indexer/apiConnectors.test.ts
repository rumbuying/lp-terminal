import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'lp-terminal-api-connectors-'));
const previous = { chain: process.env.CHAIN, db: process.env.INDEXER_DB };
process.env.CHAIN = 'bsc';
process.env.INDEXER_DB = join(tmp, 'catalog.db');

const store = await import('./store');
const api = await import('./api');

after(() => {
  store.db.close();
  if (previous.chain === undefined) delete process.env.CHAIN;
  else process.env.CHAIN = previous.chain;
  if (previous.db === undefined) delete process.env.INDEXER_DB;
  else process.env.INDEXER_DB = previous.db;
  rmSync(tmp, { recursive: true, force: true });
});

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const A = address(0xa);
const B = address(0xb);
const V23_PROTOCOLS = ['univ2', 'univ3', 'pancakev2', 'pancakev3'] as const;

let nextPool = 0x100000;
function addPool(
  proto: (typeof V23_PROTOCOLS)[number],
  a: string,
  b: string,
  tvl: number | null,
): void {
  const [token0, token1] = a < b ? [a, b] : [b, a];
  const poolAddress = address(nextPool++);
  store.insertPool({
    address: poolAddress,
    proto,
    token0,
    token1,
    feePpm: 3_000,
    ...(proto.endsWith('v3') ? { tickSpacing: 10, createdBlock: 190 } : {}),
  });
  store.db
    .prepare(
      `INSERT INTO pool_state(address, proto, reserve0, reserve1, tvl_usd, tvl_approx, updated)
       VALUES (?, ?, '0', '0', ?, 0, 1)`,
    )
    .run(poolAddress, proto, tvl);
}

function params(overrides: Record<string, string | string[]> = {}): URLSearchParams {
  const search = new URLSearchParams();
  const base: Record<string, string | string[]> = {
    a: A,
    b: B,
    protocol: [...V23_PROTOCOLS],
    ...overrides,
  };
  for (const [key, value] of Object.entries(base))
    for (const one of Array.isArray(value) ? value : [value]) search.append(key, one);
  return search;
}

function reset(): void {
  store.db.exec('DELETE FROM pools');
  store.db.exec('DELETE FROM pool_state');
  store.db.exec('DELETE FROM solver_connector_rank');
  for (const key of [
    'solver_connector_rank_built_at',
    'solver_connector_rank_rows',
    'solver_connector_rank_tokens',
    'solver_connector_rank_k',
    'solver_connector_rank_v23_seq',
    'solver_connector_rank_v23_generation',
  ])
    store.db.prepare('DELETE FROM kv WHERE k = ?').run(key);
}

test('an unpublished ranking is refused, not reported as no candidates', () => {
  reset();
  // A caller that cannot tell these apart would read "this pair has no
  // connector" from an indexer that never built the ranking at all.
  assert.throws(() => api.getSolverConnectors(params()), /ranking is not published/);
});

test('candidates carry each leg’s own protocols and rank by the thinner leg', () => {
  reset();
  const deep = address(0xd1);
  const thinOnB = address(0xd2);
  addPool('univ3', A, deep, 500_000);
  addPool('pancakev2', B, deep, 400_000);
  addPool('univ2', A, thinOnB, 900_000);
  addPool('univ2', B, thinOnB, 1_000);
  addPool('univ2', A, B, 700_000);
  store.rebuildSolverConnectorRank();

  const response = api.getSolverConnectors(params());
  assert.equal(response.schemaVersion, api.SOLVER_CONNECTORS_SCHEMA_VERSION);
  assert.equal(response.chainId, 56);
  assert.equal(response.a, A);
  assert.equal(response.b, B);
  assert.equal(response.count, 2);
  assert.deepEqual(
    response.candidates.map((candidate) => candidate.token),
    [deep, thinOnB],
  );
  assert.equal(response.candidates[0].bottleneckUsd, 400_000);
  // Uniswap into Pancake is a route; reporting one shared protocol would deny it.
  assert.deepEqual(response.candidates[0].aProtocols, ['univ3']);
  assert.deepEqual(response.candidates[0].bProtocols, ['pancakev2']);
  assert.equal(response.candidates[0].approx, false);
  // The direct pair is never offered as its own connector.
  assert.ok(!response.candidates.some((candidate) => candidate.token === B));
});

test('a narrower protocol scope must be satisfiable on both legs', () => {
  reset();
  const mixed = address(0xe1);
  addPool('univ2', A, mixed, 100_000);
  addPool('pancakev2', B, mixed, 100_000);
  store.rebuildSolverConnectorRank();

  assert.equal(api.getSolverConnectors(params({ protocol: 'univ2' })).count, 0);
  assert.equal(
    api.getSolverConnectors(params({ protocol: ['univ2', 'pancakev2'] })).count,
    1,
  );
});

test('the response says where each ranking stopped and how old it is', () => {
  reset();
  const k = store.SOLVER_CONNECTOR_RANK_K;
  // Fill A past the budget so its list truncates, and leave B narrow.
  for (let i = 0; i <= k; i += 1) addPool('univ2', A, address(0x20000 + i), 100 + i);
  addPool('univ2', B, address(0x20000 + k), 5_000);
  const meta = store.rebuildSolverConnectorRank();

  const response = api.getSolverConnectors(params());
  assert.equal(response.sides.a.truncated, true);
  assert.equal(response.sides.a.ranked, k);
  assert.equal(response.sides.a.floorUsd, 101);
  assert.equal(response.sides.b.truncated, false);
  assert.equal(response.sides.b.ranked, 1);

  assert.equal(response.ranking.perTokenLimit, k);
  assert.equal(response.ranking.edges, meta.rows);
  assert.equal(response.ranking.builtAt, meta.builtAt);
  assert.ok(response.ranking.ageSeconds >= 0);
  assert.equal(response.ranking.v23Fence.seq, meta.v23Seq);
});

test('a ranking built against an older catalog is reported, never refused', () => {
  reset();
  const shared = address(0xf1);
  addPool('univ2', A, shared, 200_000);
  addPool('univ2', B, shared, 200_000);
  const built = store.rebuildSolverConnectorRank();

  // Move the catalog on. Adjacency would reject a page spanning this, because
  // a page must be one consistent traversal; a pre-filter has no such duty --
  // identity is proved downstream, so staleness costs a candidate at worst.
  addPool('univ3', A, address(0xf2), 900_000);
  const response = api.getSolverConnectors(params());
  assert.equal(response.count, 1);
  assert.equal(response.ranking.v23Fence.seq, built.v23Seq);
  assert.notEqual(store.v23CatalogClock().seq, built.v23Seq);
});

test('an unrankable protocol is declined rather than quietly dropped', () => {
  reset();
  addPool('univ2', A, address(0x71), 10_000);
  addPool('univ2', B, address(0x71), 10_000);
  store.rebuildSolverConnectorRank();

  // V4 pools carry no pool_state.tvl_usd. Answering with a V2/V3-only ranking
  // while the caller believes V4 was weighed is the silent bias this refuses.
  assert.throws(
    () => api.getSolverConnectors(params({ protocol: ['univ2', 'univ4'] })),
    /ranks v2\/v3 protocols only/,
  );
});

test('malformed requests are rejected before any ranking is read', () => {
  reset();
  for (const [label, search] of [
    ['unknown parameter', params({ cursor: 'x' })],
    ['missing endpoint', params({ b: [] })],
    ['non-canonical token', params({ a: A.toUpperCase() })],
    ['identical tokens', params({ b: A })],
    ['no protocol', params({ protocol: [] })],
    ['unknown protocol', params({ protocol: 'sushi' })],
    ['zero limit', params({ limit: '0' })],
    ['limit past the ranking budget', params({ limit: String(store.SOLVER_CONNECTOR_RANK_K + 1) })],
  ] as const)
    assert.throws(
      () => api.getSolverConnectors(search),
      (error: unknown) => /solver connectors|invalid/.test(String(error)),
      label,
    );
});
