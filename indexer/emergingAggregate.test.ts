import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

// env FIRST, then imports — emergingAggregate transitively opens store's DB
// at module load (connectorRank.test.ts's pattern).
const tmp = mkdtempSync(join(tmpdir(), 'lp-terminal-emerging-agg-'));
const previous = { chain: process.env.CHAIN, db: process.env.INDEXER_DB };
process.env.CHAIN = 'robinhood';
process.env.INDEXER_DB = join(tmp, 'catalog.db');

const store = await import('./store');
const emergingStore = await import('./emergingStore');
const { aggregatePoolMinutes, rollUpHour } = await import('./emergingAggregate');

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
const usdg = addr(0x5fd); // "USDG" here is whatever address the test admits
const sqrtPriceToPrice = (sqrtPriceX96: string) =>
  (Number(BigInt(sqrtPriceX96)) / 2 ** 96) ** 2;

// Minutes must be RECENT: zero-bucket materialization is bounded to a
// trailing window and the completeness bound caps at wall-clock now.
const nowMinute = Math.floor(Date.now() / 1000 / 60);
const minute = (n: number) => (nowMinute + n) * 60;

// Every test gets its OWN pool: watermarks and zero-bucket windows are
// per-pool state, so sharing one pool across tests would couple them.
let nextPoolId = 0x71;
let logIndexSeq = 0;

function makePool() {
  const id = addr(nextPoolId++);
  const pool = {
    poolKey: `${chainId}:univ3:${id}`, venue: 'univ3', canonicalId: id,
    token0: addr(0x72), token1: usdg,
    baseToken: addr(0x72), quoteToken: usdg,
  };
  store.upsertEmergingDiscovery({
    poolKey: pool.poolKey, venue: 'univ3', canonicalId: id,
    token0: addr(0x72), token1: usdg, baseToken: addr(0x72), quoteIsUsdg: true,
    poolCreatedAt: 1_000, tokenCreatedAt: null, launchAt: null,
    firstSeenAt: 2_000, origin: 'test',
  });
  store.recordEmergingTransition({
    poolKey: pool.poolKey, fromState: 'discovered', toState: 'queued',
    reason: null, admittedRank: 1, occurredAt: 3_000,
  });
  // The stream's provable coverage floor (seedStream writes this in prod).
  store.kvSet('emerging_stream_seed:cl-pools', String(minute(-200)));
  return pool;
}

function swap(pool: { poolKey: string; canonicalId: string }, args: { minuteTs: number; amount0: string; amount1: string; sqrtPriceX96: string }) {
  const txHash = `0x${(0x1000 + ++logIndexSeq).toString(16)}`;
  emergingStore.commitEmergingScanBatch({
    streamKey: 'cl-pools',
    events: [{
      txHash, logIndex: logIndexSeq, blockNumber: 1_000_000 + logIndexSeq,
      blockHash: '0xblk', txIndex: 0, blockTs: args.minuteTs,
      contract: pool.canonicalId, kind: 'swap', poolKey: pool.poolKey, token: null,
      payload: { amount0: args.amount0, amount1: args.amount1, sqrtPriceX96: args.sqrtPriceX96 },
    }],
    cursorBlockNumber: 1_000_000 + logIndexSeq, cursorBlockHash: '0xblk',
    cursorBlockTs: args.minuteTs, at: 9_000,
  });
}

const SQ = (p: number) => {
  // Exact integer path: float × 2^96 overflows precision and BigInt rejects
  // the exponential string. Scale by 1e9, shift, then divide exactly.
  const scaled = BigInt(Math.round(Math.sqrt(p) * 1e9));
  return ((scaled << 96n) / 10n ** 9n).toString();
};
const minuteRow = (poolKey: string, m: number) =>
  store.db
    .prepare('SELECT * FROM pool_minute_buckets WHERE pool_key = ? AND minute_ts = ?')
    .get(poolKey, m) as Record<string, unknown> | undefined;
const bucketCount = (poolKey: string) =>
  (store.db
    .prepare('SELECT COUNT(*) AS n FROM pool_minute_buckets WHERE pool_key = ?')
    .get(poolKey) as { n: number }).n;

test('aggregation: buys/sells classified from swap direction, quote volume on the USDG side', () => {
  const pool = makePool();
  const base = minute(-100);
  // A buy: base flows in (amount0 < 0), USDG flows out to the seller.
  swap(pool, { minuteTs: base + 10, amount0: '-1000', amount1: '2500', sqrtPriceX96: SQ(2) });
  // A sell: USDG flows in (amount1 < 0), base flows out.
  swap(pool, { minuteTs: base + 30, amount0: '400', amount1: '-900', sqrtPriceX96: SQ(3) });

  const r = aggregatePoolMinutes(pool, base + 120, 1);
  assert.ok(r.written >= 2);
  const row = minuteRow(pool.poolKey, base)!;
  assert.equal(row.swap_count, 2);
  assert.equal(row.buy_count, 1);
  assert.equal(row.sell_count, 1);
  assert.equal(row.vol_quote, '3400', '2500 (buy-side USDG out) + 900 (sell proceeds)');
  assert.equal(row.buy_vol_quote, '2500');
  assert.equal(row.sell_vol_quote, '900');
  assert.equal(row.complete, 1);
  assert.equal(Number(row.open_price), sqrtPriceToPrice(SQ(2)));
  assert.equal(Number(row.close_price), sqrtPriceToPrice(SQ(3)));
  assert.equal(row.price_coverage, 2);
});

test('aggregation: minutes closing beyond the completeness watermark are NOT written (§3.2)', () => {
  const pool = makePool();
  const future = minute(+50);
  swap(pool, { minuteTs: future + 5, amount0: '-1', amount1: '5', sqrtPriceX96: SQ(1) });
  aggregatePoolMinutes(pool, future - 60, 1);
  assert.equal(minuteRow(pool.poolKey, future), undefined,
    'the unproven minute stays unwritten — a gap, never a zero');
});

test('aggregation: a complete no-swap minute inside the coverage window is a zero bucket', () => {
  const pool = makePool();
  const quiet = minute(-90);
  aggregatePoolMinutes(pool, quiet + 120, 1);
  const row = minuteRow(pool.poolKey, quiet);
  assert.ok(row, 'proven-coverage minutes materialize');
  assert.equal(row!.complete, 1);
  assert.equal(row!.swap_count, 0, 'full scan + no swaps = zero, which is information');
});

test('watermark: a re-run over the same window does not duplicate or rewind', () => {
  const pool = makePool();
  const base = minute(-100);
  swap(pool, { minuteTs: base + 10, amount0: '-1', amount1: '2', sqrtPriceX96: SQ(2) });
  const first = aggregatePoolMinutes(pool, base + 120, 1);
  const countAfterFirst = bucketCount(pool.poolKey);
  const second = aggregatePoolMinutes(pool, base + 120, 1);
  assert.ok(first.written > 0);
  assert.equal(second.written, 0, 'the watermark only ever moves forward');
  assert.equal(bucketCount(pool.poolKey), countAfterFirst);
});

test('hour rollup: 60 complete minutes produce one 1h pool_history row; 59 do not', () => {
  const pool = makePool();
  // rollUpHour targets the LAST CLOSED wall-clock hour — test against that.
  const hourStart = Math.floor(Date.now() / 1000 / 3600) * 3600 - 3600;
  for (let i = 0; i < 59; i++)
    swap(pool, { minuteTs: hourStart + i * 60 + 5, amount0: '-10', amount1: '20', sqrtPriceX96: SQ(2) });
  // Coverage stops INSIDE the hour (minute 59 unproven): exactly 59 complete
  // buckets, and the hour must not roll up.
  aggregatePoolMinutes(pool, hourStart + 3500, 1);
  assert.equal(rollUpHour(pool), false, 'a 59-bucket hour is not an hour');

  swap(pool, { minuteTs: hourStart + 59 * 60 + 5, amount0: '-10', amount1: '20', sqrtPriceX96: SQ(2) });
  aggregatePoolMinutes(pool, hourStart + 3600 + 120, 1);
  assert.equal(rollUpHour(pool), true);
  const hist = store.db
    .prepare("SELECT * FROM pool_history WHERE address = ? AND bucket = '1h'")
    .get(pool.canonicalId) as Record<string, unknown>;
  assert.equal(hist.bucket_ts, hourStart);
  assert.equal(hist.quality, 'complete');
  assert.equal(hist.interval_volume_quote, '1200', '60 minutes × 20 USDG each');
  assert.equal(hist.aggregate_version, 1);
  const ohlc = JSON.parse(hist.interval_ohlc as string) as number[];
  assert.equal(ohlc.length, 4);
});

test('aggregation: an evented minute outside coverage stays incomplete until proven (0→1 upgrade)', () => {
  const pool = makePool();
  const preSeed = minute(-300); // seed is minute(-200); the swap predates it
  swap(pool, { minuteTs: preSeed + 5, amount0: '-1', amount1: '5', sqrtPriceX96: SQ(1) });
  aggregatePoolMinutes(pool, preSeed + 120, 1);
  const row = minuteRow(pool.poolKey, preSeed)!;
  assert.equal(row.complete, 0, 'the swap is a fact, but completeness is not claimed');
  assert.equal(row.swap_count, 1);

  // The stream floor moves back to cover it (a longer rewind/seed): the row
  // upgrades 0→1, and the minute just below the old watermark zero-fills as
  // newly-proven — exactly those two writes, nothing else.
  store.kvSet('emerging_stream_seed:cl-pools', String(preSeed - 60));
  const second = aggregatePoolMinutes(pool, preSeed + 120, 1);
  assert.equal(second.written, 2);
  assert.equal(minuteRow(pool.poolKey, preSeed)!.complete, 1);
});
