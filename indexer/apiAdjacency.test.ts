import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import test, { after } from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'lp-terminal-adjacency-'));
const previous = {
  chain: process.env.CHAIN,
  db: process.env.INDEXER_DB,
  subgraph: process.env.INDEXER_V4_SUBGRAPH_ID,
};
process.env.CHAIN = 'bsc';
process.env.INDEXER_DB = join(tmp, 'catalog.db');
delete process.env.INDEXER_V4_SUBGRAPH_ID;

const store = await import('./store');
const api = await import('./api');
const { ADDR, UNI, V4 } = await import('./config');
const {
  BSC_UNI_V3_SUBGRAPH_DEPLOYMENT,
  BSC_UNI_V3_SUBGRAPH_ID,
} = await import('./v3Subgraph');
const {
  BSC_PANCAKE_V3_SUBGRAPH_DEPLOYMENT,
  BSC_PANCAKE_V3_SUBGRAPH_ID,
} = await import('./pancakeV3Subgraph');

if (!V4?.poolSubgraph) throw new Error('BSC adjacency test requires Uniswap V4');
const TEST_V4 = V4;
const TEST_V4_SUBGRAPH = V4.poolSubgraph;
type PoolProto = 'univ2' | 'univ3' | 'pancakev2' | 'pancakev3';

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const seed = address(0x1000);
const neighbors = [address(1), address(2), address(3), address(0x2000), address(0x3000)];
const hooks = address(0);
const snapshotBlock = 200;
const currentBlock = 220;
const snapshotHash = id(0xabc);
const snapshotGeneration = id(0xdef);

const canonicalPair = (a: string, b: string) =>
  a < b ? ([a, b] as const) : ([b, a] as const);
let nextPoolAddress = 0x100000;
let nextPoolId = 0x100000;

function addV23(
  proto: PoolProto,
  a: string,
  b: string,
  duplicates = 1,
): string[] {
  const [token0, token1] = canonicalPair(a, b);
  const inserted: string[] = [];
  for (let i = 0; i < duplicates; i++) {
    const poolAddress = address(nextPoolAddress++);
    store.insertPool({
      address: poolAddress,
      proto,
      token0,
      token1,
      feePpm: proto.endsWith('v2') ? 3_000 : 500 + i,
      ...(proto.endsWith('v3') ? { tickSpacing: 10, createdBlock: 190 } : {}),
    });
    inserted.push(poolAddress);
  }
  return inserted;
}

function addV4(
  a: string,
  b: string,
  options: { snapshot?: boolean; createdBlock?: number } = {},
): string {
  const [currency0, currency1] = canonicalPair(a, b);
  const poolId = id(nextPoolId++);
  store.insertV4Pool({
    poolId,
    poolManager: TEST_V4.POOL_MANAGER,
    currency0,
    currency1,
    tickSpacing: 10,
    hooks,
    ...(options.snapshot ? { snapshotGeneration } : {}),
    ...(options.createdBlock === undefined
      ? {}
      : { keyFeePpm: 500, createdBlock: options.createdBlock }),
  });
  return poolId;
}

// neighbor[0] deliberately has duplicate identities and multiple protocols;
// neighbor[1] deliberately appears in both V4 projections. Both must collapse
// without a page boundary splitting the protocol set.
addV23('univ2', seed, neighbors[0], 3);
addV23('pancakev2', seed, neighbors[0]);
addV23('univ3', seed, neighbors[1]);
const publishedSnapshotPoolA = addV4(seed, neighbors[1], {
  snapshot: true,
  createdBlock: 210,
});
addV23('pancakev3', seed, neighbors[2]);
for (const proto of ['univ2', 'univ3', 'pancakev2', 'pancakev3'] as const)
  addV23(proto, seed, neighbors[3]);
const publishedSnapshotPoolB = addV4(seed, neighbors[3], { snapshot: true });
// Already stored but outside the published finalized fence.
addV4(seed, neighbors[4], { createdBlock: 230 });

function publishReadyCatalogs(): void {
  const totals = Object.fromEntries(
    store.poolCounts().map((row) => [row.proto, row.n]),
  ) as Record<string, number>;
  store.kvSet('ready', '1');
  store.kvSet('solver_v23_boot_ready', '1');
  store.kvSet('solver_v4_boot_ready', '1');
  store.kvSet('v2_count', String(totals.univ2 ?? 0));
  store.kvSet('v2_factory_count', String(totals.univ2 ?? 0));
  store.kvSet('v3_cursor', String(currentBlock));
  store.kvSet('v3_target_block', String(currentBlock));
  store.kvSet('v3_backfilled', '1');
  store.kvSet('v3_snapshot_source', 'thegraph');
  store.kvSet('v3_snapshot_block', String(snapshotBlock));
  store.kvSet('v3_snapshot_block_hash', snapshotHash);
  store.kvSet('v3_snapshot_pool_count', '1');
  store.kvSet('v3_snapshot_deployment', BSC_UNI_V3_SUBGRAPH_DEPLOYMENT);
  store.kvSet('v3_snapshot_subgraph_id', BSC_UNI_V3_SUBGRAPH_ID);
  store.kvSet('v3_snapshot_complete', '1');
  store.kvSet('pancake_v2_count', String(totals.pancakev2 ?? 0));
  store.kvSet('pancake_v2_factory_count', String(totals.pancakev2 ?? 0));
  store.kvSet('pancake_v2_snapshot_source', 'ankr_getLogs');
  store.kvSet('pancake_v2_snapshot_block', String(snapshotBlock));
  store.kvSet('pancake_v2_snapshot_block_hash', snapshotHash);
  store.kvSet('pancake_v2_snapshot_pool_count', String(totals.pancakev2 ?? 0));
  store.kvSet(
    'pancake_v2_snapshot_catalog_generation',
    store.pancakeV2CatalogGeneration(),
  );
  store.kvSet('pancake_v2_snapshot_complete', '1');
  store.kvSet('pancake_v3_cursor', String(currentBlock));
  store.kvSet('pancake_v3_target_block', String(currentBlock));
  store.kvSet('pancake_v3_backfilled', '1');
  store.kvSet('pancake_v3_snapshot_source', 'thegraph');
  store.kvSet('pancake_v3_snapshot_block', String(snapshotBlock));
  store.kvSet('pancake_v3_snapshot_block_hash', snapshotHash);
  store.kvSet('pancake_v3_snapshot_pool_count', '1');
  store.kvSet('pancake_v3_snapshot_deployment', BSC_PANCAKE_V3_SUBGRAPH_DEPLOYMENT);
  store.kvSet('pancake_v3_snapshot_subgraph_id', BSC_PANCAKE_V3_SUBGRAPH_ID);
  store.kvSet('pancake_v3_snapshot_complete', '1');
  store.kvSet('v23_tail_error', '');
  store.kvSet('v23_tail_success_at', '219');

  store.tx(() => {
    store.kvSet('v4_snapshot_source', 'thegraph');
    store.kvSet('v4_snapshot_block', String(snapshotBlock));
    store.kvSet('v4_snapshot_block_hash', snapshotHash);
    store.kvSet('v4_snapshot_pool_count', '2');
    store.kvSet('v4_snapshot_deployment', 'QmPinned');
    store.kvSet('v4_snapshot_subgraph_id', TEST_V4_SUBGRAPH);
    store.deleteStaleV4SnapshotCandidates(snapshotGeneration);
    store.kvSet('v4_snapshot_generation', snapshotGeneration);
    store.kvSet('v4_snapshot_complete', '1');
  });
  store.kvSet('v4_cursor', String(currentBlock));
  store.kvSet('v4_target_block', String(currentBlock));
  store.kvSet('v4_backfilled', '1');
}

publishReadyCatalogs();

function allProtocolParams(token = seed, limit = 512): URLSearchParams {
  const params = new URLSearchParams({ token, limit: String(limit) });
  for (const protocol of ['pancakev3', 'univ4', 'univ2', 'pancakev2', 'univ3'])
    params.append('protocol', protocol);
  return params;
}

function decodeCursor(raw: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function encodeCursor(fields: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(fields), 'utf8').toString('base64url');
}

after(() => {
  store.db.close();
  if (previous.chain === undefined) delete process.env.CHAIN;
  else process.env.CHAIN = previous.chain;
  if (previous.db === undefined) delete process.env.INDEXER_DB;
  else process.env.INDEXER_DB = previous.db;
  if (previous.subgraph === undefined) delete process.env.INDEXER_V4_SUBGRAPH_ID;
  else process.env.INDEXER_V4_SUBGRAPH_ID = previous.subgraph;
  rmSync(tmp, { recursive: true, force: true });
});

test('adjacency emits the strict identity-free schema with canonical collapsed edges', () => {
  const response = api.getSolverAdjacency(allProtocolParams());
  assert.deepEqual(Object.keys(response), [
    'schemaVersion',
    'chainId',
    'chain',
    'ready',
    'protocols',
    'catalogs',
    'factories',
    'v23Fence',
    'v4Fence',
    'token',
    'count',
    'nextPageToken',
    'edges',
  ]);
  assert.equal(response.schemaVersion, 2);
  assert.equal(response.chainId, 56);
  assert.deepEqual(response.chain, { key: 'bsc', id: 56 });
  assert.equal(response.ready, true);
  assert.deepEqual(response.protocols, [
    'univ2',
    'univ3',
    'pancakev2',
    'pancakev3',
    'univ4',
  ]);
  assert.deepEqual(response.factories, {
    univ2: UNI.V2_FACTORY.toLowerCase(),
    univ3: UNI.V3_FACTORY.toLowerCase(),
    pancakev2: ADDR.V2_FACTORY.toLowerCase(),
    pancakev3: ADDR.CL_FACTORY.toLowerCase(),
    univ4: V4.POOL_MANAGER.toLowerCase(),
  });
  assert.equal(response.count, 4);
  assert.equal(response.nextPageToken, null);
  assert.deepEqual(
    response.edges.map((edge) => ({
      neighbor: edge.token0 === seed ? edge.token1 : edge.token0,
      protocols: edge.protocols,
      keys: Object.keys(edge),
    })),
    [
      {
        neighbor: neighbors[0],
        protocols: ['univ2', 'pancakev2'],
        keys: ['token0', 'token1', 'protocols'],
      },
      {
        neighbor: neighbors[1],
        protocols: ['univ3', 'univ4'],
        keys: ['token0', 'token1', 'protocols'],
      },
      {
        neighbor: neighbors[2],
        protocols: ['pancakev3'],
        keys: ['token0', 'token1', 'protocols'],
      },
      {
        neighbor: neighbors[3],
        protocols: ['univ2', 'univ3', 'pancakev2', 'pancakev3', 'univ4'],
        keys: ['token0', 'token1', 'protocols'],
      },
    ],
  );
  assert.ok(response.edges.every((edge) => edge.token0 < edge.token1));
  assert.ok(
    !/[Pp]ool[Ii]d|feePpm|tvl|reserve|liquidity|metadata|total/.test(
      JSON.stringify(response.edges),
    ),
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(response)) <=
      api.SOLVER_ADJACENCY_MAX_RESPONSE_BYTES,
  );
});

test('neighbor-keyset pagination never splits a multi-protocol edge', () => {
  const first = api.getSolverAdjacency(allProtocolParams(seed, 1));
  assert.equal(first.count, 1);
  assert.deepEqual(first.edges[0].protocols, ['univ2', 'pancakev2']);
  assert.ok(first.nextPageToken);
  assert.ok(
    Buffer.byteLength(first.nextPageToken) <= api.SOLVER_ADJACENCY_MAX_CURSOR_BYTES,
  );

  const seen = [...first.edges];
  let next: string | null = first.nextPageToken;
  while (next !== null) {
    const params = allProtocolParams(seed, 1);
    params.set('page_token', next);
    const page = api.getSolverAdjacency(params);
    seen.push(...page.edges);
    next = page.nextPageToken;
  }
  assert.deepEqual(
    seen.map((edge) => (edge.token0 === seed ? edge.token1 : edge.token0)),
    neighbors.slice(0, 4),
  );
  assert.equal(new Set(seen.map((edge) => `${edge.token0}:${edge.token1}`)).size, 4);
});

test('cursor binds chain, token, protocol mask, limit and canonical field order', () => {
  const first = api.getSolverAdjacency(allProtocolParams(seed, 1));
  assert.ok(first.nextPageToken);

  const wrongLimit = allProtocolParams(seed, 2);
  wrongLimit.set('page_token', first.nextPageToken);
  assert.throws(() => api.getSolverAdjacency(wrongLimit), api.ApiInputError);

  const wrongProtocol = allProtocolParams(seed, 1);
  wrongProtocol.delete('protocol');
  wrongProtocol.append('protocol', 'univ2');
  wrongProtocol.set('page_token', first.nextPageToken);
  assert.throws(() => api.getSolverAdjacency(wrongProtocol), api.ApiInputError);

  const decoded = decodeCursor(first.nextPageToken);
  const reversed = Object.fromEntries(Object.entries(decoded).reverse());
  const nonCanonical = allProtocolParams(seed, 1);
  nonCanonical.set('page_token', encodeCursor(reversed));
  assert.throws(() => api.getSolverAdjacency(nonCanonical), api.ApiInputError);

  const wrongChain = { ...decoded, chainId: 1 };
  const chainParams = allProtocolParams(seed, 1);
  chainParams.set('page_token', encodeCursor(wrongChain));
  assert.throws(() => api.getSolverAdjacency(chainParams), api.ApiInputError);

  const oversized = allProtocolParams(seed, 1);
  oversized.set('page_token', 'a'.repeat(api.SOLVER_ADJACENCY_MAX_CURSOR_BYTES + 1));
  assert.throws(() => api.getSolverAdjacency(oversized), api.ApiInputError);
});

test('explicit fences freeze both endpoints while current V4 cursor advances', () => {
  const first = api.getSolverAdjacency(allProtocolParams(seed));
  const endpoint = neighbors[0];
  const lateNeighbor = address(0x4000);
  const latePool = addV4(endpoint, lateNeighbor, { createdBlock: currentBlock + 1 });
  store.kvSet('v4_cursor', String(currentBlock + 1));
  try {
    const second = allProtocolParams(endpoint);
    second.set('v23_seq', first.v23Fence.seq);
    second.set('v23_generation', first.v23Fence.generation);
    second.set('v4_block', String(first.v4Fence.block));
    second.set('v4_generation', first.v4Fence.generation ?? 'null');
    const frozen = api.getSolverAdjacency(second);
    assert.equal(frozen.v4Fence.block, currentBlock);
    assert.equal(frozen.catalogs.univ4.cursorBlock, currentBlock + 1);
    assert.ok(
      frozen.edges.every(
        (edge) => edge.token0 !== lateNeighbor && edge.token1 !== lateNeighbor,
      ),
    );
  } finally {
    store.kvSet('v4_cursor', String(currentBlock));
    store.db.prepare('DELETE FROM v4_pools WHERE pool_id = ?').run(latePool);
  }
});

test('future fences are rejected and destructive generation changes return conflict', () => {
  const current = api.getSolverAdjacency(allProtocolParams(seed, 1));
  assert.ok(current.nextPageToken);
  const decoded = decodeCursor(current.nextPageToken);

  const future = {
    ...decoded,
    v23Seq: String(BigInt(current.v23Fence.seq) + 1n),
  };
  const futureParams = allProtocolParams(seed, 1);
  futureParams.set('page_token', encodeCursor(future));
  assert.throws(() => api.getSolverAdjacency(futureParams), api.ApiInputError);

  const temporary = addV23('univ2', seed, address(0x5000))[0];
  store.db.prepare('DELETE FROM pools WHERE address = ?').run(temporary);
  const stale = allProtocolParams(seed, 1);
  stale.set('page_token', current.nextPageToken);
  assert.throws(() => api.getSolverAdjacency(stale), api.ApiConflictError);
});

test('insert high-water excludes later additions without invalidating continuation', () => {
  const first = api.getSolverAdjacency(allProtocolParams(seed, 1));
  assert.ok(first.nextPageToken);
  const addedNeighbor = address(0x2500);
  const addedPool = addV23('univ2', seed, addedNeighbor)[0];
  try {
    const seen: string[] = [];
    let next: string | null = first.nextPageToken;
    while (next !== null) {
      const params = allProtocolParams(seed, 1);
      params.set('page_token', next);
      const page = api.getSolverAdjacency(params);
      seen.push(
        ...page.edges.map((edge) =>
          edge.token0 === seed ? edge.token1 : edge.token0,
        ),
      );
      next = page.nextPageToken;
    }
    assert.ok(!seen.includes(addedNeighbor));
  } finally {
    store.db.prepare('DELETE FROM pools WHERE address = ?').run(addedPool);
  }
});

test('active refcount projection survives identity move-and-return without duplicate rows', () => {
  const originalNeighbor = address(0x6000);
  const movedNeighbor = address(0x6001);
  const pool = addV23('univ2', seed, originalNeighbor)[0];
  const [moved0, moved1] = canonicalPair(seed, movedNeighbor);
  const [original0, original1] = canonicalPair(seed, originalNeighbor);
  try {
    store.db
      .prepare('UPDATE pools SET token0 = ?, token1 = ? WHERE address = ?')
      .run(moved0, moved1, pool);
    store.db
      .prepare('UPDATE pools SET token0 = ?, token1 = ? WHERE address = ?')
      .run(original0, original1, pool);
    const rows = store.db
      .prepare(
        `SELECT token0, token1, ref_count FROM solver_v23_adjacency
         WHERE proto = 'univ2' AND (token0 IN (?, ?) OR token1 IN (?, ?))`,
      )
      .all(originalNeighbor, movedNeighbor, originalNeighbor, movedNeighbor) as Array<{
      token0: string;
      token1: string;
      ref_count: number;
    }>;
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { token0: original0, token1: original1, ref_count: 1 },
    ]);
  } finally {
    store.db.prepare('DELETE FROM pools WHERE address = ?').run(pool);
  }
});

test('high-duplication pool identities remain one indexed projection row', () => {
  const duplicateNeighbor = address(0x7000);
  let inserted: string[] = [];
  store.tx(() => {
    inserted = addV23('univ3', seed, duplicateNeighbor, 1_500);
  });
  try {
    const [token0, token1] = canonicalPair(seed, duplicateNeighbor);
    const projection = store.db
      .prepare(
        `SELECT first_seq, ref_count FROM solver_v23_adjacency
         WHERE proto = 'univ3' AND token0 = ? AND token1 = ?`,
      )
      .get(token0, token1) as { first_seq: number; ref_count: number };
    assert.equal(projection.ref_count, inserted.length);
    const source = store.db
      .prepare(
        `SELECT MIN(catalog_seq) AS first_seq FROM pools
         WHERE proto = 'univ3' AND token0 = ? AND token1 = ?`,
      )
      .get(token0, token1) as { first_seq: number };
    assert.equal(projection.first_seq, source.first_seq);

    const plan = store.db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT token1 AS neighbor, proto
         FROM solver_v23_adjacency INDEXED BY idx_solver_v23_adjacency_t0
         WHERE proto = ? AND token0 = ? AND first_seq <= ?
         ORDER BY token1, proto LIMIT ?`,
      )
      .all('univ3', token0, Number(store.v23CatalogClock().seq), 2) as Array<{
      detail: string;
    }>;
    const details = plan.map((row) => row.detail).join('\n');
    assert.match(details, /idx_solver_v23_adjacency_t0/);
    assert.doesNotMatch(details, /\b(?:SCAN|SEARCH) pools\b/);

    const result = api.getSolverAdjacency(
      new URLSearchParams({ token: seed, protocol: 'univ3', limit: '32' }),
    );
    assert.equal(
      result.edges.filter(
        (edge) => edge.token0 === duplicateNeighbor || edge.token1 === duplicateNeighbor,
      ).length,
      1,
    );
  } finally {
    store.db
      .prepare(`DELETE FROM pools WHERE address IN (${inserted.map(() => '?').join(',')})`)
      .run(...inserted);
  }
});

test('frozen-fence admission and keyset reads use their bounded covering indexes', () => {
  const plans = [
    {
      sql: `SELECT token1 AS neighbor
            FROM solver_v23_adjacency INDEXED BY idx_solver_v23_adjacency_t0
            WHERE proto = ? AND token0 = ? AND token1 > ? AND first_seq <= ?
            ORDER BY token1 LIMIT ?`,
      args: ['univ2', seed, address(0), Number(store.v23CatalogClock().seq), 2],
      indexes: ['idx_solver_v23_adjacency_t0'],
    },
    {
      sql: `SELECT token0 AS neighbor
            FROM solver_v23_adjacency INDEXED BY idx_solver_v23_adjacency_t1
            WHERE proto = ? AND token1 = ? AND token0 > ? AND first_seq <= ?
            ORDER BY token0 LIMIT ?`,
      args: ['univ2', seed, address(0), Number(store.v23CatalogClock().seq), 2],
      indexes: ['idx_solver_v23_adjacency_t1'],
    },
    {
      sql: `SELECT 1 AS future_row FROM (
              SELECT 1
              FROM solver_v23_adjacency
                INDEXED BY idx_solver_v23_adjacency_t0_future
              WHERE proto = ? AND token0 = ? AND first_seq > ?
              UNION ALL
              SELECT 1
              FROM solver_v23_adjacency
                INDEXED BY idx_solver_v23_adjacency_t1_future
              WHERE proto = ? AND token1 = ? AND first_seq > ?
            ) LIMIT ?`,
      args: [
        'univ2',
        seed,
        0,
        'univ2',
        seed,
        0,
        api.SOLVER_ADJACENCY_MAX_FUTURE_ROWS_PER_PROTOCOL + 1,
      ],
      indexes: [
        'idx_solver_v23_adjacency_t0_future',
        'idx_solver_v23_adjacency_t1_future',
      ],
      range: /first_seq>\?/g,
    },
    {
      sql: `SELECT token1 AS neighbor
            FROM solver_v4_adjacency_event
              INDEXED BY idx_solver_v4_adjacency_event_t0
            WHERE token0 = ? AND token1 > ? AND first_created_block <= ?
            ORDER BY token1 LIMIT ?`,
      args: [seed, address(0), currentBlock, 2],
      indexes: ['idx_solver_v4_adjacency_event_t0'],
    },
    {
      sql: `SELECT token0 AS neighbor
            FROM solver_v4_adjacency_event
              INDEXED BY idx_solver_v4_adjacency_event_t1
            WHERE token1 = ? AND token0 > ? AND first_created_block <= ?
            ORDER BY token0 LIMIT ?`,
      args: [seed, address(0), currentBlock, 2],
      indexes: ['idx_solver_v4_adjacency_event_t1'],
    },
    {
      sql: `SELECT 1 AS future_row FROM (
              SELECT 1
              FROM solver_v4_adjacency_event
                INDEXED BY idx_solver_v4_adjacency_event_t0_future
              WHERE token0 = ? AND first_created_block > ?
              UNION ALL
              SELECT 1
              FROM solver_v4_adjacency_event
                INDEXED BY idx_solver_v4_adjacency_event_t1_future
              WHERE token1 = ? AND first_created_block > ?
            ) LIMIT ?`,
      args: [
        seed,
        currentBlock,
        seed,
        currentBlock,
        api.SOLVER_ADJACENCY_MAX_FUTURE_ROWS_PER_PROTOCOL + 1,
      ],
      indexes: [
        'idx_solver_v4_adjacency_event_t0_future',
        'idx_solver_v4_adjacency_event_t1_future',
      ],
      range: /first_created_block>\?/g,
    },
  ];

  for (const plan of plans) {
    const details = (
      store.db.prepare(`EXPLAIN QUERY PLAN ${plan.sql}`).all(...plan.args) as Array<{
        detail: string;
      }>
    )
      .map((row) => row.detail)
      .join('\n');
    for (const index of plan.indexes) assert.match(details, new RegExp(index));
    if (plan.range) assert.equal(details.match(plan.range)?.length, 2);
    assert.doesNotMatch(details, /USE TEMP B-TREE/);
  }
});

test('v2/v3 continuation admits the combined future-row boundary and rejects one more', () => {
  const first = api.getSolverAdjacency(allProtocolParams(seed, 1));
  assert.ok(first.nextPageToken);
  const frozenSeq = Number(first.v23Fence.seq);
  const insert = store.db.prepare(
    `INSERT INTO solver_v23_adjacency(
       proto, token0, token1, first_seq, ref_count
     ) VALUES ('univ2', ?, ?, ?, 1)`,
  );
  const clock = store.v23CatalogClock();
  const continuation = allProtocolParams(seed, 1);
  continuation.set('page_token', first.nextPageToken);
  try {
    store.tx(() => {
      for (let i = 0; i < api.SOLVER_ADJACENCY_MAX_FUTURE_ROWS_PER_PROTOCOL; i++) {
        const neighbor =
          i % 2 === 0 ? address(0x400 + i / 2) : address(0x800000 + i);
        const [token0, token1] = canonicalPair(seed, neighbor);
        insert.run(token0, token1, frozenSeq + i + 1);
      }
      store.db
        .prepare('UPDATE v23_catalog_clock SET next_seq = ? WHERE singleton = 1')
        .run(frozenSeq + api.SOLVER_ADJACENCY_MAX_FUTURE_ROWS_PER_PROTOCOL);
    });

    const admitted = api.getSolverAdjacency(continuation);
    assert.equal(admitted.v23Fence.seq, String(frozenSeq));

    const [token0, token1] = canonicalPair(seed, address(0xa00000));
    store.tx(() => {
      insert.run(
        token0,
        token1,
        frozenSeq + api.SOLVER_ADJACENCY_MAX_FUTURE_ROWS_PER_PROTOCOL + 1,
      );
      store.db
        .prepare('UPDATE v23_catalog_clock SET next_seq = ? WHERE singleton = 1')
        .run(frozenSeq + api.SOLVER_ADJACENCY_MAX_FUTURE_ROWS_PER_PROTOCOL + 1);
    });
    assert.throws(
      () => api.getSolverAdjacency(continuation),
      api.ApiCapacityError,
    );
  } finally {
    store.tx(() => {
      store.db
        .prepare(
          `DELETE FROM solver_v23_adjacency
           WHERE proto = 'univ2' AND first_seq > ? AND (token0 = ? OR token1 = ?)`,
        )
        .run(frozenSeq, seed, seed);
      store.db
        .prepare('UPDATE v23_catalog_clock SET next_seq = ? WHERE singleton = 1')
        .run(Number(clock.seq));
    });
  }
});

test('five-protocol continuation rejects adversarial future drift as a bounded 503', async () => {
  const first = api.getSolverAdjacency(allProtocolParams(seed, 1));
  assert.ok(first.nextPageToken);
  const futureBlock = currentBlock + 1;
  const insert = store.db.prepare(
    `INSERT INTO solver_v4_adjacency_event(
       token0, token1, first_created_block, ref_count
     ) VALUES (?, ?, ?, 1)`,
  );
  store.tx(() => {
    for (let i = 0; i <= api.SOLVER_ADJACENCY_MAX_FUTURE_ROWS_PER_PROTOCOL; i++) {
      const neighbor =
        i % 2 === 0 ? address(0x400 + i / 2) : address(0x900000 + i);
      const [token0, token1] = canonicalPair(seed, neighbor);
      insert.run(token0, token1, futureBlock);
    }
  });

  const server = api.createApiServer();
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const params = allProtocolParams(seed, 1);
    params.set('page_token', first.nextPageToken);
    const started = performance.now();
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/solver/adjacency?${params}`,
    );
    const elapsed = performance.now() - started;
    assert.equal(response.status, 503);
    assert.match(await response.text(), /future-row cap exceeded/);
    assert.ok(elapsed < 1_000, `bounded rejection took ${elapsed.toFixed(1)}ms`);
  } finally {
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    store.db
      .prepare(
        `DELETE FROM solver_v4_adjacency_event
         WHERE first_created_block = ? AND (token0 = ? OR token1 = ?)`,
      )
      .run(futureBlock, seed, seed);
  }
});

test('V4 snapshot projection publishes by generation and atomically GCs the old shadow', () => {
  const nextGeneration = id(0xf00);
  const nextNeighbor = address(0x7100);
  const [currency0, currency1] = canonicalPair(seed, nextNeighbor);
  const poolId = id(nextPoolId++);
  store.insertV4Pool({
    poolId,
    poolManager: TEST_V4.POOL_MANAGER,
    currency0,
    currency1,
    tickSpacing: 10,
    hooks,
    snapshotGeneration: nextGeneration,
  });
  try {
    const countGeneration = (generation: string): number =>
      (
        store.db
          .prepare(
            'SELECT COUNT(*) AS n FROM solver_v4_adjacency_snapshot WHERE snapshot_generation = ?',
          )
          .get(generation) as { n: number }
      ).n;
    assert.equal(countGeneration(snapshotGeneration), 2);
    assert.equal(countGeneration(nextGeneration), 1);

    // A replacement sees identities already present in the published
    // generation. Adding those memberships must not move the compatibility
    // column or make the old generation incomplete while download/rebuild is
    // interrupted.
    store.setV4SnapshotGeneration(publishedSnapshotPoolA, nextGeneration);
    // A same-count replacement can still be incomplete: this shadow contains
    // one shared PoolId and one new PoolId, but omits the other published PoolId.
    // It must not be able to bypass the arm/switch state machine with raw KV.
    assert.equal(store.v4SnapshotGenerationCount(nextGeneration), 2);
    assert.throws(
      () => store.kvSet('v4_snapshot_generation', nextGeneration),
      /v4 snapshot generation switch is not armed/,
    );
    assert.equal(store.kvGet('v4_snapshot_generation'), snapshotGeneration);
    assert.equal(store.hasCompleteV4SnapshotRows(), true);
    assert.doesNotThrow(() =>
      store.kvSet('v4_snapshot_generation', snapshotGeneration),
    );

    store.setV4SnapshotGeneration(publishedSnapshotPoolB, nextGeneration);
    assert.equal(store.v4SnapshotGenerationCount(snapshotGeneration), 2);
    assert.equal(store.v4SnapshotGenerationCount(nextGeneration), 3);
    assert.equal(
      store.v4PoolRow(publishedSnapshotPoolA)?.snapshot_generation,
      snapshotGeneration,
    );
    assert.equal(store.hasCompleteV4SnapshotRows(), true);
    assert.throws(() =>
      store.db
        .prepare(
          `DELETE FROM v4_pool_snapshot_membership
           WHERE snapshot_generation = ? AND pool_id = ?`,
        )
        .run(snapshotGeneration, publishedSnapshotPoolA),
    );
    assert.throws(() =>
      store.db
        .prepare('UPDATE v4_pools SET currency1 = ? WHERE pool_id = ?')
        .run(address(0xdead), publishedSnapshotPoolA),
    );

    // Rebuilding while both shadows exist must preserve both. Only the armed
    // generation switch may publish and collect the old one.
    store.rebuildSolverAdjacencyProjection();
    assert.equal(countGeneration(snapshotGeneration), 2);
    assert.equal(countGeneration(nextGeneration), 3);
    assert.throws(
      () =>
        store.tx(() => {
          store.deleteStaleV4SnapshotCandidates(nextGeneration);
          store.kvSet('v4_snapshot_generation', nextGeneration);
        }),
      /cannot publish incomplete v4 snapshot membership/,
    );
    assert.equal(store.kvGet('v4_snapshot_publish_generation'), undefined);
    assert.equal(store.v4SnapshotGenerationCount(snapshotGeneration), 2);
    store.tx(() => {
      store.kvSet('v4_snapshot_pool_count', '3');
      store.deleteStaleV4SnapshotCandidates(nextGeneration);
      store.kvSet('v4_snapshot_generation', nextGeneration);
    });
    assert.equal(countGeneration(snapshotGeneration), 0);
    assert.equal(countGeneration(nextGeneration), 3);
    assert.equal(
      store.v4PoolRow(publishedSnapshotPoolA)?.snapshot_generation,
      nextGeneration,
    );
  } finally {
    // Restore the shared fixture through the same mark/arm/switch sequence.
    // The new-only Graph candidate is then removed by publish-time cleanup.
    store.setV4SnapshotGeneration(publishedSnapshotPoolA, snapshotGeneration);
    store.setV4SnapshotGeneration(publishedSnapshotPoolB, snapshotGeneration);
    store.tx(() => {
      store.kvSet('v4_snapshot_pool_count', '2');
      store.deleteStaleV4SnapshotCandidates(snapshotGeneration);
      store.kvSet('v4_snapshot_generation', snapshotGeneration);
    });
    assert.equal(store.v4PoolRow(poolId), undefined);
  }
});

test('event-proven V4 projection is append-only through supported store writes', () => {
  const eventNeighbor = address(0x7200);
  const [currency0, currency1] = canonicalPair(seed, eventNeighbor);
  const poolId = id(nextPoolId++);
  store.insertV4Pool({
    poolId,
    poolManager: TEST_V4.POOL_MANAGER,
    currency0,
    currency1,
    tickSpacing: 10,
    hooks,
  });
  const projection = () =>
    store.db
      .prepare(
        `SELECT first_created_block, ref_count FROM solver_v4_adjacency_event
         WHERE token0 = ? AND token1 = ?`,
      )
      .get(currency0, currency1) as
      | { first_created_block: number; ref_count: number }
      | undefined;
  try {
    assert.equal(projection(), undefined);
    store.setV4EventIdentity(poolId, 500, 215);
    assert.deepEqual({ ...projection() }, { first_created_block: 215, ref_count: 1 });
    // Idempotent replay must not inflate the refcount.
    store.setV4EventIdentity(poolId, 500, 215);
    assert.deepEqual({ ...projection() }, { first_created_block: 215, ref_count: 1 });
    assert.throws(() => store.setV4EventIdentity(poolId, 3_000, 215));
  } finally {
    // Raw SQL is test-only administration; production cleanup preserves every
    // event-proven row and has no corresponding delete API.
    store.db.prepare('DELETE FROM v4_pools WHERE pool_id = ?').run(poolId);
    store.db
      .prepare('DELETE FROM solver_v4_adjacency_event WHERE token0 = ? AND token1 = ?')
      .run(currency0, currency1);
  }
});

test('projection readiness fails closed and explicit offline rebuild republishes it', () => {
  store.kvSet('solver_adjacency_projection_version', 'pending');
  assert.deepEqual(api.getHealth().solverAdjacency, {
    schemaVersion: 2,
    ready: false,
    projectionVersion: 'pending',
  });
  assert.throws(
    () => api.getSolverAdjacency(allProtocolParams()),
    api.ApiCapacityError,
  );
  store.kvSet('v4_snapshot_pool_count', '3');
  assert.throws(
    () => store.rebuildSolverAdjacencyProjection(),
    /published V4 snapshot membership is incomplete/,
  );
  assert.equal(store.solverAdjacencyProjectionReady(), false);
  assert.equal(store.kvGet('solver_v4_membership_schema_version'), 'pending');
  store.kvSet('v4_snapshot_pool_count', '2');
  store.rebuildSolverAdjacencyProjection();
  assert.equal(store.solverAdjacencyProjectionReady(), true);
  assert.deepEqual(api.getHealth().solverAdjacency, {
    schemaVersion: 2,
    ready: true,
    projectionVersion: '1',
  });
  assert.equal(api.getSolverAdjacency(allProtocolParams()).count, 4);
});

test('HTTP route is no-store and maps incomplete projection to 503', async () => {
  const server = api.createApiServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const query = allProtocolParams().toString();
    const success = await fetch(
      `http://127.0.0.1:${port}/api/solver/adjacency?${query}`,
    );
    assert.equal(success.status, 200);
    assert.equal(success.headers.get('cache-control'), 'no-store');

    store.kvSet('solver_adjacency_projection_version', 'pending');
    const unavailable = await fetch(
      `http://127.0.0.1:${port}/api/solver/adjacency?${query}`,
    );
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get('cache-control'), 'no-store');
  } finally {
    store.kvSet('solver_adjacency_projection_version', '1');
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('strict request caps reject malformed scope before querying', () => {
  const invalid = [
    new URLSearchParams({ token: seed, protocol: 'univ2', limit: '0' }),
    new URLSearchParams({ token: seed, protocol: 'univ2', limit: '01' }),
    new URLSearchParams({ token: seed, protocol: 'univ2', limit: '1025' }),
    new URLSearchParams({ token: seed.toUpperCase(), protocol: 'univ2' }),
    new URLSearchParams({ token: seed, protocol: 'unknown' }),
    new URLSearchParams({ token: seed, protocol: 'univ2', total: '1' }),
    new URLSearchParams({ token: address(0), protocol: 'univ2' }),
  ];
  for (const params of invalid)
    assert.throws(() => api.getSolverAdjacency(params), api.ApiInputError);
  assert.equal(api.SOLVER_ADJACENCY_DEFAULT_LIMIT, 512);
  assert.equal(api.SOLVER_ADJACENCY_MAX_LIMIT, 1_024);
  assert.equal(api.SOLVER_ADJACENCY_MAX_FUTURE_ROWS_PER_PROTOCOL, 2_048);
  assert.equal(api.SOLVER_ADJACENCY_MAX_QUERY_ROWS, 12_300);
});
