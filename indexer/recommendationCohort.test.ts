import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const tmp = mkdtempSync(join(tmpdir(), 'lp-terminal-recommendation-cohort-'))
const previousDb = process.env.INDEXER_DB
process.env.INDEXER_DB = join(tmp, 'catalog.db')

const store = await import('./store')

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const token0 = address(0xa1)
const token1 = address(0xb1)

store.upsertTokenMeta(token0, 'AAA', 18, true)
store.upsertTokenMeta(token1, 'BBB', 18, true)

function addEligiblePool(n: number, volume: number) {
  const pool = address(n)
  store.insertPool({
    address: pool, proto: 'univ3', token0, token1,
    feePpm: 3_000, tickSpacing: 60,
  })
  store.upsertState(pool, {
    sqrtPrice: 1n << 96n, tick: 0, liquidity: 1_000_000n,
    reserve0: 1n, reserve1: 1n,
  })
  store.upsertStats(pool, {
    m5: volume / 288, h1: volume / 24, h6: volume / 4, h24: volume,
  }, 1, 100_000, 'test')
  return pool
}

after(() => {
  store.db.close()
  if (previousDb === undefined) delete process.env.INDEXER_DB
  else process.env.INDEXER_DB = previousDb
  rmSync(tmp, { recursive: true, force: true })
})

test('a pool that drops out remains in the bounded sampling cohort', () => {
  const initial = Array.from({ length: 5 }, (_, index) => addEligiblePool(index + 1, 100_000 - index * 10_000))
  assert.deepEqual(new Set(store.recommendationAddressPoolAddrs(5)), new Set(initial))

  // The former leader fails the live freshness gate while a new high-volume
  // pool enters. Four slots remain live and one is reserved for failed-cohort
  // observation, so the failure path does not disappear from history.
  store.db.prepare('UPDATE pool_stats SET updated=0 WHERE address=?').run(initial[0])
  const entrant = addEligiblePool(6, 200_000)
  const sampled = store.recommendationAddressPoolAddrs(5)
  assert.equal(sampled.length, 5)
  assert.ok(sampled.includes(entrant))
  assert.ok(sampled.includes(initial[0]))
  assert.ok(!sampled.includes(initial[4]))
})
