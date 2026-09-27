import { randomUUID } from 'node:crypto'
import { keccak256, type Address, type Hex } from 'viem'
import type { FablesPositionRef, FablesStrategyConfig } from '../shared/strategy/types'
import { parseFablesStrategyConfig } from '../shared/strategy/fablesSchema'
import { db, walletById } from './store'
import './fablesStore'

db.exec(`
CREATE TABLE IF NOT EXISTS fables_jobs (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES fables_strategies(id),
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  config_json TEXT NOT NULL,
  state TEXT NOT NULL,
  stage TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_fables_job_per_strategy
  ON fables_jobs(strategy_id) WHERE state IN ('planned','running','recovery');
CREATE UNIQUE INDEX IF NOT EXISTS one_open_fables_job_per_wallet
  ON fables_jobs(wallet_id) WHERE state IN ('planned','running','recovery');
CREATE TABLE IF NOT EXISTS fables_job_transactions (
  job_id TEXT NOT NULL REFERENCES fables_jobs(id),
  ordinal INTEGER NOT NULL,
  stage TEXT NOT NULL,
  state TEXT NOT NULL,
  nonce TEXT NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE,
  tx_to TEXT NOT NULL,
  calldata_hash TEXT NOT NULL,
  signed_tx TEXT,
  block_number TEXT,
  gas_used TEXT,
  gas_price TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(job_id,ordinal)
);
CREATE TABLE IF NOT EXISTS fables_ledger_entries (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES fables_strategies(id),
  job_id TEXT NOT NULL REFERENCES fables_jobs(id),
  ts INTEGER NOT NULL,
  block_number TEXT,
  tx_hash TEXT,
  kind TEXT NOT NULL,
  token TEXT,
  amount TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS one_fables_ledger_fact_per_receipt
  ON fables_ledger_entries(job_id,tx_hash,kind,COALESCE(token,'')) WHERE tx_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS fables_turnover_reservations (
  job_id TEXT NOT NULL REFERENCES fables_jobs(id),
  ordinal INTEGER NOT NULL,
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  quote_token TEXT NOT NULL,
  utc_day INTEGER NOT NULL,
  amount TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(job_id,ordinal)
);
`)
if (!(db.prepare('PRAGMA table_info(fables_job_transactions)').all() as { name: string }[])
  .some(column => column.name === 'signed_tx'))
  db.exec('ALTER TABLE fables_job_transactions ADD COLUMN signed_tx TEXT')

export type FablesJobStage = 'precheck' | 'exit' | 'claim' | 'balance'
  | 'fee_conversion_approval' | 'fee_conversion'
  | 'swap_approval' | 'swap' | 'deposit_approval' | 'deposit' | 'verify'
export type FablesJobState = 'planned' | 'running' | 'recovery' | 'completed' | 'failed' | 'cancelled'
export type FablesJobContext = Record<string, unknown>
export type FablesJob = {
  id: string; strategyId: string; walletId: string; config: FablesStrategyConfig
  state: FablesJobState; stage: FablesJobStage; context: FablesJobContext
  errorCode?: string; createdAt: number; updatedAt: number
}
export type FablesJobTx = {
  jobId: string; ordinal: number; stage: FablesJobStage; state: 'sending' | 'sent' | 'confirmed' | 'failed' | 'reviewed'
  nonce: bigint; hash: Hex; to: Address; calldataHash: Hex; signedTx?: Hex
  blockNumber?: bigint; gasUsed?: bigint; gasPrice?: bigint; errorCode?: string
}
const now = () => Math.floor(Date.now() / 1000)

function readJob(row: Record<string, unknown>): FablesJob {
  return {
    id: String(row.id), strategyId: String(row.strategy_id), walletId: String(row.wallet_id),
    config: parseFablesStrategyConfig(JSON.parse(String(row.config_json)), { requireAutoApproval: false }),
    state: row.state as FablesJobState, stage: row.stage as FablesJobStage,
    context: JSON.parse(String(row.context_json)) as FablesJobContext,
    errorCode: row.error_code === null ? undefined : String(row.error_code),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  }
}

export function fablesJobById(id: string): FablesJob | undefined {
  const row = db.prepare('SELECT * FROM fables_jobs WHERE id=?').get(id) as Record<string, unknown> | undefined
  return row && readJob(row)
}

export function activeFablesJobs(): FablesJob[] {
  return (db.prepare(`SELECT * FROM fables_jobs WHERE state IN ('planned','running','recovery') ORDER BY created_at`).all() as Record<string, unknown>[]).map(readJob)
}

export function recentFablesJobs(owner?: Address): FablesJob[] {
  const rows = (owner
    ? db.prepare(`SELECT j.* FROM fables_jobs j JOIN fables_strategies s ON s.id=j.strategy_id
        WHERE s.owner=? ORDER BY j.created_at DESC LIMIT 50`).all(owner.toLowerCase())
    : db.prepare(`SELECT * FROM fables_jobs ORDER BY created_at DESC LIMIT 50`).all()) as Record<string, unknown>[]
  return rows.map(readJob)
}

export function createFablesJob(config: FablesStrategyConfig): FablesJob {
  const clean = parseFablesStrategyConfig(config)
  if (!clean.enabled || clean.execution.mode !== 'executor_auto' || !clean.execution.walletId)
    throw new Error('E_FABLES_AUTO_DISABLED')
  const wallet = walletById(clean.execution.walletId)
  if (!wallet || wallet.address.toLowerCase() !== clean.owner.toLowerCase()) throw new Error('E_FABLES_WALLET')
  const id = `fables-job-${randomUUID()}`
  const at = now()
  db.exec('BEGIN IMMEDIATE')
  try {
    const strategy = db.prepare('SELECT config_json,state FROM fables_strategies WHERE id=?').get(clean.id) as
      { config_json: string; state: string } | undefined
    if (!strategy || strategy.state !== 'dry_run_ready') throw new Error('E_FABLES_NOT_READY')
    const saved = parseFablesStrategyConfig(JSON.parse(strategy.config_json))
    if (JSON.stringify(saved) !== JSON.stringify(clean)) throw new Error('E_FABLES_CONFIG_CHANGED')
    const oldJob = db.prepare(`SELECT 1 FROM jobs j JOIN strategies s ON s.id=j.strategy_id
      WHERE s.wallet_id=? AND j.state IN ('planned','running','recovery') LIMIT 1`).get(clean.execution.walletId)
    if (oldJob) throw new Error('E_FABLES_WALLET_BUSY')
    // Other enabled strategies may share this wallet. Their open jobs above
    // prevent overlapping mutations; the ordinary job creators check for an
    // open Fables job in the other direction.
    db.prepare(`INSERT INTO fables_jobs(id,strategy_id,wallet_id,config_json,state,stage,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, clean.id, clean.execution.walletId, JSON.stringify(clean), 'planned', 'precheck', at, at)
    db.prepare(`UPDATE fables_strategies SET state='executing',updated_at=? WHERE id=?`).run(at, clean.id)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return fablesJobById(id)!
}

export function setFablesJobProgress(id: string, args: {
  state?: FablesJobState; stage?: FablesJobStage; context?: FablesJobContext; errorCode?: string | null
}): void {
  const row = fablesJobById(id)
  if (!row || ['completed','failed','cancelled'].includes(row.state)) throw new Error('E_FABLES_JOB_CLOSED')
  const state = args.state ?? row.state
  const stage = args.stage ?? row.stage
  const context = args.context ?? row.context
  db.prepare(`UPDATE fables_jobs SET state=?,stage=?,context_json=?,error_code=?,updated_at=? WHERE id=?`).run(
    state, stage, JSON.stringify(context), args.errorCode === undefined ? row.errorCode ?? null : args.errorCode,
    now(), id,
  )
  if (state === 'recovery') db.prepare(`UPDATE fables_strategies SET state='recovery',updated_at=? WHERE id=?`).run(now(), row.strategyId)
  if (state === 'running') db.prepare(`UPDATE fables_strategies SET state='executing',updated_at=? WHERE id=?`).run(now(), row.strategyId)
}

export function quarantineInterruptedFablesJobs(): number {
  const at = now()
  db.exec('BEGIN IMMEDIATE')
  try {
    const rows = db.prepare(`SELECT id,strategy_id FROM fables_jobs WHERE state='running'`).all() as { id: string; strategy_id: string }[]
    for (const row of rows) {
      db.prepare(`UPDATE fables_jobs SET state='recovery',error_code='E_FABLES_INTERRUPTED',updated_at=? WHERE id=?`).run(at, row.id)
      db.prepare(`UPDATE fables_strategies SET state='recovery',updated_at=? WHERE id=?`).run(at, row.strategy_id)
    }
    db.exec('COMMIT')
    return rows.length
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

export function fablesJobTransactions(id: string): FablesJobTx[] {
  return (db.prepare('SELECT * FROM fables_job_transactions WHERE job_id=? ORDER BY ordinal').all(id) as Record<string, unknown>[]).map(row => ({
    jobId: String(row.job_id), ordinal: Number(row.ordinal), stage: row.stage as FablesJobStage,
    state: row.state as FablesJobTx['state'], nonce: BigInt(String(row.nonce)),
    hash: String(row.tx_hash) as Hex, to: String(row.tx_to) as Address,
    calldataHash: String(row.calldata_hash) as Hex,
    signedTx: row.signed_tx == null ? undefined : String(row.signed_tx) as Hex,
    blockNumber: row.block_number === null ? undefined : BigInt(String(row.block_number)),
    gasUsed: row.gas_used === null ? undefined : BigInt(String(row.gas_used)),
    gasPrice: row.gas_price === null ? undefined : BigInt(String(row.gas_price)),
    errorCode: row.error_code === null ? undefined : String(row.error_code),
  }))
}

/** The locally signed hash is durable before the first network broadcast. */
export function recordFablesTxIntent(tx: Omit<FablesJobTx, 'state' | 'blockNumber' | 'gasUsed' | 'gasPrice' | 'errorCode'>): void {
  const job = fablesJobById(tx.jobId)
  if (!job || !['running','recovery'].includes(job.state)) throw new Error('E_FABLES_JOB_NOT_RUNNING')
  if (tx.signedTx && keccak256(tx.signedTx).toLowerCase() !== tx.hash.toLowerCase())
    throw new Error('E_FABLES_SIGNED_HASH_MISMATCH')
  const existing = fablesJobTransactions(tx.jobId)
  if (existing.some(row => row.ordinal === tx.ordinal || (row.stage === tx.stage && ['sending','sent'].includes(row.state))))
    throw new Error('E_FABLES_TX_ALREADY_SENT')
  db.prepare(`INSERT INTO fables_job_transactions
    (job_id,ordinal,stage,state,nonce,tx_hash,tx_to,calldata_hash,signed_tx,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    tx.jobId, tx.ordinal, tx.stage, 'sending', tx.nonce.toString(), tx.hash,
    tx.to, tx.calldataHash, tx.signedTx ?? null, now(), now(),
  )
}

export function updateFablesTx(id: string, ordinal: number, args: {
  state: FablesJobTx['state']; blockNumber?: bigint; gasUsed?: bigint; gasPrice?: bigint; errorCode?: string
}): void {
  const result = db.prepare(`UPDATE fables_job_transactions SET state=?,
    block_number=COALESCE(?,block_number),gas_used=COALESCE(?,gas_used),
    gas_price=COALESCE(?,gas_price),error_code=?,updated_at=? WHERE job_id=? AND ordinal=?`).run(
    args.state, args.blockNumber?.toString() ?? null, args.gasUsed?.toString() ?? null,
    args.gasPrice?.toString() ?? null, args.errorCode ?? null, now(), id, ordinal,
  )
  if (result.changes !== 1) throw new Error('E_FABLES_TX_MISSING')
}

/** Manual recovery can retry only after every broadcast hash has a final receipt. */
export function resumeFablesJob(id: string): FablesJob {
  const job = fablesJobById(id)
  if (!job || job.state !== 'recovery') throw new Error('E_FABLES_NOT_IN_RECOVERY')
  const transactions = fablesJobTransactions(id)
  if (transactions.some(tx => tx.state === 'sending' || tx.state === 'sent'))
    throw new Error('E_FABLES_TX_UNRESOLVED')
  const at = now()
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`UPDATE fables_job_transactions SET state='reviewed',updated_at=?
      WHERE job_id=? AND state='failed'`).run(at, id)
    db.prepare(`UPDATE fables_jobs SET state='running',error_code=NULL,updated_at=? WHERE id=?`).run(at, id)
    db.prepare(`UPDATE fables_strategies SET state='executing',updated_at=? WHERE id=?`).run(at, job.strategyId)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  return fablesJobById(id)!
}

export function appendFablesLedger(args: {
  strategyId: string; jobId: string; blockNumber?: bigint; txHash?: Hex
  kind: string; token?: Address; amount?: bigint; meta?: Record<string, unknown>
}): void {
  db.prepare(`INSERT OR IGNORE INTO fables_ledger_entries
    (id,strategy_id,job_id,ts,block_number,tx_hash,kind,token,amount,meta_json)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    randomUUID(), args.strategyId, args.jobId, now(), args.blockNumber?.toString() ?? null,
    args.txHash ?? null, args.kind, args.token?.toLowerCase() ?? null,
    args.amount?.toString() ?? null, JSON.stringify(args.meta ?? {}),
  )
}

export function recentFablesLedger(strategyId: string): {
  jobId: string; ts: number; blockNumber?: string; txHash?: Hex
  kind: string; token?: Address; amount?: string
}[] {
  const rows = db.prepare(`SELECT job_id,ts,block_number,tx_hash,kind,token,amount
    FROM fables_ledger_entries WHERE strategy_id=? ORDER BY ts DESC,rowid DESC LIMIT 100`).all(strategyId) as Record<string, unknown>[]
  return rows.map(row => ({ jobId: String(row.job_id), ts: Number(row.ts),
    blockNumber: row.block_number === null ? undefined : String(row.block_number),
    txHash: row.tx_hash === null ? undefined : String(row.tx_hash) as Hex,
    kind: String(row.kind), token: row.token === null ? undefined : String(row.token) as Address,
    amount: row.amount === null ? undefined : String(row.amount) }))
}

export function completedFablesCyclesSince(strategyId: string, since: number): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM fables_jobs
    WHERE strategy_id=? AND state='completed' AND updated_at>=?`).get(strategyId, since) as { count: number }
  return row.count
}

export function reserveFablesTurnover(args: {
  jobId: string; ordinal: number; walletId: string; quoteToken: Address
  amount: bigint; limit: bigint
}): void {
  if (args.amount < 0n || args.limit <= 0n) throw new Error('E_FABLES_DAILY_LIMIT')
  const day = Math.floor(now() / 86_400)
  db.exec('BEGIN IMMEDIATE')
  try {
    const rows = db.prepare(`SELECT amount FROM fables_turnover_reservations WHERE wallet_id=?
      AND quote_token=? AND utc_day=? AND state IN ('reserved','confirmed')
      AND NOT (job_id=? AND ordinal=?)`).all(
      args.walletId, args.quoteToken.toLowerCase(), day, args.jobId, args.ordinal,
    ) as { amount: string }[]
    const used = rows.reduce((sum, row) => sum + BigInt(row.amount), 0n)
    if (used + args.amount > args.limit) throw new Error('E_FABLES_DAILY_LIMIT')
    const saved = db.prepare(`INSERT INTO fables_turnover_reservations
      (job_id,ordinal,wallet_id,quote_token,utc_day,amount,state,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(job_id,ordinal) DO UPDATE SET
        utc_day=excluded.utc_day,amount=excluded.amount,state=excluded.state,
        updated_at=excluded.updated_at
        WHERE fables_turnover_reservations.state='reserved'`).run(
      args.jobId, args.ordinal, args.walletId, args.quoteToken.toLowerCase(), day,
      args.amount.toString(), 'reserved', now(),
    )
    if (saved.changes !== 1) throw new Error('E_FABLES_TURNOVER_FINAL')
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

export function markFablesTurnover(jobId: string, ordinal: number, state: 'confirmed' | 'released'): void {
  const result = db.prepare(`UPDATE fables_turnover_reservations SET state=?,updated_at=?
    WHERE job_id=? AND ordinal=?`).run(state, now(), jobId, ordinal)
  if (result.changes !== 1) throw new Error('E_FABLES_TURNOVER_MISSING')
}

export function failFablesJobBeforeMutation(id: string, code: string): void {
  const job = fablesJobById(id)
  if (!job || !['planned','running','recovery'].includes(job.state)) throw new Error('E_FABLES_JOB_CLOSED')
  if (fablesJobTransactions(id).some(tx => tx.state === 'sending' || tx.state === 'sent'
    || (tx.state === 'confirmed' && !['fee_conversion_approval','swap_approval','deposit_approval'].includes(tx.stage))))
    throw new Error('E_FABLES_MUTATION_EXISTS')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`UPDATE fables_jobs SET state='failed',error_code=?,updated_at=? WHERE id=?`).run(code.slice(0, 160), now(), id)
    const at = now()
    db.prepare(`INSERT INTO fables_monitor_state(strategy_id,revision,cooldown_until,error,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(strategy_id) DO UPDATE SET
        revision=excluded.revision,out_side=NULL,out_since=NULL,
        cooldown_until=excluded.cooldown_until,error=excluded.error,updated_at=excluded.updated_at`).run(
      job.strategyId, job.config.revision, at + Math.max(300, job.config.trigger.cooldownMinutes * 60),
      code.slice(0, 160), at,
    )
    db.prepare(`UPDATE fables_strategies SET state='paused',updated_at=? WHERE id=?`).run(at, job.strategyId)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

/** A price that returned in range cancels only an unsigned precheck job. */
export function cancelFablesJobBackInRange(id: string): void {
  const job = fablesJobById(id)
  if (!job || !['planned','running','recovery'].includes(job.state) || job.stage !== 'precheck')
    throw new Error('E_FABLES_JOB_STAGE')
  if (fablesJobTransactions(id).length !== 0) throw new Error('E_FABLES_MUTATION_EXISTS')
  const at = now()
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`UPDATE fables_jobs SET state='cancelled',error_code='E_FABLES_BACK_IN_RANGE',updated_at=?
      WHERE id=?`).run(at, id)
    db.prepare(`INSERT INTO fables_monitor_state(strategy_id,revision,updated_at)
      VALUES(?,?,?) ON CONFLICT(strategy_id) DO UPDATE SET
        revision=excluded.revision,out_side=NULL,out_since=NULL,cooldown_until=NULL,
        last_tick=NULL,last_block=NULL,error=NULL,updated_at=excluded.updated_at`).run(
      job.strategyId, job.config.revision, at,
    )
    db.prepare(`UPDATE fables_strategies SET state='monitoring',updated_at=? WHERE id=?`).run(at, job.strategyId)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

export type FablesCycleFact = {
  kind: string; token: Address; amount: bigint; txHash: Hex; blockNumber: bigint
  meta?: Record<string, unknown>
}

/** The new share reference, receipts and accounting become visible together. */
export function completeFablesJob(id: string, newRef: FablesPositionRef, facts: readonly FablesCycleFact[]): FablesStrategyConfig {
  const job = fablesJobById(id)
  if (!job || !['running','recovery'].includes(job.state) || job.stage !== 'verify')
    throw new Error('E_FABLES_JOB_STAGE')
  if (fablesJobTransactions(id).some(tx => tx.state === 'sending' || tx.state === 'sent'))
    throw new Error('E_FABLES_TX_UNRESOLVED')
  const at = now()
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.prepare(`SELECT config_json FROM fables_strategies WHERE id=?`).get(job.strategyId) as
      { config_json: string } | undefined
    if (!row) throw new Error('E_FABLES_STRATEGY_MISSING')
    const current = parseFablesStrategyConfig(JSON.parse(row.config_json), { requireAutoApproval: false })
    if (current.revision !== job.config.revision
      || current.positionRef.poolId.toLowerCase() !== job.config.positionRef.poolId.toLowerCase()
      || current.positionRef.rangeId !== job.config.positionRef.rangeId)
      throw new Error('E_FABLES_CONFIG_CHANGED')
    const next = parseFablesStrategyConfig({ ...current, positionRef: newRef,
      revision: current.revision + 1, updatedAt: at }, { requireAutoApproval: false })
    for (const fact of facts) appendFablesLedger({
      strategyId: job.strategyId, jobId: id, kind: fact.kind, token: fact.token,
      amount: fact.amount, txHash: fact.txHash, blockNumber: fact.blockNumber, meta: fact.meta,
    })
    db.prepare(`UPDATE fables_strategies SET config_json=?,pool_id=?,hook=?,range_id=?,state='monitoring',updated_at=? WHERE id=?`).run(
      JSON.stringify(next), newRef.poolId.toLowerCase(), newRef.hook.toLowerCase(), newRef.rangeId, at, job.strategyId,
    )
    db.prepare(`INSERT INTO fables_monitor_state(strategy_id,revision,cooldown_until,updated_at)
      VALUES(?,?,?,?) ON CONFLICT(strategy_id) DO UPDATE SET revision=excluded.revision,
        out_side=NULL,out_since=NULL,cooldown_until=excluded.cooldown_until,
        last_tick=NULL,last_block=NULL,error=NULL,updated_at=excluded.updated_at`).run(
      job.strategyId, next.revision, at + next.trigger.cooldownMinutes * 60, at,
    )
    db.prepare(`UPDATE fables_jobs SET state='completed',error_code=NULL,updated_at=? WHERE id=?`).run(at, id)
    db.exec('COMMIT')
    return next
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
