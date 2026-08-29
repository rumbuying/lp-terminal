import assert from 'node:assert/strict'
import test from 'node:test'
import { privateKeyToAccount } from 'viem/accounts'
import { issueWalletChallenge, resetWalletAuthForTests, verifyWalletChallenge, walletSession } from './wallet-auth'

const origin = 'https://lp-terminal.xyz'
const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)

test.beforeEach(resetWalletAuthForTests)

test('wallet challenge creates a scoped, expiring read session and consumes the nonce', async () => {
  const now = Date.UTC(2026, 7, 15, 0, 0, 0)
  const challenge = issueWalletChallenge(account.address, origin, now)
  assert.match(challenge.message, /策略只读登录/)
  assert.match(challenge.message, new RegExp(account.address, 'i'))
  assert.match(challenge.message, /lp-terminal\.xyz/)
  const signature = await account.signMessage({ message: challenge.message })
  const verified = await verifyWalletChallenge(challenge.id, account.address, signature, origin, now + 1_000)
  assert.equal(verified.address, account.address)
  assert.equal(walletSession(verified.token, now + 2_000)?.address, account.address)
  assert.equal(walletSession(verified.token, now + 9 * 60 * 60_000), undefined)
  await assert.rejects(
    verifyWalletChallenge(challenge.id, account.address, signature, origin, now + 2_000),
    /expired/,
  )
})

test('wallet challenge is bound to both address and origin', async () => {
  const challenge = issueWalletChallenge(account.address, origin)
  const signature = await account.signMessage({ message: challenge.message })
  await assert.rejects(
    verifyWalletChallenge(challenge.id, account.address, signature, 'https://evil.example'),
    /does not match/,
  )
})
