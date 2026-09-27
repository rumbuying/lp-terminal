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

test('read-only wallet login cannot resume or rebroadcast Fables transactions', async () => {
  const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)
  const origin = 'http://localhost'
  const challenge = issueWalletChallenge(account.address, origin)
  const signature = await account.signMessage({ message: challenge.message })
  const session = await verifyWalletChallenge(challenge.id, account.address, signature, origin)
  for (const path of [
    '/v1/fables/jobs/unknown/resume',
    '/v1/fables/jobs/unknown/transactions/0/rebroadcast',
  ]) {
    const walletResponse = await fetch(`${base}${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${session.token}` } })
    assert.equal(walletResponse.status, 403, path)
    const adminResponse = await fetch(`${base}${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${process.env.LP_EXECUTOR_API_TOKEN}` } })
    assert.equal(adminResponse.status, 404, path)
  }
})
