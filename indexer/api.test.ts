import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test, { after } from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'lp-terminal-api-'));
const previousDb = process.env.INDEXER_DB;
process.env.INDEXER_DB = join(tmp, 'catalog.db');

const store = await import('./store');
const api = await import('./api');
const { ADDR, CHAIN, UNI } = await import('./config');

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const token0 = address(0xa1);
const token1 = address(0xb1);
const tvls = [10, 50, 40, 30, 20];

store.upsertTokenMeta(token0, 'AAA', 18, true);
store.upsertTokenMeta(token1, 'BBB', 18, true);
for (let i = 1; i <= tvls.length; i += 1) {
  const pool = address(i);
  store.insertPool({
    address: pool,
    proto: i % 2 === 0 ? 'univ2' : 'univ3',
    token0,
    token1,
    feePpm: 3000,
    tickSpacing: i % 2 === 0 ? undefined : 60,
    createdBlock: i,
    pairIndex: i,
  });
  store.upsertState(pool, {
    sqrtPrice: i % 2 === 0 ? undefined : 1n,
    tick: i % 2 === 0 ? undefined : 0,
    liquidity: i % 2 === 0 ? undefined : 1n,
    reserve0: BigInt(i),
    reserve1: BigInt(i),
    totalSupply: i % 2 === 0 ? 1n : undefined,
  });
  store.setTvl(pool, tvls[i - 1], false);
}
store.kvSet('ready', '1');

after(() => {
  store.db.close();
  if (previousDb === undefined) delete process.env.INDEXER_DB;
  else process.env.INDEXER_DB = previousDb;
  rmSync(tmp, { recursive: true, force: true });
});

test('landing page is useful while cursor pages cover the full address space', () => {
  const first = api.getPools(new URLSearchParams({ limit: '2' }));
  assert.deepEqual(first.chain, { key: CHAIN.key, id: CHAIN.id });
  assert.deepEqual(
    first.pools.map((pool) => pool.address),
    [address(2), address(3)],
  );
  assert.equal(first.count, 5);
  assert.equal(first.nextCursor, api.FIRST_POOL_CURSOR);
  assert.ok(first.pools.every((pool) => (pool as Record<string, unknown>).stateReady === true));
  assert.equal((first.tokens[token0] as { metaOk: boolean }).metaOk, true);
  assert.equal((first.tokens[token1] as { metaOk: boolean }).metaOk, true);

  const second = api.getPools(new URLSearchParams({ limit: '2', after: first.nextCursor! }));
  assert.deepEqual(
    second.pools.map((pool) => pool.address),
    [address(1), address(2)],
  );
  assert.equal(second.nextCursor, address(2));

  const third = api.getPools(new URLSearchParams({ limit: '2', after: second.nextCursor! }));
  assert.deepEqual(
    third.pools.map((pool) => pool.address),
    [address(3), address(4)],
  );
  assert.equal(third.nextCursor, address(4));

  const end = api.getPools(new URLSearchParams({ limit: '2', after: third.nextCursor! }));
  assert.deepEqual(
    end.pools.map((pool) => pool.address),
    [address(5)],
  );
  assert.equal(end.nextCursor, null);

  const all = new Set([...first.pools, ...second.pools, ...third.pools, ...end.pools].map((pool) => pool.address));
  assert.deepEqual([...all].sort(), [1, 2, 3, 4, 5].map(address));
});

test('pool request canonicalization collapses equivalent URLs and rejects cache-key ambiguity', () => {
  const a = api.canonicalPoolsRequest(
    new URLSearchParams({ proto: 'univ3, univ2,univ3', limit: '2', q: '  AAA/BBB  ' }),
  );
  const b = api.canonicalPoolsRequest(
    new URLSearchParams({ q: 'aaa/bbb', limit: '2', proto: 'univ2,univ3' }),
  );
  assert.equal(a.key, b.key);
  assert.equal(a.params.toString(), 'proto=univ2%2Cuniv3&q=aaa%2Fbbb&limit=2');
  assert.throws(() => api.canonicalPoolsRequest(new URLSearchParams('limit=1&limit=2')), /duplicate limit/);
  assert.throws(() => api.canonicalPoolsRequest(new URLSearchParams({ ignored: '1' })), /unknown pool parameter/);
});

test('a search term can never widen into the whole catalog', () => {
  const found = (q: string) => api.getPools(new URLSearchParams({ q, limit: '10' })).pools.length;

  // The 2026-08-10 outage. `'/'.split('/')` is two empty sides, and `'' + '%'`
  // was the LIKE pattern `%` — every token, on both sides of a pair clause that
  // SQLite plans as a cartesian probe. It has to select nothing, not everything.
  assert.equal(found('/'), 0);
  assert.equal(found('//'), 0);
  assert.equal(found('  /  '), 0);
  // One empty side is the same bug half the time: `weth/` must not mean "weth
  // against anything the catalog has".
  assert.equal(found('aaa/'), 0);
  assert.equal(found('/bbb'), 0);

  // The other match-everything: an unescaped `%` reached SQLite as a wildcard.
  assert.equal(found('%'), 0);
  assert.equal(found('_'), 0);
  assert.equal(found('%%'), 0);

  // A pair search matches symbols exactly, so one side can no longer contribute
  // a prefix's worth of tokens to multiply by the other's.
  assert.equal(found('aa/bbb'), 0);
  assert.equal(found('aaa/bb'), 0);

  // ...while the searches that carry a real constraint still answer.
  assert.equal(found('aaa/bbb'), 5);
  assert.equal(found('bbb/aaa'), 5); // either orientation
  assert.equal(found('AAA/BBB'), 5); // case-insensitive
  assert.equal(found('aa'), 5); // the non-pair branch stays a prefix search
  assert.equal(found('aaa'), 5);
  assert.equal(found('zzz'), 0);
});

/** The plan SQLite chose for a query, as one string. */
const queryPlan = (sql: string, args: (string | number)[]): string =>
  (store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[])
    .map((row) => row.detail)
    .join('\n');

test('a pair search never asks the planner for a cartesian product', () => {
  // Nothing above can see this. A cartesian plan returns exactly the right rows;
  // it just seeks the pair index once for every (a, b) drawn from the two symbol
  // sets. Measured on the BSC catalog, `?/usdt` is 18.3M seeks and 29.4s with the
  // event loop held — and both factors are a permissionless catalog's to choose,
  // so no validation of the search term can bound them. Seeking one index on
  // both pair columns at once is that plan's signature.
  const { where, args } = api.poolsWhere(new URLSearchParams({ q: 'aaa/bbb' }));
  const plan = queryPlan(`SELECT p.address FROM pools p ${where}`, args);

  assert.doesNotMatch(plan, /token0=\? AND token1=\?/);
  // Instead: one column drives the index, and its partner is checked per matched
  // row by a subquery the planner cannot fold back into a seek.
  assert.match(plan, /idx_pools_pair \(token0=\?\)/);
  assert.match(plan, /CORRELATED SCALAR SUBQUERY/);
});

test('a search counts its matches to a ceiling and says when it stopped', () => {
  // A count is the one query LIMIT cannot help: it has to visit every matching
  // row to produce its number. `fastV23Count` answers the filters a counter or
  // an index can serve and returns null for a search, so every search fell onto
  // a full COUNT(*) — 16.4s for `q=a` on the BSC catalog, 298,448 matches for
  // `q=usd`. Counting to a ceiling costs 0.2s.
  const search = (q: string) => api.getPools(new URLSearchParams({ q, limit: '10' }));

  // This fixture is far below the ceiling, so the count stays exact and the
  // flag stays absent — the case every real symbol search lands in.
  const exact = search('aaa');
  assert.equal(exact.count, 5);
  assert.equal('countCapped' in exact, false);

  // An unfiltered landing page keeps its own catalog total: fastV23Count owns
  // that path, and capping a fact would replace it with a ceiling.
  const landing = api.getPools(new URLSearchParams({ limit: '10' }));
  assert.equal(landing.count, 5);
  assert.equal('countCapped' in landing, false);

  // The capping branch itself, at a ceiling this fixture can cross. Below it
  // the count is the true total and carries no flag; at it, the count is a
  // floor and says so, and it never reports more than the ceiling.
  const all = 'FROM pools p';
  assert.deepEqual(api.boundedCount(all, [], 5), { n: 5, capped: false });
  assert.deepEqual(api.boundedCount(all, [], 4), { n: 4, capped: true });
  assert.deepEqual(api.boundedCount(all, [], 2), { n: 2, capped: true });
  assert.deepEqual(api.boundedCount('FROM pools p WHERE p.proto = ?', ['univ2'], 5), {
    n: 2,
    capped: false,
  });
});

test('token search bounds the work in front of its pool-count subquery', () => {
  const search = (q: string) => api.getTokens(new URLSearchParams({ q }));

  // `LIMIT 20` never protected this query: ORDER BY pools DESC evaluates the
  // correlated COUNT(*) for every match before it can sort. An unescaped `%`
  // therefore counted pools for all 460k BSC tokens — ~72s with the event loop
  // held the whole time.
  assert.deepEqual(search('%').tokens, []);
  assert.deepEqual(search('_').tokens, []);
  assert.equal(search('%').truncated, false);

  // Real prefixes keep answering, with the pool count intact.
  const aaa = search('aa').tokens as { symbol: string; pools: number }[];
  assert.deepEqual(
    aaa.map((t) => t.symbol),
    ['AAA'],
  );
  assert.equal(aaa[0].pools, 5);
  assert.equal(search('aa').truncated, false);
  assert.deepEqual(search('zzz').tokens, []);

  // An exact address still bypasses the symbol path entirely.
  const byAddress = search(token0).tokens as { symbol: string }[];
  assert.deepEqual(
    byAddress.map((t) => t.symbol),
    ['AAA'],
  );
});

test('recommendation candidates expose fresh v3 state without changing the public catalog protocol contract', () => {
  const pool = address(0xd001);
  store.insertPool({
    address: pool,
    proto: CHAIN.id === 56 ? 'pancakev3' : 'univ3',
    token0,
    token1,
    feePpm: 2_500,
    tickSpacing: 50,
  });
  try {
    store.upsertState(pool, {
      sqrtPrice: 1n << 96n,
      tick: 0,
      liquidity: 1_000_000n,
      reserve0: 1_000n,
      reserve1: 1_000n,
    });
    store.setTvl(pool, 100_000, false);
    store.upsertStats(pool, { m5: 100, h1: 1_000, h6: 6_000, h24: 24_000 }, 10, 100_000, 'test');
    store.captureAddressTickSamples([pool], '123');

    const result = api.getRecommendationCandidates(new URLSearchParams({ limit: '10' }));
    const candidate = result.candidates.find((row) => row.pool === pool);
    assert.ok(candidate);
    assert.equal(candidate.protocol, CHAIN.id === 56 ? 'pancakeswap-v3' : 'univ3');
    assert.equal(candidate.poolId, undefined);
    assert.equal(candidate.vol1hUsd, 1_000);
    assert.equal(candidate.tickHistory.at(-1)?.tick, 0);
    assert.throws(
      () => api.canonicalPoolsRequest(new URLSearchParams({ proto: 'up33cl' })),
      /invalid pool protocol/,
    );
  } finally {
    store.db.prepare('DELETE FROM pools WHERE address = ?').run(pool);
  }
});

test('fresh rank snapshots ride on recommendation candidates; stale ones do not', { skip: CHAIN.key !== 'robinhood' }, () => {
  const pool = address(0xd004);
  store.insertPool({
    address: pool,
    proto: 'up33cl',
    token0,
    token1,
    feePpm: 3_000,
    unstakedFeePpm: 100_000,
    tickSpacing: 60,
  });
  try {
    store.upsertState(pool, {
      sqrtPrice: 1n << 96n,
      tick: 0,
      liquidity: 1_000_000n,
      reserve0: 1_000n,
      reserve1: 1_000n,
    });
    store.setTvl(pool, 100_000, false);
    store.upsertStats(pool, { m5: 100, h1: 1_000, h6: 6_000, h24: 24_000 }, 10, 100_000, 'test');

    const rankRow = {
      venue: 'up33-cl', pool: 'AAA/BBB', address: pool, feeBps: 30, tickSpacing: 60,
      tvlUsd: 100_000, volDayUsd: 24_000, feeApr: 0.5, netFeeApr: 0.45,
      sigmaDaily: 0.03, sigmaAnnual: 0.572, coverage: 1.2, stakedShare: 0.5,
      emitApr: 0.1, volumePersistence: 1.1, daysActive: 40,
    };
    const secondsNow = Math.floor(Date.now() / 1_000);
    const snapshot = (generatedAt: number) => JSON.stringify({
      generatedAt, durationMs: 1_000, windowDays: 45, upPriceUsd: 1, rows: [rankRow], dropped: [],
    });
    const candidatesOf = () =>
      api.getRecommendationCandidates(new URLSearchParams({ limit: '10' })).candidates;

    store.kvSet('pool_rank_snapshot', snapshot(secondsNow));
    const fresh = candidatesOf().find((row) => row.pool === pool);
    assert.ok(fresh?.poolRank, 'a fresh snapshot must attach a prior');
    assert.equal(fresh.poolRank.coverage, 1.2);
    assert.equal(fresh.poolRank.volDayUsd, 24_000);
    assert.equal(fresh.poolRank.emitApr, 0.1);
    // pools the rank table never ranked carry no prior
    const rankedAddresses = new Set([pool.toLowerCase()]);
    const unranked = candidatesOf().find((row) => row.pool !== pool && !rankedAddresses.has(String(row.pool).toLowerCase()));
    if (unranked) assert.equal(unranked.poolRank, undefined);

    // older than two rank cycles: the prior stops being a prior
    store.kvSet('pool_rank_snapshot', snapshot(secondsNow - 3 * 43_200));
    const stale = candidatesOf().find((row) => row.pool === pool);
    assert.equal(stale?.poolRank, undefined);
  } finally {
    store.kvSet('pool_rank_snapshot', '');
    store.db.prepare('DELETE FROM pools WHERE address = ?').run(pool);
  }
});

test('rank seeds give a high-coverage pool a second entry past the volume ordering', { skip: CHAIN.key !== 'robinhood' }, () => {
  // A prices into the volume×fee/TVL top; B is deep and quiet — the ordering the
  // main cohort uses buries it, and the coverage table is the only way in.
  const topPool = address(0xd011);
  const seedPool = address(0xd012);
  for (const [pool, tvl] of [[topPool, 100_000], [seedPool, 1_000_000]] as const) {
    store.insertPool({ address: pool, proto: 'up33cl', token0, token1, feePpm: 3_000, unstakedFeePpm: 100_000, tickSpacing: 60 });
    store.upsertState(pool, { sqrtPrice: 1n << 96n, tick: 0, liquidity: 1_000_000n, reserve0: 1_000n, reserve1: 1_000n });
    store.setTvl(pool, tvl, false);
    store.upsertStats(pool, { m5: 100, h1: 1_000, h6: 6_000, h24: 24_000 }, 10, tvl, 'test');
  }
  try {
    const rankRow = (pool: string, coverage: number) => ({
      venue: 'up33-cl', pool: 'AAA/BBB', address: pool, feeBps: 30, tickSpacing: 60,
      tvlUsd: 100_000, volDayUsd: 24_000, feeApr: 0.5, netFeeApr: 0.45,
      sigmaDaily: 0.03, sigmaAnnual: 0.572, coverage, stakedShare: null,
      emitApr: null, volumePersistence: 1, daysActive: 40,
    });
    const secondsNow = Math.floor(Date.now() / 1_000);
    store.kvSet('pool_rank_snapshot', JSON.stringify({
      generatedAt: secondsNow, durationMs: 1_000, windowDays: 45, upPriceUsd: 1,
      rows: [rankRow(topPool, 1.2), rankRow(seedPool, 3.0)], dropped: [],
    }));

    // limit=1: the volume cohort holds only the top pool, so the seed pool can
    // only be present through the rank entry
    const candidates = api.getRecommendationCandidates(new URLSearchParams({ limit: '1' })).candidates;
    const seeded = candidates.find((row) => row.pool === seedPool);
    assert.ok(seeded, 'rank seed must open a second entry');
    assert.equal(seeded.rankSeeded, true);
    assert.equal(seeded.poolRank?.coverage, 3.0);
    const top = candidates.find((row) => row.pool === topPool);
    assert.ok(top);
    assert.equal(top.rankSeeded, undefined, 'a pool the volume cohort already took is not rank-seeded');

    // stale snapshot: the seed entry closes and the pool leaves the universe
    store.kvSet('pool_rank_snapshot', JSON.stringify({
      generatedAt: secondsNow - 3 * 43_200, durationMs: 1_000, windowDays: 45, upPriceUsd: 1,
      rows: [rankRow(topPool, 1.2), rankRow(seedPool, 3.0)], dropped: [],
    }));
    const staleCandidates = api.getRecommendationCandidates(new URLSearchParams({ limit: '1' })).candidates;
    assert.equal(staleCandidates.some((row) => row.pool === seedPool), false);
    assert.ok(staleCandidates.some((row) => row.pool === topPool));
  } finally {
    store.kvSet('pool_rank_snapshot', '');
    store.db.prepare('DELETE FROM pools WHERE address = ?').run(topPool);
    store.db.prepare('DELETE FROM pools WHERE address = ?').run(seedPool);
  }
});

test('rankSeedIdentities caps at the coverage top, best first, and closes when stale', { skip: CHAIN.key !== 'robinhood' }, () => {
  const secondsNow = Math.floor(Date.now() / 1_000);
  const rankRow = (n: number, coverage: number) => ({
    venue: 'univ3', pool: `P${n}`, address: address(0xee00 + n), feeBps: 30, tickSpacing: null,
    tvlUsd: 100_000, volDayUsd: 24_000, feeApr: 0.5, netFeeApr: 0.5,
    sigmaDaily: 0.03, sigmaAnnual: 0.572, coverage, stakedShare: null,
    emitApr: null, volumePersistence: 1, daysActive: 40,
  });
  store.kvSet('pool_rank_snapshot', JSON.stringify({
    generatedAt: secondsNow, durationMs: 1, windowDays: 45, upPriceUsd: 1,
    rows: Array.from({ length: 25 }, (_, i) => rankRow(i, 1 + i)), dropped: [],
  }));
  const seeds = api.rankSeedIdentities();
  assert.equal(seeds.length, 20);
  assert.equal(seeds[0], address(0xee00 + 24));
  assert.equal(seeds[19], address(0xee00 + 5));

  store.kvSet('pool_rank_snapshot', JSON.stringify({
    generatedAt: secondsNow - 3 * 43_200, durationMs: 1, windowDays: 45, upPriceUsd: 1,
    rows: Array.from({ length: 25 }, (_, i) => rankRow(i, 1 + i)), dropped: [],
  }));
  assert.deepEqual(api.rankSeedIdentities(), []);

  store.kvSet('pool_rank_snapshot', '');
  assert.deepEqual(api.rankSeedIdentities(), []);
});

test('Robinhood recommendation candidates retain UP33 fee and reward identity', { skip: !CHAIN.gov }, () => {
  const pool = address(0xd002);
  store.insertPool({
    address: pool,
    proto: 'up33cl',
    token0,
    token1,
    feePpm: 3_000,
    unstakedFeePpm: 100_000,
    tickSpacing: 60,
    gauge: address(0xd003),
  });
  try {
    store.upsertState(pool, {
      sqrtPrice: 1n << 96n,
      tick: 0,
      liquidity: 1_000_000n,
      stakedLiquidity: 750_000n,
      rewardRate: 10n ** 18n,
      periodFinish: BigInt(Math.floor(Date.now() / 1_000) + 86_400),
      gaugeAlive: true,
      reserve0: 1_000n,
      reserve1: 1_000n,
    });
    store.setTvl(pool, 100_000, false);
    store.upsertStats(pool, { m5: 100, h1: 1_000, h6: 6_000, h24: 24_000 }, 10, 100_000, 'test');

    const candidate = api.getRecommendationCandidates(new URLSearchParams({ limit: '20' }))
      .candidates.find((row) => row.pool === pool);
    assert.ok(candidate);
    assert.equal(candidate.protocol, 'up33');
    assert.equal(candidate.unstakedFeePpm, 100_000);
    assert.equal(candidate.gaugeAlive, true);
    assert.equal(candidate.stakedLiquidity, '750000');
  } finally {
    store.db.prepare('DELETE FROM pools WHERE address = ?').run(pool);
  }
});

test('LIKE metacharacters in a search term only ever match themselves', () => {
  assert.equal(api.escapeLikePattern('usdt'), 'usdt');
  assert.equal(api.escapeLikePattern('%'), '\\%');
  assert.equal(api.escapeLikePattern('_'), '\\_');
  assert.equal(api.escapeLikePattern('a%b_c'), 'a\\%b\\_c');
  // The escape character itself goes first, or escaping would corrupt it.
  assert.equal(api.escapeLikePattern('\\'), '\\\\');
  assert.equal(api.escapeLikePattern('\\%'), '\\\\\\%');
});

test('pool request namespace retains its last generation only after a generation read failure', () => {
  const params = new URLSearchParams({ proto: 'univ3', limit: '2' });
  const seeded = api.canonicalPoolsRequest(params, () => 'generation-7');
  const unavailable = new Error('sqlite unavailable');
  const fallback = api.canonicalPoolsRequest(params, () => {
    throw unavailable;
  });

  assert.equal(fallback.key, seeded.key);
  assert.equal(fallback.generationError, unavailable);
});

test('generation read failure serves only an existing last-good response', () => {
  api.clearPoolResponseCache();
  const params = new URLSearchParams({ proto: 'univ3', limit: '2' });
  const first = api.preparePoolsResponse(params, () => 'generation-cache-test');
  const unavailable = new Error('sqlite unavailable');
  const fail = () => {
    throw unavailable;
  };

  const fallback = api.preparePoolsResponse(params, fail);
  assert.equal(first.status, 'MISS');
  assert.equal(fallback.status, 'STALE');
  assert.equal(fallback.response.body, first.response.body);

  api.clearPoolResponseCache();
  assert.throws(() => api.preparePoolsResponse(params, fail), unavailable);
});

test('HTTP pool responses share serialized bodies and support ETag revalidation', async () => {
  api.clearPoolResponseCache();
  const server = api.createApiServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    const first = await fetch(`${base}/api/pools?proto=univ3%2Cuniv2&limit=2`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'public, max-age=30');
    assert.equal(
      first.headers.get('cloudflare-cdn-cache-control'),
      'public, max-age=60, stale-while-revalidate=240, stale-if-error=3600',
    );
    assert.equal(first.headers.get('x-indexer-cache'), 'MISS');
    const etag = first.headers.get('etag');
    assert.match(etag ?? '', /^W\/"[A-Za-z0-9_-]+"$/);
    const firstBody = await first.text();

    const shared = await fetch(`${base}/api/pools?limit=2&proto=univ2%2Cuniv3`);
    assert.equal(shared.status, 200);
    assert.equal(shared.headers.get('x-indexer-cache'), 'HIT');
    assert.equal(shared.headers.get('etag'), etag);
    assert.equal(await shared.text(), firstBody);

    const revalidated = await fetch(`${base}/api/pools?limit=2&proto=univ2%2Cuniv3`, {
      headers: { 'if-none-match': etag!.replace(/^W\//, '') },
    });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.headers.get('etag'), etag);
    assert.equal(revalidated.headers.get('cache-control'), 'public, max-age=30');
    assert.equal(await revalidated.text(), '');

    const health = await fetch(`${base}/api/health`);
    assert.equal(health.headers.get('cache-control'), 'no-store');
    const topology = await fetch(
      `${base}/api/solver/topology?pair=${token0}%2C${token1}&protocol=univ2`,
    );
    assert.equal(topology.headers.get('cache-control'), 'no-store');

    const invalid = await fetch(`${base}/api/pools?ignored=1`);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.headers.get('cache-control'), 'no-store');

    const method = await fetch(`${base}/api/pools`, { method: 'POST' });
    assert.equal(method.status, 405);
    assert.equal(method.headers.get('cache-control'), 'no-store');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('V2/V3 insertion fence excludes a lower-address tail insert without livelock', () => {
  const get = (params: URLSearchParams) =>
    api.getPools(params) as unknown as {
      pools: Array<{ address: string }>
      nextCursor: string | null
      catalogSeq: string
      catalogGeneration: string
    }
  const fenceToken0 = address(0xfa1);
  const fenceToken1 = address(0xfb1);
  const low = address(0xf001);
  const firstAddress = address(0xf002);
  const lastAddress = address(0xf004);
  store.upsertTokenMeta(fenceToken0, 'FENCEA', 18, true);
  store.upsertTokenMeta(fenceToken1, 'FENCEB', 18, true);
  const add = (pool: string, tvl: number) => {
    store.insertPool({
      address: pool,
      proto: 'univ2',
      token0: fenceToken0,
      token1: fenceToken1,
      feePpm: 3_000,
    });
    store.upsertState(pool, { reserve0: 1n, reserve1: 1n, totalSupply: 1n });
    store.setTvl(pool, tvl, false);
  };

  try {
    add(firstAddress, 20);
    add(lastAddress, 10);
    const landing = get(
      new URLSearchParams({ q: 'FENCEA/FENCEB', limit: '1' }),
    );
    assert.equal(landing.nextCursor, api.FIRST_POOL_CURSOR);
    assert.match(landing.catalogSeq, /^(0|[1-9]\d*)$/);
    assert.match(landing.catalogGeneration, /^(0|[1-9]\d*)$/);

    const first = get(
      new URLSearchParams({
        q: 'FENCEA/FENCEB',
        limit: '1',
        after: landing.nextCursor!,
        catalog_seq: landing.catalogSeq,
        catalog_generation: landing.catalogGeneration,
      }),
    );
    assert.deepEqual(first.pools.map((pool) => pool.address), [firstAddress]);
    assert.equal(first.nextCursor, firstAddress);

    // This is the production race: the live factory tail discovers a pool
    // which sorts before the cursor already returned to the browser.
    add(low, 30);
    const end = get(
      new URLSearchParams({
        q: 'FENCEA/FENCEB',
        limit: '5',
        after: first.nextCursor!,
        catalog_seq: landing.catalogSeq,
        catalog_generation: landing.catalogGeneration,
      }),
    );
    assert.deepEqual(end.pools.map((pool) => pool.address), [lastAddress]);
    assert.equal(end.nextCursor, null);
    assert.equal(end.catalogSeq, landing.catalogSeq);
    assert.equal(end.catalogGeneration, landing.catalogGeneration);

    const fresh = get(new URLSearchParams({ q: 'FENCEA/FENCEB', limit: '1' }));
    assert.ok(BigInt(fresh.catalogSeq) > BigInt(landing.catalogSeq));
    const freshTraversal = get(
      new URLSearchParams({
        q: 'FENCEA/FENCEB',
        limit: '10',
        after: api.FIRST_POOL_CURSOR,
        catalog_seq: fresh.catalogSeq,
        catalog_generation: fresh.catalogGeneration,
      }),
    );
    assert.deepEqual(
      freshTraversal.pools.map((pool) => pool.address),
      [low, firstAddress, lastAddress],
    );

    store.db.prepare('DELETE FROM pools WHERE address = ?').run(lastAddress);
    assert.throws(
      () =>
        get(
          new URLSearchParams({
            q: 'FENCEA/FENCEB',
            limit: '1',
            after: api.FIRST_POOL_CURSOR,
            catalog_seq: fresh.catalogSeq,
            catalog_generation: fresh.catalogGeneration,
          }),
        ),
      api.ApiConflictError,
    );
  } finally {
    for (const pool of [low, firstAddress, lastAddress])
      store.db.prepare('DELETE FROM pools WHERE address = ?').run(pool);
    store.db.prepare('DELETE FROM tokens WHERE address IN (?, ?)').run(fenceToken0, fenceToken1);
  }
});

test('address cursor keeps protocol and TVL filters on every page', () => {
  const v2First = api.getPools(
    new URLSearchParams({
      proto: 'univ2',
      limit: '1',
      after: api.FIRST_POOL_CURSOR,
    }),
  );
  assert.equal(v2First.count, 2);
  assert.deepEqual(
    v2First.pools.map((pool) => pool.address),
    [address(2)],
  );
  assert.equal(v2First.nextCursor, address(2));
  const v2End = api.getPools(
    new URLSearchParams({
      proto: 'univ2',
      limit: '1',
      after: v2First.nextCursor!,
    }),
  );
  assert.deepEqual(
    v2End.pools.map((pool) => pool.address),
    [address(4)],
  );
  assert.equal(v2End.nextCursor, null);

  const liquid = api.getPools(
    new URLSearchParams({
      min_tvl: '35',
      limit: '5',
      after: api.FIRST_POOL_CURSOR,
    }),
  );
  assert.equal(liquid.count, 2);
  assert.deepEqual(
    liquid.pools.map((pool) => pool.address),
    [address(2), address(3)],
  );
  assert.equal(liquid.nextCursor, null);
});

test('unified catalog filters and paginates Uniswap and Pancake venues independently', () => {
  const insertPool = store.insertPool as (pool: {
    address: string;
    proto: 'pancakev2' | 'pancakev3';
    token0: string;
    token1: string;
    feePpm: number;
    tickSpacing?: number;
    createdBlock?: number;
    pairIndex?: number;
  }) => boolean;
  insertPool({
    address: address(6),
    proto: 'pancakev2',
    token0,
    token1,
    feePpm: 2500,
    createdBlock: 6,
    pairIndex: 6,
  });
  store.upsertState(address(6), {
    reserve0: 6n,
    reserve1: 6n,
    totalSupply: 1n,
  });
  store.setTvl(address(6), 60, false);
  insertPool({
    address: address(7),
    proto: 'pancakev3',
    token0,
    token1,
    feePpm: 500,
    tickSpacing: 10,
    createdBlock: 7,
  });
  store.upsertState(address(7), {
    sqrtPrice: 1n,
    tick: 0,
    liquidity: 1n,
    reserve0: 0n,
    reserve1: 0n,
  });
  store.setTvl(address(7), 70, false);

  const pancakeFirst = api.getPools(
    new URLSearchParams({
      proto: 'pancakev2,pancakev3',
      q: 'AAA/BBB',
      limit: '1',
      after: api.FIRST_POOL_CURSOR,
    }),
  );
  assert.equal(pancakeFirst.count, 2);
  assert.deepEqual(
    pancakeFirst.pools.map((pool) => pool.proto),
    ['pancakev2'],
  );
  assert.equal((pancakeFirst.pools[0] as Record<string, unknown>).stateReady, true);
  assert.equal(pancakeFirst.nextCursor, address(6));
  const pancakeEnd = api.getPools(
    new URLSearchParams({
      proto: 'pancakev2,pancakev3',
      q: 'AAA/BBB',
      limit: '1',
      after: pancakeFirst.nextCursor!,
    }),
  );
  assert.deepEqual(
    pancakeEnd.pools.map((pool) => pool.proto),
    ['pancakev3'],
  );
  assert.equal((pancakeEnd.pools[0] as Record<string, unknown>).stateReady, true);
  assert.equal(pancakeEnd.nextCursor, null);
  const totals = pancakeEnd.totals as Record<string, number>;
  assert.equal(totals.pancakev2, 1);
  assert.equal(totals.pancakev3, 1);

  const uniswap = api.getPools(
    new URLSearchParams({
      proto: 'univ2,univ3',
      limit: '10',
      after: api.FIRST_POOL_CURSOR,
    }),
  );
  assert.equal(uniswap.count, 5);
  assert.ok(uniswap.pools.every((pool) => pool.proto === 'univ2' || pool.proto === 'univ3'));
  assert.equal(api.getPools(new URLSearchParams({ proto: 'pancakev2' })).count, 1);
  assert.equal(api.getPools(new URLSearchParams({ proto: 'pancakev3' })).count, 1);
  assert.throws(() => api.getPools(new URLSearchParams({ proto: 'univ3,unknown' })), /invalid pool protocol/);
});

test('exact contract-address pair lookup spans all four address-keyed venues without a token-wide scan', () => {
  const distractorToken = address(0xc2);
  const distractorPool = address(80);
  store.upsertTokenMeta(distractorToken, 'OTHER', 18, true);
  store.insertPool({
    address: distractorPool,
    proto: 'pancakev2',
    token0,
    token1: distractorToken,
    feePpm: 2_500,
  });

  try {
    const exact = api.getPools(
      new URLSearchParams({ token0, token1, limit: '100' }),
    );
    assert.equal(exact.count, 7);
    assert.equal(exact.pools.length, 7);
    assert.equal(exact.nextCursor, null);
    assert.ok(exact.pools.every((pool) => pool.token0 === token0 && pool.token1 === token1));
    assert.deepEqual(
      [...new Set(exact.pools.map((pool) => pool.proto))].sort(),
      ['pancakev2', 'pancakev3', 'univ2', 'univ3'],
    );
    assert.ok(!exact.pools.some((pool) => pool.address === distractorPool));

    const pancakeV3 = api.getPools(
      new URLSearchParams({ proto: 'pancakev3', token0, token1, limit: '100' }),
    );
    assert.equal(pancakeV3.count, 1);
    assert.equal(pancakeV3.pools[0].proto, 'pancakev3');

    const plan = store.db
      .prepare('EXPLAIN QUERY PLAN SELECT address FROM pools WHERE token0 = ? AND token1 = ? ORDER BY address')
      .all(token0, token1) as Array<{ detail: string }>;
    assert.ok(plan.some((row) => row.detail.includes('idx_pools_pair')));

    const invalid: Array<Record<string, string>> = [
      { token0 },
      { token1 },
      { token0: token1, token1: token0 },
      { token0: 'bad', token1 },
      { token0, token1, q: 'AAA/BBB' },
    ];
    for (const params of invalid)
      assert.throws(() => api.getPools(new URLSearchParams(params)), api.ApiInputError);
  } finally {
    store.db.prepare('DELETE FROM pools WHERE address = ?').run(distractorPool);
    store.db.prepare('DELETE FROM tokens WHERE address = ?').run(distractorToken);
  }
});

test('exact-address catalog lookup exposes unverified metadata and unswept V2 state', () => {
  const pool = address(8);
  const fallbackToken = address(0xc1);
  store.upsertTokenMeta(fallbackToken, 'FALLBACK', 18, false);
  store.insertPool({
    address: pool,
    proto: 'pancakev2',
    token0,
    token1: fallbackToken,
    feePpm: 2500,
    pairIndex: 8,
  });

  try {
    const result = api.getPools(new URLSearchParams({ proto: 'pancakev2', q: pool, limit: '1' }));
    assert.equal(result.count, 1, 'catalog match must remain visible before hydration');
    assert.equal(result.nextCursor, null);
    assert.equal(result.pools.length, 1);
    assert.equal(result.pools[0].address, pool);
    assert.equal((result.pools[0] as Record<string, unknown>).stateReady, false);
    assert.equal((result.tokens[token0] as { metaOk: boolean }).metaOk, true);
    assert.equal((result.tokens[fallbackToken] as { metaOk: boolean }).metaOk, false);
    assert.equal((result.totals as Record<string, number>).pancakev2, 2);
  } finally {
    store.db.prepare('DELETE FROM pools WHERE address = ?').run(pool);
    store.db.prepare('DELETE FROM tokens WHERE address = ?').run(fallbackToken);
  }
});

test('exact pool-address lookup queues a refresh when otherwise complete state is stale', () => {
  const pool = address(2);
  store.db.prepare('UPDATE pool_state SET updated = ? WHERE address = ?').run(1, pool);

  const result = api.getPools(new URLSearchParams({ q: pool, limit: '1' }));
  assert.equal(result.pools[0].address, pool);
  assert.equal((result.pools[0] as Record<string, unknown>).stateReady, true);
  assert.equal(
    (store.db.prepare('SELECT COUNT(*) AS n FROM hydration_demand WHERE address = ?').get(pool) as { n: number }).n,
    1,
  );

  store.upsertState(pool, { reserve0: 2n, reserve1: 2n, totalSupply: 1n });
  assert.deepEqual(store.settleHydrationDemand([pool]), { ready: 1, retry: 0 });
});

test('health identifies the configured chain and every supported official factory', () => {
  store.kvSet('v2_count', '5');
  store.kvSet('v2_factory_count', '7');
  store.kvSet('v3_cursor', '100');
  store.kvSet('v3_target_block', '120');
  const health = api.getHealth();
  assert.deepEqual(health.chain, { key: CHAIN.key, id: CHAIN.id });
  assert.deepEqual(health.uniswap, {
    v2Factory: UNI.V2_FACTORY,
    v3Factory: UNI.V3_FACTORY,
    v4PoolManager: CHAIN.uniV4?.POOL_MANAGER ?? null,
  });
  assert.deepEqual(health.pancake, {
    v2Factory: CHAIN.id === 56 ? ADDR.V2_FACTORY : null,
    v3Factory: CHAIN.id === 56 ? ADDR.CL_FACTORY : null,
  });
  assert.deepEqual(health.catalog, {
    v2: {
      supported: true,
      ready: false,
      localCount: 2,
      cursor: 5,
      factoryCount: 7,
    },
    v3: {
      supported: true,
      ready: false,
      localCount: 3,
      cursorBlock: 100,
      targetBlock: 120,
      backfilled: false,
      snapshotSource: null,
      snapshotBlock: null,
      snapshotBlockHash: null,
      snapshotPoolCount: null,
      snapshotDeployment: null,
      snapshotSubgraphId: null,
      snapshotComplete: false,
    },
    pancakeV2: {
      supported: CHAIN.id === 56,
      ready: false,
      localCount: 1,
      cursor: 0,
      factoryCount: 0,
      snapshotSource: null,
      snapshotBlock: null,
      snapshotBlockHash: null,
      snapshotPoolCount: null,
      snapshotCatalogGeneration: null,
      catalogGeneration: store.pancakeV2CatalogGeneration(),
      snapshotComplete: false,
    },
    pancakeV3: {
      supported: CHAIN.id === 56,
      ready: false,
      localCount: 1,
      cursorBlock: 0,
      targetBlock: 0,
      backfilled: false,
      snapshotSource: null,
      snapshotBlock: null,
      snapshotBlockHash: null,
      snapshotPoolCount: null,
      snapshotDeployment: null,
      snapshotSubgraphId: null,
      snapshotComplete: false,
    },
    v4: {
      // Two directory sources answer the same question, and a chain with
      // neither has no v4 catalog. Pinning this to the subgraph alone is how it
      // went stale: Robinhood publishes none and is discovered by RPC scan, so
      // this read `false` against a live, ready v4 catalog for six days.
      supported: Boolean(CHAIN.uniV4 && (CHAIN.uniV4.poolSubgraph || CHAIN.uniV4.rpcDirectory)),
      ready: false,
      degraded: false,
      lastError: null,
      lastErrorAt: null,
      localCount: 0,
      cursorBlock: 0,
      targetBlock: 0,
      backfilled: false,
      snapshotSource: null,
      snapshotBlock: null,
      snapshotBlockHash: null,
      snapshotPoolCount: null,
      snapshotDeployment: null,
      snapshotSubgraphId: null,
      snapshotGeneration: null,
      snapshotComplete: false,
      featuredBlock: null,
      featuredCount: null,
      featuredAsof: null,
    },
  });
});

test('protocol landing ranking is scoped and its full-catalog work is index-bounded', () => {
  const pancake: string[] = [];
  const poolsPerVenue = 2_100; // exceeds the default 2,048 candidate slice
  store.tx(() => {
    for (let i = 0; i < poolsPerVenue; i++) {
      const uni = address(0x10_000 + i);
      store.insertPool({
        address: uni,
        proto: 'univ2',
        token0,
        token1,
        feePpm: 3_000,
      });
      store.upsertState(uni, { reserve0: 1n, reserve1: 1n, totalSupply: 1n });
      store.setTvl(uni, 1_000_000 - i, false);

      const cake = address(0x20_000 + i);
      pancake.push(cake);
      store.insertPool({
        address: cake,
        proto: 'pancakev2',
        token0,
        token1,
        feePpm: 2_500,
      });
      store.upsertState(cake, { reserve0: 1n, reserve1: 1n, totalSupply: 1n });
      store.setTvl(cake, i === poolsPerVenue - 1 ? 500_000 : i + 1, false);
    }
  });

  const started = Date.now();
  const result = api.getPools(new URLSearchParams({ proto: 'pancakev2', sort: 'tvl', limit: '1' }));
  assert.equal(result.pools[0].address, pancake.at(-1));
  assert.equal(result.count, poolsPerVenue + 1);
  assert.ok(Date.now() - started < 2_000, 'bounded landing query should not scale with catalog sort');

  const plan = api.explainV23Landing(new URLSearchParams({ proto: 'pancakev2', sort: 'tvl', limit: '100' }));
  assert.ok(plan.some((line) => line.includes('idx_state_proto_tvl')));
  assert.ok(plan.some((line) => line.includes('idx_stats_proto_vol')));
  assert.ok(plan.some((line) => line.includes('idx_stats_proto_liq')));
  assert.ok(plan.some((line) => line.includes('idx_pools_proto_added')));
  assert.ok(plan.some((line) => line === 'SCAN c'));
  assert.ok(
    !plan.some((line) => /^SCAN p(?:\s|$)/.test(line)),
    `catalog table must not drive the landing join:\n${plan.join('\n')}`,
  );
});
