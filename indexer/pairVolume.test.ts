import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// pairVolume imports store.ts (db at import time) — same throwaway-db pattern
// as poolRank.test.ts, set before the first import.
const tmp = mkdtempSync(join(tmpdir(), 'lp-terminal-pairvolume-'));
process.env.INDEXER_DB = join(tmp, 'catalog.db');

const { buildPairVolumeSnapshot, getPairVolumeApi, nearEpochFlip, storePairVolumeSnapshot } = await import('./pairVolume');

after(() => rmSync(tmp, { recursive: true, force: true }));

const DAY = 86_400;
// A day-start baseline recent enough that "today" is never one of the series
// days regardless of when the test runs.
const baseDay = Math.floor(Date.now() / 1000 / DAY) * DAY - 60 * DAY;

const subgraphPool = (id: string, volumes: number[]) => ({
  id,
  tickSpacing: 10,
  totalValueLockedUSD: '200000',
  token0: { id: '0xtokena', symbol: 'AAA' },
  token1: { id: '0xtokenb', symbol: 'BBB' },
  poolDayData: volumes.map((vol, i) => ({
    date: baseDay + i * DAY,
    volumeUSD: String(vol),
    txCount: '10',
  })),
});

// 45 days: a dominant pool (A) hands its volume to a newcomer (B) over the
// final week while the pair total holds — the canonical migration story.
const VOL_A = [
  ...Array(38).fill(800),
  ...[800, 750, 700, 600, 500, 400, 250],
];
const VOL_B = [
  ...Array(38).fill(100),
  ...[150, 200, 250, 350, 400, 550, 700],
];

const onchain = new Map([
  ['0xpoola', { feePpm: 12500, rewardRateWeiPerSec: null }],
  ['0xpoolb', { feePpm: 3000, rewardRateWeiPerSec: null }],
]);

function build() {
  // dayStart(nowTs) = baseDay + 45d, so the aligned 45-day window is exactly
  // baseDay+0 … baseDay+44 — the fixture's full span.
  return buildPairVolumeSnapshot({
    subgraphPools: [subgraphPool('0xPoolA', VOL_A), subgraphPool('0xPoolB', VOL_B)],
    onchain,
    univ3Candidates: [],
    univ3Candles: new Map(),
    rankedIdentities: new Set(['0xpoola']),
    nowTs: baseDay + 45 * DAY,
  });
}

test('a ranked pair assembles family shares, a migration event, and the diagnosis', () => {
  const snapshot = build();
  const keys = Object.keys(snapshot.pairs);
  assert.equal(keys.length, 1, 'one family: both pools share the token pair');
  const payload = snapshot.pairs[keys[0]];
  assert.equal(payload.symbol0, 'AAA');
  assert.equal(payload.pools.length, 2);
  assert.equal(payload.days.length, 45);
  assert.equal(payload.pairTotal.length, 45);
  // 45 full days ending YESTERDAY relative to nowTs — today never appears
  assert.ok(Math.max(...payload.days) < baseDay + 46 * DAY);

  const byId = new Map(payload.pools.map((p) => [p.identity, p]));
  const a = byId.get('0xpoola')!;
  const b = byId.get('0xpoolb')!;
  assert.ok(Math.abs(a.share[0]! - 800 / 900) < 1e-9, 'shares are of the priced family total');
  assert.ok(Math.abs(b.share[44]! - 700 / 950) < 1e-9);
  assert.equal(a.feeBps, 125);
  assert.equal(b.feeBps, 30);
  assert.equal(byPoolIdentity(snapshot), keys[0]);

  assert.equal(payload.events.length, 1, 'the handover crosses the PRD §8.3 thresholds');
  const event = payload.events[0];
  assert.equal(event.fromPool, '0xpoola');
  assert.equal(event.toPool, '0xpoolb');
  assert.equal(event.windowDays, 7);
  assert.ok(event.magnitudeUsd > 0);
  assert.equal(event.feeFromBps, 125);
  assert.equal(event.feeToBps, 30);

  assert.equal(payload.diagnosis.kind, 'migration', 'pair total holds, focus share falls, peer gains');
  assert.deepEqual(payload.diagnosis.caveats, [], 'no caveat on migration');
});

test('the API read routes an identity to its family and answers unknown pools', () => {
  storePairVolumeSnapshot(build());
  const hit = getPairVolumeApi('0xPoolA');
  assert.equal(hit.ready, true);
  assert.equal(hit.ready === true && hit.pools.length, 2);
  assert.equal(getPairVolumeApi('0xunrelated').ready, false);
  assert.deepEqual(getPairVolumeApi('0xunrelated'), { ready: false, reason: 'pool_not_grouped' });
});

function byPoolIdentity(snapshot: ReturnType<typeof build>): string {
  return snapshot.byPool['0xpoolb'];
}

test('a collapsing pair total is retreat with the v2 blind-spot caveat, not migration', () => {
  const VOL_A2 = [...Array(38).fill(800), ...[800, 750, 700, 600, 500, 400, 250]];
  const VOL_B2 = [...Array(45).fill(0)];
  const snapshot = buildPairVolumeSnapshot({
    subgraphPools: [subgraphPool('0xPoolA2', VOL_A2), subgraphPool('0xPoolB2', VOL_B2)],
    onchain: new Map([['0xpoola2', { feePpm: 12500, rewardRateWeiPerSec: null }]]),
    univ3Candidates: [],
    univ3Candles: new Map(),
    rankedIdentities: new Set(['0xpoola2']),
    nowTs: baseDay + 45 * DAY,
  });
  const payload = Object.values(snapshot.pairs)[0];
  assert.equal(payload.diagnosis.kind, 'retreat', 'pair total collapsed with no absorbing pool');
  assert.deepEqual(payload.diagnosis.caveats, ['v2_not_monitored']);
  assert.equal(payload.events.length, 0);
});

test('nearEpochFlip flags the 48h window around a Thursday 00:00 UTC flip', () => {
  const flip = Date.UTC(2026, 6, 23) / 1000; // docs: epoch_next 2026-07-23
  assert.equal(new Date(flip * 1000).getUTCDay(), 4, 'the docs flip date is a Thursday');
  assert.equal(nearEpochFlip(flip - 3600), true, '1h before the flip');
  assert.equal(nearEpochFlip(flip + 3600), true, '1h after the flip');
  assert.equal(nearEpochFlip(flip - 3 * DAY), false, '3 days out is not near');
  assert.equal(nearEpochFlip(flip + 3 * DAY), false, '3 days past is not near');
});
