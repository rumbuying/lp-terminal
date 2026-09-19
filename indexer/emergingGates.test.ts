import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

// env FIRST, then imports (connectorRank.test.ts's pattern).
const tmp = mkdtempSync(join(tmpdir(), 'lp-terminal-emerging-gates-'));
const previous = { chain: process.env.CHAIN, db: process.env.INDEXER_DB };
process.env.CHAIN = 'robinhood';
process.env.INDEXER_DB = join(tmp, 'catalog.db');

const store = await import('./store');
const emergingStore = await import('./emergingStore');
const { evaluateGates } = await import('./emergingGates');
const { runEmergingSignalSweep } = await import('./emergingSignals');
const { EMERGING_POLICY } = await import('./emergingPolicy');
const { saveReduction } = await import('./emergingReduction');
const { CHAIN } = await import('./config');
import { getSqrtRatioAtTick } from '../src/lib/clmath';

after(() => {
  store.db.close();
  if (previous.chain === undefined) delete process.env.CHAIN;
  else process.env.CHAIN = previous.chain;
  if (previous.db === undefined) delete process.env.INDEXER_DB;
  else process.env.INDEXER_DB = previous.db;
  rmSync(tmp, { recursive: true, force: true });
});

const chainId = 4663;
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const BASE = addr(0xbeef);
const POOL_ID = addr(0x71);
const POOL_KEY = `${chainId}:univ3:${POOL_ID}`;
const t = Math.floor(Date.now() / 1000);
const SQRT0 = getSqrtRatioAtTick(0);

function admit() {
  store.upsertEmergingDiscovery({
    poolKey: POOL_KEY, venue: 'univ3', canonicalId: POOL_ID,
    token0: BASE, token1: CHAIN.addr.STABLE, baseToken: BASE, quoteIsUsdg: true,
    poolCreatedAt: t - 2 * 86_400, tokenCreatedAt: t - 3 * 86_400, launchAt: t - 3 * 86_400,
    firstSeenAt: t - 2 * 86_400, origin: 'test',
  });
  store.recordEmergingTransition({
    poolKey: POOL_KEY, fromState: 'discovered', toState: 'queued',
    reason: null, admittedRank: 1, occurredAt: t,
  });
  store.db.prepare(
    `INSERT INTO pools(address, proto, token0, token1, fee_ppm, created_block, added_ts)
     VALUES (?, 'univ3', ?, ?, 3000, 1, 1)`,
  ).run(POOL_ID, BASE, CHAIN.addr.STABLE);
  // Fresh cursor so G03/G08's freshness holds.
  store.db.prepare(
    `INSERT INTO emerging_scan_cursors(chain_id, stream_key, block_number, block_hash, last_scan_at, complete_through_ts, status)
     VALUES (?, 'cl-pools', 100, '0xh', ?, ?, 'active')`,
  ).run(chainId, t, t);
}

let seq = 0;
const addSwap = (args: { ts: number; amount0: string; amount1: string; recipient: string; block: number }) => {
  emergingStore.commitEmergingScanBatch({
    streamKey: 'cl-pools',
    events: [{
      txHash: `0x${(0xb000 + ++seq).toString(16)}`, logIndex: seq,
      blockNumber: args.block, blockHash: '0xh', txIndex: 0, blockTs: args.ts,
      contract: POOL_ID, kind: 'swap', poolKey: POOL_KEY, token: null,
      payload: { amount0: args.amount0, amount1: args.amount1, sqrtPriceX96: SQRT0.toString(), liquidity: '1000000000', tick: '0', sender: POOL_ID, recipient: args.recipient },
    }],
    cursorBlockNumber: args.block, cursorBlockHash: '0xh', cursorBlockTs: args.ts, at: t,
  });
};

test('gates: an unreviewed token is UNKNOWN everywhere it matters — the default-deny spine', () => {
  admit();
  const { gates, allPass } = evaluateGates(POOL_KEY, 'research-100usdg-v1');
  assert.equal(allPass, false, 'an empty registry can never pass all gates');
  assert.equal(gates.G02.status, 'unknown');
  assert.match(gates.G02.reason, /template_unreviewed/);
  assert.equal(gates.G04.status, 'unknown', 'G04 says its feed is missing (§5.3)');
  assert.match(gates.G04.reason, /not_built/);
  assert.equal(gates.G07.status, 'unknown', 'G07 says its feed is missing');
  assert.equal(gates.G03.status, 'pass', 'static-fee v3 with fresh cursor passes');
  assert.equal(gates.G08.status, 'unknown', 'no sell evidence recorded yet');
  // The bundle carries what a pass is meaningless without (§5.3/§6.1).
  assert.equal(gates.researchProfileHash, 'research-100usdg-v1');
  assert.equal(gates.policyVersion, '1');
});

test('signals: nothing becomes a candidate while a gate is unknown — even with perfect flows', () => {
  // Perfect retention hours and a confirmed reduction, but G02 stays unknown.
  for (let h = 1; h <= 12; h++) {
    store.db.prepare(
      `INSERT INTO pool_minute_buckets(pool_key, minute_ts, complete, aggregate_version, swap_count, vol_quote, close_price)
       VALUES (?, ?, 1, 1, 1, '500000000', '1.1')`,
    ).run(POOL_KEY, t - h * 3600 + 30);
  }
  saveReduction(BASE, { startedAt: t - 7 * 3600, confirmedAt: t - 3600, invalidatedAt: null, reason: null });
  const r = runEmergingSignalSweep();
  assert.equal(r.candidates, 0);
  const rows = store.db
    .prepare('SELECT COUNT(*) AS n FROM emerging_signal_events')
    .get() as { n: number };
  assert.equal(rows.n, 0, 'unknown gates never mint candidates');
});

test('gates: a REVIEWED template flips G02 to pass; concentration and sells evaluate on data', () => {
  EMERGING_POLICY.tokens[BASE] = {
    fixedSupply: true, noTax: true, noRebase: true, noBlacklist: true,
    noPause: true, permissionsRenounced: true,
    review: { reviewer: 'test-reviewer', artifact: 'test-artifact', reviewedAt: t },
  };
  // Supply ledger, reconciled, with a dispersed holder set (top10 < 30%).
  store.db.prepare(
    `INSERT INTO emerging_supply_state(token, watermark_rowid, total_supply, minted, burned, balance_sum, birth_ts, supply_block, reconciled_at, reconcile_status, version)
     VALUES (?, 1, '1000000000', '1000000000', '0', '1000000000', ?, 100, ?, 'matched', 1)`,
  ).run(BASE, t - 3 * 86_400, t);
  for (let i = 1; i <= 12; i++) {
    store.db.prepare(
      'INSERT INTO emerging_supply_balances(token, address, balance) VALUES (?, ?, ?)',
    ).run(BASE, addr(0x100 + i), String(25_000_000)); // 12 × 2.5% — top10 = 25% < 30%
  }
  const { gates, allPass } = evaluateGates(POOL_KEY, 'research-100usdg-v1');
  assert.equal(gates.G02.status, 'pass');
  assert.equal(gates.G05.status, 'pass', `top10 = ${gates.G05.reason}`);
  // G08 still lacks sell prints.
  assert.equal(gates.G08.status, 'unknown');
  assert.equal(allPass, false, 'G04/G07/G08 keep the bundle short of a pass');
});
