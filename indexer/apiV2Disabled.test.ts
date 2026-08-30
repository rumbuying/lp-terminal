import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const tmp = mkdtempSync(join(tmpdir(), 'lp-terminal-api-no-v2-'))
const previous = {
  chain: process.env.CHAIN,
  db: process.env.INDEXER_DB,
  disableV2: process.env.INDEXER_DISABLE_V2,
}
process.env.CHAIN = 'bsc'
process.env.INDEXER_DB = join(tmp, 'catalog.db')
process.env.INDEXER_DISABLE_V2 = '1'

const store = await import('./store')
const api = await import('./api')
const config = await import('./config')
const { BSC_UNI_V3_SUBGRAPH_DEPLOYMENT, BSC_UNI_V3_SUBGRAPH_ID } = await import('./v3Subgraph')
const {
  BSC_PANCAKE_V3_SUBGRAPH_DEPLOYMENT,
  BSC_PANCAKE_V3_SUBGRAPH_ID,
} = await import('./pancakeV3Subgraph')

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const hash = `0x${'12'.repeat(32)}`
const token0 = address(1)
const token1 = address(2)

for (const [proto, pool] of [
  ['univ2', address(10)],
  ['univ3', address(11)],
  ['pancakev2', address(12)],
  ['pancakev3', address(13)],
] as const) {
  store.insertPool({
    address: pool,
    proto,
    token0,
    token1,
    feePpm: proto === 'pancakev2' ? 2_500 : 3_000,
    ...(proto.endsWith('v2') ? { pairIndex: 0 } : { tickSpacing: 10, createdBlock: 100 }),
  })
}

const markGraphReady = (
  prefix: 'v3_' | 'pancake_v3_',
  deployment: string,
  subgraphId: string,
) => {
  store.kvSet(`${prefix}cursor`, '120')
  store.kvSet(`${prefix}target_block`, '120')
  store.kvSet(`${prefix}backfilled`, '1')
  store.kvSet(`${prefix}snapshot_source`, 'thegraph')
  store.kvSet(`${prefix}snapshot_block`, '100')
  store.kvSet(`${prefix}snapshot_block_hash`, hash)
  store.kvSet(`${prefix}snapshot_pool_count`, '1')
  store.kvSet(`${prefix}snapshot_deployment`, deployment)
  store.kvSet(`${prefix}snapshot_subgraph_id`, subgraphId)
  store.kvSet(`${prefix}snapshot_complete`, '1')
}
markGraphReady('v3_', BSC_UNI_V3_SUBGRAPH_DEPLOYMENT, BSC_UNI_V3_SUBGRAPH_ID)
markGraphReady(
  'pancake_v3_',
  BSC_PANCAKE_V3_SUBGRAPH_DEPLOYMENT,
  BSC_PANCAKE_V3_SUBGRAPH_ID,
)
store.kvSet('v23_tail_error', '')
store.kvSet('ready', '1')

after(() => {
  store.db.close()
  if (previous.chain === undefined) delete process.env.CHAIN
  else process.env.CHAIN = previous.chain
  if (previous.db === undefined) delete process.env.INDEXER_DB
  else process.env.INDEXER_DB = previous.db
  if (previous.disableV2 === undefined) delete process.env.INDEXER_DISABLE_V2
  else process.env.INDEXER_DISABLE_V2 = previous.disableV2
  rmSync(tmp, { recursive: true, force: true })
})

test('the V2 switch accepts only the explicit disable value', () => {
  assert.equal(config.v2IndexEnabled('1'), false)
  assert.equal(config.v2IndexEnabled('0'), true)
  assert.equal(config.v2IndexEnabled(undefined), true)
})

test('disabled V2 venues are omitted without blocking the V3 catalog', () => {
  const result = api.getPools(new URLSearchParams({ limit: '20' }))
  assert.equal(result.ready, true)
  assert.deepEqual(result.totals, {
    univ2: 0,
    univ3: 1,
    pancakev2: 0,
    pancakev3: 1,
  })
  assert.equal(result.count, 2)
  assert.deepEqual(
    result.pools.map((pool) => pool.proto).sort(),
    ['pancakev3', 'univ3'],
  )
  const health = api.getHealth()
  assert.equal(health.catalog.v2.supported, false)
  assert.equal(health.catalog.pancakeV2.supported, false)
  assert.equal(health.catalog.v3.ready, true)
  assert.equal(health.catalog.pancakeV3.ready, true)
})

test('an explicit V2 request fails instead of returning a partial catalog', () => {
  assert.throws(
    () => api.getPools(new URLSearchParams({ proto: 'univ2' })),
    /pool protocol is disabled/,
  )
})
