import assert from 'node:assert/strict'
import test from 'node:test'
import { fablesDepositCaps } from './fablesWrite'

test('Fables deposit caps limit each token even when the cycle wallet holds more', () => {
  const caps = fablesDepositCaps(1_000_000n, 2_000_000n,
    9_000_000n, 20_000_000n, 100)
  assert.deepEqual(caps, { max0: 1_010_002n, max1: 2_020_002n })
  assert.deepEqual(fablesDepositCaps(1_000n, 0n, 1_000n, 0n, 100),
    { max0: 1_000n, max1: 0n })
  assert.throws(() => fablesDepositCaps(2n, 0n, 1n, 0n, 100), /DEPOSIT_AMOUNTS/)
  assert.throws(() => fablesDepositCaps(1n, 0n, 1n, 0n, 10_001), /SLIPPAGE/)
})
