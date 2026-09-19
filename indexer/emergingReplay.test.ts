import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

// env FIRST, then imports (connectorRank.test.ts's pattern).
const tmp = mkdtempSync(join(tmpdir(), 'lp-terminal-emerging-replay-'));
const previous = { chain: process.env.CHAIN, db: process.env.INDEXER_DB };
process.env.CHAIN = 'robinhood';
process.env.INDEXER_DB = join(tmp, 'catalog.db');

const store = await import('./store');
const emergingStore = await import('./emergingStore');
const { replayShadowPosition } = await import('./emergingReplay');
const { amount1Delta, nextSqrtFromAmount1 } = await import('./emergingReplayCore');
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
const POOL_ID = addr(0x71);
const POOL_KEY = `${chainId}:univ3:${POOL_ID}`;
const SQRT0 = getSqrtRatioAtTick(0);

store.upsertEmergingDiscovery({
  poolKey: POOL_KEY, venue: 'univ3', canonicalId: POOL_ID,
  token0: addr(1), token1: addr(2), baseToken: null, quoteIsUsdg: false,
  poolCreatedAt: 1_000, tokenCreatedAt: null, launchAt: null,
  firstSeenAt: 2_000, origin: 'test',
});
store.db.prepare(
  `INSERT INTO pools(address, proto, token0, token1, fee_ppm, created_block, added_ts)
   VALUES (?, 'univ3', ?, ?, 3000, 1, 1)`,
).run(POOL_ID, addr(1), addr(2));

let seq = 0;
const addEvent = (kind: 'mint' | 'burn' | 'swap', payload: Record<string, unknown>, block: number) => {
  emergingStore.commitEmergingScanBatch({
    streamKey: 'cl-pools',
    events: [{
      txHash: `0x${(0x7000 + ++seq).toString(16)}`, logIndex: seq,
      blockNumber: block, blockHash: '0xh', txIndex: 0, blockTs: null,
      contract: POOL_ID, kind, poolKey: POOL_KEY, token: null, payload,
    }],
    cursorBlockNumber: block, cursorBlockHash: '0xh', cursorBlockTs: null, at: 9_000,
  });
};

test('C00: replay of a consistent history yields an exact ledger with range-exit', () => {
  // One chain LP of 1e9 across [-60,60]; the shadow mirrors the range at 1e8.
  addEvent('mint', { sender: addr(9), owner: addr(9), tickLower: '-60', tickUpper: '60', amount: '1000000000', amount0: '1', amount1: '1' }, 100);
  // Price bootstrap: a 5-wei swap, then a crossing swap to tick 60.
  const bootSqrt = nextSqrtFromAmount1(SQRT0, 1_000_000_000n, 4n, true);
  addEvent('swap', { sender: addr(9), recipient: addr(9), amount0: '-4', amount1: '5', sqrtPriceX96: bootSqrt.toString(), liquidity: '1000000000', tick: '0' }, 101);
  const spanDelta = amount1Delta(bootSqrt, getSqrtRatioAtTick(60), 1_000_000_000n, false);
  const input = spanDelta + 20_000n;
  // The only LP's range ends at tick 60: crossing it empties active L — the
  // event says so, and the walk must reproduce it.
  addEvent('swap', { sender: addr(9), recipient: addr(9), amount0: '0', amount1: input.toString(), sqrtPriceX96: getSqrtRatioAtTick(60).toString(), liquidity: '0', tick: '60' }, 102);

  const ledger = replayShadowPosition(POOL_KEY, { tickLower: -60, tickUpper: 60, liquidity: 100_000_000n });
  assert.equal(ledger.integrity, 'exact');
  assert.equal(ledger.exit, 'range-exit');
  assert.ok(ledger.fees1 > 0n, 'the shadow earned fees before the crossing');
  assert.ok(ledger.principal1 > 0n, 'above range the principal is all token1 (quote)');
  assert.equal(ledger.principal0, 0n);
  assert.ok(ledger.entryActiveLiquidity! > 0n, 'the caps\u2019 entry-side figure is reported');
});

test('C00: non-v3 venues and histories without a first mint are unsupported (§7.1)', () => {
  const v4Key = `${chainId}:univ4:${'ab'.repeat(32)}`;
  store.upsertEmergingDiscovery({
    poolKey: v4Key, venue: 'univ4', canonicalId: 'ab'.repeat(32),
    token0: addr(1), token1: addr(2), baseToken: null, quoteIsUsdg: false,
    poolCreatedAt: 1_000, tokenCreatedAt: null, launchAt: null,
    firstSeenAt: 2_000, origin: 'test',
  });
  const v4 = replayShadowPosition(v4Key, { tickLower: -60, tickUpper: 60, liquidity: 1n });
  assert.equal(v4.integrity, 'unsupported');
  assert.match(v4.unsupportedReason!, /static-fee v3/);

  // A UP33 pool exists in the pools table as proto 'up33cl' — unsupported too.
  store.upsertEmergingDiscovery({
    poolKey: `${chainId}:up33-cl:${addr(0x72)}`, venue: 'up33-cl', canonicalId: addr(0x72),
    token0: addr(1), token1: addr(2), baseToken: null, quoteIsUsdg: false,
    poolCreatedAt: 1_000, tokenCreatedAt: null, launchAt: null,
    firstSeenAt: 2_000, origin: 'test',
  });
  store.db.prepare(
    `INSERT INTO pools(address, proto, token0, token1, fee_ppm, created_block, added_ts)
     VALUES (?, 'up33cl', ?, ?, 3000, 1, 1)`,
  ).run(addr(0x72), addr(1), addr(2));
  const up33 = replayShadowPosition(`${chainId}:up33-cl:${addr(0x72)}`, { tickLower: -60, tickUpper: 60, liquidity: 1n });
  assert.equal(up33.integrity, 'unsupported');
});

test('C00: a history that starts mid-life is unsupported rather than silently partial', () => {
  const key = `${chainId}:univ3:${addr(0x73)}`;
  store.upsertEmergingDiscovery({
    poolKey: key, venue: 'univ3', canonicalId: addr(0x73),
    token0: addr(1), token1: addr(2), baseToken: null, quoteIsUsdg: false,
    poolCreatedAt: 1_000, tokenCreatedAt: null, launchAt: null,
    firstSeenAt: 2_000, origin: 'test',
  });
  store.db.prepare(
    `INSERT INTO pools(address, proto, token0, token1, fee_ppm, created_block, added_ts)
     VALUES (?, 'univ3', ?, ?, 3000, 1, 1)`,
  ).run(addr(0x73), addr(1), addr(2));
  emergingStore.commitEmergingScanBatch({
    streamKey: 'cl-pools',
    events: [{
      txHash: '0x8001', logIndex: 1, blockNumber: 500, blockHash: '0xh', txIndex: 0,
      blockTs: null, contract: addr(0x73), kind: 'swap', poolKey: key, token: null,
      payload: { amount0: '0', amount1: '1', sqrtPriceX96: SQRT0.toString(), liquidity: '10', tick: '0' },
    }],
    cursorBlockNumber: 500, cursorBlockHash: '0xh', cursorBlockTs: null, at: 9_000,
  });
  const ledger = replayShadowPosition(key, { tickLower: -60, tickUpper: 60, liquidity: 1n });
  assert.equal(ledger.integrity, 'unsupported');
  assert.match(ledger.unsupportedReason!, /first mint/);
});
