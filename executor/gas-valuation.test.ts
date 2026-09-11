import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'lp-gas-valuation-'))
process.env.LP_EXECUTOR_DATA_DIR = dir

const { backfillLegacyGasValuation, completeGasValuation, db, gasValuation, recordGasReceipt } = await import('./store')

db.prepare("INSERT INTO strategies(id,config_json,state,updated_at) VALUES('strategy-1','{}','monitoring',1)").run()
db.prepare("INSERT INTO jobs(id,strategy_id,plan_json,state,created_at,updated_at) VALUES('job-1','strategy-1','{}','completed',1,1)").run()

after(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const base = {
  txHash: '0x1000000000000000000000000000000000000000000000000000000000000000',
  strategyId: 'strategy-1',
  jobId: 'job-1',
  blockNumber: '123',
  observedAt: 1_800_000_000,
  gasWei: '21000000000000',
  quoteToken: '0x0000000000000000000000000000000000000010',
  settlementToken: '0x0000000000000000000000000000000000000020',
  valuationVersion: 1 as const,
}

test('receipt gas is durable even when confirmation-time pricing is unavailable', () => {
  recordGasReceipt(base)
  const stored = gasValuation(base.txHash)
  assert.equal(stored?.gasWei, base.gasWei)
  assert.equal(stored?.blockNumber, base.blockNumber)
  assert.equal(stored?.quoteValueRaw, undefined)
  assert.equal(stored?.settlementValueRaw, undefined)
})

test('a confirmation-time mark is immutable and a later observation cannot backfill it', () => {
  completeGasValuation({
    ...base,
    quoteValueRaw: '42',
    settlementValueRaw: '84',
    quoteSource: 'confirmation_quote',
    settlementSource: 'confirmation_quote',
  })
  completeGasValuation({
    ...base,
    quoteValueRaw: '999',
    settlementValueRaw: '999',
    quoteSource: 'confirmation_quote',
    settlementSource: 'confirmation_quote',
  })
  completeGasValuation({
    ...base,
    observedAt: base.observedAt + 60,
    quoteValueRaw: '777',
    settlementValueRaw: '777',
    quoteSource: 'confirmation_quote',
    settlementSource: 'confirmation_quote',
  })
  const stored = gasValuation(base.txHash)
  assert.equal(stored?.quoteValueRaw, '42')
  assert.equal(stored?.settlementValueRaw, '84')
  assert.equal(stored?.observedAt, base.observedAt)
})

test('a legacy gas row receives one immutable historical block-close mark', () => {
  const txHash = '0x2000000000000000000000000000000000000000000000000000000000000000'
  db.prepare(`INSERT INTO ledger_entries(id,strategy_id,job_id,ts,block_number,tx_hash,kind,amount,meta_json)
    VALUES(?,?,?,?,?,?,?,?,?)`).run('legacy-gas-1', 'strategy-1', 'job-1', 1_700_000_000, '120', txHash, 'gas', '100', JSON.stringify({ unit: 'wei', estimated: false }))
  const mark = {
    ledgerId: 'legacy-gas-1',
    strategyId: 'strategy-1',
    jobId: 'job-1',
    txHash,
    blockNumber: '120',
    observedAt: 1_700_000_000,
    gasWei: '100',
    quoteToken: base.quoteToken,
    quoteValueRaw: '100',
    settlementToken: base.settlementToken,
    settlementValueRaw: '245',
  }

  assert.equal(backfillLegacyGasValuation(mark), true)
  assert.equal(backfillLegacyGasValuation(mark), false)
  const row = db.prepare('SELECT quote_value,meta_json FROM ledger_entries WHERE id=?').get('legacy-gas-1') as { quote_value: string; meta_json: string }
  assert.equal(row.quote_value, '100')
  assert.deepEqual(JSON.parse(row.meta_json), {
    unit: 'wei',
    estimated: false,
    gasValuationVersion: 1,
    observedAt: 1_700_000_000,
    quoteToken: base.quoteToken,
    quoteSource: 'exact_native',
    settlementToken: base.settlementToken,
    settlementValueRaw: '245',
    settlementSource: 'historical_block_close',
  })
  assert.equal(gasValuation(txHash)?.settlementValueRaw, '245')
  assert.equal(gasValuation(txHash)?.settlementSource, 'historical_block_close')
  assert.throws(
    () => backfillLegacyGasValuation({ ...mark, settlementValueRaw: '246' }),
    /conflicts with historical mark/,
  )
})
