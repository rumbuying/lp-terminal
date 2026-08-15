import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, beforeEach } from 'node:test'

const tmp = mkdtempSync(join(tmpdir(), 'lp-terminal-api-v4-'))
const previous = {
  chain: process.env.CHAIN,
  db: process.env.INDEXER_DB,
  subgraph: process.env.INDEXER_V4_SUBGRAPH_ID,
}
process.env.CHAIN = 'bsc'
process.env.INDEXER_DB = join(tmp, 'catalog.db')
delete process.env.INDEXER_V4_SUBGRAPH_ID

const store = await import('./store')
const api = await import('./api')
const { ADDR, CHAIN, UNI, V4 } = await import('./config')
const { BSC_UNI_V3_SUBGRAPH_DEPLOYMENT } = await import('./v3Subgraph')

if (!V4?.poolSubgraph) throw new Error('BSC test requires configured Uniswap V4')
const testV4Subgraph = V4.poolSubgraph

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
const token0 = address(0xa1)
const token1 = address(0xb1)
const hooks = address(0)
const snapshotHash = id(200)
const snapshotGeneration = id(999)

store.upsertV4TokenMeta(token0, 'AAA', 18)
store.upsertV4TokenMeta(token1, 'BBB', 6)
for (let i = 1; i <= 5; i++) {
  store.insertV4Pool({
    poolId: id(i),
    poolManager: V4.POOL_MANAGER,
    currency0: token0,
    currency1: token1,
    tickSpacing: i,
    hooks,
    snapshotGeneration,
  })
  store.upsertV4GraphStats(id(i), i * 10, i * 20, [
    { date: 100 + i, volume0: i, volume1: i * 2 },
  ])
}
store.markV4Featured(id(4), 205, 0)
store.markV4Featured(id(5), 205, 1)
store.kvSet('ready', '1')
store.kvSet('solver_v23_boot_ready', '1')
store.kvSet('solver_v4_boot_ready', '1')
store.tx(() => {
  store.kvSet('v4_snapshot_source', 'thegraph')
  store.kvSet('v4_snapshot_block', '200')
  store.kvSet('v4_snapshot_block_hash', snapshotHash)
  store.kvSet('v4_snapshot_pool_count', '5')
  store.kvSet('v4_snapshot_deployment', 'QmPinned')
  store.kvSet('v4_snapshot_subgraph_id', testV4Subgraph)
  store.deleteStaleV4SnapshotCandidates(snapshotGeneration)
  store.kvSet('v4_snapshot_generation', snapshotGeneration)
  store.kvSet('v4_snapshot_complete', '1')
})
store.kvSet('v4_cursor', '220')
store.kvSet('v4_target_block', '220')
store.kvSet('v4_backfilled', '1')
store.kvSet('v4_featured_block', '205')
store.kvSet('v4_featured_count', '2')
store.kvSet('v4_featured_asof', '300')

// Top-level health is deliberately aggregate on BSC: V4 cannot mask a missing
// Uniswap or Pancake address-keyed directory. Give each official catalog one
// complete row so this V4-focused fixture represents a fully ready process.
store.insertPool({
  address: address(10),
  proto: 'univ2',
  token0,
  token1,
  feePpm: 3_000,
  pairIndex: 0,
})
store.insertPool({
  address: address(11),
  proto: 'univ3',
  token0,
  token1,
  feePpm: 500,
  tickSpacing: 10,
  createdBlock: 190,
})
store.insertPool({
  address: address(12),
  proto: 'pancakev2',
  token0,
  token1,
  feePpm: 2_500,
  pairIndex: 0,
})
store.insertPool({
  address: address(13),
  proto: 'pancakev3',
  token0,
  token1,
  feePpm: 2_500,
  tickSpacing: 50,
  createdBlock: 190,
})
store.kvSet('v2_count', '1')
store.kvSet('v2_factory_count', '1')
store.kvSet('v3_cursor', '220')
store.kvSet('v3_target_block', '220')
store.kvSet('v3_backfilled', '1')
store.kvSet('v3_snapshot_source', 'thegraph')
store.kvSet('v3_snapshot_block', '200')
store.kvSet('v3_snapshot_block_hash', snapshotHash)
store.kvSet('v3_snapshot_pool_count', '1')
store.kvSet('v3_snapshot_deployment', BSC_UNI_V3_SUBGRAPH_DEPLOYMENT)
store.kvSet('v3_snapshot_subgraph_id', '8f1KyiuNYiNGrjagzEVpf6k6KkPG517prtjdrJihgHw')
store.kvSet('v3_snapshot_complete', '1')
store.kvSet('pancake_v2_count', '1')
store.kvSet('pancake_v2_factory_count', '1')
store.kvSet('pancake_v2_snapshot_source', 'ankr_getLogs')
store.kvSet('pancake_v2_snapshot_block', '200')
store.kvSet('pancake_v2_snapshot_block_hash', snapshotHash)
store.kvSet('pancake_v2_snapshot_pool_count', '1')
store.kvSet('pancake_v2_snapshot_catalog_generation', store.pancakeV2CatalogGeneration())
store.kvSet('pancake_v2_snapshot_complete', '1')
store.kvSet('pancake_v3_cursor', '220')
store.kvSet('pancake_v3_target_block', '220')
store.kvSet('pancake_v3_backfilled', '1')
store.kvSet('pancake_v3_snapshot_source', 'thegraph')
store.kvSet('pancake_v3_snapshot_block', '200')
store.kvSet('pancake_v3_snapshot_block_hash', snapshotHash)
store.kvSet('pancake_v3_snapshot_pool_count', '1')
store.kvSet(
  'pancake_v3_snapshot_deployment',
  'QmQhHo4B63yqxLsqFTMjEF6VQJ6xYorn6k5r5a8takVnJQ',
)
store.kvSet(
  'pancake_v3_snapshot_subgraph_id',
  '78EUqzJmEVJsAKvWghn7qotf9LVGqcTQxJhT5z84ZmgJ',
)
store.kvSet('pancake_v3_snapshot_complete', '1')
store.kvSet('v23_tail_error', '')
store.kvSet('v23_tail_error_at', '')
store.kvSet('v23_tail_success_at', '299')

beforeEach(() => {
  // Several cases deliberately delete address-catalog rows. Keep the shared
  // fixture's published marker aligned unless the case itself is testing a
  // stale or malformed destructive-generation fence.
  store.kvSet('pancake_v2_snapshot_catalog_generation', store.pancakeV2CatalogGeneration())
  store.kvSet('ready', '1')
  store.kvSet('solver_v23_boot_ready', '1')
  store.kvSet('solver_v4_boot_ready', '1')
})

after(() => {
  store.db.close()
  if (previous.chain === undefined) delete process.env.CHAIN
  else process.env.CHAIN = previous.chain
  if (previous.db === undefined) delete process.env.INDEXER_DB
  else process.env.INDEXER_DB = previous.db
  if (previous.subgraph === undefined) delete process.env.INDEXER_V4_SUBGRAPH_ID
  else process.env.INDEXER_V4_SUBGRAPH_ID = previous.subgraph
  rmSync(tmp, { recursive: true, force: true })
})

test('the v4 pair search never asks the planner for a cartesian product either', () => {
  // The sibling half of the 2026-08-10 lesson. Last time this path had the
  // safer contract and the v23 path did not, so `q=/&proto=univ4` answered 200
  // while its twin held the loop for ten hours. Both now build the clause from
  // one shared helper, and both are pinned, so they cannot drift apart again.
  const { where, args } = api.v4PoolsWhere(new URLSearchParams({ q: 'aaa/bbb' }))
  const plan = (
    store.db
      .prepare(`EXPLAIN QUERY PLAN SELECT p.pool_id FROM v4_pools p ${where}`)
      .all(...args) as { detail: string }[]
  )
    .map((row) => row.detail)
    .join('\n')

  assert.doesNotMatch(plan, /currency0=\? AND currency1=\?/)
  assert.match(plan, /CORRELATED SCALAR SUBQUERY/)
  assert.deepEqual(
    api.getV4Pools(new URLSearchParams({ proto: 'univ4', q: 'aaa/bbb' })).pools.length,
    5,
    'and it still answers the search',
  )
})

test('v4 landing page and 64-byte PoolId cursor cover singleton-backed pools', () => {
  const landing = api.getV4Pools(new URLSearchParams({ proto: 'univ4', limit: '2' }))
  assert.equal(landing.ready, true)
  assert.deepEqual(
    landing.pools.map((pool) => pool.poolId),
    [id(4), id(5)],
  )
  assert.equal(landing.nextCursor, api.FIRST_V4_POOL_CURSOR)
  assert.equal(landing.count, 5)
  assert.equal(landing.totals.univ4, 5)
  assert.equal(landing.subgraphBlock, 200)
  assert.equal(landing.catalogBlock, 220)
  assert.equal(landing.catalogGeneration, snapshotGeneration)
  assert.equal(landing.catalogs.univ4.ready, true)
  assert.ok(landing.pools.every((pool) => pool.address === V4.POOL_MANAGER.toLowerCase()))
  assert.ok(landing.pools.every((pool) => !('feePpm' in pool)))
  assert.deepEqual(
    api
      .getV4Pools(new URLSearchParams({ proto: 'univ4', limit: '4' }))
      .pools.map((pool) => pool.poolId),
    [id(4), id(5), id(1), id(2)],
    'landing is featured-first and fills the remainder by PoolId',
  )

  // A finalized tail row arrives between clicks. Continuation pages stay
  // frozen at the first response's catalog block and must not grow to six.
  store.insertV4Pool({
    poolId: id(6),
    poolManager: V4.POOL_MANAGER,
    currency0: token0,
    currency1: token1,
    keyFeePpm: 500,
    tickSpacing: 10,
    hooks,
    createdBlock: 221,
  })
  store.kvSet('v4_cursor', '221')
  store.kvSet('v4_target_block', '221')

  const pages = []
  let cursor: string | null = landing.nextCursor
  while (cursor) {
    const page = api.getV4Pools(
      new URLSearchParams({
        proto: 'univ4',
        limit: '2',
        after: cursor,
        catalog_block: String(landing.catalogBlock),
        catalog_generation: landing.catalogGeneration!,
      }),
    )
    assert.equal(page.count, 5)
    assert.equal(page.catalogBlock, 220)
    pages.push(...page.pools.map((pool) => pool.poolId))
    cursor = page.nextCursor
  }
  assert.deepEqual(pages, [1, 2, 3, 4, 5].map(id))
  assert.equal(
    api.getV4Pools(new URLSearchParams({ proto: 'univ4', limit: '10' })).count,
    6,
  )
  store.db.prepare('DELETE FROM v4_pools WHERE pool_id = ?').run(id(6))
  store.kvSet('v4_cursor', '220')
  store.kvSet('v4_target_block', '220')
})

test('v4 search returns raw Graph accounting and isolated display metadata', () => {
  const exact = api.getV4Pools(
    new URLSearchParams({ proto: 'univ4', q: id(4), limit: '10' }),
  )
  assert.equal(exact.count, 1)
  assert.deepEqual(exact.pools[0].rawDays, [
    { date: 104, volume0: 4, volume1: 8 },
  ])
  assert.deepEqual(exact.tokens[token0], {
    address: token0,
    symbol: 'AAA',
    decimals: 18,
    priceUsd: null,
  })
  const dropped = api.getV4Pools(
    new URLSearchParams({ proto: 'univ4', q: id(3), limit: '10' }),
  )
  assert.equal(dropped.pools[0].rawTvl0, null)
  assert.deepEqual(dropped.pools[0].rawDays, [])

  const pair = api.getV4Pools(
    new URLSearchParams({ proto: 'univ4', q: 'aaa/bbb', limit: '10' }),
  )
  assert.equal(pair.count, 5)
  const prefixPair = api.getV4Pools(
    new URLSearchParams({ proto: 'univ4', q: 'aa/bbb', limit: '10' }),
  )
  assert.equal(prefixPair.count, 0, 'pair search requires exact symbols')
  const byToken = api.getV4Pools(
    new URLSearchParams({ proto: 'univ4', q: token1, limit: '10' }),
  )
  assert.equal(byToken.count, 5)

  store.pruneV4StatsExcept(205)
  assert.equal(
    (store.db.prepare('SELECT COUNT(*) AS n FROM v4_pool_stats').get() as { n: number }).n,
    2,
  )
  assert.equal(
    (store.db.prepare('SELECT COUNT(*) AS n FROM v4_pool_days').get() as { n: number }).n,
    2,
  )
})

test('v4 exact contract-address pair lookup supports native currency and uses the pair index', () => {
  const nativePool = id(98)
  store.insertV4Pool({
    poolId: nativePool,
    poolManager: V4.POOL_MANAGER,
    currency0: address(0),
    currency1: token1,
    keyFeePpm: 500,
    tickSpacing: 10,
    hooks,
    createdBlock: 210,
  })

  try {
    const exact = api.getV4Pools(
      new URLSearchParams({ proto: 'univ4', token0, token1, limit: '100' }),
    )
    assert.equal(exact.count, 5)
    assert.equal(exact.pools.length, 5)
    assert.ok(exact.pools.every((pool) => pool.token0 === token0 && pool.token1 === token1))

    const native = api.getV4Pools(
      new URLSearchParams({
        proto: 'univ4',
        token0: address(0),
        token1,
        limit: '100',
      }),
    )
    assert.equal(native.count, 1)
    assert.equal(native.pools[0].poolId, nativePool)

    const plan = store.db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT pool_id FROM v4_pools WHERE currency0 = ? AND currency1 = ? ORDER BY pool_id',
      )
      .all(token0, token1) as Array<{ detail: string }>
    assert.ok(plan.some((row) => row.detail.includes('idx_v4_pools_pair')))

    assert.throws(
      () => api.getV4Pools(new URLSearchParams({ proto: 'univ4', token0: token1, token1: token0 })),
      api.ApiInputError,
    )
    assert.throws(
      () => api.getV4Pools(new URLSearchParams({ proto: 'univ4', token0 })),
      api.ApiInputError,
    )
  } finally {
    store.db.prepare('DELETE FROM v4_pools WHERE pool_id = ?').run(nativePool)
  }
})

test('solver topology returns one fenced, deterministic identity-only snapshot across all five venues', () => {
  const native = address(0)
  const nativePool = id(98)
  store.insertV4Pool({
    poolId: nativePool,
    poolManager: V4.POOL_MANAGER,
    currency0: native,
    currency1: token1,
    keyFeePpm: 500,
    tickSpacing: 10,
    hooks,
    createdBlock: 210,
  })

  try {
    const params = new URLSearchParams()
    params.append('pair', `${token0.toUpperCase()},${token1.toUpperCase()}`)
    params.append('pair', `${native},${token1}`)
    params.append('pair', `${token0},${token1}`) // canonical duplicate is removed
    for (const protocol of ['univ2', 'univ3', 'pancakev2', 'pancakev3', 'univ4'])
      params.append('protocol', protocol)
    const topology = api.getSolverTopology(params)

    assert.equal(topology.schemaVersion, 2)
    assert.equal(topology.chainId, 56)
    assert.deepEqual(topology.chain, { key: 'bsc', id: 56 })
    assert.equal(topology.ready, true)
    assert.deepEqual(topology.protocols, ['univ2', 'univ3', 'pancakev2', 'pancakev3', 'univ4'])
    assert.deepEqual(topology.pairs, [
      { token0: native, token1 },
      { token0, token1 },
    ])
    assert.deepEqual(topology.factories, {
      univ2: UNI.V2_FACTORY.toLowerCase(),
      univ3: UNI.V3_FACTORY.toLowerCase(),
      pancakev2: ADDR.V2_FACTORY.toLowerCase(),
      pancakev3: ADDR.CL_FACTORY.toLowerCase(),
      univ4: V4.POOL_MANAGER.toLowerCase(),
    })
    assert.deepEqual(topology.catalogs.v23, {
      ready: true,
      degraded: false,
      lastError: null,
      lastErrorAt: null,
      lastSuccessAt: 299,
    })
    for (const proto of ['univ2', 'univ3', 'pancakev2', 'pancakev3'] as const)
      assert.deepEqual(topology.catalogs[proto], { supported: true, ready: true })
    assert.equal(topology.catalogs.univ4.ready, true)
    assert.equal(topology.catalogs.univ4.degraded, false)
    assert.match(topology.v23Fence.seq, /^(0|[1-9]\d*)$/)
    assert.match(topology.v23Fence.generation, /^(0|[1-9]\d*)$/)
    assert.deepEqual(topology.v4Fence, { block: 220, generation: snapshotGeneration })
    assert.equal(topology.count, 10)
    assert.equal(topology.pools.length, topology.count)
    assert.deepEqual(
      topology.pools.map((pool) =>
        pool.proto === 'univ4' ? `${pool.token0}:${pool.proto}:${pool.poolId}` : `${pool.token0}:${pool.proto}:${pool.address}`,
      ),
      [
        `${native}:univ4:${nativePool}`,
        `${token0}:univ2:${address(10)}`,
        `${token0}:univ3:${address(11)}`,
        `${token0}:pancakev2:${address(12)}`,
        `${token0}:pancakev3:${address(13)}`,
        ...[1, 2, 3, 4, 5].map((n) => `${token0}:univ4:${id(n)}`),
      ],
    )
    assert.ok(
      topology.pools.every(
        (pool) => !('stateReady' in pool) && !('tvlUsd' in pool) && !('rawTvl0' in pool),
      ),
    )
    const graphCandidate = topology.pools.find(
      (pool) => pool.proto === 'univ4' && pool.poolId === id(1),
    )
    assert.equal(graphCandidate?.proto === 'univ4' ? graphCandidate.keyFeePpm : 'wrong', null)
    const eventCandidate = topology.pools.find(
      (pool) => pool.proto === 'univ4' && pool.poolId === nativePool,
    )
    assert.equal(eventCandidate?.proto === 'univ4' ? eventCandidate.keyFeePpm : 'wrong', 500)
  } finally {
    store.db.prepare('DELETE FROM v4_pools WHERE pool_id = ?').run(nativePool)
  }
})

test('solver V4 topology stays ready at a durable cursor ahead of its published target', () => {
  const params = new URLSearchParams({
    pair: `${token0},${token1}`,
    protocol: 'univ4',
  })
  store.kvSet('v4_cursor', '221')
  try {
    const topology = api.getSolverTopology(params)
    assert.equal(topology.ready, true)
    assert.equal(topology.catalogs.univ4.ready, true)
    assert.equal(topology.catalogs.univ4.cursorBlock, 221)
    assert.equal(topology.catalogs.univ4.targetBlock, 220)
    assert.deepEqual(topology.v4Fence, {
      block: 221,
      generation: snapshotGeneration,
    })
  } finally {
    store.kvSet('v4_cursor', '220')
  }
})

test('solver topology rejects malformed requests and deduplicates only valid repeated pairs', () => {
  const invalid = [
    new URLSearchParams(),
    new URLSearchParams({ pair: `${token0},${token1}`, limit: '1' }),
    new URLSearchParams({ pair: token0 }),
    new URLSearchParams({ pair: `${token0},${token1},${hooks}` }),
    new URLSearchParams({ pair: `bad,${token1}` }),
    new URLSearchParams({ pair: `${token1},${token0}` }),
    new URLSearchParams({ pair: `${token0},${token0}` }),
  ]
  const tooMany = new URLSearchParams()
  for (let i = 0; i <= api.SOLVER_TOPOLOGY_MAX_PAIRS; i++)
    tooMany.append('pair', `${token0},${token1}`)
  invalid.push(tooMany)
  for (const params of invalid)
    assert.throws(() => api.getSolverTopology(params), api.ApiInputError)
})

test('solver topology boot readiness is scoped to the selected protocol families', () => {
  const v23 = new URLSearchParams({ pair: `${token0},${token1}` })
  for (const protocol of ['univ2', 'univ3', 'pancakev2', 'pancakev3'])
    v23.append('protocol', protocol)
  const v4 = new URLSearchParams({ pair: `${token0},${token1}`, protocol: 'univ4' })

  // Expensive display enrichment may still keep aggregate readiness closed,
  // but this boot has already re-proved the complete address-keyed catalogs.
  store.kvSet('ready', '0')
  store.kvSet('solver_v23_boot_ready', '1')
  store.kvSet('solver_v4_boot_ready', '0')
  assert.equal(api.getSolverTopology(v23).ready, true)
  assert.equal(api.getSolverTopology(v4).ready, false)

  // Persisted catalog-complete flags from an older process are insufficient
  // until this boot validates the corresponding RPC/catalog family itself.
  store.kvSet('ready', '1')
  store.kvSet('solver_v23_boot_ready', '0')
  assert.equal(api.getSolverTopology(v23).ready, false)
})

test('solver topology scopes aggregate V2/V3 readiness to requested protocols', () => {
  const params = new URLSearchParams({
    pair: `${token0},${token1}`,
    protocol: 'univ2',
  })
  const previousComplete = store.kvGet('pancake_v3_snapshot_complete')
  try {
    store.kvSet('pancake_v3_snapshot_complete', '0')
    const topology = api.getSolverTopology(params)
    assert.equal(topology.ready, true)
    assert.equal(topology.catalogs.v23.ready, true)
    assert.equal(topology.catalogs.pancakev3.ready, false)
  } finally {
    store.kvSet('pancake_v3_snapshot_complete', previousComplete ?? '')
  }
})

test('address-only solver topology treats malformed unrequested V4 metadata as opaque', () => {
  const params = new URLSearchParams({ pair: `${token0},${token1}` })
  for (const protocol of ['univ2', 'univ3', 'pancakev2', 'pancakev3'])
    params.append('protocol', protocol)

  const malformed = {
    v4_cursor: 'not-a-number',
    v4_target_block: 'Infinity',
    v4_snapshot_block: '-1',
    v4_snapshot_pool_count: 'NaN',
    v4_snapshot_block_hash: 'malformed-hash',
  }
  const previousValues = Object.fromEntries(
    Object.keys(malformed).map((key) => [key, store.kvGet(key)]),
  )
  try {
    for (const [key, value] of Object.entries(malformed)) store.kvSet(key, value)
    const topology = api.getSolverTopology(params)

    assert.equal(topology.ready, true)
    assert.deepEqual(topology.v4Fence, { block: 0, generation: null })
    assert.deepEqual(topology.catalogs.univ4, {
      supported: false,
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
    })
  } finally {
    for (const [key, value] of Object.entries(previousValues)) store.kvSet(key, value ?? '')
  }
})

test('a persisted address-catalog tail failure degrades every readiness surface', () => {
  store.kvSet('v23_tail_error', 'RPC log tail unavailable')
  store.kvSet('v23_tail_error_at', '301')
  try {
    const params = new URLSearchParams({ pair: `${token0},${token1}` })
    for (const protocol of ['univ2', 'univ3', 'pancakev2', 'pancakev3'])
      params.append('protocol', protocol)
    const topology = api.getSolverTopology(params)
    assert.equal(topology.ready, false)
    assert.deepEqual(topology.catalogs.v23, {
      ready: false,
      degraded: true,
      lastError: 'RPC log tail unavailable',
      lastErrorAt: 301,
      lastSuccessAt: 299,
    })
    for (const proto of ['univ2', 'univ3', 'pancakev2', 'pancakev3'] as const)
      assert.equal(topology.catalogs[proto].ready, false)
    assert.equal(api.getPools(new URLSearchParams({ proto: 'univ2' })).ready, false)
    assert.equal(api.getHealth().ready, false)
  } finally {
    store.kvSet('v23_tail_error', '')
    store.kvSet('v23_tail_error_at', '')
  }
})

test('solver topology fails closed when one bounded response would exceed its pool cap', () => {
  const capToken0 = address(0xd1)
  const capToken1 = address(0xd2)
  store.tx(() => {
    for (let i = 0; i <= api.SOLVER_TOPOLOGY_MAX_POOLS; i++)
      store.insertPool({
        address: address(0x10_0000 + i),
        proto: 'univ2',
        token0: capToken0,
        token1: capToken1,
        feePpm: 3_000,
      })
  })
  try {
    assert.throws(
      () =>
        api.getSolverTopology(
          new URLSearchParams({
            pair: `${capToken0},${capToken1}`,
            protocol: 'univ2',
          }),
        ),
      api.ApiCapacityError,
    )
  } finally {
    store.db.prepare('DELETE FROM pools WHERE token0 = ? AND token1 = ?').run(capToken0, capToken1)
  }
})

test('unselected V4 rows cannot consume a V2/V3 solver topology budget', () => {
  const scopedToken0 = address(0xe1)
  const scopedToken1 = address(0xe2)
  store.insertPool({
    address: address(0x20_0000),
    proto: 'univ2',
    token0: scopedToken0,
    token1: scopedToken1,
    feePpm: 3_000,
  })
  store.tx(() => {
    for (let i = 0; i <= api.SOLVER_TOPOLOGY_MAX_POOLS; i++)
      store.insertV4Pool({
        poolId: id(0x30_0000 + i),
        poolManager: V4.POOL_MANAGER,
        currency0: scopedToken0,
        currency1: scopedToken1,
        keyFeePpm: 500,
        tickSpacing: 10,
        hooks,
        createdBlock: 210,
      })
  })
  try {
    const v2 = api.getSolverTopology(
      new URLSearchParams({
        pair: `${scopedToken0},${scopedToken1}`,
        protocol: 'univ2',
      }),
    )
    assert.equal(v2.count, 1)
    assert.deepEqual(v2.protocols, ['univ2'])
    assert.ok(v2.pools.every((pool) => pool.proto === 'univ2'))

    assert.throws(
      () =>
        api.getSolverTopology(
          new URLSearchParams({
            pair: `${scopedToken0},${scopedToken1}`,
            protocol: 'univ4',
          }),
        ),
      api.ApiCapacityError,
    )
  } finally {
    store.db.prepare('DELETE FROM pools WHERE token0 = ? AND token1 = ?').run(scopedToken0, scopedToken1)
    store.db.prepare('DELETE FROM v4_pools WHERE currency0 = ? AND currency1 = ?').run(scopedToken0, scopedToken1)
  }
})

test('v4 PoolId cursor cannot be mixed with address-keyed protocols', () => {
  assert.throws(
    () =>
      api.getPools(
        new URLSearchParams({ proto: 'univ3,univ4', after: api.FIRST_POOL_CURSOR }),
      ),
    /cannot be mixed/,
  )
  assert.throws(
    () =>
      api.getV4Pools(
        new URLSearchParams({ proto: 'univ4', catalog_block: '999999' }),
      ),
    /invalid univ4 catalog_block/,
  )
  const invalidParams: Array<Record<string, string>> = [
    { limit: '1.5' },
    { limit: '0' },
    { limit: '501' },
    { after: 'bad' },
    { catalog_block: '0200' },
    { catalog_generation: 'bad' },
  ]
  for (const params of invalidParams) {
    assert.throws(
      () => api.getV4Pools(new URLSearchParams({ proto: 'univ4', ...params })),
      api.ApiInputError,
    )
  }
  assert.throws(
    () =>
      api.getV4Pools(
        new URLSearchParams({
          proto: 'univ4',
          after: api.FIRST_V4_POOL_CURSOR,
        }),
      ),
    /requires catalog_block and catalog_generation/,
  )
  assert.throws(
    () =>
      api.getV4Pools(
        new URLSearchParams({
          proto: 'univ4',
          catalog_generation: id(998),
        }),
      ),
    api.ApiConflictError,
  )
})

test('v4 accepts the 500-row maximum and keeps the fenced cursor complete', () => {
  store.tx(() => {
    for (let i = 1_000; i <= 1_500; i++)
      store.insertV4Pool({
        poolId: id(i),
        poolManager: V4.POOL_MANAGER,
        currency0: token0,
        currency1: token1,
        keyFeePpm: 500,
        tickSpacing: 10,
        hooks,
        createdBlock: 210,
      })
  })
  try {
    const landing = api.getV4Pools(
      new URLSearchParams({ proto: 'univ4', limit: '500' }),
    )
    assert.equal(landing.pools.length, 500)
    assert.equal(landing.count, 506)
    assert.equal(landing.nextCursor, api.FIRST_V4_POOL_CURSOR)

    const seen: string[] = []
    let after: string | null = landing.nextCursor
    while (after) {
      const page = api.getV4Pools(
        new URLSearchParams({
          proto: 'univ4',
          limit: '500',
          after,
          catalog_block: String(landing.catalogBlock),
          catalog_generation: landing.catalogGeneration!,
        }),
      )
      seen.push(...page.pools.map((pool) => pool.poolId))
      after = page.nextCursor
    }
    assert.equal(seen.length, 506)
    assert.equal(new Set(seen).size, 506)
  } finally {
    store.db.prepare('DELETE FROM v4_pools WHERE pool_id >= ?').run(id(1_000))
  }
})

test('health reports v4 singleton identity and pinned snapshot provenance', () => {
  const health = api.getHealth()
  assert.equal(health.chainId, CHAIN.id)
  assert.equal(health.uniswap.v4PoolManager, V4.POOL_MANAGER)
  assert.equal(health.pools.univ4, 5)
  assert.equal(health.ready, true)
  assert.deepEqual(health.catalog.v4, {
    supported: true,
    ready: true,
    degraded: false,
    lastError: null,
    lastErrorAt: null,
    localCount: 5,
    cursorBlock: 220,
    targetBlock: 220,
    backfilled: true,
    snapshotSource: 'thegraph',
    snapshotBlock: 200,
    snapshotBlockHash: snapshotHash,
    snapshotPoolCount: 5,
    snapshotDeployment: 'QmPinned',
    snapshotSubgraphId: testV4Subgraph,
    snapshotGeneration,
    snapshotComplete: true,
    featuredBlock: 205,
    featuredCount: 2,
    featuredAsof: 300,
  })

  store.kvSet('v4_tail_error', 'RPC unavailable')
  store.kvSet('v4_tail_error_at', '301')
  const degraded = api.getHealth()
  assert.equal(degraded.ready, false)
  assert.equal(degraded.catalog.v4.ready, false)
  assert.equal(degraded.catalog.v4.degraded, true)
  assert.equal(degraded.catalog.v4.lastError, 'RPC unavailable')
  assert.equal(degraded.catalog.v4.lastErrorAt, 301)
  store.kvSet('v4_tail_error', '')
  store.kvSet('v4_tail_error_at', '')

  store.kvSet('v3_snapshot_block_hash', '0x1234')
  const invalidUniV3Hash = api.getHealth()
  assert.equal(invalidUniV3Hash.ready, false)
  assert.equal(invalidUniV3Hash.catalog.v3.ready, false)
  store.kvSet('v3_snapshot_block_hash', snapshotHash)

  store.kvSet('v3_snapshot_deployment', 'QmUnexpected')
  const wrongUniDeployment = api.getHealth()
  assert.equal(wrongUniDeployment.ready, false)
  assert.equal(wrongUniDeployment.catalog.v3.ready, false)
  store.kvSet('v3_snapshot_deployment', BSC_UNI_V3_SUBGRAPH_DEPLOYMENT)

  store.kvSet('pancake_v3_snapshot_deployment', 'QmUnexpected')
  const wrongPancakeDeployment = api.getHealth()
  assert.equal(wrongPancakeDeployment.ready, false)
  assert.equal(wrongPancakeDeployment.catalog.pancakeV3.ready, false)
  store.kvSet(
    'pancake_v3_snapshot_deployment',
    'QmQhHo4B63yqxLsqFTMjEF6VQJ6xYorn6k5r5a8takVnJQ',
  )
})

test('health publishes only complete Pancake V2 snapshot provenance and accepts a complete RPC tail', () => {
  const expected = {
    supported: true,
    ready: true,
    localCount: 1,
    cursor: 1,
    factoryCount: 1,
    snapshotSource: 'ankr_getLogs',
    snapshotBlock: 200,
    snapshotBlockHash: snapshotHash,
    snapshotPoolCount: 1,
    snapshotCatalogGeneration: store.pancakeV2CatalogGeneration(),
    catalogGeneration: store.pancakeV2CatalogGeneration(),
    snapshotComplete: true,
  }
  assert.deepEqual(api.getHealth().catalog.pancakeV2, expected)

  // Tail-discovered pairs can legitimately move cursor/local/factory beyond
  // the immutable bootstrap snapshot without invalidating its provenance.
  const tailPool = address(99)
  store.insertPool({
    address: tailPool,
    proto: 'pancakev2',
    token0,
    token1,
    feePpm: 2_500,
    pairIndex: 1,
  })
  store.kvSet('pancake_v2_count', '2')
  store.kvSet('pancake_v2_factory_count', '2')
  try {
    const tailed = api.getHealth().catalog.pancakeV2
    assert.equal(tailed.ready, true)
    assert.equal(tailed.snapshotPoolCount, 1)
    assert.equal(tailed.cursor, 2)
    assert.equal(tailed.localCount, 2)
  } finally {
    store.db.prepare('DELETE FROM pools WHERE address = ?').run(tailPool)
    store.kvSet('pancake_v2_count', '1')
    store.kvSet('pancake_v2_factory_count', '1')
  }
})

test('Pancake V2 partial import checkpoints and invalid published provenance fail closed', () => {
  const publishedKeys = [
    'pancake_v2_snapshot_source',
    'pancake_v2_snapshot_block',
    'pancake_v2_snapshot_block_hash',
    'pancake_v2_snapshot_pool_count',
    'pancake_v2_snapshot_catalog_generation',
    'pancake_v2_snapshot_complete',
  ]
  const importKeys = publishedKeys.map((key) => key.replace('_snapshot_', '_snapshot_import_'))
  const published = {
    source: store.kvGet('pancake_v2_snapshot_source'),
    block: store.kvGet('pancake_v2_snapshot_block'),
    blockHash: store.kvGet('pancake_v2_snapshot_block_hash'),
    poolCount: store.kvGet('pancake_v2_snapshot_pool_count'),
    catalogGeneration: store.kvGet('pancake_v2_snapshot_catalog_generation'),
    complete: store.kvGet('pancake_v2_snapshot_complete'),
  }
  try {
    store.db
      .prepare(`DELETE FROM kv WHERE k IN (${publishedKeys.map(() => '?').join(',')})`)
      .run(...publishedKeys)
    store.kvSet('pancake_v2_snapshot_import_source', 'ankr_getLogs')
    store.kvSet('pancake_v2_snapshot_import_block', '200')
    store.kvSet('pancake_v2_snapshot_import_block_hash', snapshotHash)
    store.kvSet('pancake_v2_snapshot_import_pool_count', '1')
    store.kvSet('pancake_v2_snapshot_import_complete', '1')

    const partial = api.getHealth().catalog.pancakeV2
    assert.equal(partial.ready, false)
    assert.deepEqual(partial, {
      supported: true,
      ready: false,
      localCount: 1,
      cursor: 1,
      factoryCount: 1,
      snapshotSource: null,
      snapshotBlock: null,
      snapshotBlockHash: null,
      snapshotPoolCount: null,
      snapshotCatalogGeneration: null,
      catalogGeneration: store.pancakeV2CatalogGeneration(),
      snapshotComplete: false,
    })
    assert.ok(!Object.keys(partial).some((key) => key.toLowerCase().includes('import')))

    store.kvSet('pancake_v2_snapshot_source', 'ankr_getLogs')
    store.kvSet('pancake_v2_snapshot_block', '200')
    store.kvSet('pancake_v2_snapshot_block_hash', snapshotHash.toUpperCase())
    store.kvSet('pancake_v2_snapshot_pool_count', '1')
    store.kvSet('pancake_v2_snapshot_catalog_generation', store.pancakeV2CatalogGeneration())
    store.kvSet('pancake_v2_snapshot_complete', '1')
    assert.equal(api.getHealth().catalog.pancakeV2.ready, false)

    store.kvSet('pancake_v2_snapshot_block_hash', snapshotHash)
    store.kvSet('pancake_v2_snapshot_pool_count', '2')
    assert.equal(api.getHealth().catalog.pancakeV2.ready, false)

    store.kvSet('pancake_v2_snapshot_pool_count', '1')
    store.kvSet('pancake_v2_snapshot_source', 'rpc_getLogs')
    assert.equal(api.getHealth().catalog.pancakeV2.ready, false)

    store.kvSet('pancake_v2_snapshot_source', 'ankr_getLogs')
    store.kvSet('pancake_v2_snapshot_block', '0')
    assert.equal(api.getHealth().catalog.pancakeV2.ready, false)

    store.kvSet('pancake_v2_snapshot_block', '200')
    const liveGeneration = store.pancakeV2CatalogGeneration()
    store.kvSet('pancake_v2_snapshot_catalog_generation', '00')
    assert.equal(api.getHealth().catalog.pancakeV2.ready, false)

    store.kvSet(
      'pancake_v2_snapshot_catalog_generation',
      (BigInt(liveGeneration) + 1n).toString(),
    )
    assert.equal(api.getHealth().catalog.pancakeV2.ready, false)

    store.kvSet('pancake_v2_snapshot_catalog_generation', liveGeneration)
    assert.equal(api.getHealth().catalog.pancakeV2.ready, true)

    store.kvSet('pancake_v2_snapshot_complete', '0')
    assert.equal(api.getHealth().catalog.pancakeV2.ready, false)
  } finally {
    store.kvSet('pancake_v2_snapshot_source', published.source ?? '')
    store.kvSet('pancake_v2_snapshot_block', published.block ?? '')
    store.kvSet('pancake_v2_snapshot_block_hash', published.blockHash ?? '')
    store.kvSet('pancake_v2_snapshot_pool_count', published.poolCount ?? '')
    store.kvSet('pancake_v2_snapshot_catalog_generation', published.catalogGeneration ?? '')
    store.kvSet('pancake_v2_snapshot_complete', published.complete ?? '')
    store.db
      .prepare(`DELETE FROM kv WHERE k IN (${importKeys.map(() => '?').join(',')})`)
      .run(...importKeys)
  }
})
