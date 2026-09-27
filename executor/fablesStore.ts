import type { FablesStrategyConfig } from '../shared/strategy/types'
import { parseFablesStrategyConfig } from '../shared/strategy/fablesSchema'
import { db } from './store'

db.exec(`
CREATE TABLE IF NOT EXISTS fables_strategies (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  hook TEXT NOT NULL,
  range_id TEXT NOT NULL,
  wallet_id TEXT,
  config_json TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_enabled_fables_strategy_per_range
  ON fables_strategies(owner,pool_id,hook,range_id) WHERE enabled=1;
-- A wallet may own multiple ranges. Open jobs, not enabled strategies, hold the signer lock.
DROP INDEX IF EXISTS one_enabled_fables_strategy_per_wallet;
CREATE TABLE IF NOT EXISTS fables_monitor_state (
  strategy_id TEXT PRIMARY KEY REFERENCES fables_strategies(id),
  revision INTEGER NOT NULL,
  out_side TEXT,
  out_since INTEGER,
  cooldown_until INTEGER,
  last_tick INTEGER,
  last_block TEXT,
  error TEXT,
  updated_at INTEGER NOT NULL
);
`)

export type StoredFablesStrategy = { config: FablesStrategyConfig; state: string; updatedAt: number }

export function fablesStrategyById(id: string): StoredFablesStrategy | undefined {
  const row = db.prepare('SELECT config_json,state,updated_at FROM fables_strategies WHERE id=?').get(id) as
    { config_json: string; state: string; updated_at: number } | undefined
  return row && { config: parseFablesStrategyConfig(JSON.parse(row.config_json), { requireAutoApproval: false }), state: row.state, updatedAt: row.updated_at }
}

export function listFablesStrategies(owner?: string): StoredFablesStrategy[] {
  const rows = (owner
    ? db.prepare('SELECT config_json,state,updated_at FROM fables_strategies WHERE owner=? ORDER BY updated_at DESC').all(owner.toLowerCase())
    : db.prepare('SELECT config_json,state,updated_at FROM fables_strategies ORDER BY updated_at DESC').all()) as
    { config_json: string; state: string; updated_at: number }[]
  return rows.map(row => ({ config: parseFablesStrategyConfig(JSON.parse(row.config_json), { requireAutoApproval: false }), state: row.state, updatedAt: row.updated_at }))
}

export function upsertFablesStrategy(config: FablesStrategyConfig): void {
  const clean = parseFablesStrategyConfig(config)
  const now = Math.floor(Date.now() / 1000)
  db.exec('BEGIN IMMEDIATE')
  try {
    const current = db.prepare('SELECT config_json,state FROM fables_strategies WHERE id=?').get(clean.id) as
      { config_json: string; state: string } | undefined
    if (current) {
      const old = parseFablesStrategyConfig(JSON.parse(current.config_json), { requireAutoApproval: false })
      if (clean.revision !== old.revision + 1) throw new Error('E_FABLES_REVISION_CONFLICT')
      if (old.owner.toLowerCase() !== clean.owner.toLowerCase()) throw new Error('E_FABLES_OWNER_CHANGE')
      if (current.state === 'executing' || current.state === 'recovery') throw new Error('E_FABLES_JOB_OPEN')
    } else if (clean.revision !== 1) throw new Error('E_FABLES_REVISION_CONFLICT')
    db.prepare(`INSERT INTO fables_strategies
      (id,owner,pool_id,hook,range_id,wallet_id,config_json,enabled,state,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        pool_id=excluded.pool_id,hook=excluded.hook,range_id=excluded.range_id,
        wallet_id=excluded.wallet_id,config_json=excluded.config_json,
        enabled=excluded.enabled,state=excluded.state,updated_at=excluded.updated_at`).run(
      clean.id, clean.owner.toLowerCase(), clean.positionRef.poolId.toLowerCase(),
      clean.positionRef.hook.toLowerCase(), clean.positionRef.rangeId,
      clean.execution.walletId ?? null, JSON.stringify(clean), clean.enabled ? 1 : 0,
      clean.enabled ? 'monitoring' : 'disabled', now,
    )
    db.prepare('DELETE FROM fables_monitor_state WHERE strategy_id=?').run(clean.id)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export type FablesMonitorState = {
  revision: number; outSide?: 'lower' | 'upper'; outSince?: number; cooldownUntil?: number
  lastTick?: number; lastBlock?: string; error?: string
}

export function fablesMonitorState(id: string): FablesMonitorState | undefined {
  const row = db.prepare(`SELECT revision,out_side,out_since,cooldown_until,last_tick,last_block,error
    FROM fables_monitor_state WHERE strategy_id=?`).get(id) as Record<string, unknown> | undefined
  return row && {
    revision: Number(row.revision),
    outSide: row.out_side === 'lower' || row.out_side === 'upper' ? row.out_side : undefined,
    outSince: row.out_since === null ? undefined : Number(row.out_since),
    cooldownUntil: row.cooldown_until === null ? undefined : Number(row.cooldown_until),
    lastTick: row.last_tick === null ? undefined : Number(row.last_tick),
    lastBlock: row.last_block === null ? undefined : String(row.last_block),
    error: row.error === null ? undefined : String(row.error),
  }
}

export function updateFablesMonitorState(id: string, state: FablesMonitorState, strategyState: string): void {
  const now = Math.floor(Date.now() / 1000)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`INSERT INTO fables_monitor_state
      (strategy_id,revision,out_side,out_since,cooldown_until,last_tick,last_block,error,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(strategy_id) DO UPDATE SET
        revision=excluded.revision,out_side=excluded.out_side,out_since=excluded.out_since,
        cooldown_until=excluded.cooldown_until,last_tick=excluded.last_tick,
        last_block=excluded.last_block,error=excluded.error,updated_at=excluded.updated_at`).run(
      id, state.revision, state.outSide ?? null, state.outSince ?? null,
      state.cooldownUntil ?? null, state.lastTick ?? null, state.lastBlock ?? null,
      state.error ?? null, now,
    )
    db.prepare('UPDATE fables_strategies SET state=?,updated_at=? WHERE id=?').run(strategyState, now, id)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
