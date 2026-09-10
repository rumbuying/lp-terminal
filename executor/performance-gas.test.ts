import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import type { StrategyConfig } from '../shared/strategy/types'

const dir = mkdtempSync(join(tmpdir(), 'lp-performance-gas-'))
process.env.LP_EXECUTOR_DATA_DIR = dir

const { EXECUTOR } = await import('./config')
const { valueGas } = await import('./performance')
const { db } = await import('./store')

after(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const cycle = { id: 'cycle-a' }
const row = (meta: Record<string, unknown>, quoteValue = '42') => ({
  cycle_id: 'cycle-a', block_number: '10', kind: 'gas', token: null, amount: '100',
  quote_value: quoteValue, tx_hash: '0x1', meta_json: JSON.stringify(meta),
})

test('historical gas accepts only a versioned occurrence-time mark', () => {
  const config = { quoteToken: EXECUTOR.network.settlementToken } as StrategyConfig
  const marked = valueGas([cycle] as never, [row({
    gasValuationVersion: 1,
    quoteToken: EXECUTOR.network.settlementToken,
    settlementToken: EXECUTOR.network.settlementToken,
    settlementValueRaw: '42',
  })] as never, config, 0n)
  assert.equal(marked.quoteComplete, true)
  assert.equal(marked.usdgComplete, true)
  assert.equal(marked.total, 42n)
  assert.equal(marked.totalUsdg, 42n)

  const legacy = valueGas([cycle] as never, [row({})] as never, config, 0n)
  assert.equal(legacy.quoteComplete, false)
  assert.equal(legacy.usdgComplete, false)
  assert.equal(legacy.total, 0n)
})

test('native-denominated gas remains exact without a market quote', () => {
  const config = { quoteToken: EXECUTOR.network.wrappedNative } as StrategyConfig
  const result = valueGas([cycle] as never, [row({}, '999')] as never, config, 0n)
  assert.equal(result.quoteComplete, true)
  assert.equal(result.total, 100n)
})
