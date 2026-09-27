import assert from 'node:assert/strict'
import test from 'node:test'
import { validateFablesDailyTurnover } from './fablesLimits'

test('Fables daily turnover respects the quote token precision', () => {
  assert.equal(validateFablesDailyTurnover('0.05', 18), 50_000_000_000_000_000n)
  assert.equal(validateFablesDailyTurnover('0.05', 6), 50_000n)
  assert.throws(() => validateFablesDailyTurnover('0.0000001', 6))
  assert.throws(() => validateFablesDailyTurnover('0.0000000000000000001', 18))
  assert.throws(() => validateFablesDailyTurnover('0', 18), /E_FABLES_DAILY_LIMIT/)
  assert.throws(() => validateFablesDailyTurnover('1', 255), /E_FABLES_QUOTE_DECIMALS/)
})
