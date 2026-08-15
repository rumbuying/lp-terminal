// SQLite store (node:sqlite — built into node ≥22.13, zero dependencies).
// bigints are stored as TEXT and travel as strings through the API; REAL
// columns are display/ranking data only, never used to build transactions.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DB_PATH, TUNE, now } from './config'

mkdirSync(dirname(DB_PATH), { recursive: true })
export const db = new DatabaseSync(DB_PATH)

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS pools (
  address       TEXT PRIMARY KEY,          -- lowercase
  proto         TEXT NOT NULL,             -- 'univ2' | 'univ3'
  token0        TEXT NOT NULL,             -- lowercase
  token1        TEXT NOT NULL,
  fee_ppm       INTEGER NOT NULL,          -- univ2 fixed 3000 (0.30%)
  tick_spacing  INTEGER,                   -- univ3 only
  created_block INTEGER,                   -- univ3 only (from PoolCreated)
  pair_index    INTEGER,                   -- univ2 only (allPairs index)
  added_ts      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pools_t0 ON pools(token0);
CREATE INDEX IF NOT EXISTS idx_pools_t1 ON pools(token1);

CREATE TABLE IF NOT EXISTS tokens (
  address        TEXT PRIMARY KEY,
  symbol         TEXT NOT NULL DEFAULT '?',
  decimals       INTEGER NOT NULL DEFAULT 18,
  meta_ok        INTEGER NOT NULL DEFAULT 0, -- 0 = symbol/decimals defaulted (call reverted)
  price_usd      REAL,
  price_depth_usd REAL NOT NULL DEFAULT 0,   -- USD depth backing the price (bigger wins)
  price_src      TEXT,                       -- 'gt' | 'pool' | 'anchor'
  price_updated  INTEGER
);

CREATE TABLE IF NOT EXISTS pool_state (
  address      TEXT PRIMARY KEY,
  sqrt_price   TEXT,    -- univ3
  tick         INTEGER, -- univ3
  liquidity    TEXT,    -- univ3 in-range L
  reserve0     TEXT NOT NULL DEFAULT '0', -- univ2: reserves; univ3: erc20 balances (TVL basis)
  reserve1     TEXT NOT NULL DEFAULT '0',
  total_supply TEXT,    -- univ2 LP supply
  tvl_usd      REAL,
  tvl_approx   INTEGER NOT NULL DEFAULT 0, -- 1 = bounded figure: one side unpriced (2× priced side) or junk-side clamp (see tvlOf)
  updated      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_state_tvl ON pool_state(tvl_usd);

CREATE TABLE IF NOT EXISTS pool_stats (
  address    TEXT PRIMARY KEY,
  vol5m_usd  REAL,
  vol1h_usd  REAL,
  vol6h_usd  REAL,
  vol24h_usd REAL,
  txns24h    INTEGER,
  liq_usd    REAL,     -- GT's own reserve figure (cross-check; tvl_usd is chain-derived)
  source     TEXT NOT NULL,
  updated    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`)

// Existing production databases predate the intraday windows. CREATE TABLE IF
// NOT EXISTS does not evolve them, so add each nullable column in place without
// discarding the accumulated catalog/state/stat rows.
const poolStatColumns = new Set(
  (db.prepare('PRAGMA table_info(pool_stats)').all() as { name: string }[]).map((column) => column.name),
)
for (const column of ['vol5m_usd', 'vol1h_usd', 'vol6h_usd']) {
  if (!poolStatColumns.has(column)) db.exec(`ALTER TABLE pool_stats ADD COLUMN ${column} REAL`)
}

// ---- kv ----
const kvGetQ = db.prepare('SELECT v FROM kv WHERE k = ?')
const kvSetQ = db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
export const kvGet = (k: string): string | undefined => (kvGetQ.get(k) as { v: string } | undefined)?.v
export const kvSet = (k: string, v: string) => void kvSetQ.run(k, v)

// ---- pools ----
const insPoolQ = db.prepare(`
  INSERT OR IGNORE INTO pools (address, proto, token0, token1, fee_ppm, tick_spacing, created_block, pair_index, added_ts)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
/** returns true when the pool is new */
export function insertPool(p: {
  address: string
  proto: 'univ2' | 'univ3'
  token0: string
  token1: string
  feePpm: number
  tickSpacing?: number
  createdBlock?: number
  pairIndex?: number
}): boolean {
  const r = insPoolQ.run(
    p.address.toLowerCase(),
    p.proto,
    p.token0.toLowerCase(),
    p.token1.toLowerCase(),
    p.feePpm,
    p.tickSpacing ?? null,
    p.createdBlock ?? null,
    p.pairIndex ?? null,
    now(),
  )
  return Number(r.changes) > 0
}

export type PoolRow = {
  address: string
  proto: 'univ2' | 'univ3'
  token0: string
  token1: string
  fee_ppm: number
  tick_spacing: number | null
}
const poolsByAddrQ = db.prepare('SELECT address, proto, token0, token1, fee_ppm, tick_spacing FROM pools WHERE address = ?')
export const poolRow = (addr: string) => poolsByAddrQ.get(addr.toLowerCase()) as PoolRow | undefined
export const allPoolAddrs = (): string[] =>
  (db.prepare('SELECT address FROM pools').all() as { address: string }[]).map((r) => r.address)
export const poolCounts = () =>
  db.prepare(`SELECT proto, COUNT(*) AS n FROM pools GROUP BY proto`).all() as { proto: string; n: number }[]

// ---- tokens ----
const insTokenQ = db.prepare(`
  INSERT INTO tokens (address, symbol, decimals, meta_ok) VALUES (?, ?, ?, ?)
  ON CONFLICT(address) DO UPDATE SET symbol = excluded.symbol, decimals = excluded.decimals, meta_ok = excluded.meta_ok`)
export const upsertTokenMeta = (addr: string, symbol: string, decimals: number, metaOk: boolean) =>
  void insTokenQ.run(addr.toLowerCase(), symbol, decimals, metaOk ? 1 : 0)

const priceQ = db.prepare(`
  INSERT INTO tokens (address, price_usd, price_depth_usd, price_src, price_updated) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(address) DO UPDATE SET price_usd = excluded.price_usd, price_depth_usd = excluded.price_depth_usd,
    price_src = excluded.price_src, price_updated = excluded.price_updated`)
export const setTokenPrice = (addr: string, usd: number, depthUsd: number, src: string) =>
  void priceQ.run(
    addr.toLowerCase(),
    Number.isFinite(usd) ? usd : null,
    Number.isFinite(depthUsd) && depthUsd >= 0 ? depthUsd : 0,
    src,
    now(),
  )

// Drop every pool-derived price (reprice rebuilds them from the credible seeds
// on the same pass) plus anything outside the plausibility band, whatever its
// source — a GT quote can be garbage too, and a stored fantasy price is how one
// broken pool poisoned 138 tokens. Runs inside reprice's transaction, so the
// API never observes the gap.
const clearDerivedQ = db.prepare(
  `UPDATE tokens SET price_usd = NULL, price_depth_usd = 0, price_src = NULL, price_updated = NULL
   WHERE price_src = 'pool' OR (price_usd IS NOT NULL AND (price_usd < ? OR price_usd > ?))`,
)
export const clearDerivedPrices = () => void clearDerivedQ.run(TUNE.minTokenUsd, TUNE.maxTokenUsd)

export type TokenRow = {
  address: string
  symbol: string
  decimals: number
  meta_ok: number
  price_usd: number | null
  price_depth_usd: number
  price_src: string | null
  price_updated: number | null
}
export const allTokens = () => db.prepare('SELECT * FROM tokens').all() as TokenRow[]
export const missingMetaTokens = (): string[] =>
  (
    db
      .prepare(
        `SELECT DISTINCT u.addr FROM (SELECT token0 AS addr FROM pools UNION SELECT token1 FROM pools) u
         LEFT JOIN tokens t ON t.address = u.addr WHERE t.address IS NULL`,
      )
      .all() as { addr: string }[]
  ).map((r) => r.addr)

// ---- pool_state ----
const upStateQ = db.prepare(`
  INSERT INTO pool_state (address, sqrt_price, tick, liquidity, reserve0, reserve1, total_supply, updated)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(address) DO UPDATE SET sqrt_price = excluded.sqrt_price, tick = excluded.tick,
    liquidity = excluded.liquidity, reserve0 = excluded.reserve0, reserve1 = excluded.reserve1,
    total_supply = excluded.total_supply, updated = excluded.updated`)
export const upsertState = (
  addr: string,
  s: { sqrtPrice?: bigint; tick?: number; liquidity?: bigint; reserve0: bigint; reserve1: bigint; totalSupply?: bigint },
) =>
  void upStateQ.run(
    addr.toLowerCase(),
    s.sqrtPrice !== undefined ? String(s.sqrtPrice) : null,
    s.tick ?? null,
    s.liquidity !== undefined ? String(s.liquidity) : null,
    String(s.reserve0),
    String(s.reserve1),
    s.totalSupply !== undefined ? String(s.totalSupply) : null,
    now(),
  )

const tvlQ = db.prepare('UPDATE pool_state SET tvl_usd = ?, tvl_approx = ? WHERE address = ?')
export const setTvl = (addr: string, tvl: number | null, approx: boolean) =>
  void tvlQ.run(tvl !== null && Number.isFinite(tvl) ? tvl : null, approx ? 1 : 0, addr.toLowerCase())

// ---- pool_stats ----
const upStatsQ = db.prepare(`
  INSERT INTO pool_stats (address, vol5m_usd, vol1h_usd, vol6h_usd, vol24h_usd, txns24h, liq_usd, source, updated)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(address) DO UPDATE SET vol5m_usd = excluded.vol5m_usd, vol1h_usd = excluded.vol1h_usd,
    vol6h_usd = excluded.vol6h_usd, vol24h_usd = excluded.vol24h_usd, txns24h = excluded.txns24h,
    liq_usd = excluded.liq_usd, source = excluded.source, updated = excluded.updated`)
export const upsertStats = (
  addr: string,
  volumes: { m5: number | null; h1: number | null; h6: number | null; h24: number | null },
  txns24h: number | null,
  liqUsd: number | null,
  source: string,
) =>
  void upStatsQ.run(
    addr.toLowerCase(),
    volumes.m5,
    volumes.h1,
    volumes.h6,
    volumes.h24,
    txns24h,
    liqUsd,
    source,
    now(),
  )

/**
 * Frontpage set: the top-N pools by TVL — exactly what /api/pools?sort=tvl
 * returns to the POOLS tab, so sweeping these keeps every on-screen row fresh.
 * The maxPoolTvlUsd ceiling matches the API's ranking guard: a corrupt figure
 * must not be able to spend the fast tier's whole RPC budget on itself.
 */
export const frontpageAddrs = (n: number): string[] =>
  (
    db
      .prepare('SELECT address FROM pool_state WHERE tvl_usd IS NOT NULL AND tvl_usd < ? ORDER BY tvl_usd DESC LIMIT ?')
      .all(TUNE.maxPoolTvlUsd, n) as { address: string }[]
  ).map((r) => r.address)

// ---- demand gate ----
// The frontpage sweep only spends RPC while the POOLS tab is actually being
// polled: the API stamps `lastPoolsHit` on every /api/pools request, the sweep
// loop checks its age. Idle site → no fast sweeps → no cost. Starts "closed"
// (lastPoolsHit = 0) so nothing sweeps until the first request lands.
let lastPoolsHit = 0
export const notePoolsHit = (): void => {
  lastPoolsHit = Date.now()
}
export const poolsHitAgeMs = (): number => Date.now() - lastPoolsHit

/** hot set: real TVL, or GT-visible activity, or freshly created */
export const hotAddrs = (): string[] =>
  (
    db
      .prepare(
        `SELECT address FROM pool_state WHERE tvl_usd BETWEEN ? AND ?
         UNION SELECT address FROM pool_stats WHERE vol24h_usd > 0
         UNION SELECT address FROM pools WHERE added_ts > ?`,
      )
      .all(TUNE.hotTvlUsd, TUNE.maxPoolTvlUsd, now() - 3_600) as { address: string }[]
  ).map((r) => r.address)

/**
 * active set for the hourly sweep: anything that ever showed ≥$100 TVL plus
 * everything younger than 48h. The launchpads mint ~20k dust pools/day — the
 * 6-hourly census (allPoolAddrs) keeps their state honest, the hourly sweep
 * stays bounded by real liquidity instead of catalog size.
 */
export const activeAddrs = (): string[] =>
  (
    db
      .prepare(
        `SELECT address FROM pool_state WHERE tvl_usd >= ?
         UNION SELECT address FROM pools WHERE added_ts > ?`,
      )
      .all(100, now() - 172_800) as { address: string }[]
  ).map((r) => r.address)

export const tx = (fn: () => void) => {
  db.exec('BEGIN')
  try {
    fn()
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
