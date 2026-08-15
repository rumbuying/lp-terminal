import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { privateKeyToAccount } from 'viem/accounts'
import { originalStrategyDraft } from '../shared/strategy/schema'
import { UNI } from '../src/config/addresses'

const dir = mkdtempSync(join(tmpdir(), 'lp-executor-api-'))
const token = 'api-test-token-with-at-least-thirty-two-bytes'
process.env.LP_EXECUTOR_DATA_DIR = dir
process.env.LP_EXECUTOR_MASTER_KEY = 'api-test-master-key-with-at-least-32-bytes'
process.env.LP_EXECUTOR_API_TOKEN = token
process.env.LP_EXECUTOR_PORT = '0'
process.env.LP_EXECUTOR_ALLOWED_ORIGIN = 'http://127.0.0.1:9999'

try {
  const { startApi } = await import('../executor/api')
  const server = startApi()
  if (!server.listening) await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  const auth = { authorization: `Bearer ${token}` }

  const health = await fetch(`${base}/health`)
  assert.equal(health.status, 200)
  assert.equal((await health.json() as any).ok, true)
  assert.equal((await fetch(`${base}/v1/wallets`)).status, 401)
  assert.equal((await fetch(`${base}/v1/wallets`, { headers: { ...auth, origin: 'https://evil.example' } })).status, 403)
  assert.equal((await fetch(`${base}/v1/wallets`, { headers: { ...auth, origin: 'http://127.0.0.1:9999' } })).status, 200)
  const paused = await fetch(`${base}/v1/pause-all`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ paused: true }),
  })
  assert.equal(paused.status, 200)
  assert.equal((await paused.json() as any).paused, true)
  assert.equal((await fetch(`${base}/health`).then((response) => response.json()) as any).paused, true)
  await fetch(`${base}/v1/pause-all`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ paused: false }),
  })

  const badKey = await fetch(`${base}/v1/wallets/import`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ privateKey: 'not-a-key' }),
  })
  const badKeyBody = JSON.stringify(await badKey.json())
  assert.equal(badKey.status, 400)
  assert.equal(badKeyBody.includes('not-a-key'), false)

  const privateKey = `0x${'11'.repeat(32)}`
  const imported = await fetch(`${base}/v1/wallets/import`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Primary', privateKey }),
  })
  const importedBody = await imported.json() as any
  assert.equal(imported.status, 201)
  assert.equal(JSON.stringify(importedBody).includes(privateKey), false)
  assert.equal(importedBody.wallet.address.toLowerCase(), '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a')
  assert.equal(importedBody.wallet.label, 'Primary')
  const renamed = await fetch(`${base}/v1/wallets/${importedBody.wallet.id}`, {
    method: 'PATCH', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Treasury' }),
  })
  assert.equal(renamed.status, 200)
  assert.equal((await renamed.json() as any).wallet.label, 'Treasury')
  const noPrefixKey = '22'.repeat(32)
  const noPrefixImported = await fetch(`${base}/v1/wallets/import`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'No prefix', privateKey: noPrefixKey }),
  })
  assert.equal(noPrefixImported.status, 201)
  assert.equal((await noPrefixImported.json() as any).wallet.address.toLowerCase(), '0x1563915e194d8cfba1943570603f7606a3115508')
  const mismatchedKey = '33'.repeat(32)
  const mismatchedImport = await fetch(`${base}/v1/wallets/import`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Wrong wallet', privateKey: mismatchedKey, expectedAddress: importedBody.wallet.address }),
  })
  assert.equal(mismatchedImport.status, 400)
  assert.match((await mismatchedImport.json() as any).error, /does not match/)

  const config = originalStrategyDraft({
    owner: importedBody.wallet.address,
    protocol: 'univ3',
    pool: '0x0000000000000000000000000000000000000002',
    positionManager: UNI.V3_NPM,
    riskToken: '0x0000000000000000000000000000000000000004',
    quoteToken: '0x0000000000000000000000000000000000000005',
    activeTokenId: '9',
  })
  const put = await fetch(`${base}/v1/strategies/${encodeURIComponent(config.id)}`, {
    method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(config),
  })
  assert.equal(put.status, 200)

  const loginOrigin = 'http://127.0.0.1:9999'
  const challenge = await fetch(`${base}/auth/challenge`, {
    method: 'POST', headers: { origin: loginOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ address: importedBody.wallet.address }),
  })
  assert.equal(challenge.status, 200)
  const challengeBody = await challenge.json() as any
  const loginAccount = privateKeyToAccount(privateKey as `0x${string}`)
  const signature = await loginAccount.signMessage({ message: challengeBody.message })
  const verified = await fetch(`${base}/auth/verify`, {
    method: 'POST', headers: { origin: loginOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId: challengeBody.id, address: importedBody.wallet.address, signature }),
  })
  assert.equal(verified.status, 200)
  const sessionToken = (await verified.json() as any).token
  const walletAuth = { authorization: `Bearer ${sessionToken}`, origin: loginOrigin }
  const scopedWallets = await fetch(`${base}/v1/wallets`, { headers: walletAuth }).then((response) => response.json()) as any
  assert.deepEqual(scopedWallets.wallets.map((wallet: any) => wallet.address.toLowerCase()), [importedBody.wallet.address.toLowerCase()])
  const scopedStrategies = await fetch(`${base}/v1/strategies`, { headers: walletAuth }).then((response) => response.json()) as any
  assert.deepEqual(scopedStrategies.strategies.map((row: any) => row.config.id), [config.id])
  assert.equal((await fetch(`${base}/v1/pause-all`, {
    method: 'POST', headers: { ...walletAuth, 'content-type': 'application/json' }, body: JSON.stringify({ paused: true }),
  })).status, 403)

  const conflict = await fetch(`${base}/v1/strategies/${encodeURIComponent(config.id)}`, {
    method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(config),
  })
  assert.equal(conflict.status, 409)
  const removed = await fetch(`${base}/v1/strategies/${encodeURIComponent(config.id)}`, { method: 'DELETE', headers: auth })
  assert.equal(removed.status, 200)
  assert.deepEqual(await removed.json(), { archived: true, chainTransactions: 0, assetLocation: 'position' })
  const afterRemove = await fetch(`${base}/v1/strategies`, { headers: auth }).then((response) => response.json()) as any
  assert.equal(afterRemove.strategies.some((row: any) => row.config.id === config.id), false)
  const history = await fetch(`${base}/v1/history`, { headers: auth })
  assert.equal(history.status, 200)
  const historyBody = await history.json() as any
  assert.equal(historyBody.strategies.some((row: any) => row.config.id === config.id && row.archivedAt > 0), true)

  const calendar = await fetch(`${base}/v1/pnl-calendar`, { headers: auth })
  assert.equal(calendar.status, 200)
  const calendarBody = await calendar.json() as any
  assert.equal(calendarBody.timezone, 'Asia/Shanghai')
  assert.equal(Array.isArray(calendarBody.rows), true)

  const oversized = await fetch(`${base}/v1/wallets/import`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ privateKey: 'x'.repeat(20_000) }),
  })
  assert.equal(oversized.status, 400)
  server.close()
  await once(server, 'close')
  console.log('executor api smoke: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
