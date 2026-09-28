import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { mock } from 'node:test'
import { zeroAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const directory = mkdtempSync(join(tmpdir(), 'fables-api-coexist-'))
const key = `0x${'11'.repeat(32)}` as const
const owner = privateKeyToAccount(key).address
const walletId = 'shared-wallet'
const keyPath = join(directory, 'signer.key')
writeFileSync(keyPath, key, { mode: 0o600 })
process.env.CHAIN = 'robinhood'
process.env.LP_EXECUTOR_CHAIN_ID = '4663'
process.env.LP_EXECUTOR_DATA_DIR = directory
process.env.LP_EXECUTOR_PORT = '0'
process.env.LP_EXECUTOR_API_TOKEN = 'fables-api-coexist-admin-token-32-bytes'
process.env.LP_EXECUTOR_PRIVATE_KEY_FILE = keyPath
process.env.LP_EXECUTOR_PRIVATE_KEY_WALLET_ID = walletId

const poolId = '0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551' as const
const hook = '0x06a889870c8f83640d6816319f72e2aa579b6080' as const
const riskToken = '0x0000000000000000000000000000000000000002' as const
const actualFables = await import('../src/lib/fables')
mock.module('../src/lib/fables', { namedExports: { ...actualFables,
  readFablesPosition: async () => ({ owner, pool: { id: poolId, key: {
    currency0: zeroAddress, currency1: riskToken, hooks: hook,
  } }, tickLower: -100, tickUpper: 100, shares: 1n, staked: 0n,
  observedBlock: 1n }),
} })

const [{ addWallet, db, upsertStrategy }, { startApi },
  { originalStrategyDraft }, { v4Deployment }, { FABLES_AUTO_POOL_IDS }] = await Promise.all([
  import('./store'), import('./api'),
  import('../shared/strategy/schema'), import('../src/config/networks'), import('../src/config/fables'),
])
const at = Math.floor(Date.now() / 1000)
addWallet({ id: walletId, label: 'shared', address: owner, vaultPath: keyPath, createdAt: at, updatedAt: at })
const v4 = v4Deployment(4663)
const ordinary = originalStrategyDraft({ chainId: 4663, owner, protocol: 'univ4',
  pool: v4.POOL_MANAGER, poolId: `0x${'ab'.repeat(32)}`, hooks: zeroAddress,
  positionManager: v4.POSITION_MANAGER, riskToken, quoteToken: zeroAddress,
  activeTokenId: '7' })
upsertStrategy({ ...ordinary, enabled: true, execution: { ...ordinary.execution,
  mode: 'executor_auto', walletId, signerAddress: owner, dryRun: true } })
FABLES_AUTO_POOL_IDS.add(poolId)
const server = startApi()
await new Promise<void>(resolve => server.once('listening', resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

test.after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  FABLES_AUTO_POOL_IDS.delete(poolId)
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

test('an enabled Fables strategy can share a wallet with an enabled ordinary LP strategy', async () => {
  const rangeId = actualFables.fablesRangeId(poolId, -100, 100).toString()
  const config = {
    version: 2, protocol: 'fables', chainId: 4663, id: 'fables-shared-wallet',
    name: 'Fables shared wallet', enabled: true, owner, poolManager: v4.POOL_MANAGER,
    positionRef: { kind: 'fables_range', poolId, hook, rangeId, tickLower: -100, tickUpper: 100 },
    riskToken, quoteToken: zeroAddress,
    range: { lowerPct: 5, upperPct: 5 },
    trigger: { pollSeconds: 4, confirmationSeconds: 300, cooldownMinutes: 5 },
    fees: { handling: 'reinvest' },
    safeguards: { maxSlippageBps: 100, maxSwapImpactBps: 150,
      maxRebalancesPerDay: 6, maxPlanAgeSeconds: 60, maxClaimFeeBps: 1000,
      allowLegacyUnboundedFeeExit: true, minNativeGasReserveWei: '1000000000000000' },
    execution: { mode: 'executor_auto', walletId, signerAddress: owner, dryRun: false,
      maxDailyTurnoverQuote: '0.05' },
    revision: 1, createdAt: at, updatedAt: at,
  }
  const response = await fetch(`${base}/v1/fables/strategies/${config.id}`, {
    method: 'PUT', headers: { authorization: `Bearer ${process.env.LP_EXECUTOR_API_TOKEN}`,
      'content-type': 'application/json' }, body: JSON.stringify(config),
  })
  assert.equal(response.status, 200, await response.text())
  assert.equal(db.prepare('SELECT count(*) AS count FROM strategies WHERE id=?').get(ordinary.id)?.count, 1)
  assert.equal(db.prepare('SELECT count(*) AS count FROM fables_strategies WHERE id=?').get(config.id)?.count, 1)
  const unrepresentable = { ...config, revision: 2, updatedAt: at + 1,
    execution: { ...config.execution, maxDailyTurnoverQuote: '0.0000000000000000001' } }
  const invalidResponse = await fetch(`${base}/v1/fables/strategies/${config.id}`, {
    method: 'PUT', headers: { authorization: `Bearer ${process.env.LP_EXECUTOR_API_TOKEN}`,
      'content-type': 'application/json' }, body: JSON.stringify(unrepresentable),
  })
  assert.equal(invalidResponse.status, 400)
  const saved = db.prepare('SELECT config_json FROM fables_strategies WHERE id=?').get(config.id) as { config_json: string }
  assert.equal(JSON.parse(saved.config_json).execution.maxDailyTurnoverQuote, '0.05')
})
