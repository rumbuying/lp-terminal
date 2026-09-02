import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

// poolRank imports store.ts, which opens its database at import time — point
// it at a throwaway file before the first import, like every other indexer
// test that touches the store.
const tmp = mkdtempSync(join(tmpdir(), 'lp-terminal-poolrank-'));
process.env.INDEXER_DB = join(tmp, 'catalog.db');

const { annualizeSigma, coverageOf, dailyLogReturns, dailySigma, getPoolRankApi, up33Rows, volumePersistence } = await import('./poolRank');
type SubgraphPool = Parameters<typeof up33Rows>[0][number];
type Up33Onchain = Parameters<typeof up33Rows>[1] extends Map<string, infer V> ? V : never;

after(() => rmSync(tmp, { recursive: true, force: true }));

test('dailyLogReturns measures day-over-day log change and skips unusable closes', () => {
  const rets = dailyLogReturns([100, 110, 121, 0, 242]);
  // (100→110) and (110→121) are usable; the 0 close kills both pairs it touches
  assert.equal(rets.length, 2);
  assert.ok(Math.abs(rets[0] - Math.log(1.1)) < 1e-12);
  assert.ok(Math.abs(rets[1] - Math.log(1.1)) < 1e-12);
});

test('dailySigma needs a real history and matches the sample-stdev formula', () => {
  // a flat series has zero dispersion and is refused, not reported as calm
  assert.equal(dailySigma([5, 5, 5, 5, 5, 5, 5, 5, 5]), null);
  assert.equal(dailySigma([100, 101, 102]), null); // too few returns
  const closes = [100, 102, 99, 103, 98, 104, 97, 105, 96];
  const rets = dailyLogReturns(closes);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const expected = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
  const sigma = dailySigma(closes);
  assert.ok(sigma !== null);
  assert.ok(Math.abs(sigma - expected) < 1e-12);
});

test('annualization and the LVR coverage multiple keep their definitions', () => {
  assert.ok(Math.abs(annualizeSigma(0.01) - 0.01 * Math.sqrt(365)) < 1e-12);
  // coverage = feeApr / (σ_a²/8): the σ²/8 loss-versus-rebalancing floor
  const sigmaDaily = 0.02;
  const sigmaAnnual = annualizeSigma(sigmaDaily);
  const feeApr = 0.5;
  const coverage = coverageOf(feeApr, sigmaDaily);
  assert.ok(coverage !== null);
  assert.ok(Math.abs(coverage - feeApr / ((sigmaAnnual ** 2) / 8)) < 1e-12);
  // a degenerate series is a null, never an infinite ranking score
  assert.equal(coverageOf(feeApr, 0), null);
  assert.equal(coverageOf(feeApr, Number.NaN), null);
});

test('volumePersistence reads 0 for an empty lifetime, not Infinity', () => {
  assert.equal(volumePersistence(10, 0), 0);
  assert.ok(Math.abs(volumePersistence(2, 1) - 2) < 1e-12);
});

const day = (volumeUSD: number, sqrtPrice: number, txCount = 5): { date: number; volumeUSD: string; sqrtPrice: string; txCount: string } => ({
  date: 0,
  volumeUSD: String(volumeUSD),
  sqrtPrice: String(sqrtPrice),
  txCount: String(txCount),
});

function makePool(overrides: Partial<SubgraphPool> = {}): SubgraphPool {
  const oscillating = Array.from({ length: 20 }, (_, i) => day(1000, i % 2 === 0 ? 1e12 : 1.02e12));
  return {
    id: '0xpool',
    tickSpacing: 60,
    totalValueLockedUSD: '100000',
    token0: { symbol: 'AAA' },
    token1: { symbol: 'BBB' },
    poolDayData: oscillating,
    ...overrides,
  };
}

const onchain = (overrides: Partial<Up33Onchain> = {}): Up33Onchain => ({
  feePpm: 500,
  unstakedFeePpm: 100_000, // 10%
  liquidity: 1_000_000n,
  stakedLiquidity: 250_000n,
  rewardRateWeiPerSec: null,
  ...overrides,
});

test('up33Rows prices fees off the on-chain tier and nets the unstaked levy', () => {
  const { rows } = up33Rows([makePool()], new Map([['0xpool', onchain()]]), null);
  assert.equal(rows.length, 1);
  const row = rows[0];
  // 7d-mean volume $1000/day × 500ppm × 365 / $100k TVL = 0.18% gross
  assert.ok(Math.abs(row.feeApr - 0.001825) < 1e-12);
  // unstaked take = gross × (1 − 10% levy)
  assert.ok(Math.abs(row.netFeeApr - 0.001825 * 0.9) < 1e-12);
  assert.equal(row.stakedShare, 0.25);
  // no UP price or no rewardRate: emission APR stays null instead of lying
  assert.equal(row.emitApr, null);
  assert.ok(row.coverage > 0);
});

test('up33Rows drops corrupted price series instead of ranking them', () => {
  const corrupt = makePool({
    id: '0xcursed',
    // a 25× one-day jump is a pulled pool re-anchoring, not a market
    poolDayData: Array.from({ length: 20 }, (_, i) => day(1000, i === 10 ? 2.5e13 : 1e12)),
  });
  const { rows, dropped } = up33Rows([corrupt], new Map([['0xcursed', onchain()]]), null);
  assert.equal(rows.length, 0);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /corrupted price series/);
});

test('up33Rows values emissions off the post-cap rewardRate and staked TVL', () => {
  // 0.4 UP/sec × 31.536M s × $1 / (25% of $100k) = 505.7% APR
  const { rows } = up33Rows([makePool()], new Map([['0xpool', onchain({ rewardRateWeiPerSec: 400_000_000_000_000_000n })]]), 1);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].emitApr !== null);
  assert.ok(Math.abs(rows[0].emitApr! - (0.4 * 31_536_000 / 25_000)) < 1e-6);
});

test('the API getter answers disabled/empty before the first cycle lands', () => {
  const api = getPoolRankApi();
  assert.equal(api.ready, false);
  assert.deepEqual(api.rows, []);
  assert.equal(api.generatedAt, null);
});
