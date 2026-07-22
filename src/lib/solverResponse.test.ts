import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSolverMidAmountOut, parseSolverPriceImpactBps } from './solverResponse'

test('validates nullable solver price impact basis points', () => {
  assert.equal(parseSolverPriceImpactBps(undefined), null)
  assert.equal(parseSolverPriceImpactBps(null), null)
  assert.equal(parseSolverPriceImpactBps(0), 0)
  assert.equal(parseSolverPriceImpactBps(10_000), 10_000)

  for (const invalid of ['8', -1, 1.5, 10_001]) {
    assert.throws(() => parseSolverPriceImpactBps(invalid), /invalid solver priceImpactBps/)
  }
})

test('validates the nullable solver cost baseline', () => {
  assert.equal(parseSolverMidAmountOut('15631003702256628545100'), 15631003702256628545100n)
  assert.equal(parseSolverMidAmountOut(null), null)
  for (const invalid of [undefined, 1, '', '0', '-1', '1.5', '0x1f', '12a', '007']) {
    assert.throws(() => parseSolverMidAmountOut(invalid), /invalid solver midAmountOut/)
  }
})
