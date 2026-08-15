import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

/**
 * The catalog gate in stats.ts, exercised through the real cycle.
 *
 * It is worth a whole child process because the thing that broke was invisible
 * from inside a unit: GT hands v4 pools back in the same `address` field as
 * everything else, `poolRow` could never match a bytes32, and the drop was
 * silent — the paid-for volume simply never appeared and every v4 market read
 * "—". A test that stubbed `poolRow` would have agreed with the bug.
 */
const knownPair = '0x1111111111111111111111111111111111111111';
const unknownPair = '0x2222222222222222222222222222222222222222';
const knownPoolId = `0x${'aa'.repeat(32)}`;
const unknownPoolId = `0x${'bb'.repeat(32)}`;
const manager = '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df';
const weth = '0x0000000000000000000000000000000000000010';
const usdg = '0x0000000000000000000000000000000000000020';

function runCycle(dbPath: string, source: string): string {
  const result = spawnSync(
    process.execPath,
    ['--import=tsx', '--input-type=module', '--eval', source],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, CHAIN: 'robinhood', INDEXER_DB: dbPath },
    },
  );
  assert.equal(
    result.status,
    0,
    `stats child failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result.stdout;
}

test('a GT cycle files v4 pools by PoolId and never returns one as an address', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stats-gate-'));
  const dbPath = join(dir, 'index.db');
  try {
    const out = runCycle(
      dbPath,
      `
      // One short page per list, so the cycle makes one call per list and the
      // free-tier pacing does not dominate the test.
      const page = { data: [
        pool(${JSON.stringify(knownPair)}, '11.5', 4),
        pool(${JSON.stringify(unknownPair)}, '99', 9),
        pool(${JSON.stringify(knownPoolId)}, '22.5', 6),
        pool(${JSON.stringify(unknownPoolId)}, '88', 8),
      ] };
      function pool(address, vol, buys) {
        return { attributes: {
          address,
          reserve_in_usd: '1000',
          volume_usd: { h24: vol },
          transactions: { h24: { buys, sells: 1 } },
        } };
      }
      globalThis.fetch = async () => ({ ok: true, json: async () => page });

      const { db, insertPool, insertV4Pool } = await import('./indexer/store.ts');
      insertPool({
        address: ${JSON.stringify(knownPair)}, proto: 'univ2',
        token0: ${JSON.stringify(weth)}, token1: ${JSON.stringify(usdg)}, feePpm: 3000,
      });
      insertV4Pool({
        poolId: ${JSON.stringify(knownPoolId)}, poolManager: ${JSON.stringify(manager)},
        currency0: ${JSON.stringify(weth)}, currency1: ${JSON.stringify(usdg)},
        tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000',
      });

      const { gtCycle } = await import('./indexer/stats.ts');
      const returned = await gtCycle();
      const rows = (table, key) => db.prepare(
        \`SELECT \${key} AS k, vol24h_usd AS v, txns24h AS n FROM \${table} ORDER BY k\`
      ).all();
      console.log('RESULT ' + JSON.stringify({
        returned,
        v23: rows('pool_stats', 'address'),
        v4: rows('v4_market_stats', 'pool_id'),
      }));
      `,
    );
    const line = out.split('\n').find((l) => l.startsWith('RESULT '));
    assert.ok(line, `child printed no result\n${out}`);
    const got = JSON.parse(line.slice('RESULT '.length)) as {
      returned: string[];
      v23: Array<{ k: string; v: number; n: number }>;
      v4: Array<{ k: string; v: number; n: number }>;
    };

    assert.deepEqual(
      got.v23,
      [{ k: knownPair, v: 11.5, n: 5 }],
      'an address in the catalog is recorded, an address outside it is not',
    );
    assert.deepEqual(
      got.v4,
      [{ k: knownPoolId, v: 22.5, n: 7 }],
      'a PoolId in the v4 directory is recorded — this is what used to be dropped',
    );
    // The caller spends the return value on address-keyed RPC work. A PoolId
    // there sends it looking for a contract that does not exist.
    assert.deepEqual(got.returned, [knownPair]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
