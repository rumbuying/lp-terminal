import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { zeroAddress } from 'viem'
import { FABLES_AUTO_POOL_IDS } from '../src/config/fables'
import { fablesRangeId } from '../src/lib/fables'

const directory = mkdtempSync(join(tmpdir(), 'fables-jobs-'))
process.env.LP_EXECUTOR_DATA_DIR = directory
const { addWallet, db } = await import('./store')
const { upsertFablesStrategy, updateFablesMonitorState } = await import('./fablesStore')
const { activeFablesJobs, createFablesJob, fablesJobTransactions, quarantineInterruptedFablesJobs,
  recordFablesTxIntent, resumeFablesJob, setFablesJobProgress, updateFablesTx,
  fablesJobById } = await import('./fablesJobs')
const { reconcileFablesTransactions } = await import('./fablesRecovery')

const owner = '0x0000000000000000000000000000000000000001' as const
const token = '0x0000000000000000000000000000000000000002' as const
const hook = '0x06a889870c8f83640d6816319f72e2aa579b6080' as const
const poolId = '0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551' as const

test.after(() => { FABLES_AUTO_POOL_IDS.delete(poolId); db.close(); rmSync(directory, { recursive: true, force: true }) })

test('Fables job persists a signed hash before broadcast and quarantines interrupted work', () => {
  FABLES_AUTO_POOL_IDS.add(poolId)
  const at = Math.floor(Date.now() / 1000)
  addWallet({ id: 'fables-wallet', label: 'test', address: owner, vaultPath: 'test-fables-vault', createdAt: at, updatedAt: at })
  const config = {
    version: 2, protocol: 'fables', chainId: 4663, id: 'fables-test', name: 'test', enabled: true,
    owner, poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
    positionRef: { kind: 'fables_range', poolId, hook, rangeId: fablesRangeId(poolId, -100, 100).toString(), tickLower: -100, tickUpper: 100 },
    riskToken: token, quoteToken: zeroAddress,
    range: { lowerPct: 5, upperPct: 5 },
    trigger: { pollSeconds: 4, confirmationSeconds: 300, cooldownMinutes: 5 },
    fees: { handling: 'reinvest' },
    safeguards: { maxSlippageBps: 100, maxSwapImpactBps: 150, maxRebalancesPerDay: 6,
      maxPlanAgeSeconds: 60, maxClaimFeeBps: 1000, allowLegacyUnboundedFeeExit: true,
      minNativeGasReserveWei: '1000000000000000' },
    execution: { mode: 'executor_auto', walletId: 'fables-wallet', signerAddress: owner, dryRun: false,
      maxDailyTurnoverQuote: '1000' },
    revision: 1, createdAt: at, updatedAt: at,
  } as const
  upsertFablesStrategy(config)
  updateFablesMonitorState(config.id, { revision: 1, outSide: 'upper', outSince: at - 300,
    lastTick: 101, lastBlock: '1' }, 'dry_run_ready')
  const job = createFablesJob(config)
  setFablesJobProgress(job.id, { state: 'running', stage: 'exit' })
  const hash = `0x${'ab'.repeat(32)}` as const
  recordFablesTxIntent({ jobId: job.id, ordinal: 0, stage: 'exit', nonce: 7n,
    hash, to: hook, calldataHash: `0x${'cd'.repeat(32)}` })
  assert.equal(fablesJobTransactions(job.id)[0].hash, hash)
  assert.throws(() => recordFablesTxIntent({ jobId: job.id, ordinal: 0, stage: 'exit', nonce: 8n,
    hash: `0x${'ef'.repeat(32)}`, to: hook, calldataHash: `0x${'cd'.repeat(32)}` }), /ALREADY_SENT/)
  assert.equal(quarantineInterruptedFablesJobs(), 1)
  assert.equal(fablesJobById(job.id)?.state, 'recovery')
  assert.equal(fablesJobTransactions(job.id)[0].state, 'sending')
  assert.throws(() => createFablesJob(config), /NOT_READY|constraint/)
})

test('Fables recovery resolves the stored hash once without resending', async () => {
  const job = activeFablesJobs()[0]
  const pending = await reconcileFablesTransactions(job, {
    getTransactionReceipt: async () => { throw new Error('not found') },
    getBlockNumber: async () => 12n,
  } as never)
  assert.equal(pending.unresolved, 1)
  assert.equal(fablesJobTransactions(job.id)[0].state, 'sending')
  const hash = fablesJobTransactions(job.id)[0].hash
  const recovered = await reconcileFablesTransactions(job, {
    getTransactionReceipt: async () => ({ transactionHash: hash, status: 'success', blockNumber: 12n,
      gasUsed: 100n, effectiveGasPrice: 2n }),
    getBlockNumber: async () => 13n,
  } as never)
  assert.equal(recovered.confirmed, 1)
  assert.equal(fablesJobTransactions(job.id)[0].state, 'confirmed')
  const gas = db.prepare(`SELECT amount FROM fables_ledger_entries WHERE job_id=? AND kind='gas'`).get(job.id) as { amount: string }
  assert.equal(gas.amount, '200')
  assert.equal((await reconcileFablesTransactions(job, { getTransactionReceipt: async () => { throw new Error('should not read again') },
    getBlockNumber: async () => 13n } as never)).confirmed, 0)
})

test('manual resume refuses unknown broadcasts and records a reviewed reverted receipt', () => {
  const job = activeFablesJobs()[0]
  const hash = `0x${'12'.repeat(32)}` as const
  recordFablesTxIntent({ jobId: job.id, ordinal: 1, stage: 'claim', nonce: 8n,
    hash, to: hook, calldataHash: `0x${'34'.repeat(32)}` })
  assert.throws(() => resumeFablesJob(job.id), /TX_UNRESOLVED/)
  updateFablesTx(job.id, 1, { state: 'failed', blockNumber: 14n,
    gasUsed: 100n, gasPrice: 2n, errorCode: 'E_FABLES_TX_REVERTED' })
  const resumed = resumeFablesJob(job.id)
  assert.equal(resumed.state, 'running')
  assert.equal(fablesJobTransactions(job.id)[1].state, 'reviewed')
})
