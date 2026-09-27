import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { keccak256, zeroAddress, type Hex } from 'viem'
import { FABLES_AUTO_POOL_IDS } from '../src/config/fables'
import { fablesRangeId } from '../src/lib/fables'

const directory = mkdtempSync(join(tmpdir(), 'fables-jobs-'))
process.env.LP_EXECUTOR_DATA_DIR = directory
const { addWallet, createPlannedJob, createProfitWithdrawalJob, db } = await import('./store')
const { fablesMonitorState, fablesStrategyById, upsertFablesStrategy, updateFablesMonitorState } = await import('./fablesStore')
const { activeFablesJobs, cancelFablesJobBackInRange, createFablesJob, fablesJobTransactions, quarantineInterruptedFablesJobs,
  markFablesTurnover, recordFablesTxIntent, reserveFablesTurnover,
  resumeFablesJob, setFablesJobProgress, updateFablesTx,
  fablesJobById } = await import('./fablesJobs')
const { fablesRecoveryRequiresReview, reconcileFablesTransactions,
  rebroadcastFablesTransaction } = await import('./fablesRecovery')

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
  // The production wallet can host other enabled strategies. Only an open
  // signer job, in either protocol, must prevent this Fables cycle.
  db.prepare(`INSERT INTO strategies(id,wallet_id,config_json,state,updated_at)
    VALUES(?,?,?,?,?)`).run('legacy-same-wallet', 'fables-wallet', '{}', 'monitoring', at)
  const oldPlan = { id: 'legacy-open', strategyId: 'legacy-same-wallet', steps: [] }
  assert.equal(createPlannedJob(oldPlan as never), true)
  assert.throws(() => createFablesJob(config), /E_FABLES_WALLET_BUSY/)
  db.prepare('DELETE FROM jobs WHERE id=?').run(oldPlan.id)
  const job = createFablesJob(config)
  assert.equal(createPlannedJob({ ...oldPlan, id: 'legacy-blocked' } as never), false)
  assert.equal(createProfitWithdrawalJob({ id: 'legacy-withdrawal-blocked',
    strategyId: oldPlan.strategyId, target: 'ETH', steps: [] }), false)
  db.prepare('DELETE FROM strategies WHERE id=?').run(oldPlan.strategyId)
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

test('separate Fables ranges can share a wallet while open jobs stay serialized', () => {
  const first = fablesStrategyById('fables-test')!.config
  const tickLower = -200, tickUpper = 200
  const second = { ...first, id: 'fables-second-range',
    positionRef: { ...first.positionRef, tickLower, tickUpper,
      rangeId: fablesRangeId(poolId, tickLower, tickUpper).toString() },
    revision: 1 }
  upsertFablesStrategy(second)
  updateFablesMonitorState(second.id, { revision: 1, outSide: 'upper',
    outSince: Math.floor(Date.now() / 1000) - 300, lastTick: 201, lastBlock: '1' }, 'dry_run_ready')
  assert.equal(fablesStrategyById(second.id)?.config.positionRef.rangeId, second.positionRef.rangeId)
  assert.throws(() => createFablesJob(second), /E_FABLES_WALLET_BUSY/)
})

test('manual recovery rebroadcasts only original signed bytes before resume', async () => {
  const job = activeFablesJobs()[0]
  const signedTx = '0x1234' as const
  const hash = keccak256(signedTx)
  assert.throws(() => recordFablesTxIntent({ jobId: job.id, ordinal: 1, stage: 'claim', nonce: 8n,
    hash: `0x${'12'.repeat(32)}`, to: hook, calldataHash: `0x${'34'.repeat(32)}`,
    signedTx }), /SIGNED_HASH_MISMATCH/)
  recordFablesTxIntent({ jobId: job.id, ordinal: 1, stage: 'claim', nonce: 8n,
    hash, to: hook, calldataHash: `0x${'34'.repeat(32)}`, signedTx })
  assert.equal(fablesJobTransactions(job.id)[1].signedTx, signedTx)
  await assert.rejects(rebroadcastFablesTransaction(job.id, 1, {
    getChainId: async () => 4663,
    sendRawTransaction: async () => { throw new Error('temporary network failure') },
  } as never), /temporary network failure/)
  assert.equal(fablesJobTransactions(job.id)[1].state, 'sending')
  let broadcasts = 0
  const returned = await rebroadcastFablesTransaction(job.id, 1, {
    getChainId: async () => 4663,
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      assert.equal(serializedTransaction, signedTx)
      broadcasts += 1
      return hash
    },
  } as never)
  assert.equal(returned, hash)
  assert.equal(broadcasts, 1)
  assert.equal(fablesJobTransactions(job.id)[1].state, 'sent')
  assert.throws(() => resumeFablesJob(job.id), /TX_UNRESOLVED/)
  updateFablesTx(job.id, 1, { state: 'failed', blockNumber: 14n,
    gasUsed: 100n, gasPrice: 2n, errorCode: 'E_FABLES_TX_REVERTED' })
  await assert.rejects(rebroadcastFablesTransaction(job.id, 1, {
    getChainId: async () => 4663,
    sendRawTransaction: async () => { throw new Error('must not broadcast') },
  } as never), /TX_NOT_UNRESOLVED/)
  const resumed = resumeFablesJob(job.id)
  assert.equal(resumed.state, 'running')
  assert.equal(fablesJobTransactions(job.id)[1].state, 'reviewed')
})

test('daily turnover follows the current UTC day and cannot rewrite a confirmed swap', () => {
  const job = activeFablesJobs()[0]
  const originalNow = Date.now
  const day = Math.floor(originalNow() / 86_400_000)
  try {
    Date.now = () => (day * 86_400 + 86_390) * 1_000
    reserveFablesTurnover({ jobId: job.id, ordinal: 0, walletId: job.walletId,
      quoteToken: zeroAddress, amount: 30n, limit: 100n })
    Date.now = () => ((day + 1) * 86_400 + 10) * 1_000
    reserveFablesTurnover({ jobId: job.id, ordinal: 0, walletId: job.walletId,
      quoteToken: zeroAddress, amount: 60n, limit: 100n })
    const saved = db.prepare(`SELECT utc_day,amount FROM fables_turnover_reservations
      WHERE job_id=? AND ordinal=0`).get(job.id) as { utc_day: number; amount: string }
    assert.equal(saved.utc_day, day + 1)
    assert.equal(saved.amount, '60')
    assert.throws(() => reserveFablesTurnover({ jobId: job.id, ordinal: 1,
      walletId: job.walletId, quoteToken: zeroAddress, amount: 41n, limit: 100n }), /DAILY_LIMIT/)
    reserveFablesTurnover({ jobId: job.id, ordinal: 1,
      walletId: job.walletId, quoteToken: zeroAddress, amount: 40n, limit: 100n })
    assert.throws(() => markFablesTurnover(job.id, 2, 'confirmed'), /TURNOVER_MISSING/)
    markFablesTurnover(job.id, 0, 'confirmed')
    assert.throws(() => reserveFablesTurnover({ jobId: job.id, ordinal: 0,
      walletId: job.walletId, quoteToken: zeroAddress, amount: 1n, limit: 100n }), /TURNOVER_FINAL/)
    const final = db.prepare(`SELECT state,amount FROM fables_turnover_reservations
      WHERE job_id=? AND ordinal=0`).get(job.id) as { state: string; amount: string }
    assert.equal(final.state, 'confirmed')
    assert.equal(final.amount, '60')
  } finally { Date.now = originalNow }
})

test('a discarded LP swap quote releases its daily turnover for a no-swap plan', () => {
  const job = activeFablesJobs()[0]
  try {
    reserveFablesTurnover({ jobId: job.id, ordinal: 2, walletId: job.walletId,
      quoteToken: token, amount: 90n, limit: 100n })
    reserveFablesTurnover({ jobId: job.id, ordinal: 2, walletId: job.walletId,
      quoteToken: token, amount: 0n, limit: 100n })
    reserveFablesTurnover({ jobId: job.id, ordinal: 3, walletId: job.walletId,
      quoteToken: token, amount: 100n, limit: 100n })
    assert.throws(() => reserveFablesTurnover({ jobId: job.id, ordinal: 2,
      walletId: job.walletId, quoteToken: token, amount: 1n, limit: 100n }), /DAILY_LIMIT/)
  } finally {
    db.prepare('DELETE FROM fables_turnover_reservations WHERE job_id=? AND ordinal IN (2,3)').run(job.id)
  }
})

test('recovery repairs a gas ledger write interrupted after confirmation', async () => {
  const job = activeFablesJobs()[0]
  const hash = `0x${'56'.repeat(32)}` as const
  recordFablesTxIntent({ jobId: job.id, ordinal: 2, stage: 'deposit', nonce: 9n,
    hash, to: hook, calldataHash: `0x${'78'.repeat(32)}` })
  updateFablesTx(job.id, 2, { state: 'confirmed', blockNumber: 15n,
    gasUsed: 123n, gasPrice: 4n })
  const client = { getTransactionReceipt: async () => { throw new Error('final tx must not be polled') },
    getBlockNumber: async () => 16n } as never
  assert.equal((await reconcileFablesTransactions(job, client)).confirmed, 0)
  const gas = db.prepare(`SELECT amount FROM fables_ledger_entries
    WHERE job_id=? AND tx_hash=? AND kind='gas'`).get(job.id, hash) as { amount: string }
  assert.equal(gas.amount, '492')
  await reconcileFablesTransactions(job, client)
  const count = db.prepare(`SELECT COUNT(*) AS count FROM fables_ledger_entries
    WHERE job_id=? AND tx_hash=? AND kind='gas'`).get(job.id, hash) as { count: number }
  assert.equal(count.count, 1)
})

test('asset accounting failures wait for manual review while receipt timeouts retry', () => {
  assert.equal(fablesRecoveryRequiresReview('E_FABLES_EXIT_UNDERPAID'), true)
  assert.equal(fablesRecoveryRequiresReview('E_FABLES_FEE_RECEIPT_MISMATCH'), true)
  assert.equal(fablesRecoveryRequiresReview('E_FABLES_CONTEXT_BASELINE'), true)
  assert.equal(fablesRecoveryRequiresReview('E_FABLES_RECEIPT_UNKNOWN'), false)
  assert.equal(fablesRecoveryRequiresReview('E_FABLES_CLAIM_PAUSED'), false)
})

test('each mutating stage holds its durable hash through a crash and receipt recovery', async () => {
  const stages = ['exit', 'claim', 'fee_conversion', 'swap', 'deposit'] as const
  for (const [index, stage] of stages.entries()) {
    const job = activeFablesJobs()[0]
    const ordinal = index + 3
    const hash = `0x${(90 + index).toString(16).padStart(2, '0').repeat(32)}` as Hex
    setFablesJobProgress(job.id, { state: 'recovery', stage })
    recordFablesTxIntent({ jobId: job.id, ordinal, stage, nonce: BigInt(10 + index),
      hash, to: hook, calldataHash: `0x${'ab'.repeat(32)}` })
    const pending = await reconcileFablesTransactions(job, {
      getTransactionReceipt: async () => { throw new Error('receipt not visible') },
      getBlockNumber: async () => 100n,
    } as never)
    assert.equal(pending.unresolved, 1, stage)
    assert.throws(() => resumeFablesJob(job.id), /TX_UNRESOLVED/, stage)
    assert.throws(() => recordFablesTxIntent({ jobId: job.id, ordinal: ordinal + 100,
      stage, nonce: BigInt(100 + index), hash: `0x${'cd'.repeat(32)}`,
      to: hook, calldataHash: `0x${'ef'.repeat(32)}` }), /ALREADY_SENT/, stage)
    const blockNumber = BigInt(30 + index)
    const recovered = await reconcileFablesTransactions(job, {
      getTransactionReceipt: async ({ hash: requested }: { hash: Hex }) => {
        assert.equal(requested, hash)
        return { transactionHash: hash, status: 'success', blockNumber,
          gasUsed: 100n, effectiveGasPrice: 2n }
      },
      getBlockNumber: async () => blockNumber + 2n,
    } as never)
    assert.equal(recovered.confirmed, 1, stage)
    assert.equal(fablesJobTransactions(job.id).find(tx => tx.ordinal === ordinal)?.state, 'confirmed')
    assert.equal(resumeFablesJob(job.id).state, 'running')
  }
})

test('a returned in-range price cancels an unsigned job and restores monitoring', () => {
  const source = activeFablesJobs()[0].config
  const secondOwner = '0x0000000000000000000000000000000000000003' as const
  const at = Math.floor(Date.now() / 1000)
  addWallet({ id: 'fables-cancel-wallet', label: 'cancel test', address: secondOwner,
    vaultPath: 'test-fables-cancel-vault', createdAt: at, updatedAt: at })
  const config = { ...source, id: 'fables-cancel-test', owner: secondOwner,
    execution: { ...source.execution, walletId: 'fables-cancel-wallet', signerAddress: secondOwner },
    createdAt: at, updatedAt: at }
  upsertFablesStrategy(config)
  updateFablesMonitorState(config.id, { revision: 1, outSide: 'upper', outSince: at - 300 }, 'dry_run_ready')
  const job = createFablesJob(config)
  setFablesJobProgress(job.id, { state: 'running' })
  cancelFablesJobBackInRange(job.id)
  assert.equal(fablesJobById(job.id)?.state, 'cancelled')
  assert.equal(fablesJobById(job.id)?.errorCode, 'E_FABLES_BACK_IN_RANGE')
  assert.equal(fablesStrategyById(config.id)?.state, 'monitoring')
  assert.equal(fablesMonitorState(config.id)?.outSince, undefined)
  assert.equal(fablesJobTransactions(job.id).length, 0)
  assert.throws(() => setFablesJobProgress(job.id, { stage: 'exit' }), /JOB_CLOSED/)
  assert.throws(() => cancelFablesJobBackInRange(job.id), /JOB_STAGE/)
})
