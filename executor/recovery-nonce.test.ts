import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyMissingTransactionNonce } from './recovery-nonce'

test('confirmed external nonce consumption supersedes an absent tracked transaction', () => {
  assert.equal(classifyMissingTransactionNonce({ nonce: 7n, latest: 8n, pending: 8n }), 'absent')
})

test('an unused nonce keeps an absent tracked transaction restart-safe', () => {
  assert.equal(classifyMissingTransactionNonce({ nonce: 7n, latest: 7n, pending: 7n }), 'absent')
})

test('pending-only nonce displacement remains ambiguous', () => {
  assert.equal(classifyMissingTransactionNonce({ nonce: 7n, latest: 7n, pending: 8n }), 'ambiguous')
})

test('a verified local replacement resolves a pending-count displacement', () => {
  assert.equal(classifyMissingTransactionNonce({
    nonce: 7n,
    latest: 7n,
    pending: 8n,
    hasConfirmedLocalReplacement: true,
  }), 'absent')
})
