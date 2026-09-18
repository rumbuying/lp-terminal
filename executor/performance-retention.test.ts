import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'lp-performance-retention-'))
process.env.LP_EXECUTOR_DATA_DIR = dir

const { EXECUTOR } = await import('./config')
const { retainedIncomeSettlementRaw } = await import('./performance')

after(() => {
  rmSync(dir, { recursive: true, force: true })
})

const settlement = EXECUTOR.network.settlementToken
const row = (overrides: Partial<{ kind: string; token: string | null; amount: string | null }> = {}) => ({
  cycle_id: null, block_number: null, kind: 'income_tax', token: settlement, amount: '1000000',
  quote_value: null, tx_hash: null, meta_json: '{}',
  ...overrides,
})

test('wallet-retention total sums only settlement-denominated income_tax rows', () => {
  const total = retainedIncomeSettlementRaw([
    row(),
    row({ amount: '5614632' }),
    // retention recorded in a non-settlement token is not counted here — the
    // executor only ever writes settlement-denominated income_tax rows
    row({ token: '0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725', amount: '999' }),
    // non-retention kinds and malformed amounts are ignored
    row({ kind: 'fee_gross', amount: '777' }),
    row({ amount: 'not-a-number' }),
    row({ amount: null }),
    row({ token: null }),
  ])
  assert.equal(total, 6614632n)
})

test('wallet-retention total is zero without income_tax rows', () => {
  assert.equal(retainedIncomeSettlementRaw([]), 0n)
  assert.equal(retainedIncomeSettlementRaw([row({ kind: 'gas', token: null, amount: '5' })]), 0n)
})
