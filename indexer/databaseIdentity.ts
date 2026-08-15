import type { DatabaseSync } from 'node:sqlite'

export type IndexerChainIdentity = {
  chainKey: string
  chainId: number
}

export type DatabaseIdentityBinding = IndexerChainIdentity & {
  status: 'bound' | 'adopted' | 'verified'
}

type IdentityRow = {
  chain_key: string
  chain_id: number
}

const CREATE_IDENTITY = `
CREATE TABLE IF NOT EXISTS indexer_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  chain_key TEXT NOT NULL,
  chain_id INTEGER NOT NULL
)`

const hasIdentityTable = (db: DatabaseSync): boolean =>
  Boolean(
    db
      .prepare(
        `SELECT 1 AS present FROM sqlite_schema
         WHERE type = 'table' AND name = 'indexer_identity'`,
      )
      .get(),
  )

const identityOf = (db: DatabaseSync): IndexerChainIdentity | undefined => {
  const row = db
    .prepare('SELECT chain_key, chain_id FROM indexer_identity WHERE singleton = 1')
    .get() as IdentityRow | undefined
  return row ? { chainKey: row.chain_key, chainId: Number(row.chain_id) } : undefined
}

const sameIdentity = (a: IndexerChainIdentity, b: IndexerChainIdentity): boolean =>
  a.chainKey === b.chainKey && a.chainId === b.chainId

const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`

/** Any row outside the identity table makes this a legacy DB, not a fresh DB. */
function hasApplicationData(db: DatabaseSync): boolean {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'indexer_identity'`,
    )
    .all() as { name: string }[]
  return tables.some((table) =>
    Boolean(db.prepare(`SELECT 1 AS present FROM ${quoteIdentifier(table.name)} LIMIT 1`).get()),
  )
}

/**
 * Bind a fresh DB to one chain, or verify an existing binding. A populated DB
 * from an older release is rejected unless the operator explicitly adopts it.
 * INSERT OR IGNORE plus the final read also makes concurrent starts safe: only
 * one identity can win, and a process configured for another chain then fails.
 */
export function bindOrAssertDatabaseChain(
  db: DatabaseSync,
  expected: IndexerChainIdentity,
  options: { adoptLegacy?: boolean } = {},
): DatabaseIdentityBinding {
  if (!expected.chainKey || !Number.isSafeInteger(expected.chainId) || expected.chainId <= 0) {
    throw new Error('invalid configured indexer chain identity')
  }

  const existing = hasIdentityTable(db) ? identityOf(db) : undefined
  if (existing) {
    if (!sameIdentity(existing, expected)) {
      throw new Error(
        `indexer DB belongs to ${existing.chainKey}:${existing.chainId}; refusing configured chain ${expected.chainKey}:${expected.chainId}`,
      )
    }
    return { ...existing, status: 'verified' }
  }

  const legacy = hasApplicationData(db)
  if (legacy && !options.adoptLegacy) {
    throw new Error(
      `indexer DB has legacy data but no chain identity; refusing to bind it to ${expected.chainKey}:${expected.chainId} without INDEXER_ADOPT_LEGACY_DB=${expected.chainKey}:${expected.chainId}`,
    )
  }

  db.exec(CREATE_IDENTITY)
  db.prepare(
    `INSERT OR IGNORE INTO indexer_identity (singleton, chain_key, chain_id)
     VALUES (1, ?, ?)`,
  ).run(expected.chainKey, expected.chainId)

  const bound = identityOf(db)
  if (!bound || !sameIdentity(bound, expected)) {
    const owner = bound ? `${bound.chainKey}:${bound.chainId}` : 'unknown'
    throw new Error(
      `indexer DB identity race: ${owner}; refusing configured chain ${expected.chainKey}:${expected.chainId}`,
    )
  }
  return { ...bound, status: legacy ? 'adopted' : 'bound' }
}
