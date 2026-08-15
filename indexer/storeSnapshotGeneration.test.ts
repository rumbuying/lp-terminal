import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const tmp = mkdtempSync(join(tmpdir(), 'lp-terminal-store-generation-'))
const previousDb = process.env.INDEXER_DB
process.env.INDEXER_DB = join(tmp, 'catalog.db')

const { db, deletePoolsOutsideSnapshotGeneration } = await import('./store')

after(() => {
  db.close()
  if (previousDb === undefined) delete process.env.INDEXER_DB
  else process.env.INDEXER_DB = previousDb
  rmSync(tmp, { recursive: true, force: true })
})

test('snapshot-generation index covers only CL protocols and serves generation pruning', () => {
  const index = db
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'index' AND name = 'idx_pools_cl_snapshot_generation'`,
    )
    .get() as { sql: string } | undefined
  assert.ok(index)
  const sql = index.sql.replace(/\s+/g, ' ').toLowerCase()
  assert.match(sql, /where proto = 'univ3' or proto = 'pancakev3'/)
  assert.doesNotMatch(sql, /univ2|pancakev2/)

  const listed = db.prepare(`PRAGMA index_list('pools')`).all() as Array<{
    name: string
    partial: number
  }>
  assert.equal(
    listed.find((row) => row.name === 'idx_pools_cl_snapshot_generation')
      ?.partial,
    1,
  )

  for (const proto of ['univ3', 'pancakev3']) {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN DELETE FROM pools
         WHERE (proto = 'univ3' OR proto = 'pancakev3')
           AND proto = '${proto}'
           AND (snapshot_generation IS NULL OR snapshot_generation <> ?)`,
      )
      .all('generation') as Array<{ detail: string }>
    assert.ok(
      plan.some((row) =>
        row.detail.includes('idx_pools_cl_snapshot_generation'),
      ),
      `${proto} prune must use the partial CL generation index`,
    )
  }

  assert.throws(
    () =>
      deletePoolsOutsideSnapshotGeneration(
        'pancakev2' as never,
        'generation',
      ),
    /CL-only/,
  )
})
