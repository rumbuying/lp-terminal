import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { bindOrAssertDatabaseChain } from './databaseIdentity'

const robinhood = { chainKey: 'robinhood', chainId: 4663 }
const bsc = { chainKey: 'bsc', chainId: 56 }

test('fresh DB is bound once and the same chain verifies it', () => {
  const db = new DatabaseSync(':memory:')
  try {
    assert.deepEqual(bindOrAssertDatabaseChain(db, bsc), { ...bsc, status: 'bound' })
    assert.deepEqual(bindOrAssertDatabaseChain(db, bsc), { ...bsc, status: 'verified' })
  } finally {
    db.close()
  }
})

test('chain identity survives reopen and rejects wrong-chain reuse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-indexer-identity-'))
  const path = join(dir, 'catalog.db')
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path)
    bindOrAssertDatabaseChain(db, robinhood)
    db.close()
    db = undefined

    db = new DatabaseSync(path)
    assert.throws(
      () => bindOrAssertDatabaseChain(db!, bsc),
      /belongs to robinhood:4663; refusing configured chain bsc:56/,
    )
  } finally {
    db?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('populated legacy DB fails closed unless explicitly adopted', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE pools (address TEXT PRIMARY KEY)')
    db.prepare('INSERT INTO pools (address) VALUES (?)').run('0xlegacy')

    assert.throws(
      () => bindOrAssertDatabaseChain(db, bsc),
      /legacy data but no chain identity.*INDEXER_ADOPT_LEGACY_DB=bsc:56/,
    )
    const identityTables = db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = 'indexer_identity'")
      .get() as { n: number }
    assert.equal(identityTables.n, 0, 'a rejected legacy DB must not be mutated')
    assert.deepEqual(bindOrAssertDatabaseChain(db, bsc, { adoptLegacy: true }), {
      ...bsc,
      status: 'adopted',
    })
    assert.throws(
      () => bindOrAssertDatabaseChain(db, robinhood, { adoptLegacy: true }),
      /belongs to bsc:56/,
    )
  } finally {
    db.close()
  }
})
