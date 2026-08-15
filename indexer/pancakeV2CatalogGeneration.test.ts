import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { after } from 'node:test'

const tmp = mkdtempSync(join(tmpdir(), 'lp-terminal-pancake-v2-generation-'))
const database = join(tmp, 'catalog.db')
const previous = {
  chain: process.env.CHAIN,
  db: process.env.INDEXER_DB,
}
process.env.CHAIN = 'bsc'
process.env.INDEXER_DB = database

// Exercise the deployed migration path: the original clock had only the
// global generation and may already contain a large non-zero value.
const legacy = new DatabaseSync(database)
legacy.exec(`
  CREATE TABLE indexer_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    chain_key TEXT NOT NULL,
    chain_id INTEGER NOT NULL
  );
  INSERT INTO indexer_identity VALUES (1, 'bsc', 56);
  CREATE TABLE v23_catalog_clock (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    next_seq INTEGER NOT NULL,
    generation INTEGER NOT NULL
  );
  INSERT INTO v23_catalog_clock VALUES (1, 12, 37);
`)
legacy.close()

const store = await import('./store')

after(() => {
  store.db.close()
  if (previous.chain === undefined) delete process.env.CHAIN
  else process.env.CHAIN = previous.chain
  if (previous.db === undefined) delete process.env.INDEXER_DB
  else process.env.INDEXER_DB = previous.db
  rmSync(tmp, { recursive: true, force: true })
})

const address = (value: number) =>
  `0x${value.toString(16).padStart(40, '0')}`

test('Pancake V2 provenance ignores V3 pruning and tracks its own destructive changes', () => {
  assert.equal(store.pancakeV2CatalogGeneration(), '37')

  const pancakeV2 = address(1)
  store.insertPool({
    address: pancakeV2,
    proto: 'pancakev2',
    token0: address(101),
    token1: address(102),
    feePpm: 2_500,
    pairIndex: 0,
  })
  store.insertPool({
    address: address(2),
    proto: 'univ3',
    token0: address(201),
    token1: address(202),
    feePpm: 3_000,
    tickSpacing: 60,
    snapshotGeneration: 'old',
  })

  const publishedGeneration = store.pancakeV2CatalogGeneration()
  store.kvSet('pancake_v2_snapshot_catalog_generation', publishedGeneration)
  const globalBeforeV3Prune = BigInt(store.v23CatalogClock().generation)

  assert.equal(store.deletePoolsOutsideSnapshotGeneration('univ3', 'new'), 1)
  assert.equal(store.v23CatalogClock().generation, String(globalBeforeV3Prune + 1n))
  assert.equal(store.pancakeV2CatalogGeneration(), publishedGeneration)
  assert.equal(
    store.kvGet('pancake_v2_snapshot_catalog_generation'),
    store.pancakeV2CatalogGeneration(),
  )

  store.db
    .prepare('UPDATE pools SET fee_ppm = ? WHERE address = ?')
    .run(3_000, pancakeV2)
  assert.equal(
    store.pancakeV2CatalogGeneration(),
    String(BigInt(publishedGeneration) + 1n),
  )

  store.db.prepare('DELETE FROM pools WHERE address = ?').run(pancakeV2)
  assert.equal(
    store.pancakeV2CatalogGeneration(),
    String(BigInt(publishedGeneration) + 2n),
  )
  assert.notEqual(
    store.kvGet('pancake_v2_snapshot_catalog_generation'),
    store.pancakeV2CatalogGeneration(),
  )
})
