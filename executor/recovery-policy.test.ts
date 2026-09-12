import assert from 'node:assert/strict'
import test from 'node:test'
import { isTransientRecoveryFailure } from './recovery-policy'

test('a pre-send market-guard trip waits for the market instead of quarantining', () => {
  // The live CASHCAT quarantine of 2026-09-11: after two on-chain reverts the
  // re-quoted recovery plan crossed maxSwapImpactBps before sending anything,
  // and that third strike shut the strategy while its funds sat in the wallet.
  assert.equal(isTransientRecoveryFailure(new Error('E_SWAP_IMPACT')), true)
})

test('execution-grade failures remain quarantine-eligible', () => {
  assert.equal(isTransientRecoveryFailure(new Error('E_TX_REVERTED')), false)
  assert.equal(isTransientRecoveryFailure(new Error('E_NONCE')), false)
  assert.equal(isTransientRecoveryFailure(new Error('E_RECOVERY_CONTEXT')), false)
  assert.equal(isTransientRecoveryFailure(new Error('E_ALLOCATION_MISMATCH')), false)
})

test('provider and quote noise stay transient', () => {
  assert.equal(isTransientRecoveryFailure(new Error('E_RECOVERY_PENDING')), true)
  assert.equal(isTransientRecoveryFailure(new Error('E_KYBER_QUOTE')), true)
  assert.equal(isTransientRecoveryFailure(new Error('HTTP request failed. Status: 503')), true)
})

test('non-error throws keep the execution-grade default', () => {
  assert.equal(isTransientRecoveryFailure('E_TX_REVERTED'), false)
  assert.equal(isTransientRecoveryFailure(undefined), false)
})
