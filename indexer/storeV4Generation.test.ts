import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const oldGeneration = `0x${'11'.repeat(32)}`;
const nextGeneration = `0x${'22'.repeat(32)}`;
const poolA = `0x${'aa'.repeat(32)}`;
const poolB = `0x${'bb'.repeat(32)}`;
const poolC = `0x${'cc'.repeat(32)}`;
const manager = '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df';
const tokenA = '0x0000000000000000000000000000000000000010';
const tokenB = '0x0000000000000000000000000000000000000020';
const tokenC = '0x0000000000000000000000000000000000000030';
const hooks = '0x0000000000000000000000000000000000000000';

function runStoreProcess(dbPath: string, source: string): void {
  const result = spawnSync(
    process.execPath,
    ['--import=tsx', '--input-type=module', '--eval', source],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        CHAIN: 'bsc',
        INDEXER_DB: dbPath,
      },
    },
  );
  assert.equal(
    result.status,
    0,
    `store child failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

test('interrupted V4 replacement survives restart, rebuild, switch and old-generation GC', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lp-terminal-v4-membership-'));
  const dbPath = join(tmp, 'catalog.db');
  try {
    runStoreProcess(
      dbPath,
      `
        import assert from 'node:assert/strict';
        import * as store from './indexer/store.ts';
        const common = {
          poolManager: '${manager}',
          tickSpacing: 10,
          hooks: '${hooks}',
        };
        store.insertV4Pool({
          ...common,
          poolId: '${poolA}',
          currency0: '${hooks}',
          currency1: '${tokenA}',
          snapshotGeneration: '${oldGeneration}',
        });
        store.insertV4Pool({
          ...common,
          poolId: '${poolB}',
          currency0: '${tokenA}',
          currency1: '${tokenB}',
          snapshotGeneration: '${oldGeneration}',
        });
        assert.throws(
          () => store.kvSet('v4_snapshot_generation', '${oldGeneration}'),
          /v4 snapshot generation switch is not armed/,
        );
        assert.equal(store.kvGet('v4_snapshot_generation'), undefined);
        store.tx(() => {
          store.kvSet('v4_snapshot_source', 'thegraph');
          store.kvSet('v4_snapshot_block', '200');
          store.kvSet('v4_snapshot_block_hash', '0x' + 'ab'.repeat(32));
          store.kvSet('v4_snapshot_pool_count', '2');
          store.kvSet('v4_snapshot_deployment', 'QmPinnedDeployment');
          store.kvSet('v4_snapshot_subgraph_id', 'EAq1nJKgjnuKH6Gj4RFjCW7LcL7E2uipbncdwV7TTWkX');
          store.deleteStaleV4SnapshotCandidates('${oldGeneration}');
          store.kvSet('v4_snapshot_generation', '${oldGeneration}');
          store.kvSet('v4_snapshot_complete', '1');
        });

        // Download part of a replacement, including one PoolId shared with the
        // published generation, then exit without arming or switching it.
        store.setV4SnapshotGeneration('${poolA}', '${nextGeneration}');
        store.insertV4Pool({
          ...common,
          poolId: '${poolC}',
          currency0: '${tokenA}',
          currency1: '${tokenC}',
          snapshotGeneration: '${nextGeneration}',
        });
        if (!store.hasCompleteV4SnapshotRows()) throw new Error('published generation was damaged');
        store.db.close();
      `,
    );

    runStoreProcess(
      dbPath,
      `
        import assert from 'node:assert/strict';
        import * as store from './indexer/store.ts';
        assert.equal(store.solverAdjacencyProjectionReady(), true);
        assert.equal(store.hasCompleteV4SnapshotRows(), true);
        assert.equal(store.v4SnapshotGenerationCount('${oldGeneration}'), 2);
        assert.equal(store.v4SnapshotGenerationCount('${nextGeneration}'), 2);
        assert.equal(store.v4PoolRow('${poolA}')?.snapshot_generation, '${oldGeneration}');

        // Offline rebuild must preserve both durable shadows and validate the
        // published count before returning readiness.
        store.rebuildSolverAdjacencyProjection();
        assert.equal(store.solverAdjacencyProjectionReady(), true);
        assert.equal(store.v4SnapshotGenerationCount('${oldGeneration}'), 2);
        assert.equal(store.v4SnapshotGenerationCount('${nextGeneration}'), 2);

        store.tx(() => {
          store.deleteStaleV4SnapshotCandidates('${nextGeneration}');
          store.kvSet('v4_snapshot_generation', '${nextGeneration}');
        });
        assert.equal(store.v4SnapshotGenerationCount('${oldGeneration}'), 0);
        assert.equal(store.v4SnapshotGenerationCount('${nextGeneration}'), 2);
        assert.equal(store.v4PoolRow('${poolA}')?.snapshot_generation, '${nextGeneration}');
        assert.equal(store.v4PoolRow('${poolB}'), undefined);
        assert.ok(store.v4PoolRow('${poolC}'));
        assert.equal(store.hasCompleteV4SnapshotRows(), true);
        store.db.close();
      `,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
