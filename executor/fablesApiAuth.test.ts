import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { privateKeyToAccount } from 'viem/accounts'

const directory = mkdtempSync(join(tmpdir(), 'fables-api-auth-'))
process.env.CHAIN = 'robinhood'
process.env.LP_EXECUTOR_CHAIN_ID = '4663'
process.env.LP_EXECUTOR_DATA_DIR = directory
process.env.LP_EXECUTOR_PORT = '0'
process.env.LP_EXECUTOR_API_TOKEN = 'fables-api-test-admin-token-32-bytes'

const { db } = await import('./store')
const { startApi } = await import('./api')
const { issueWalletChallenge, verifyWalletChallenge } = await import('./wallet-auth')
const server = startApi()
await new Promise<void>(resolve => server.once('listening', resolve))
const port = (server.address() as AddressInfo).port
const base = `http://127.0.0.1:${port}`

test.after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

test('read-only wallet login cannot save, resume or rebroadcast Fables work', async () => {
  const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)
  const origin = 'http://localhost'
  const challenge = issueWalletChallenge(account.address, origin)
  const signature = await account.signMessage({ message: challenge.message })
  const session = await verifyWalletChallenge(challenge.id, account.address, signature, origin)
  for (const { method, path, body, adminStatus } of [
    { method: 'PUT', path: '/v1/fables/strategies/unknown', body: '{}', adminStatus: 400 },
    { method: 'POST', path: '/v1/fables/jobs/unknown/resume', adminStatus: 404 },
    { method: 'POST', path: '/v1/fables/jobs/unknown/transactions/0/rebroadcast', adminStatus: 404 },
  ]) {
    const walletResponse = await fetch(`${base}${path}`, { method, body,
      headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' } })
    assert.equal(walletResponse.status, 403, path)
    const adminResponse = await fetch(`${base}${path}`, { method, body,
      headers: { authorization: `Bearer ${process.env.LP_EXECUTOR_API_TOKEN}`, 'content-type': 'application/json' } })
    assert.equal(adminResponse.status, adminStatus, path)
  }
})
