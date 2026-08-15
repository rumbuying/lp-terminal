import assert from 'node:assert/strict'
import test from 'node:test'
import { allocateProRata, executionShortfall, incomeTaxRetentionEntry } from '../../shared/strategy/accounting'

test('execution cost uses source-pool spot when it is the better baseline', () => {
  assert.deepEqual(
    executionShortfall({ spotOut: 1_000n, quotedOut: 990n, actualOut: 980n }),
    { amountOut: 20n, impactBps: 200 },
  )
})

test('execution cost preserves quote slippage when an aggregated quote beats source-pool spot', () => {
  assert.deepEqual(
    executionShortfall({ spotOut: 990n, quotedOut: 1_000n, actualOut: 998n }),
    { amountOut: 2n, impactBps: 20 },
  )
})

test('execution cost does not fabricate a loss after price improvement', () => {
  assert.deepEqual(
    executionShortfall({ spotOut: 990n, quotedOut: 1_000n, actualOut: 1_001n }),
    { amountOut: 0n, impactBps: null },
  )
})

test('execution impact retains sub-basis-point precision', () => {
  assert.deepEqual(
    executionShortfall({ spotOut: 1_000_000n, actualOut: 999_990n }),
    { amountOut: 10n, impactBps: 0.1 },
  )
})

test('gas quote allocation preserves the exact quoted total', () => {
  assert.deepEqual(allocateProRata(10n, [1n, 1n, 1n]), [3n, 3n, 4n])
  assert.deepEqual(allocateProRata(7n, [0n, 2n, 5n]), [0n, 2n, 5n])
})

test('directly retained income tax becomes an explicit ledger fact', () => {
  const entry = incomeTaxRetentionEntry({
    id: 'tax-1', strategyId: 'strategy-1', cycleId: 'cycle-1', jobId: 'job-1', ts: 1,
    token: '0x0000000000000000000000000000000000000001', amount: 123n,
  })
  assert.equal(entry?.kind, 'income_tax')
  assert.equal(entry?.amount, '123')
  assert.deepEqual(entry?.meta, { purpose: 'fee_tax', source: 'direct_retention' })
})
