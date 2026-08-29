import assert from 'node:assert/strict'
import test from 'node:test'
import { ADDR } from '../config/addresses'
import { strategyDisplayValue, strategyStableValue } from './strategyValuation'
import { CHAIN } from '../config/chains'

const virtual = '0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31'

test('strategy assets use an arbitrary quote-token USD mark when available', () => {
  assert.ok(Math.abs(strategyStableValue(356.13, virtual, 0.56)! - 199.4328) < 1e-9)
  const display = strategyDisplayValue(356.13, virtual, 0.56)
  assert.equal(display.unit, CHAIN.stable.symbol)
  assert.ok(Math.abs(display.value - 199.4328) < 1e-9)
})

test('strategy assets fall back to the known quote amount instead of rendering empty', () => {
  assert.deepEqual(strategyDisplayValue(356.13, virtual), { value: 356.13, unit: 'quote' })
  assert.deepEqual(strategyDisplayValue(356.13, ADDR.STABLE), { value: 356.13, unit: CHAIN.stable.symbol })
})
