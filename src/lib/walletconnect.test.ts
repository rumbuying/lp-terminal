import assert from 'node:assert/strict'
import test from 'node:test'
import { isWalletConnectProjectId } from './walletconnect'

// the id that was actually live on 2026-07-23
const REAL = '54570d840a2a808ddc70d2d2e3c90afb'

test('accepts a real project id, in either case', () => {
  assert.equal(isWalletConnectProjectId(REAL), true)
  assert.equal(isWalletConnectProjectId(REAL.toUpperCase()), true)
})

test('rejects everything that would fail silently at the relay', () => {
  for (const bad of [
    '',
    ' ',
    'up33-terminal-local', // the placeholder that shipped to production
    'YOUR_PROJECT_ID',
    'undefined',
    'null',
    REAL.slice(0, -1), // 31 chars
    REAL + 'a', // 33 chars
    REAL.replace('5', 'g'), // non-hex
    ` ${REAL}`, // untrimmed env values are a real source of this
    `${REAL} `,
    `${REAL}\n`,
    `"${REAL}"`, // quotes left on by a .env line
    `${REAL},${REAL}`,
    'projectId=' + REAL,
  ])
    assert.equal(isWalletConnectProjectId(bad), false, `should reject ${JSON.stringify(bad)}`)
})

// a global regex would carry lastIndex between calls and alternate true/false
test('is stateless across repeated calls', () => {
  for (let i = 0; i < 5; i++) assert.equal(isWalletConnectProjectId(REAL), true, `call ${i}`)
})
