import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StrategyConfig } from '../shared/strategy/types'
import type { StrategyExecutionPlan } from '../shared/strategy/types'
import type { LedgerEntry } from '../shared/strategy/types'
import { parseStrategyConfig } from '../shared/strategy/schema'
import { EXECUTOR } from './config'

mkdirSync(dirname(EXECUTOR.dbPath), { recursive: true, mode: 0o700 })
export const db = new DatabaseSync(EXECUTOR.dbPath)
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL UNIQUE,
  vault_path TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS strategies (
  id TEXT PRIMARY KEY,
  wallet_id TEXT REFERENCES wallets(id),
  config_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'disabled',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES strategies(id),
  plan_json TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  recovery_attempts INTEGER NOT NULL DEFAULT 0,
  recovery_error_streak INTEGER NOT NULL DEFAULT 0,
  recovery_last_error TEXT,
  recovery_next_at INTEGER,
  recovery_quarantined_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_job_per_strategy ON jobs(strategy_id) WHERE state IN ('planned','running','recovery');
CREATE TABLE IF NOT EXISTS job_steps (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  step_index INTEGER NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  nonce TEXT,
  tx_hash TEXT,
  tx_to TEXT,
  calldata_hash TEXT,
  sent_at INTEGER,
  confirmed_at INTEGER,
  block_number TEXT,
  result_json TEXT,
  error_code TEXT,
  PRIMARY KEY(job_id, step_index)
);
CREATE TABLE IF NOT EXISTS job_transactions (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  step_index INTEGER NOT NULL,
  tx_index INTEGER NOT NULL,
  state TEXT NOT NULL,
  nonce TEXT,
  tx_hash TEXT,
  tx_to TEXT NOT NULL,
  calldata_hash TEXT NOT NULL,
  sent_at INTEGER,
  confirmed_at INTEGER,
  block_number TEXT,
  result_json TEXT,
  error_code TEXT,
  PRIMARY KEY(job_id, step_index, tx_index),
  UNIQUE(tx_hash)
);
CREATE TABLE IF NOT EXISTS allocations (
  strategy_id TEXT NOT NULL REFERENCES strategies(id),
  token TEXT NOT NULL,
  amount TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(strategy_id, token)
);
CREATE TABLE IF NOT EXISTS allocation_components (
  strategy_id TEXT NOT NULL REFERENCES strategies(id),
  token TEXT NOT NULL,
  principal_amount TEXT NOT NULL,
  held_fee_amount TEXT NOT NULL,
  held_profit_amount TEXT NOT NULL DEFAULT '0',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(strategy_id, token)
);
CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES strategies(id),
  cycle_id TEXT,
  job_id TEXT,
  ts INTEGER NOT NULL,
  block_number TEXT,
  tx_hash TEXT,
  kind TEXT NOT NULL,
  token TEXT,
  amount TEXT,
  quote_value TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS cycles (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES strategies(id),
  old_token_id TEXT,
  new_token_id TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  trigger_side TEXT,
  range_scale REAL NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  tx_hashes_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS daily_turnover_reservations (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  quote_token TEXT NOT NULL,
  utc_day INTEGER NOT NULL,
  amount TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(job_id, quote_token)
);
CREATE TABLE IF NOT EXISTS job_context (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  context_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(job_id, context_key)
);
CREATE TABLE IF NOT EXISTS monitor_state (
  strategy_id TEXT PRIMARY KEY REFERENCES strategies(id),
  revision INTEGER NOT NULL,
  out_side TEXT,
  out_since INTEGER,
  cooldown_until INTEGER,
  guard_reason TEXT,
  guard_stable_since INTEGER,
  burst_wait_until INTEGER,
  burst_reset_at INTEGER,
  last_tick INTEGER,
  last_liquidity TEXT,
  last_token_id TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS price_samples (
  strategy_id TEXT NOT NULL REFERENCES strategies(id),
  ts INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  block_number TEXT NOT NULL,
  PRIMARY KEY(strategy_id, ts)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS executor_flags (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS strategy_baselines (
  strategy_id TEXT PRIMARY KEY,
  value_quote_raw TEXT NOT NULL,
  value_usdg_raw TEXT,
  quote_token TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  block_number TEXT NOT NULL,
  token_id TEXT,
  tick INTEGER NOT NULL,
  source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS strategy_history (
  strategy_id TEXT PRIMARY KEY,
  archived_at INTEGER NOT NULL,
  asset_location TEXT NOT NULL,
  performance_json TEXT,
  FOREIGN KEY(strategy_id) REFERENCES strategies(id)
);
CREATE TABLE IF NOT EXISTS strategy_daily_snapshots (
  strategy_id TEXT NOT NULL,
  shanghai_day INTEGER NOT NULL,
  first_observed_at INTEGER NOT NULL,
  last_observed_at INTEGER NOT NULL,
  quote_token TEXT NOT NULL,
  quote_symbol TEXT NOT NULL,
  quote_decimals INTEGER NOT NULL,
  opening_pnl_raw TEXT,
  closing_pnl_raw TEXT,
  opening_pnl_usdg_raw TEXT,
  closing_pnl_usdg_raw TEXT,
  opening_fees_raw TEXT NOT NULL,
  closing_fees_raw TEXT NOT NULL,
  opening_gas_raw TEXT NOT NULL,
  closing_gas_raw TEXT NOT NULL,
  opening_execution_raw TEXT NOT NULL,
  closing_execution_raw TEXT NOT NULL,
  opening_assets_raw TEXT,
  closing_assets_raw TEXT,
  opening_reopens INTEGER NOT NULL,
  closing_reopens INTEGER NOT NULL,
  PRIMARY KEY(strategy_id,shanghai_day),
  FOREIGN KEY(strategy_id) REFERENCES strategies(id)
);
CREATE TABLE IF NOT EXISTS strategy_pnl_snapshots (
  strategy_id TEXT NOT NULL,
  bucket_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  quote_token TEXT NOT NULL,
  quote_symbol TEXT NOT NULL,
  quote_decimals INTEGER NOT NULL,
  pnl_raw TEXT,
  pnl_usdg_raw TEXT,
  PRIMARY KEY(strategy_id,bucket_at),
  FOREIGN KEY(strategy_id) REFERENCES strategies(id)
);
CREATE INDEX IF NOT EXISTS strategy_pnl_snapshots_by_time ON strategy_pnl_snapshots(bucket_at,strategy_id);
`)
const walletColumns = db.prepare('PRAGMA table_info(wallets)').all() as { name: string }[]
if (!walletColumns.some((column) => column.name === 'label'))
  db.exec("ALTER TABLE wallets ADD COLUMN label TEXT NOT NULL DEFAULT ''")
const baselineColumns = db.prepare('PRAGMA table_info(strategy_baselines)').all() as { name: string }[]
if (!baselineColumns.some((column) => column.name === 'value_usdg_raw'))
  db.exec('ALTER TABLE strategy_baselines ADD COLUMN value_usdg_raw TEXT')
const dailySnapshotColumns = db.prepare('PRAGMA table_info(strategy_daily_snapshots)').all() as { name: string }[]
if (!dailySnapshotColumns.some((column) => column.name === 'opening_pnl_usdg_raw'))
  db.exec('ALTER TABLE strategy_daily_snapshots ADD COLUMN opening_pnl_usdg_raw TEXT')
if (!dailySnapshotColumns.some((column) => column.name === 'closing_pnl_usdg_raw'))
  db.exec('ALTER TABLE strategy_daily_snapshots ADD COLUMN closing_pnl_usdg_raw TEXT')
db.exec(`INSERT OR IGNORE INTO strategy_pnl_snapshots(strategy_id,bucket_at,observed_at,quote_token,quote_symbol,quote_decimals,pnl_raw,pnl_usdg_raw)
  SELECT strategy_id,(last_observed_at / 300) * 300,last_observed_at,quote_token,quote_symbol,quote_decimals,closing_pnl_raw,closing_pnl_usdg_raw
  FROM strategy_daily_snapshots`)
const monitorColumns = db.prepare('PRAGMA table_info(monitor_state)').all() as { name: string }[]
if (!monitorColumns.some((column) => column.name === 'guard_reason'))
  db.exec('ALTER TABLE monitor_state ADD COLUMN guard_reason TEXT')
if (!monitorColumns.some((column) => column.name === 'guard_stable_since'))
  db.exec('ALTER TABLE monitor_state ADD COLUMN guard_stable_since INTEGER')
if (!monitorColumns.some((column) => column.name === 'burst_wait_until'))
  db.exec('ALTER TABLE monitor_state ADD COLUMN burst_wait_until INTEGER')
if (!monitorColumns.some((column) => column.name === 'burst_reset_at'))
  db.exec('ALTER TABLE monitor_state ADD COLUMN burst_reset_at INTEGER')
if (!monitorColumns.some((column) => column.name === 'econ_wait_until'))
  db.exec('ALTER TABLE monitor_state ADD COLUMN econ_wait_until INTEGER')
if (!monitorColumns.some((column) => column.name === 'econ_fees_quote'))
  db.exec('ALTER TABLE monitor_state ADD COLUMN econ_fees_quote TEXT')
if (!monitorColumns.some((column) => column.name === 'econ_cost_quote'))
  db.exec('ALTER TABLE monitor_state ADD COLUMN econ_cost_quote TEXT')
const allocationComponentColumns = db.prepare('PRAGMA table_info(allocation_components)').all() as { name: string }[]
if (!allocationComponentColumns.some((column) => column.name === 'held_profit_amount'))
  db.exec("ALTER TABLE allocation_components ADD COLUMN held_profit_amount TEXT NOT NULL DEFAULT '0'")
const cycleColumns = db.prepare('PRAGMA table_info(cycles)').all() as { name: string }[]
if (!cycleColumns.some((column) => column.name === 'range_scale'))
  db.exec('ALTER TABLE cycles ADD COLUMN range_scale REAL NOT NULL DEFAULT 1')
const jobColumns = db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]
if (!jobColumns.some((column) => column.name === 'recovery_attempts'))
  db.exec('ALTER TABLE jobs ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0')
if (!jobColumns.some((column) => column.name === 'recovery_error_streak'))
  db.exec('ALTER TABLE jobs ADD COLUMN recovery_error_streak INTEGER NOT NULL DEFAULT 0')
if (!jobColumns.some((column) => column.name === 'recovery_last_error'))
  db.exec('ALTER TABLE jobs ADD COLUMN recovery_last_error TEXT')
if (!jobColumns.some((column) => column.name === 'recovery_next_at'))
  db.exec('ALTER TABLE jobs ADD COLUMN recovery_next_at INTEGER')
if (!jobColumns.some((column) => column.name === 'recovery_quarantined_at'))
  db.exec('ALTER TABLE jobs ADD COLUMN recovery_quarantined_at INTEGER')
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')

const ts = () => Math.floor(Date.now() / 1000)

export function executorPaused(): boolean {
  const row = db.prepare(`SELECT value FROM executor_flags WHERE key='paused'`).get() as { value: string } | undefined
  return row?.value === '1'
}

export function setExecutorPaused(paused: boolean) {
  db.prepare(`INSERT INTO executor_flags(key,value,updated_at) VALUES('paused',?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(paused ? '1' : '0', ts())
  audit('api', paused ? 'executor_paused' : 'executor_resumed', 'executor')
}
export type StoredWallet = { id: string; label: string; address: string; vaultPath: string; createdAt: number; updatedAt: number }

export function addWallet(wallet: StoredWallet) {
  db.prepare('INSERT INTO wallets(id,label,address,vault_path,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(
    wallet.id,
    wallet.label,
    wallet.address.toLowerCase(),
    wallet.vaultPath,
    wallet.createdAt,
    wallet.updatedAt,
  )
}
export function listWallets(): Omit<StoredWallet, 'vaultPath'>[] {
  return (db.prepare('SELECT id,label,address,created_at,updated_at FROM wallets ORDER BY created_at').all() as any[]).map((r, index) => ({
    id: r.id,
    label: r.label || `Account ${index + 1}`,
    address: r.address,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
}
export function walletById(id: string): StoredWallet | undefined {
  const r = db.prepare('SELECT id,label,address,vault_path,created_at,updated_at FROM wallets WHERE id=?').get(id) as any
  return r && { id: r.id, label: r.label || 'Account', address: r.address, vaultPath: r.vault_path, createdAt: r.created_at, updatedAt: r.updated_at }
}
export function walletByAddress(address: string): StoredWallet | undefined {
  const r = db.prepare('SELECT id,label,address,vault_path,created_at,updated_at FROM wallets WHERE address=?').get(address.toLowerCase()) as any
  return r && { id: r.id, label: r.label || 'Account', address: r.address, vaultPath: r.vault_path, createdAt: r.created_at, updatedAt: r.updated_at }
}
export function updateWalletLabel(id: string, label: string): boolean {
  const result = db.prepare('UPDATE wallets SET label=?,updated_at=? WHERE id=?').run(label, ts(), id)
  return result.changes === 1
}
export function upsertStrategy(config: StrategyConfig) {
  const now = ts()
  db.prepare(`INSERT INTO strategies(id,wallet_id,config_json,state,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET wallet_id=excluded.wallet_id,config_json=excluded.config_json,state=excluded.state,updated_at=excluded.updated_at`).run(
    config.id,
    config.execution.walletId ?? null,
    JSON.stringify(config),
    config.enabled ? 'monitoring' : 'disabled',
    now,
  )
}

export type StrategyBaseline = {
  strategyId: string
  valueQuoteRaw: string
  valueUsdgRaw?: string
  quoteToken: string
  observedAt: number
  blockNumber: string
  tokenId: string | null
  tick: number
  source: 'strategy_start' | 'baseline_backfill'
}

/** Immutable P/L origin. Rebalances update the NFT, never this row. */
export function strategyBaseline(strategyId: string): StrategyBaseline | undefined {
  const row = db.prepare(`SELECT strategy_id,value_quote_raw,value_usdg_raw,quote_token,observed_at,block_number,token_id,tick,source
    FROM strategy_baselines WHERE strategy_id=?`).get(strategyId) as Record<string, unknown> | undefined
  return row && {
    strategyId: String(row.strategy_id),
    valueQuoteRaw: String(row.value_quote_raw),
    valueUsdgRaw: row.value_usdg_raw === null ? undefined : String(row.value_usdg_raw),
    quoteToken: String(row.quote_token),
    observedAt: Number(row.observed_at),
    blockNumber: String(row.block_number),
    tokenId: row.token_id === null ? null : String(row.token_id),
    tick: Number(row.tick),
    source: row.source === 'baseline_backfill' ? 'baseline_backfill' : 'strategy_start',
  }
}

export function setStrategyBaselineIfAbsent(baseline: StrategyBaseline): boolean {
  const result = db.prepare(`INSERT OR IGNORE INTO strategy_baselines(strategy_id,value_quote_raw,value_usdg_raw,quote_token,observed_at,block_number,token_id,tick,source)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(
    baseline.strategyId,
    baseline.valueQuoteRaw,
    baseline.valueUsdgRaw ?? null,
    baseline.quoteToken.toLowerCase(),
    baseline.observedAt,
    baseline.blockNumber,
    baseline.tokenId,
    baseline.tick,
    baseline.source,
  )
  if (Number(result.changes) > 0) audit('executor', 'strategy_baseline_recorded', 'strategy', baseline.strategyId, {
    valueQuoteRaw: baseline.valueQuoteRaw,
    valueUsdgRaw: baseline.valueUsdgRaw ?? null,
    quoteToken: baseline.quoteToken,
    blockNumber: baseline.blockNumber,
    tokenId: baseline.tokenId,
    source: baseline.source,
  })
  return Number(result.changes) > 0
}

/** Backfill a legacy baseline once its historical USDG mark is proven. */
export function setStrategyBaselineUsdgIfAbsent(strategyId: string, valueUsdgRaw: string): boolean {
  const result = db.prepare('UPDATE strategy_baselines SET value_usdg_raw=? WHERE strategy_id=? AND value_usdg_raw IS NULL').run(valueUsdgRaw, strategyId)
  if (Number(result.changes) > 0) audit('accounting', 'strategy_baseline_usdg_backfilled', 'strategy', strategyId, { valueUsdgRaw })
  return Number(result.changes) > 0
}

/** Rebase only when the strategy's accounting quote token itself changes. */
export function replaceStrategyBaselineQuote(baseline: StrategyBaseline) {
  const previous = strategyBaseline(baseline.strategyId)
  if (!previous || previous.quoteToken.toLowerCase() === baseline.quoteToken.toLowerCase()) return false
  db.prepare(`UPDATE strategy_baselines SET value_quote_raw=?,value_usdg_raw=?,quote_token=?,observed_at=?,block_number=?,token_id=?,tick=?,source=? WHERE strategy_id=?`).run(
    baseline.valueQuoteRaw,
    baseline.valueUsdgRaw ?? null,
    baseline.quoteToken.toLowerCase(),
    baseline.observedAt,
    baseline.blockNumber,
    baseline.tokenId,
    baseline.tick,
    baseline.source,
    baseline.strategyId,
  )
  audit('accounting', 'strategy_baseline_quote_rebased', 'strategy', baseline.strategyId, {
    previousQuoteToken: previous.quoteToken,
    quoteToken: baseline.quoteToken,
    valueQuoteRaw: baseline.valueQuoteRaw,
  })
  return true
}

export type StrategyDailyPoint = {
  strategyId: string; observedAt: number; day: number
  quoteToken: string; quoteSymbol: string; quoteDecimals: number
  pnlRaw: string | null; pnlUsdgRaw: string | null; feesRaw: string; gasRaw: string; executionRaw: string; assetsRaw: string | null; reopens: number
}

/** First value is immutable for the day; latest value advances monotonically in time. */
export function recordStrategyDailyPoint(point: StrategyDailyPoint) {
  db.prepare(`INSERT INTO strategy_daily_snapshots(strategy_id,shanghai_day,first_observed_at,last_observed_at,quote_token,quote_symbol,quote_decimals,
    opening_pnl_raw,closing_pnl_raw,opening_pnl_usdg_raw,closing_pnl_usdg_raw,opening_fees_raw,closing_fees_raw,opening_gas_raw,closing_gas_raw,opening_execution_raw,closing_execution_raw,
    opening_assets_raw,closing_assets_raw,opening_reopens,closing_reopens)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(strategy_id,shanghai_day) DO UPDATE SET
      last_observed_at=excluded.last_observed_at,closing_pnl_raw=excluded.closing_pnl_raw,closing_pnl_usdg_raw=excluded.closing_pnl_usdg_raw,closing_fees_raw=excluded.closing_fees_raw,
      closing_gas_raw=excluded.closing_gas_raw,closing_execution_raw=excluded.closing_execution_raw,closing_assets_raw=excluded.closing_assets_raw,
      closing_reopens=excluded.closing_reopens
    WHERE excluded.last_observed_at>=strategy_daily_snapshots.last_observed_at`).run(
    point.strategyId, point.day, point.observedAt, point.observedAt, point.quoteToken.toLowerCase(), point.quoteSymbol, point.quoteDecimals,
    point.pnlRaw, point.pnlRaw, point.pnlUsdgRaw, point.pnlUsdgRaw, point.feesRaw, point.feesRaw, point.gasRaw, point.gasRaw, point.executionRaw, point.executionRaw,
    point.assetsRaw, point.assetsRaw, point.reopens, point.reopens,
  )
}

const PNL_SNAPSHOT_SECONDS = 5 * 60
const PNL_SNAPSHOT_RETENTION_SECONDS = 90 * 24 * 60 * 60

/** Keep the latest valuation observed inside each five-minute UTC bucket. */
export function recordStrategyPnlSnapshot(point: StrategyDailyPoint) {
  const bucketAt = Math.floor(point.observedAt / PNL_SNAPSHOT_SECONDS) * PNL_SNAPSHOT_SECONDS
  db.prepare(`INSERT INTO strategy_pnl_snapshots(strategy_id,bucket_at,observed_at,quote_token,quote_symbol,quote_decimals,pnl_raw,pnl_usdg_raw)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(strategy_id,bucket_at) DO UPDATE SET
      observed_at=excluded.observed_at,quote_token=excluded.quote_token,quote_symbol=excluded.quote_symbol,quote_decimals=excluded.quote_decimals,
      pnl_raw=excluded.pnl_raw,pnl_usdg_raw=excluded.pnl_usdg_raw
    WHERE excluded.observed_at>=strategy_pnl_snapshots.observed_at`).run(
    point.strategyId, bucketAt, point.observedAt, point.quoteToken.toLowerCase(), point.quoteSymbol, point.quoteDecimals, point.pnlRaw, point.pnlUsdgRaw,
  )
  db.prepare('DELETE FROM strategy_pnl_snapshots WHERE strategy_id=? AND bucket_at<?').run(
    point.strategyId, bucketAt - PNL_SNAPSHOT_RETENTION_SECONDS,
  )
}

export function strategyPnlSnapshots(from: number, to: number) {
  return db.prepare(`SELECT strategy_id,bucket_at,observed_at,quote_token,quote_symbol,quote_decimals,pnl_raw,pnl_usdg_raw
    FROM strategy_pnl_snapshots WHERE bucket_at>=? AND bucket_at<=? ORDER BY bucket_at,strategy_id`).all(from, to) as Record<string, unknown>[]
}

export function strategyDailySnapshots(fromDay?: number, toDay?: number) {
  const where = fromDay === undefined ? '' : 'WHERE d.shanghai_day>=? AND d.shanghai_day<=?'
  const args = fromDay === undefined ? [] : [fromDay, toDay ?? fromDay]
  return db.prepare(`SELECT d.*,s.config_json,s.state FROM strategy_daily_snapshots d JOIN strategies s ON s.id=d.strategy_id ${where}
    ORDER BY d.shanghai_day,d.strategy_id`).all(...args) as Record<string, unknown>[]
}
export function listStrategies(): { config: StrategyConfig; state: string; updatedAt: number }[] {
  return (db.prepare(`SELECT config_json,state,updated_at FROM strategies WHERE state!='archived'`).all() as any[]).map((r) => ({
    config: parseStrategyConfig(JSON.parse(r.config_json)),
    state: r.state,
    updatedAt: r.updated_at,
  })).sort((a, b) => b.config.createdAt - a.config.createdAt || a.config.id.localeCompare(b.config.id))
}
export function listArchivedStrategies(): { config: StrategyConfig; state: 'archived'; updatedAt: number; archivedAt: number; assetLocation: string; performance?: unknown }[] {
  return (db.prepare(`SELECT s.config_json,s.updated_at,h.archived_at,h.asset_location,h.performance_json
    FROM strategies s LEFT JOIN strategy_history h ON h.strategy_id=s.id
    WHERE s.state='archived' ORDER BY COALESCE(h.archived_at,s.updated_at) DESC,s.id`).all() as any[]).map((r) => ({
    config: parseStrategyConfig(JSON.parse(r.config_json)),
    state: 'archived' as const,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at ?? r.updated_at,
    assetLocation: r.asset_location ?? 'unknown',
    performance: r.performance_json ? JSON.parse(r.performance_json) : undefined,
  }))
}
export function strategyById(id: string): { config: StrategyConfig; state: string; updatedAt: number } | undefined {
  return listStrategies().find((row) => row.config.id === id)
}

export function activeJobForStrategy(strategyId: string): { id: string; state: string } | undefined {
  return db.prepare(`SELECT id,state FROM jobs WHERE strategy_id=? AND state IN ('planned','running','recovery') ORDER BY created_at DESC,id DESC LIMIT 1`).get(strategyId) as { id: string; state: string } | undefined
}

/** Only an uncertain in-flight transaction may temporarily serialize a wallet. */
export function walletHasUnfinishedMutation(walletId: string): boolean {
  const row = db.prepare(`SELECT 1 FROM jobs j JOIN strategies s ON s.id=j.strategy_id
    WHERE s.wallet_id=? AND j.state='recovery'
      AND EXISTS (SELECT 1 FROM job_transactions t WHERE t.job_id=j.id AND t.state IN ('sending','sent'))
    LIMIT 1`).get(walletId)
  return row !== undefined
}

/** Archive automation and its open local job without deleting audit/history. */
export function archiveStrategy(args: { strategyId: string; jobId?: string; allocations?: Record<string, bigint>; assetLocation?: string; performance?: unknown }) {
  const now = ts()
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.prepare('SELECT config_json FROM strategies WHERE id=?').get(args.strategyId) as { config_json: string } | undefined
    if (!row) throw new Error('E_STRATEGY_MISSING')
    const current = parseStrategyConfig(JSON.parse(row.config_json))
    const archived = { ...current, enabled: false, revision: current.revision + 1, updatedAt: now }
    if (args.jobId) {
      const job = db.prepare(`SELECT state FROM jobs WHERE id=? AND strategy_id=?`).get(args.jobId, args.strategyId) as { state: string } | undefined
      if (!job || !['planned', 'recovery'].includes(job.state)) throw new Error('E_STRATEGY_BUSY')
      db.prepare(`UPDATE jobs SET state='cancelled',updated_at=? WHERE id=?`).run(now, args.jobId)
      db.prepare(`UPDATE job_steps SET state='failed',error_code='E_USER_STOPPED' WHERE job_id=? AND state='pending'`).run(args.jobId)
      db.prepare(`UPDATE daily_turnover_reservations SET state='released',updated_at=? WHERE job_id=? AND state='reserved'`).run(now, args.jobId)
    }
    if (args.allocations) {
      const setAllocation = db.prepare(`INSERT INTO allocations(strategy_id,token,amount,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(strategy_id,token) DO UPDATE SET amount=excluded.amount,updated_at=excluded.updated_at`)
      for (const [token, amount] of Object.entries(args.allocations)) setAllocation.run(args.strategyId, token.toLowerCase(), amount.toString(), now)
    }
    db.prepare(`UPDATE strategies SET config_json=?,state='archived',updated_at=? WHERE id=?`).run(JSON.stringify(archived), now, args.strategyId)
    db.prepare(`INSERT INTO strategy_history(strategy_id,archived_at,asset_location,performance_json) VALUES(?,?,?,?)
      ON CONFLICT(strategy_id) DO UPDATE SET archived_at=excluded.archived_at,asset_location=excluded.asset_location,
        performance_json=COALESCE(strategy_history.performance_json,excluded.performance_json)`).run(
      args.strategyId,
      now,
      args.assetLocation ?? 'unknown',
      args.performance === undefined ? null : JSON.stringify(args.performance),
    )
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  audit('api', 'strategy_archived', 'strategy', args.strategyId, { jobId: args.jobId ?? null, assetLocation: args.assetLocation ?? 'unknown', preservedHistory: true })
}
export function enabledExecutorStrategies(): { config: StrategyConfig; state: string }[] {
  return listStrategies().filter((row) => row.config.enabled
    && row.config.execution.mode === 'executor_auto'
    && ['monitoring', 'guard_wait', 'paused_guard', 'awaiting_manual'].includes(row.state))
}
export function setStrategyState(id: string, state: string) {
  db.prepare('UPDATE strategies SET state=?,updated_at=? WHERE id=? AND state!=?').run(state, ts(), id, state)
}
export function createPlannedJob(plan: StrategyExecutionPlan): boolean {
  try {
    const now = ts()
    db.exec('BEGIN IMMEDIATE')
    try {
      const strategy = db.prepare('SELECT wallet_id FROM strategies WHERE id=?').get(plan.strategyId) as { wallet_id: string | null } | undefined
      if (!strategy?.wallet_id) throw new Error('E_WALLET')
      const recovery = db.prepare(`SELECT 1 FROM jobs j JOIN strategies s ON s.id=j.strategy_id
        WHERE s.wallet_id=? AND j.state='recovery'
          AND EXISTS (SELECT 1 FROM job_transactions t WHERE t.job_id=j.id AND t.state IN ('sending','sent'))
        LIMIT 1`).get(strategy.wallet_id)
      if (recovery) throw new Error('E_WALLET_RECOVERY')
      db.prepare('INSERT INTO jobs(id,strategy_id,plan_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(
      plan.id,
      plan.strategyId,
      JSON.stringify(plan),
      'planned',
      now,
      now,
    )
      const insert = db.prepare('INSERT INTO job_steps(job_id,step_index,kind,state) VALUES(?,?,?,?)')
      for (const step of plan.steps) insert.run(plan.id, step.index, step.kind, 'pending')
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return true
  } catch (error: any) {
    const message = String(error?.message)
    if (message.includes('UNIQUE constraint failed') || message.includes('E_WALLET_RECOVERY')) return false
    throw error
  }
}

export type ProfitWithdrawalTarget = 'USDG' | 'WETH' | 'ETH'

/** Create a synchronous signer job that is invisible to the rebalance runner. */
export function createProfitWithdrawalJob(args: {
  id: string
  strategyId: string
  target: ProfitWithdrawalTarget
  steps: { index: number; kind: string }[]
}): boolean {
  try {
    const now = ts()
    db.exec('BEGIN IMMEDIATE')
    try {
      const strategy = db.prepare('SELECT wallet_id FROM strategies WHERE id=?').get(args.strategyId) as { wallet_id: string | null } | undefined
      if (!strategy?.wallet_id) throw new Error('E_WALLET')
      const recovery = db.prepare(`SELECT 1 FROM jobs j JOIN strategies s ON s.id=j.strategy_id
        WHERE s.wallet_id=? AND j.state='recovery'
          AND EXISTS (SELECT 1 FROM job_transactions t WHERE t.job_id=j.id AND t.state IN ('sending','sent'))
        LIMIT 1`).get(strategy.wallet_id)
      if (recovery) throw new Error('E_WALLET_RECOVERY')
      db.prepare('INSERT INTO jobs(id,strategy_id,plan_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(
        args.id, args.strategyId, JSON.stringify({ kind: 'profit_withdrawal', strategyId: args.strategyId, target: args.target }), 'running', now, now,
      )
      const insert = db.prepare('INSERT INTO job_steps(job_id,step_index,kind,state) VALUES(?,?,?,?)')
      for (const step of args.steps) insert.run(args.id, step.index, step.kind, 'pending')
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return true
  } catch (error: any) {
    const message = String(error?.message)
    if (message.includes('UNIQUE constraint failed') || message.includes('E_WALLET_RECOVERY')) return false
    throw error
  }
}

export function completeProfitWithdrawalJob(jobId: string, result: Record<string, unknown>) {
  const now = ts()
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`UPDATE job_steps SET state='confirmed',confirmed_at=?,result_json=?,error_code=NULL WHERE job_id=? AND step_index=11`).run(now, JSON.stringify(result), jobId)
    const row = db.prepare(`SELECT strategy_id FROM jobs WHERE id=? AND state IN ('running','recovery')`).get(jobId) as { strategy_id: string } | undefined
    if (!row) throw new Error('E_PROFIT_WITHDRAWAL_JOB')
    db.prepare(`UPDATE jobs SET state='completed',updated_at=?,recovery_last_error=NULL,recovery_next_at=NULL,recovery_quarantined_at=NULL WHERE id=?`).run(now, jobId)
    db.prepare(`UPDATE strategies SET state='monitoring',updated_at=? WHERE id=? AND state IN ('executing','recovery','recovery_quarantined')`).run(now, row.strategy_id)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** A pending/unknown broadcast remains a recovery lock; proven failures don't. */
export function failProfitWithdrawalJob(jobId: string, code: string) {
  const unfinished = db.prepare(`SELECT 1 FROM job_transactions WHERE job_id=? AND state IN ('sending','sent') LIMIT 1`).get(jobId)
  const confirmedMutation = db.prepare(`SELECT 1 FROM job_steps WHERE job_id=? AND kind IN ('profit_swap','profit_unwrap') AND state='confirmed' LIMIT 1`).get(jobId)
  const state = unfinished || confirmedMutation ? 'recovery' : 'failed'
  const now = ts()
  db.prepare(`UPDATE jobs SET state=?,updated_at=?,recovery_last_error=? WHERE id=?`).run(state, now, code, jobId)
  db.prepare(`UPDATE job_steps SET state='failed',error_code=? WHERE job_id=? AND state='pending'`).run(code, jobId)
  if (state === 'recovery') db.prepare(`UPDATE strategies SET state='recovery',updated_at=? WHERE id=(SELECT strategy_id FROM jobs WHERE id=?)`).run(now, jobId)
  return state as 'recovery' | 'failed'
}

export function abandonProfitWithdrawalJob(jobId: string, code = 'E_PROFIT_WITHDRAWAL_RETRY') {
  const now = ts()
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.prepare(`SELECT strategy_id FROM jobs WHERE id=? AND state IN ('running','recovery')`).get(jobId) as { strategy_id: string } | undefined
    if (!row) throw new Error('E_PROFIT_WITHDRAWAL_JOB')
    db.prepare(`UPDATE jobs SET state='failed',updated_at=?,recovery_last_error=?,recovery_next_at=NULL,recovery_quarantined_at=NULL WHERE id=?`).run(now, code, jobId)
    db.prepare(`UPDATE strategies SET state='monitoring',updated_at=? WHERE id=? AND state IN ('executing','recovery','recovery_quarantined')`).run(now, row.strategy_id)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
export type RunnableJob = { id: string; plan: StrategyExecutionPlan; config: StrategyConfig; walletId: string }
export function runnableJobs(): RunnableJob[] {
  return (db.prepare(`SELECT j.id,j.plan_json,s.config_json,s.wallet_id FROM jobs j JOIN strategies s ON s.id=j.strategy_id
    WHERE j.state='planned' AND s.state='planned' ORDER BY j.created_at ASC`).all() as any[]).flatMap((r) => {
    try {
      const config = parseStrategyConfig(JSON.parse(r.config_json))
      if (!r.wallet_id || !config.execution.walletId || r.wallet_id !== config.execution.walletId) return []
      return [{ id: r.id, plan: JSON.parse(r.plan_json) as StrategyExecutionPlan, config, walletId: r.wallet_id }]
    } catch {
      return []
    }
  })
}
export function setJobState(id: string, state: 'planned' | 'running' | 'recovery' | 'completed' | 'failed') {
  db.prepare('UPDATE jobs SET state=?,updated_at=? WHERE id=?').run(state, ts(), id)
}
export function quarantineInterruptedJobs(): number {
  const now = ts()
  db.exec('BEGIN IMMEDIATE')
  try {
    const rows = db.prepare(`SELECT id,strategy_id FROM jobs WHERE state='running'`).all() as { id: string; strategy_id: string }[]
    const setJob = db.prepare(`UPDATE jobs SET state='recovery',updated_at=? WHERE id=?`)
    const setStrategy = db.prepare(`UPDATE strategies SET state='recovery',updated_at=? WHERE id=?`)
    for (const row of rows) {
      setJob.run(now, row.id)
      setStrategy.run(now, row.strategy_id)
    }
    db.exec('COMMIT')
    return rows.length
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
export function markStep(args: { jobId: string; index: number; state: 'pending' | 'sending' | 'sent' | 'confirmed' | 'failed'; nonce?: bigint; txHash?: string; txTo?: string; calldataHash?: string; blockNumber?: bigint; result?: unknown; errorCode?: string }) {
  db.prepare(`UPDATE job_steps SET state=?,nonce=COALESCE(?,nonce),tx_hash=COALESCE(?,tx_hash),tx_to=COALESCE(?,tx_to),calldata_hash=COALESCE(?,calldata_hash),
    sent_at=CASE WHEN ?='sent' THEN ? ELSE sent_at END,confirmed_at=CASE WHEN ?='confirmed' THEN ? ELSE confirmed_at END,block_number=COALESCE(?,block_number),result_json=COALESCE(?,result_json),
    error_code=CASE WHEN ?='failed' THEN COALESCE(?,error_code) ELSE NULL END WHERE job_id=? AND step_index=?`).run(
    args.state, args.nonce?.toString() ?? null, args.txHash ?? null, args.txTo ?? null, args.calldataHash ?? null, args.state, ts(), args.state, ts(), args.blockNumber?.toString() ?? null, args.result === undefined ? null : JSON.stringify(args.result), args.state, args.errorCode ?? null, args.jobId, args.index,
  )
}
export function markTransaction(args: { jobId: string; stepIndex: number; txIndex: number; state: 'sending' | 'sent' | 'confirmed' | 'failed'; nonce?: bigint; txHash?: string; txTo: string; calldataHash: string; blockNumber?: bigint; result?: unknown; errorCode?: string }) {
  const now = ts()
  db.prepare(`INSERT INTO job_transactions(job_id,step_index,tx_index,state,nonce,tx_hash,tx_to,calldata_hash,sent_at,confirmed_at,block_number,result_json,error_code)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(job_id,step_index,tx_index) DO UPDATE SET state=excluded.state,nonce=COALESCE(excluded.nonce,nonce),tx_hash=COALESCE(excluded.tx_hash,tx_hash),
      tx_to=excluded.tx_to,calldata_hash=excluded.calldata_hash,sent_at=COALESCE(excluded.sent_at,sent_at),confirmed_at=COALESCE(excluded.confirmed_at,confirmed_at),
      block_number=COALESCE(excluded.block_number,block_number),result_json=COALESCE(excluded.result_json,result_json),
      error_code=CASE WHEN excluded.state='failed' THEN COALESCE(excluded.error_code,job_transactions.error_code) ELSE NULL END`).run(
    args.jobId, args.stepIndex, args.txIndex, args.state, args.nonce?.toString() ?? null, args.txHash ?? null, args.txTo, args.calldataHash,
    args.state === 'sent' ? now : null, args.state === 'confirmed' ? now : null, args.blockNumber?.toString() ?? null,
    args.result === undefined ? null : JSON.stringify(args.result), args.errorCode ?? null,
  )
}
export function setJobContext(jobId: string, key: string, value: unknown) {
  db.prepare(`INSERT INTO job_context(job_id,context_key,value_json,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(job_id,context_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(jobId, key, JSON.stringify(value), ts())
}
export function getJobContext<T>(jobId: string, key: string): T | undefined {
  const row = db.prepare('SELECT value_json FROM job_context WHERE job_id=? AND context_key=?').get(jobId, key) as { value_json: string } | undefined
  return row ? JSON.parse(row.value_json) as T : undefined
}
export function appendLedger(entries: LedgerEntry[]) {
  if (!entries.length) return
  db.exec('BEGIN IMMEDIATE')
  try {
    const insert = db.prepare(`INSERT OR IGNORE INTO ledger_entries(id,strategy_id,cycle_id,job_id,ts,block_number,tx_hash,kind,token,amount,quote_value,meta_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    for (const entry of entries) {
      insert.run(entry.id, entry.strategyId, entry.cycleId ?? null, entry.jobId ?? null, entry.ts, entry.blockNumber ?? null, entry.txHash ?? null, entry.kind, entry.token ?? null, entry.amount ?? null, entry.quoteValue ?? null, JSON.stringify({ ...(entry.meta ?? {}), estimated: entry.estimated === true }))
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
export function strategyAllocations(strategyId: string): Record<string, bigint> {
  const rows = db.prepare('SELECT token,amount FROM allocations WHERE strategy_id=?').all(strategyId) as { token: string; amount: string }[]
  return Object.fromEntries(rows.map((row) => [row.token, BigInt(row.amount)]))
}

export type AllocationComponent = { principal: bigint; heldFee: bigint; heldProfit: bigint }

const sameAllocationComponent = (a: AllocationComponent | undefined, b: AllocationComponent | undefined) =>
  Boolean(a && b && a.principal === b.principal && a.heldFee === b.heldFee && a.heldProfit === b.heldProfit)

/**
 * Split idle strategy assets into principal that should be redeployed and
 * realized fees that should remain parked. Legacy unclassified balances fail
 * closed as held assets instead of being spent automatically.
 */
export function strategyAllocationComponents(strategyId: string): Record<string, AllocationComponent> {
  const totals = strategyAllocations(strategyId)
  const rows = db.prepare('SELECT token,principal_amount,held_fee_amount,held_profit_amount FROM allocation_components WHERE strategy_id=?').all(strategyId) as {
    token: string; principal_amount: string; held_fee_amount: string; held_profit_amount: string
  }[]
  const stored = Object.fromEntries(rows.map((row) => [row.token.toLowerCase(), { principal: BigInt(row.principal_amount), heldFee: BigInt(row.held_fee_amount), heldProfit: BigInt(row.held_profit_amount) }]))
  return Object.fromEntries(Object.entries(totals).map(([token, total]) => {
    const component = stored[token]
    return [token, component && component.principal >= 0n && component.heldFee >= 0n && component.heldProfit >= 0n && component.principal + component.heldFee + component.heldProfit === total
      ? component
      : { principal: 0n, heldFee: total, heldProfit: 0n }]
  }))
}

/** Reclassify already-realized idle income for deployment on the next cycle. */
export function compoundHeldAllocations(strategyId: string) {
  const rows = db.prepare('SELECT token,principal_amount,held_fee_amount,held_profit_amount FROM allocation_components WHERE strategy_id=?').all(strategyId) as {
    token: string; principal_amount: string; held_fee_amount: string; held_profit_amount: string
  }[]
  const now = ts()
  db.exec('BEGIN IMMEDIATE')
  try {
    const update = db.prepare('UPDATE allocation_components SET principal_amount=?,held_fee_amount=?,updated_at=? WHERE strategy_id=? AND token=?')
    for (const row of rows) update.run((BigInt(row.principal_amount) + BigInt(row.held_fee_amount)).toString(), '0', now, strategyId, row.token)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  audit('accounting', 'held_income_marked_for_compounding', 'strategy', strategyId, {
    tokens: rows.filter((row) => BigInt(row.held_fee_amount) > 0n).map((row) => row.token),
  })
}

function setAllocationComponents(strategyId: string, components: Record<string, AllocationComponent>, now: number) {
  const set = db.prepare(`INSERT INTO allocation_components(strategy_id,token,principal_amount,held_fee_amount,held_profit_amount,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(strategy_id,token) DO UPDATE SET principal_amount=excluded.principal_amount,held_fee_amount=excluded.held_fee_amount,held_profit_amount=excluded.held_profit_amount,updated_at=excluded.updated_at`)
  for (const [token, component] of Object.entries(components)) {
    if (component.principal < 0n || component.heldFee < 0n || component.heldProfit < 0n) throw new Error('E_ALLOCATION_MISMATCH')
    set.run(strategyId, token.toLowerCase(), component.principal.toString(), component.heldFee.toString(), component.heldProfit.toString(), now)
  }
}

export function walletAllocationTokens(walletId: string): string[] {
  return (db.prepare(`SELECT DISTINCT a.token FROM allocations a JOIN strategies s ON s.id=a.strategy_id WHERE s.wallet_id=? AND s.state!='archived' ORDER BY a.token`).all(walletId) as { token: string }[])
    .map((row) => row.token.toLowerCase())
}

export function assertWalletAllocations(walletId: string, balances: Record<string, bigint>) {
  const rows = db.prepare(`SELECT a.token,a.amount FROM allocations a JOIN strategies s ON s.id=a.strategy_id WHERE s.wallet_id=? AND s.state!='archived'`).all(walletId) as { token: string; amount: string }[]
  const totals: Record<string, bigint> = {}
  for (const row of rows) totals[row.token] = (totals[row.token] ?? 0n) + BigInt(row.amount)
  for (const [token, total] of Object.entries(totals)) {
    if (total > (balances[token.toLowerCase()] ?? 0n)) throw new Error('E_ALLOCATION_MISMATCH')
  }
}

/**
 * Prove that the wallet can cover an atomic allocation update without
 * attributing unrelated wallet balance changes to the strategy being updated.
 */
export function assertWalletAllocationUpdate(
  walletId: string,
  strategyId: string,
  balances: Record<string, bigint>,
  nextAllocations: Record<string, bigint>,
) {
  const rows = db.prepare(`SELECT s.id AS strategy_id,a.token,a.amount FROM allocations a JOIN strategies s ON s.id=a.strategy_id WHERE s.wallet_id=? AND s.state!='archived'`).all(walletId) as {
    strategy_id: string; token: string; amount: string
  }[]
  const totals: Record<string, bigint> = {}
  const current: Record<string, bigint> = {}
  for (const row of rows) {
    const token = row.token.toLowerCase()
    const amount = BigInt(row.amount)
    totals[token] = (totals[token] ?? 0n) + amount
    if (row.strategy_id === strategyId) current[token] = (current[token] ?? 0n) + amount
  }
  for (const [rawToken, amount] of Object.entries(nextAllocations)) {
    const token = rawToken.toLowerCase()
    totals[token] = (totals[token] ?? 0n) - (current[token] ?? 0n) + amount
  }
  for (const rawToken of Object.keys(nextAllocations)) {
    const token = rawToken.toLowerCase()
    const total = totals[token] ?? 0n
    if (total < 0n || total > (balances[token] ?? 0n)) throw new Error('E_ALLOCATION_MISMATCH')
  }
}

/**
 * Atomically move/release wallet-custodied strategy assets after a confirmed
 * profit-withdrawal transaction. The optimistic component check prevents a
 * stale API request from consuming principal, fees, or a newer harvest.
 */
export function commitProfitAllocationMutation(args: {
  strategyId: string
  walletId: string
  expected: Record<string, AllocationComponent>
  next: Record<string, AllocationComponent>
  balances: Record<string, bigint>
  ledger?: LedgerEntry[]
}) {
  const now = ts()
  const current = strategyAllocationComponents(args.strategyId)
  for (const [rawToken, expected] of Object.entries(args.expected)) {
    const token = rawToken.toLowerCase()
    const actual = current[token] ?? { principal: 0n, heldFee: 0n, heldProfit: 0n }
    if (!sameAllocationComponent(actual, expected)) throw new Error('E_ALLOCATION_CHANGED')
  }
  const nextTotals = Object.fromEntries(Object.entries(args.next).map(([rawToken, component]) => {
    if (component.principal < 0n || component.heldFee < 0n || component.heldProfit < 0n) throw new Error('E_ALLOCATION_MISMATCH')
    return [rawToken.toLowerCase(), component.principal + component.heldFee + component.heldProfit]
  }))
  assertWalletAllocationUpdate(args.walletId, args.strategyId, args.balances, nextTotals)

  db.exec('BEGIN IMMEDIATE')
  try {
    // Recheck under the write transaction so an accounting mutation can never
    // race between the optimistic read and the durable update.
    const totals = strategyAllocations(args.strategyId)
    const rows = db.prepare('SELECT token,principal_amount,held_fee_amount,held_profit_amount FROM allocation_components WHERE strategy_id=?').all(args.strategyId) as {
      token: string; principal_amount: string; held_fee_amount: string; held_profit_amount: string
    }[]
    const stored = Object.fromEntries(rows.map((row) => [row.token.toLowerCase(), {
      principal: BigInt(row.principal_amount), heldFee: BigInt(row.held_fee_amount), heldProfit: BigInt(row.held_profit_amount),
    }]))
    for (const [rawToken, expected] of Object.entries(args.expected)) {
      const token = rawToken.toLowerCase()
      const total = totals[token] ?? 0n
      const actual = stored[token] && stored[token].principal + stored[token].heldFee + stored[token].heldProfit === total
        ? stored[token]
        : { principal: 0n, heldFee: total, heldProfit: 0n }
      if (!sameAllocationComponent(actual, expected)) throw new Error('E_ALLOCATION_CHANGED')
    }
    const setAllocation = db.prepare(`INSERT INTO allocations(strategy_id,token,amount,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(strategy_id,token) DO UPDATE SET amount=excluded.amount,updated_at=excluded.updated_at`)
    for (const [token, amount] of Object.entries(nextTotals)) setAllocation.run(args.strategyId, token, amount.toString(), now)
    setAllocationComponents(args.strategyId, Object.fromEntries(Object.entries(args.next).map(([token, component]) => [token.toLowerCase(), component])), now)
    if (args.ledger?.length) {
      const insert = db.prepare(`INSERT OR IGNORE INTO ledger_entries(id,strategy_id,cycle_id,job_id,ts,block_number,tx_hash,kind,token,amount,quote_value,meta_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      for (const entry of args.ledger) insert.run(entry.id, entry.strategyId, entry.cycleId ?? null, entry.jobId ?? null, entry.ts, entry.blockNumber ?? null, entry.txHash ?? null, entry.kind, entry.token ?? null, entry.amount ?? null, entry.quoteValue ?? null, JSON.stringify({ ...(entry.meta ?? {}), estimated: entry.estimated === true }))
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

const utcDay = (timestamp: number) => Math.floor(timestamp / 86_400) * 86_400

export function dailyTurnoverUsed(walletId: string, quoteToken: string, now = ts(), strategyId?: string): bigint {
  const rows = strategyId
    ? db.prepare(`SELECT r.amount FROM daily_turnover_reservations r JOIN jobs j ON j.id=r.job_id
      WHERE r.wallet_id=? AND r.quote_token=? AND r.utc_day=? AND r.state IN ('reserved','confirmed') AND j.strategy_id=?`).all(
      walletId, quoteToken.toLowerCase(), utcDay(now), strategyId,
    ) as { amount: string }[]
    : db.prepare(`SELECT amount FROM daily_turnover_reservations
      WHERE wallet_id=? AND quote_token=? AND utc_day=? AND state IN ('reserved','confirmed')`).all(
      walletId, quoteToken.toLowerCase(), utcDay(now),
    ) as { amount: string }[]
  return rows.reduce((total, row) => total + BigInt(row.amount), 0n)
}

/**
 * Reserve quote-token turnover before the first approval/swap. Reservations
 * are deliberately conservative after a crash; recovery later confirms or
 * releases them from chain facts rather than silently under-counting usage.
 */
export function reserveDailyTurnover(args: { jobId: string; walletId: string; quoteToken: string; amount: bigint; limit: bigint; now?: number }) {
  if (args.amount < 0n || args.limit < 0n) throw new Error('E_DAILY_LIMIT')
  if (args.amount === 0n) return
  const now = args.now ?? ts()
  const day = utcDay(now)
  const token = args.quoteToken.toLowerCase()
  db.exec('BEGIN IMMEDIATE')
  try {
    const job = db.prepare('SELECT strategy_id FROM jobs WHERE id=?').get(args.jobId) as { strategy_id: string } | undefined
    if (!job) throw new Error('E_JOB_MISSING')
    const existing = db.prepare('SELECT amount,utc_day,state FROM daily_turnover_reservations WHERE job_id=? AND quote_token=?').get(args.jobId, token) as { amount: string; utc_day: number; state: string } | undefined
    if (existing) {
      if (!['reserved', 'confirmed'].includes(existing.state)) throw new Error('E_DAILY_LIMIT')
      if (existing.state === 'confirmed') {
        if (existing.utc_day !== day || BigInt(existing.amount) !== args.amount) throw new Error('E_DAILY_LIMIT')
        db.exec('COMMIT')
        return
      }
      // An unfinished recovery may cross 00:00 UTC. Its old reservation never
      // became confirmed turnover, so move it into the current UTC bucket only
      // after re-checking today's other usage. Counting the full recovery
      // estimate again is conservative even if an earlier step partially
      // executed before midnight.
      const otherRows = db.prepare(`SELECT r.amount FROM daily_turnover_reservations r JOIN jobs j ON j.id=r.job_id
        WHERE r.wallet_id=? AND r.quote_token=? AND r.utc_day=? AND r.state IN ('reserved','confirmed') AND j.strategy_id=? AND NOT (r.job_id=? AND r.quote_token=?)`).all(args.walletId, token, day, job.strategy_id, args.jobId, token) as { amount: string }[]
      const usedByOthers = otherRows.reduce((total, row) => total + BigInt(row.amount), 0n)
      if (usedByOthers + args.amount > args.limit) throw new Error('E_DAILY_LIMIT')
      db.prepare(`UPDATE daily_turnover_reservations SET utc_day=?,amount=?,updated_at=? WHERE job_id=? AND quote_token=?`).run(day, args.amount.toString(), now, args.jobId, token)
      db.exec('COMMIT')
      return
    }
    const rows = db.prepare(`SELECT r.amount FROM daily_turnover_reservations r JOIN jobs j ON j.id=r.job_id
      WHERE r.wallet_id=? AND r.quote_token=? AND r.utc_day=? AND r.state IN ('reserved','confirmed') AND j.strategy_id=?`).all(args.walletId, token, day, job.strategy_id) as { amount: string }[]
    const used = rows.reduce((total, row) => total + BigInt(row.amount), 0n)
    if (used + args.amount > args.limit) throw new Error('E_DAILY_LIMIT')
    db.prepare('INSERT INTO daily_turnover_reservations(job_id,wallet_id,quote_token,utc_day,amount,state,updated_at) VALUES(?,?,?,?,?,?,?)').run(
      args.jobId, args.walletId, token, day, args.amount.toString(), 'reserved', now,
    )
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function confirmDailyTurnover(jobId: string) {
  db.prepare(`UPDATE daily_turnover_reservations SET state='confirmed',updated_at=? WHERE job_id=? AND state='reserved'`).run(ts(), jobId)
}

export function releaseDailyTurnover(jobId: string) {
  db.prepare(`UPDATE daily_turnover_reservations SET state='released',updated_at=? WHERE job_id=? AND state='reserved'`).run(ts(), jobId)
}

export function nextTransactionIndex(jobId: string, stepIndex: number): number {
  // Recovery must reuse a durable but unfinished slot. Re-signing the same
  // nonce/calldata/gas can produce the same transaction hash, and inserting a
  // second row would violate both hash uniqueness and the one-intent audit
  // trail. Confirmed transactions are never reused.
  const unfinished = db.prepare(`SELECT tx_index FROM job_transactions
    WHERE job_id=? AND step_index=? AND state IN ('sending','failed') ORDER BY tx_index LIMIT 1`).get(jobId, stepIndex) as { tx_index: number } | undefined
  if (unfinished) return Number(unfinished.tx_index)
  const row = db.prepare('SELECT MAX(tx_index) AS n FROM job_transactions WHERE job_id=? AND step_index=?').get(jobId, stepIndex) as { n: number | null }
  return row.n === null ? 0 : Number(row.n) + 1
}

export function confirmedTransactionsAtNonce(nonce: bigint): Record<string, unknown>[] {
  return db.prepare(`SELECT job_id,step_index,tx_index,state,nonce,tx_hash,tx_to,calldata_hash,block_number
    FROM job_transactions WHERE nonce=? AND state='confirmed' AND tx_hash IS NOT NULL`).all(nonce.toString()) as Record<string, unknown>[]
}

export function abandonRecoveryJob(jobId: string) {
  const now = ts()
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.prepare(`SELECT strategy_id FROM jobs WHERE id=? AND state IN ('recovery','failed')`).get(jobId) as { strategy_id: string } | undefined
    if (!row) throw new Error('E_RECOVERY_JOB')
    db.prepare(`UPDATE jobs SET state='failed',updated_at=? WHERE id=?`).run(now, jobId)
    db.prepare(`UPDATE strategies SET state='monitoring',updated_at=? WHERE id=?`).run(now, row.strategy_id)
    db.prepare(`UPDATE daily_turnover_reservations SET state='released',updated_at=? WHERE job_id=? AND state='reserved'`).run(now, jobId)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function completedCyclesSince(strategyId: string, since: number): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM cycles WHERE strategy_id=? AND status='completed' AND completed_at>=?`).get(strategyId, since) as { n: number }
  return Number(row.n)
}

export function consecutiveLowerBreaks(strategyId: string): number {
  const rows = db.prepare(`SELECT trigger_side FROM cycles WHERE strategy_id=? AND status='completed' ORDER BY completed_at DESC LIMIT 1000`).all(strategyId) as { trigger_side: string | null }[]
  let count = 0
  for (const row of rows) {
    if (row.trigger_side !== 'lower') break
    count += 1
  }
  return count
}

export type MonitorState = {
  revision: number
  outSide?: 'lower' | 'upper'
  outSince?: number
  cooldownUntil?: number
  guardReason?: 'market_volatility' | 'spot_twap_deviation'
  guardStableSince?: number
  burstWaitUntil?: number
  burstResetAt?: number
  /** Epoch second at which the economics gate stops deferring a recenter. */
  econWaitUntil?: number
  /** Collectable fees valued in quote units at the last gate check. */
  econFeesQuote?: string
  /** Last cycle's realized cost (gas + execution shortfall) in quote units. */
  econCostQuote?: string
  lastTick?: number
  lastLiquidity?: string
  lastTokenId?: string
}

export function monitorState(strategyId: string): MonitorState | undefined {
  const row = db.prepare('SELECT revision,out_side,out_since,cooldown_until,guard_reason,guard_stable_since,burst_wait_until,burst_reset_at,econ_wait_until,econ_fees_quote,econ_cost_quote,last_tick,last_liquidity,last_token_id FROM monitor_state WHERE strategy_id=?').get(strategyId) as any
  return row && {
    revision: row.revision,
    outSide: row.out_side ?? undefined,
    outSince: row.out_since ?? undefined,
    cooldownUntil: row.cooldown_until ?? undefined,
    guardReason: row.guard_reason ?? undefined,
    guardStableSince: row.guard_stable_since ?? undefined,
    burstWaitUntil: row.burst_wait_until ?? undefined,
    burstResetAt: row.burst_reset_at ?? undefined,
    econWaitUntil: row.econ_wait_until ?? undefined,
    econFeesQuote: row.econ_fees_quote ?? undefined,
    econCostQuote: row.econ_cost_quote ?? undefined,
    lastTick: row.last_tick ?? undefined,
    lastLiquidity: row.last_liquidity ?? undefined,
    lastTokenId: row.last_token_id ?? undefined,
  }
}

export function updateMonitorState(strategyId: string, state: MonitorState) {
  db.prepare(`INSERT INTO monitor_state(strategy_id,revision,out_side,out_since,cooldown_until,guard_reason,guard_stable_since,burst_wait_until,burst_reset_at,econ_wait_until,econ_fees_quote,econ_cost_quote,last_tick,last_liquidity,last_token_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(strategy_id) DO UPDATE SET revision=excluded.revision,out_side=excluded.out_side,out_since=excluded.out_since,cooldown_until=excluded.cooldown_until,
      guard_reason=excluded.guard_reason,guard_stable_since=excluded.guard_stable_since,burst_wait_until=excluded.burst_wait_until,burst_reset_at=excluded.burst_reset_at,
      econ_wait_until=excluded.econ_wait_until,econ_fees_quote=excluded.econ_fees_quote,econ_cost_quote=excluded.econ_cost_quote,
      last_tick=excluded.last_tick,last_liquidity=excluded.last_liquidity,last_token_id=excluded.last_token_id,updated_at=excluded.updated_at`).run(
    strategyId, state.revision, state.outSide ?? null, state.outSince ?? null, state.cooldownUntil ?? null,
    state.guardReason ?? null, state.guardStableSince ?? null, state.burstWaitUntil ?? null, state.burstResetAt ?? null,
    state.econWaitUntil ?? null, state.econFeesQuote ?? null, state.econCostQuote ?? null,
    state.lastTick ?? null, state.lastLiquidity ?? null, state.lastTokenId ?? null, ts(),
  )
}

/** Latest `strategy_paused` audit event, used to explain a `paused_guard` state. */
export function latestStrategyPause(strategyId: string): { code?: string; reason?: string; side?: string; at: number } | undefined {
  const row = db.prepare(`SELECT ts,detail_json FROM audit_events WHERE action='strategy_paused' AND target_type='strategy' AND target_id=? ORDER BY id DESC LIMIT 1`)
    .get(strategyId) as { ts: number; detail_json: string } | undefined
  if (!row) return undefined
  try {
    const detail = JSON.parse(row.detail_json) as { code?: string; detail?: { reason?: string; side?: string } }
    return { code: detail.code, reason: detail.detail?.reason, side: detail.detail?.side, at: row.ts }
  } catch {
    return { at: row.ts }
  }
}

export function recordPriceSample(strategyId: string, timestamp: number, tick: number, blockNumber: string) {
  db.prepare('INSERT OR REPLACE INTO price_samples(strategy_id,ts,tick,block_number) VALUES(?,?,?,?)').run(strategyId, timestamp, tick, blockNumber)
  db.prepare('DELETE FROM price_samples WHERE strategy_id=? AND ts<?').run(strategyId, timestamp - 86_400)
}

export function sampledAverageTick(strategyId: string, since: number): { tick: number; firstTs: number; lastTs: number; count: number } | undefined {
  const row = db.prepare('SELECT AVG(tick) AS avg_tick,MIN(ts) AS first_ts,MAX(ts) AS last_ts,COUNT(*) AS n FROM price_samples WHERE strategy_id=? AND ts>=?').get(strategyId, since) as { avg_tick: number | null; first_ts: number | null; last_ts: number | null; n: number }
  if (row.avg_tick === null || row.first_ts === null || row.last_ts === null || row.n === 0) return undefined
  return { tick: Math.round(row.avg_tick), firstTs: row.first_ts, lastTs: row.last_ts, count: Number(row.n) }
}

export function sampledTickStats(strategyId: string, since: number): { tick: number; minTick: number; maxTick: number; firstTs: number; lastTs: number; count: number } | undefined {
  const row = db.prepare('SELECT AVG(tick) AS avg_tick,MIN(tick) AS min_tick,MAX(tick) AS max_tick,MIN(ts) AS first_ts,MAX(ts) AS last_ts,COUNT(*) AS n FROM price_samples WHERE strategy_id=? AND ts>=?').get(strategyId, since) as {
    avg_tick: number | null; min_tick: number | null; max_tick: number | null; first_ts: number | null; last_ts: number | null; n: number
  }
  if (row.avg_tick === null || row.min_tick === null || row.max_tick === null || row.first_ts === null || row.last_ts === null || row.n === 0) return undefined
  return { tick: Math.round(row.avg_tick), minTick: row.min_tick, maxTick: row.max_tick, firstTs: row.first_ts, lastTs: row.last_ts, count: Number(row.n) }
}

export function latestCompletedCycleAt(strategyId: string): number | undefined {
  const row = db.prepare(`SELECT MAX(completed_at) AS completed_at FROM cycles WHERE strategy_id=? AND status='completed'`).get(strategyId) as { completed_at: number | null }
  return row.completed_at ?? undefined
}

export function latestCompletedCycleRange(strategyId: string): { completedAt: number; rangeScale: number } | undefined {
  const row = db.prepare(`SELECT completed_at,range_scale FROM cycles WHERE strategy_id=? AND status='completed' AND new_token_id IS NOT NULL ORDER BY completed_at DESC,id DESC LIMIT 1`).get(strategyId) as { completed_at: number; range_scale: number } | undefined
  return row && { completedAt: row.completed_at, rangeScale: Number(row.range_scale) || 1 }
}

export function latestFeeCollectionAt(strategyId: string): number | undefined {
  const row = db.prepare(`SELECT MAX(ts) AS collected_at FROM ledger_entries WHERE strategy_id=? AND kind='fee_gross'`).get(strategyId) as { collected_at: number | null }
  return row.collected_at ?? undefined
}

export function commitRebalance(args: {
  jobId: string
  config: StrategyConfig
  oldTokenId: string
  newTokenId: string
  triggerSide: string
  rangeScale?: number
  allocations: Record<string, bigint>
  allocationComponents?: Record<string, AllocationComponent>
  ledger: LedgerEntry[]
  txHashes: string[]
  commitResult: Record<string, string | number | boolean>
}) {
  const now = ts()
  db.exec('BEGIN IMMEDIATE')
  try {
    const nextConfig: StrategyConfig = {
      ...args.config,
      activeTokenId: args.newTokenId,
      revision: args.config.revision + 1,
      updatedAt: now,
    }
    db.prepare('UPDATE strategies SET config_json=?,state=?,updated_at=? WHERE id=?').run(JSON.stringify(nextConfig), 'monitoring', now, args.config.id)
    const setAllocation = db.prepare(`INSERT INTO allocations(strategy_id,token,amount,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(strategy_id,token) DO UPDATE SET amount=excluded.amount,updated_at=excluded.updated_at`)
    for (const [token, value] of Object.entries(args.allocations)) setAllocation.run(args.config.id, token.toLowerCase(), value.toString(), now)
    if (args.allocationComponents) {
      for (const [token, component] of Object.entries(args.allocationComponents))
        if (component.principal + component.heldFee + component.heldProfit !== (args.allocations[token.toLowerCase()] ?? args.allocations[token])) throw new Error('E_ALLOCATION_MISMATCH')
      setAllocationComponents(args.config.id, args.allocationComponents, now)
    }
    const job = db.prepare('SELECT created_at FROM jobs WHERE id=?').get(args.jobId) as { created_at: number } | undefined
    if (!job) throw new Error('E_JOB_MISSING')
    db.prepare('INSERT INTO cycles(id,strategy_id,old_token_id,new_token_id,started_at,completed_at,trigger_side,range_scale,status,tx_hashes_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      `cycle-${args.jobId}`, args.config.id, args.oldTokenId, args.newTokenId, job.created_at, now, args.triggerSide, args.rangeScale ?? 1, 'completed', JSON.stringify(args.txHashes),
    )
    const insertLedger = db.prepare(`INSERT OR IGNORE INTO ledger_entries(id,strategy_id,cycle_id,job_id,ts,block_number,tx_hash,kind,token,amount,quote_value,meta_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    for (const entry of args.ledger) insertLedger.run(entry.id, entry.strategyId, entry.cycleId ?? `cycle-${args.jobId}`, args.jobId, entry.ts, entry.blockNumber ?? null, entry.txHash ?? null, entry.kind, entry.token ?? null, entry.amount ?? null, entry.quoteValue ?? null, JSON.stringify({ ...(entry.meta ?? {}), estimated: entry.estimated === true }))
    db.prepare(`UPDATE job_steps SET state='confirmed',confirmed_at=?,result_json=?,error_code=NULL WHERE job_id=? AND step_index=11`).run(now, JSON.stringify(args.commitResult), args.jobId)
    db.prepare(`UPDATE daily_turnover_reservations SET state='confirmed',updated_at=? WHERE job_id=? AND state='reserved'`).run(now, args.jobId)
    db.prepare('UPDATE jobs SET state=?,updated_at=? WHERE id=?').run('completed', now, args.jobId)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Atomically finish an exit-to-quote action without creating a replacement NFT. */
export function commitHoldQuote(args: {
  jobId: string
  config: StrategyConfig
  oldTokenId: string
  triggerSide: string
  allocations: Record<string, bigint>
  ledger: LedgerEntry[]
  txHashes: string[]
  commitResult: Record<string, string | number | boolean>
}) {
  const now = ts()
  db.exec('BEGIN IMMEDIATE')
  try {
    const nextConfig: StrategyConfig = {
      ...args.config,
      activeTokenId: null,
      enabled: false,
      revision: args.config.revision + 1,
      updatedAt: now,
    }
    db.prepare('UPDATE strategies SET config_json=?,state=?,updated_at=? WHERE id=?').run(JSON.stringify(nextConfig), 'paused_hold_quote', now, args.config.id)
    const setAllocation = db.prepare(`INSERT INTO allocations(strategy_id,token,amount,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(strategy_id,token) DO UPDATE SET amount=excluded.amount,updated_at=excluded.updated_at`)
    for (const [token, value] of Object.entries(args.allocations)) setAllocation.run(args.config.id, token.toLowerCase(), value.toString(), now)
    const job = db.prepare('SELECT created_at FROM jobs WHERE id=?').get(args.jobId) as { created_at: number } | undefined
    if (!job) throw new Error('E_JOB_MISSING')
    db.prepare('INSERT INTO cycles(id,strategy_id,old_token_id,new_token_id,started_at,completed_at,trigger_side,status,tx_hashes_json) VALUES(?,?,?,?,?,?,?,?,?)').run(
      `cycle-${args.jobId}`, args.config.id, args.oldTokenId, null, job.created_at, now, args.triggerSide, 'completed', JSON.stringify(args.txHashes),
    )
    const insertLedger = db.prepare(`INSERT OR IGNORE INTO ledger_entries(id,strategy_id,cycle_id,job_id,ts,block_number,tx_hash,kind,token,amount,quote_value,meta_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    for (const entry of args.ledger) insertLedger.run(entry.id, entry.strategyId, entry.cycleId ?? `cycle-${args.jobId}`, args.jobId, entry.ts, entry.blockNumber ?? null, entry.txHash ?? null, entry.kind, entry.token ?? null, entry.amount ?? null, entry.quoteValue ?? null, JSON.stringify({ ...(entry.meta ?? {}), estimated: entry.estimated === true }))
    db.prepare(`UPDATE job_steps SET state='confirmed',confirmed_at=?,result_json=?,error_code=NULL WHERE job_id=? AND step_index=11`).run(now, JSON.stringify(args.commitResult), args.jobId)
    db.prepare(`UPDATE daily_turnover_reservations SET state='confirmed',updated_at=? WHERE job_id=? AND state='reserved'`).run(now, args.jobId)
    db.prepare('UPDATE jobs SET state=?,updated_at=? WHERE id=?').run('completed', now, args.jobId)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function commitFeeCollection(args: {
  jobId: string
  config: StrategyConfig
  allocations: Record<string, bigint>
  allocationComponents?: Record<string, AllocationComponent>
  ledger: LedgerEntry[]
  txHashes: string[]
  commitResult: Record<string, string | number | boolean>
}) {
  const now = ts()
  db.exec('BEGIN IMMEDIATE')
  try {
    const setAllocation = db.prepare(`INSERT INTO allocations(strategy_id,token,amount,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(strategy_id,token) DO UPDATE SET amount=excluded.amount,updated_at=excluded.updated_at`)
    for (const [token, value] of Object.entries(args.allocations)) setAllocation.run(args.config.id, token.toLowerCase(), value.toString(), now)
    if (args.allocationComponents) {
      for (const [token, component] of Object.entries(args.allocationComponents))
        if (component.principal + component.heldFee + component.heldProfit !== (args.allocations[token.toLowerCase()] ?? args.allocations[token])) throw new Error('E_ALLOCATION_MISMATCH')
      setAllocationComponents(args.config.id, args.allocationComponents, now)
    }
    const insertLedger = db.prepare(`INSERT OR IGNORE INTO ledger_entries(id,strategy_id,cycle_id,job_id,ts,block_number,tx_hash,kind,token,amount,quote_value,meta_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    for (const entry of args.ledger) insertLedger.run(entry.id, entry.strategyId, null, args.jobId, entry.ts, entry.blockNumber ?? null, entry.txHash ?? null, entry.kind, entry.token ?? null, entry.amount ?? null, entry.quoteValue ?? null, JSON.stringify({ ...(entry.meta ?? {}), estimated: entry.estimated === true }))
    db.prepare(`UPDATE job_steps SET state='confirmed',confirmed_at=?,result_json=?,error_code=NULL WHERE job_id=? AND step_index=11`).run(now, JSON.stringify(args.commitResult), args.jobId)
    db.prepare(`UPDATE daily_turnover_reservations SET state='confirmed',updated_at=? WHERE job_id=? AND state='reserved'`).run(now, args.jobId)
    db.prepare('UPDATE jobs SET state=?,updated_at=? WHERE id=?').run('completed', now, args.jobId)
    db.prepare('UPDATE strategies SET state=?,updated_at=? WHERE id=?').run('monitoring', now, args.config.id)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
export function jobsForRecovery() {
  return db.prepare(`SELECT j.id,j.strategy_id,j.plan_json,j.state,j.created_at,j.updated_at,j.recovery_attempts,j.recovery_error_streak,
      j.recovery_last_error,j.recovery_next_at,j.recovery_quarantined_at,s.wallet_id
    FROM jobs j JOIN strategies s ON s.id=j.strategy_id WHERE j.state='recovery'
    ORDER BY COALESCE(j.recovery_next_at,0),j.updated_at,j.created_at`).all() as {
    id: string; strategy_id: string; plan_json: string; state: string; created_at: number; updated_at: number; wallet_id: string | null
    recovery_attempts: number; recovery_error_streak: number; recovery_last_error: string | null
    recovery_next_at: number | null; recovery_quarantined_at: number | null
  }[]
}

export function recoveryAttemptReady(jobId: string, now = ts()): boolean {
  const row = db.prepare('SELECT recovery_next_at,recovery_quarantined_at FROM jobs WHERE id=? AND state=\'recovery\'').get(jobId) as {
    recovery_next_at: number | null; recovery_quarantined_at: number | null
  } | undefined
  return Boolean(row && row.recovery_quarantined_at === null && (row.recovery_next_at ?? 0) <= now)
}

export function clearRecoverySchedule(jobId: string) {
  db.prepare(`UPDATE jobs SET recovery_attempts=0,recovery_error_streak=0,recovery_last_error=NULL,recovery_next_at=NULL,recovery_quarantined_at=NULL
    WHERE id=?`).run(jobId)
}

export function scheduleRecoveryRetry(jobId: string, code: string, quarantineEligible: boolean) {
  const now = ts()
  const row = db.prepare(`SELECT strategy_id,recovery_attempts,recovery_error_streak,recovery_last_error FROM jobs WHERE id=? AND state='recovery'`).get(jobId) as {
    strategy_id: string; recovery_attempts: number; recovery_error_streak: number; recovery_last_error: string | null
  } | undefined
  if (!row) throw new Error('E_RECOVERY_JOB')
  const attempts = Number(row.recovery_attempts) + 1
  const streak = row.recovery_last_error === code ? Number(row.recovery_error_streak) + 1 : 1
  const delaySeconds = Math.min(300, 5 * (2 ** Math.min(attempts - 1, 6)))
  const quarantined = quarantineEligible && streak >= 3
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`UPDATE jobs SET recovery_attempts=?,recovery_error_streak=?,recovery_last_error=?,recovery_next_at=?,recovery_quarantined_at=?,updated_at=? WHERE id=?`).run(
      attempts, streak, code, now + delaySeconds, quarantined ? now : null, now, jobId,
    )
    if (quarantined) db.prepare(`UPDATE strategies SET state='recovery_quarantined',updated_at=? WHERE id=?`).run(now, row.strategy_id)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { attempts, streak, delayMs: delaySeconds * 1_000, quarantined }
}

/** Allow one operator-requested attempt without discarding any chain facts. */
export function reactivateRecoveryJob(jobId: string) {
  const row = db.prepare(`SELECT strategy_id FROM jobs WHERE id=? AND state='recovery'`).get(jobId) as { strategy_id: string } | undefined
  if (!row) throw new Error('E_RECOVERY_JOB')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`UPDATE jobs SET recovery_next_at=NULL,recovery_quarantined_at=NULL WHERE id=?`).run(jobId)
    db.prepare(`UPDATE strategies SET state='recovery',updated_at=? WHERE id=?`).run(ts(), row.strategy_id)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
export function recoveryJobById(id: string): RunnableJob | undefined {
  const row = db.prepare(`SELECT j.id,j.plan_json,s.config_json,s.wallet_id FROM jobs j JOIN strategies s ON s.id=j.strategy_id WHERE j.id=? AND j.state IN ('recovery','failed')`).get(id) as { id: string; plan_json: string; config_json: string; wallet_id: string | null } | undefined
  if (!row?.wallet_id) return undefined
  const config = parseStrategyConfig(JSON.parse(row.config_json))
  if (!config.execution.walletId || config.execution.walletId !== row.wallet_id) return undefined
  return { id: row.id, plan: JSON.parse(row.plan_json) as StrategyExecutionPlan, config, walletId: row.wallet_id }
}

/**
 * Correct a token-role configuration before recovery has performed any swap.
 * Confirmed withdrawal/collect facts stay immutable; the stale swap plan and
 * its reservation are released so recovery must quote from current balances.
 */
export function replaceRecoveryStrategyConfig(jobId: string, config: StrategyConfig) {
  const now = ts()
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.prepare(`SELECT j.strategy_id,j.state FROM jobs j WHERE j.id=?`).get(jobId) as { strategy_id: string; state: string } | undefined
    if (!row || row.state !== 'recovery' || row.strategy_id !== config.id) throw new Error('E_RECOVERY_JOB')
    const afterSwap = db.prepare(`SELECT COUNT(*) AS n FROM job_transactions WHERE job_id=? AND step_index>=4 AND state='confirmed'`).get(jobId) as { n: number }
    if (Number(afterSwap.n) !== 0) throw new Error('E_RECOVERY_CONTEXT')
    db.prepare('UPDATE strategies SET wallet_id=?,config_json=?,updated_at=? WHERE id=?').run(
      config.execution.walletId ?? null,
      JSON.stringify(parseStrategyConfig(config)),
      now,
      config.id,
    )
    db.prepare(`DELETE FROM job_context WHERE job_id=? AND context_key='swap_plan'`).run(jobId)
    db.prepare(`UPDATE daily_turnover_reservations SET state='released',updated_at=? WHERE job_id=? AND state='reserved'`).run(now, jobId)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  audit('recovery', 'recovery_config_repaired', 'job', jobId, {
    riskToken: config.riskToken,
    quoteToken: config.quoteToken,
    revision: config.revision,
  })
}
export function jobSteps(jobId: string) {
  return db.prepare(`SELECT step_index,kind,state,nonce,tx_hash,tx_to,calldata_hash,sent_at,confirmed_at,block_number,result_json,error_code FROM job_steps WHERE job_id=? ORDER BY step_index`).all(jobId) as Record<string, unknown>[]
}
export function jobTransactions(jobId: string) {
  return db.prepare('SELECT * FROM job_transactions WHERE job_id=? ORDER BY step_index,tx_index').all(jobId) as Record<string, unknown>[]
}

export function reconcileJobTransaction(args: { jobId: string; stepIndex: number; txIndex: number; state: 'confirmed' | 'failed'; blockNumber?: bigint; errorCode?: string }) {
  const now = ts()
  db.prepare(`UPDATE job_transactions SET state=?,confirmed_at=CASE WHEN ?='confirmed' THEN COALESCE(confirmed_at,?) ELSE confirmed_at END,
    block_number=COALESCE(?,block_number),error_code=CASE WHEN ?='failed' THEN ? ELSE NULL END
    WHERE job_id=? AND step_index=? AND tx_index=?`).run(
    args.state, args.state, now, args.blockNumber?.toString() ?? null, args.state, args.errorCode ?? null,
    args.jobId, args.stepIndex, args.txIndex,
  )
}
export type LatestJobSummary = {
  id: string
  state: string
  createdAt: number
  updatedAt: number
  confirmedSteps: number
  totalSteps: number
  transactionCount: number
  txHashes: string[]
  errorCode?: string
  result?: Record<string, unknown>
  dryRun: boolean
  recoveryAttempts: number
  recoveryErrorStreak: number
  recoveryLastError?: string
  recoveryNextAt?: number
  recoveryQuarantinedAt?: number
}

/** Compact user-facing progress/result derived only from durable job facts. */
export function latestJobSummary(strategyId: string): LatestJobSummary | undefined {
  const row = db.prepare(`SELECT id,state,created_at,updated_at,recovery_attempts,recovery_error_streak,recovery_last_error,recovery_next_at,recovery_quarantined_at
    FROM jobs WHERE strategy_id=? ORDER BY created_at DESC,id DESC LIMIT 1`).get(strategyId) as {
    id: string; state: string; created_at: number; updated_at: number; recovery_attempts: number; recovery_error_streak: number
    recovery_last_error: string | null; recovery_next_at: number | null; recovery_quarantined_at: number | null
  } | undefined
  if (!row) return undefined
  const steps = db.prepare(`SELECT step_index,state,result_json,error_code FROM job_steps WHERE job_id=? ORDER BY step_index`).all(row.id) as {
    step_index: number; state: string; result_json: string | null; error_code: string | null
  }[]
  const transactions = db.prepare(`SELECT tx_hash,state,error_code FROM job_transactions WHERE job_id=? ORDER BY step_index,tx_index`).all(row.id) as {
    tx_hash: string | null; state: string; error_code: string | null
  }[]
  const commit = steps.find((step) => step.step_index === 11 && step.result_json)
  let result: Record<string, unknown> | undefined
  try { result = commit?.result_json ? JSON.parse(commit.result_json) as Record<string, unknown> : undefined } catch { result = undefined }
  const errorCode = row.state === 'completed'
    ? undefined
    : [...steps.map((step) => step.error_code), ...transactions.map((tx) => tx.error_code)].find((value): value is string => Boolean(value))
  const txHashes = [...new Set(transactions.map((tx) => tx.tx_hash).filter((value): value is string => Boolean(value)))]
  const confirmedSteps = steps.filter((step) => step.state === 'confirmed').length
  return {
    id: row.id,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedSteps,
    totalSteps: steps.length,
    transactionCount: transactions.length,
    txHashes,
    errorCode,
    result,
    dryRun: row.state === 'completed' && transactions.length === 0 && confirmedSteps === 1,
    recoveryAttempts: Number(row.recovery_attempts),
    recoveryErrorStreak: Number(row.recovery_error_streak),
    recoveryLastError: row.recovery_last_error ?? undefined,
    recoveryNextAt: row.recovery_next_at ?? undefined,
    recoveryQuarantinedAt: row.recovery_quarantined_at ?? undefined,
  }
}
export const audit = (actor: string, action: string, targetType?: string, targetId?: string, detail: Record<string, unknown> = {}) =>
  void db.prepare('INSERT INTO audit_events(ts,actor,action,target_type,target_id,detail_json) VALUES(?,?,?,?,?,?)').run(ts(), actor, action, targetType ?? null, targetId ?? null, JSON.stringify(detail))
