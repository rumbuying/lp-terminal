import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const directory = mkdtempSync(join(tmpdir(), 'fables-store-migration-'))
process.env.LP_EXECUTOR_DATA_DIR = directory
const { db } = await import('./store')
db.exec(`
CREATE TABLE fables_strategies (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, pool_id TEXT NOT NULL,
  hook TEXT NOT NULL, range_id TEXT NOT NULL, wallet_id TEXT,
  config_json TEXT NOT NULL, enabled INTEGER NOT NULL,
  state TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX one_enabled_fables_strategy_per_wallet
  ON fables_strategies(wallet_id) WHERE enabled=1 AND wallet_id IS NOT NULL;
`)
await import('./fablesStore')

test.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })

test('existing Fables databases release the old one-strategy-per-wallet index', () => {
  const index = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index'
    AND name='one_enabled_fables_strategy_per_wallet'`).get()
  assert.equal(index, undefined)
  const rangeIndex = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index'
    AND name='one_enabled_fables_strategy_per_range'`).get()
  assert.ok(rangeIndex)
})
