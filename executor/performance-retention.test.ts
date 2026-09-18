import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'lp-performance-retention-'))
process.env.LP_EXECUTOR_DATA_DIR = dir

const { EXECUTOR } = await import('./config')
const { cycleIncomeTaxQuote, incomeTaxRetentionRows, retainedIncomeSettlementRaw } = await import('./performance')

after(() => {
  rmSync(dir, { recursive: true, force: true })
})

const settlement = EXECUTOR.network.settlementToken
const riskToken = '0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725'
const row = (overrides: Partial<{ kind: string; token: string | null; amount: string | null; cycle_id: string | null; meta_json: string }> = {}) => ({
  cycle_id: 'cycle-a', block_number: null, kind: 'income_tax', token: settlement, amount: '1000000',
  quote_value: null, tx_hash: null, meta_json: '{}',
  ...overrides,
})
const taxSwapOut = (amount: string, cycleId = 'cycle-a') => row({
  kind: 'swap_out', cycle_id: cycleId, meta_json: '{"purpose":"fee_tax"}', amount,
})

test('wallet-retention total sums explicit settlement income_tax rows', () => {
  const total = retainedIncomeSettlementRaw([
    row(),
    row({ amount: '5614632' }),
    // non-retention kinds and malformed amounts are ignored
    row({ kind: 'fee_gross', amount: '777' }),
    row({ kind: 'protocol_fee', amount: '888' }),
    row({ amount: 'not-a-number' }),
    row({ amount: null }),
    row({ token: null }),
    // retention recorded in a non-settlement token is not counted here
    row({ token: riskToken, amount: '999' }),
  ])
  assert.equal(total, 6614632n)
})

test('cycles without an income_tax row fall back to their fee_tax swap output', () => {
  const total = retainedIncomeSettlementRaw([
    taxSwapOut('30000000', 'cycle-legacy-1'),
    taxSwapOut('18094940', 'cycle-legacy-2'),
  ])
  assert.equal(total, 48094940n)
})

test('a cycle with an income_tax row never also counts its fee_tax swap output', () => {
  const total = retainedIncomeSettlementRaw([
    row({ cycle_id: 'cycle-new', amount: '4850000' }),
    taxSwapOut('4850000', 'cycle-new'),
    taxSwapOut('12000000', 'cycle-legacy'),
  ])
  assert.equal(total, 16850000n)
})

test('non-settlement fee_tax swap outputs are ignored', () => {
  const total = retainedIncomeSettlementRaw([
    row({ kind: 'swap_out', token: riskToken, amount: '5000000', cycle_id: 'cycle-x', meta_json: '{"purpose":"fee_tax"}' }),
    row({ kind: 'swap_out', token: settlement, amount: '250000', cycle_id: 'cycle-x', meta_json: '{"purpose":"strategy"}' }),
  ])
  assert.equal(total, 0n)
})

test('rows without a cycle share one bucket and explicit rows win it', () => {
  const total = retainedIncomeSettlementRaw([
    taxSwapOut('1000000', 'cycle-a'),
    row({ cycle_id: null }),
    row({ kind: 'swap_out', cycle_id: null, token: settlement, amount: '2000000', meta_json: '{"purpose":"fee_tax"}' }),
  ])
  // cycle-a falls back to its swap output; the null cycle has an explicit row,
  // so its own fee_tax swap output is not double-counted
  assert.equal(total, 2000000n)
})

test('wallet-retention total is zero without retention rows', () => {
  assert.equal(retainedIncomeSettlementRaw([]), 0n)
  assert.equal(retainedIncomeSettlementRaw([row({ kind: 'gas', token: null, amount: '5' })]), 0n)
})

test('income_tax rows take precedence over swapped tax inputs for the same cycle', () => {
  const rows = [
    row({ amount: '4850000' }),
    row({ kind: 'swap_in', token: riskToken, amount: '19700000000000000', meta_json: '{"purpose":"fee_tax"}' }),
  ]
  assert.deepEqual(incomeTaxRetentionRows(rows), [rows[0]])
})

test('cycles without income_tax rows fall back to swapped tax inputs', () => {
  const swapIn = row({ kind: 'swap_in', token: riskToken, amount: '19700000000000000', meta_json: '{"purpose":"fee_tax"}' })
  const other = row({ kind: 'swap_in', token: riskToken, amount: '1', meta_json: '{"purpose":"strategy"}' })
  assert.deepEqual(incomeTaxRetentionRows([swapIn, other]), [swapIn])
  assert.deepEqual(incomeTaxRetentionRows([]), [])
})

const quoteToken = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
const priceBase = {
  snapshot: {
    token0: settlement, token1: quoteToken, token0Decimals: 6, token1Decimals: 18,
    sqrtPriceX96: '0', tick: 0, tickLower: -10, tickUpper: 10, liquidity: '0', observedAt: 0, blockNumber: '1',
  },
  sqrtPriceX96: 1n << 96n,
  tick: 0, observedAt: 0, blockNumber: '1', source: 'rebalance_snapshot',
}
const price = priceBase as never
const taxCycle = { id: 'cycle-a', job_id: 'job-a' } as never

test('settlement retention on an out-of-pool quote values through its funding swap, never E_POOL_IDENTITY', () => {
  // WETH-quoted strategy (quote/risk are neither settlement): the explicit
  // income_tax row is settlement-denominated and must not be pool-priced.
  const config = { quoteToken, riskToken } as never
  const rows = [
    row({ cycle_id: 'cycle-a', amount: '181778' }),
    row({ kind: 'swap_in', token: quoteToken, amount: '73347201677222', meta_json: '{"purpose":"fee_tax"}' }),
    row({ kind: 'swap_out', token: settlement, amount: '181778', meta_json: '{"purpose":"fee_tax"}' }),
  ]
  assert.equal(cycleIncomeTaxQuote(taxCycle, rows, config, price), 73347201677222n)
})

test('direct settlement retention without a funding swap values to zero instead of throwing', () => {
  const config = { quoteToken, riskToken } as never
  assert.equal(cycleIncomeTaxQuote(taxCycle, [row({ amount: '181778' })], config, price), 0n)
})

test('settlement-denominated retention keeps pricing directly when settlement is a pool token', () => {
  // risk-token-as-settlement strategy (e.g. USDG risk legs): the explicit row
  // pool-converts at the rebalance mark; 2^96 sqrt means a 1:1 mark here.
  const config = { quoteToken, riskToken: settlement } as never
  assert.equal(cycleIncomeTaxQuote(taxCycle, [row({ amount: '1000000' })], config, price), 1000000n)
})

test('quote-denominated retention keeps pricing directly', () => {
  const config = { quoteToken: settlement, riskToken } as never
  assert.equal(cycleIncomeTaxQuote(taxCycle, [row({ amount: '250000' })], config, price), 250000n)
})

test('cycles before explicit rows keep their legacy swapped-tax valuation', () => {
  const config = { quoteToken, riskToken } as never
  const rows = [
    row({ kind: 'swap_in', token: quoteToken, amount: '73347201677222', meta_json: '{"purpose":"fee_tax"}' }),
  ]
  assert.equal(cycleIncomeTaxQuote(taxCycle, rows, config, price), 73347201677222n)
})

test('legacy swapped tax on the risk leg pool-converts at the cycle mark', () => {
  const config = { quoteToken: settlement, riskToken } as never
  const riskLegPrice = {
    ...priceBase,
    snapshot: { ...priceBase.snapshot, token0: riskToken, token1: settlement },
  } as never
  const rows = [
    row({ kind: 'swap_in', token: riskToken, amount: '19700000000000000', meta_json: '{"purpose":"fee_tax"}' }),
  ]
  assert.equal(cycleIncomeTaxQuote(taxCycle, rows, config, riskLegPrice), 19700000000000000n)
})
