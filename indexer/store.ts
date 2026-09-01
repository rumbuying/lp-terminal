// SQLite store (node:sqlite — built into node ≥22.13, zero dependencies).
// bigints are stored as TEXT and travel as strings through the API; REAL
// columns are display/ranking data only, never used to build transactions.
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { allowLegacyDbAdoption, DB_CHAIN_IDENTITY, DB_PATH, TUNE, now } from './config';
import { bindOrAssertDatabaseChain } from './databaseIdentity';

mkdirSync(dirname(DB_PATH), { recursive: true });
export const db = new DatabaseSync(DB_PATH);

const configuredBusyTimeout = Number(process.env.INDEXER_SQLITE_BUSY_TIMEOUT_MS);
export const SQLITE_BUSY_TIMEOUT_MS =
  Number.isSafeInteger(configuredBusyTimeout) && configuredBusyTimeout > 0 ? configuredBusyTimeout : 30_000;

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};
`);

// This must run before this process creates or prepares catalog/state/API
// tables. A wrong-chain or ambiguous legacy DB therefore fails closed without
// mutating the existing catalog schema or rows.
export const databaseIdentity = bindOrAssertDatabaseChain(db, DB_CHAIN_IDENTITY, {
  adoptLegacy: allowLegacyDbAdoption(),
});

db.exec(`
CREATE TABLE IF NOT EXISTS pools (
  address       TEXT PRIMARY KEY,          -- lowercase
  proto         TEXT NOT NULL,             -- venue: 'univ2' | 'univ3' | 'pancakev2' ...
  token0        TEXT NOT NULL,             -- lowercase
  token1        TEXT NOT NULL,
  fee_ppm       INTEGER NOT NULL,          -- venue fee in parts per million
  unstaked_fee_ppm INTEGER NOT NULL DEFAULT 0, -- UP33 fee withheld from unstaked LPs
  gauge         TEXT,                      -- UP33 per-pool gauge; null elsewhere
  tick_spacing  INTEGER,                   -- CL/v3 only
  created_block INTEGER,                   -- CL/v3 only (snapshot or PoolCreated)
  pair_index    INTEGER,                   -- v2 only (allPairs index)
  snapshot_generation TEXT,                -- Graph generation; CL snapshots only
  catalog_seq   INTEGER,                   -- null = pre-fence baseline; positive = insertion sequence
  added_ts      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pools_t0 ON pools(token0);
CREATE INDEX IF NOT EXISTS idx_pools_t1 ON pools(token1);
-- Solver topology lookups always know both canonical token addresses. Without
-- this composite index, a WBNB pair lookup scans every pool containing WBNB.
CREATE INDEX IF NOT EXISTS idx_pools_pair ON pools(token0, token1, address);
CREATE INDEX IF NOT EXISTS idx_pools_proto_address ON pools(proto, address);
-- A V2 factory's PairCreated ordinal is the zero-based allPairs index. Keep it
-- unique per venue so a corrupt historical snapshot cannot publish two rows
-- for one factory slot (or silently skip a slot behind an address PK conflict).
CREATE UNIQUE INDEX IF NOT EXISTS idx_pools_v2_pair_index
  ON pools(proto, pair_index)
  WHERE proto IN ('univ2', 'pancakev2') AND pair_index IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pools_cl_token0
  ON pools(token0) WHERE proto IN ('univ3', 'pancakev3');
CREATE INDEX IF NOT EXISTS idx_pools_cl_token1
  ON pools(token1) WHERE proto IN ('univ3', 'pancakev3');
CREATE INDEX IF NOT EXISTS idx_pools_added ON pools(added_ts DESC, address);
CREATE INDEX IF NOT EXISTS idx_pools_proto_added ON pools(proto, added_ts DESC, address);
CREATE INDEX IF NOT EXISTS idx_pools_created
  ON pools(created_block DESC, pair_index DESC, address);

CREATE TABLE IF NOT EXISTS pool_catalog_counts (
  proto TEXT PRIMARY KEY,
  n     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  address        TEXT PRIMARY KEY,
  symbol         TEXT NOT NULL DEFAULT '?',
  decimals       INTEGER NOT NULL DEFAULT 18,
  meta_ok        INTEGER NOT NULL DEFAULT 0, -- 0 = decimals defaulted; symbol may use an address fallback
  price_usd      REAL,
  price_depth_usd REAL NOT NULL DEFAULT 0,   -- USD depth backing the price (bigger wins)
  price_src      TEXT,                       -- 'gt' | 'pool' | 'anchor'
  price_updated  INTEGER
);

CREATE TABLE IF NOT EXISTS pool_state (
  address      TEXT PRIMARY KEY,
  proto        TEXT,
  sqrt_price   TEXT,    -- CL/v3
  tick         INTEGER, -- CL/v3
  liquidity    TEXT,    -- CL/v3 in-range L
  staked_liquidity TEXT NOT NULL DEFAULT '0', -- UP33 active liquidity earning emissions
  reward_rate  TEXT NOT NULL DEFAULT '0',
  period_finish INTEGER NOT NULL DEFAULT 0,
  gauge_alive  INTEGER NOT NULL DEFAULT 0,
  reserve0     TEXT NOT NULL DEFAULT '0', -- v2: reserves; CL/v3: erc20 balances (TVL basis)
  reserve1     TEXT NOT NULL DEFAULT '0',
  total_supply TEXT,    -- v2 LP supply
  tvl_usd      REAL,
  tvl_approx   INTEGER NOT NULL DEFAULT 0, -- 1 = bounded figure: one side unpriced (2× priced side) or junk-side clamp (see tvlOf)
  updated      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_state_tvl ON pool_state(tvl_usd);
CREATE INDEX IF NOT EXISTS idx_state_updated ON pool_state(updated);

CREATE TABLE IF NOT EXISTS pool_stats (
  address    TEXT PRIMARY KEY,
  proto      TEXT,
  vol5m_usd  REAL,
  vol1h_usd  REAL,
  vol6h_usd  REAL,
  vol24h_usd REAL,
  txns24h    INTEGER,
  liq_usd    REAL,     -- GT's own reserve figure (cross-check; tvl_usd is chain-derived)
  source     TEXT NOT NULL,
  updated    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stats_liq ON pool_stats(liq_usd DESC, address);
CREATE INDEX IF NOT EXISTS idx_stats_vol ON pool_stats(vol24h_usd DESC, address);
CREATE INDEX IF NOT EXISTS idx_stats_updated ON pool_stats(updated);

-- Strategy recommendation history is deliberately identity-agnostic: v2/v3
-- rows use a pool address, while v4 rows use their bytes32 PoolId. The public
-- pool catalogs remain separate and keep their existing cursor contracts.
CREATE TABLE IF NOT EXISTS pool_market_snapshots (
  pool TEXT NOT NULL,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  vol5m_usd REAL,
  vol1h_usd REAL,
  vol6h_usd REAL,
  vol24h_usd REAL,
  tvl_usd REAL,
  tick INTEGER,
  liquidity TEXT,
  fee_ppm INTEGER NOT NULL,
  PRIMARY KEY(pool, ts)
);
CREATE INDEX IF NOT EXISTS idx_market_snapshots_ts ON pool_market_snapshots(ts);

CREATE TABLE IF NOT EXISTS pool_tick_samples (
  pool TEXT NOT NULL,
  ts INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  block_number TEXT NOT NULL,
  PRIMARY KEY(pool, ts)
);
CREATE INDEX IF NOT EXISTS idx_tick_samples_ts ON pool_tick_samples(ts);

CREATE TABLE IF NOT EXISTS v4_recommendation_state (
  pool_id TEXT PRIMARY KEY,
  sqrt_price TEXT NOT NULL,
  tick INTEGER NOT NULL,
  liquidity TEXT NOT NULL,
  lp_fee INTEGER NOT NULL,
  updated INTEGER NOT NULL
);

-- API reads may discover an official catalog row before its progressive
-- metadata/state pass. Keep that demand durable and bounded; the shared loop owns
-- the RPC work, so an HTTP request never blocks on chain reads.
CREATE TABLE IF NOT EXISTS hydration_demand (
  address      TEXT PRIMARY KEY,
  proto        TEXT,
  requested_at INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT
);
CREATE INDEX IF NOT EXISTS idx_hydration_demand_due
  ON hydration_demand(next_attempt, requested_at DESC, address);

-- Uniswap v4 pools do not have pool contract addresses. Every pool shares one
-- PoolManager and is identified by a bytes32 PoolId, so putting v4 rows in the
-- address-keyed tables above would collapse the whole catalog onto one row.
-- Keep the candidate directory separate and key every related table by
-- pool_id. Historic Graph rows are candidates until a client re-derives their
-- PoolId from live StateView data; key_fee_ppm is therefore nullable and is
-- populated only for Initialize events observed directly from PoolManager.
CREATE TABLE IF NOT EXISTS v4_pools (
  pool_id        TEXT PRIMARY KEY,          -- lowercase bytes32
  pool_manager   TEXT NOT NULL,             -- lowercase singleton address
  currency0      TEXT NOT NULL,             -- lowercase; native coin is address(0)
  currency1      TEXT NOT NULL,
  key_fee_ppm    INTEGER,                   -- trusted only when sourced from Initialize
  tick_spacing   INTEGER NOT NULL,
  hooks          TEXT NOT NULL,
  created_block  INTEGER,
  snapshot_generation TEXT,                 -- exact pinned Graph generation, null for tail-only rows
  added_ts       INTEGER NOT NULL
);
-- The scope of an RPC-sourced v4 directory: every token one launchpad factory
-- minted. Membership only — a token here is not yet known to have any pool,
-- and a pool is admitted to v4_pools when either of its currencies is listed.
-- Empty (and unused) on chains whose directory comes from a subgraph.
CREATE TABLE IF NOT EXISTS v4_launchpad_tokens (
  address       TEXT PRIMARY KEY,          -- lowercase ERC-20 address
  created_block INTEGER NOT NULL,
  added_ts      INTEGER NOT NULL
);

-- The other origin the chain can prove, and the other half of that scope:
-- tokenized equities. Same role as v4_launchpad_tokens — membership only — but
-- proven differently. A launchpad token is proven by CREATE2 derivation from a
-- known factory; an issued share by its proxy codehash TOGETHER WITH the
-- ERC-1967 slot naming that issuer's beacon or admin. Both halves are required,
-- and src/lib/stockToken.ts is the one implementation of that check, shared with
-- the browser so the two cannot drift into disagreeing about the same token.
--
-- A NULL issuer is a real answer: measured, matched nobody. Recording it is
-- what keeps the sweep from re-reading every ordinary token forever. A read
-- that FAILED is not recorded at all — absence of a mark is the warning here,
-- so a dropped packet has to leave a token unmeasured rather than unissued.
CREATE TABLE IF NOT EXISTS stock_tokens (
  address TEXT PRIMARY KEY,                -- lowercase ERC-20 address
  issuer  TEXT,                            -- StockIssuerId, or NULL for measured-and-matched-nobody
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_tokens_issuer
  ON stock_tokens(issuer, address) WHERE issuer IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_v4_pools_c0 ON v4_pools(currency0);
CREATE INDEX IF NOT EXISTS idx_v4_pools_c1 ON v4_pools(currency1);
CREATE INDEX IF NOT EXISTS idx_v4_pools_pair
  ON v4_pools(currency0, currency1, pool_id);
CREATE INDEX IF NOT EXISTS idx_v4_pools_created ON v4_pools(created_block);

-- v4 position OWNERSHIP for a chain with no position subgraph. One row per
-- currently-held tokenId, derived by replaying the PositionManager's ERC-721
-- Transfer logs: mint (0x0 -> owner) inserts, burn (owner -> 0x0) deletes, and
-- a transfer moves the row to the new owner. The reader asks only "which ids
-- might this wallet own" and re-reads ownership from the chain, so a stale row
-- can only waste a call, never show a position someone else holds.
CREATE TABLE IF NOT EXISTS v4_position_owners (
  token_id      INTEGER PRIMARY KEY,       -- the ERC-721 id
  owner         TEXT NOT NULL,             -- lowercase address
  updated_block INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v4_position_owner
  ON v4_position_owners(owner, token_id);

-- V4 Graph metadata is isolated from the chain-verified v2/v3 token table.
-- It is display metadata only; transaction identity is independently proven
-- from PoolKey + StateView in the browser before a row becomes executable.
CREATE TABLE IF NOT EXISTS v4_tokens (
  address       TEXT PRIMARY KEY,
  symbol        TEXT NOT NULL DEFAULT '?',
  decimals      INTEGER NOT NULL DEFAULT 18,
  updated       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v4_pool_stats (
  pool_id           TEXT PRIMARY KEY,
  tvl0              REAL,
  tvl1              REAL,
  featured_snapshot INTEGER,
  featured_rank     INTEGER,
  updated           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v4_stats_featured
  ON v4_pool_stats(featured_snapshot DESC, featured_rank ASC);

CREATE TABLE IF NOT EXISTS v4_pool_days (
  pool_id  TEXT NOT NULL,
  date     INTEGER NOT NULL,
  volume0  REAL,
  volume1  REAL,
  PRIMARY KEY(pool_id, date)
);

-- What pool_state + pool_stats are for the address-keyed protocols, in one
-- PoolId-keyed table: what a v4 pool is worth, and what trades through it.
-- Its own table rather than columns on v4_pool_stats, because the two have
-- different lifetimes — v4_pool_stats holds one Graph generation's raw
-- accounting and is pruned wholesale when the featured set rotates, while a
-- reading stays true until the next one replaces it.
--
-- The two depth figures are two different claims and are kept apart for the
-- same reason they are on the address side: tvl_usd is derived from the token
-- quantities in the pool priced through this indexer's own graph, liq_usd is an
-- outside aggregator's number. The derived one is preferred and the aggregator's
-- is the fallback and the cross-check.
CREATE TABLE IF NOT EXISTS v4_market_stats (
  pool_id    TEXT PRIMARY KEY,
  vol5m_usd  REAL,
  vol1h_usd  REAL,
  vol6h_usd  REAL,
  vol24h_usd REAL,
  txns24h    INTEGER,
  liq_usd    REAL,     -- the aggregator's own reserve figure
  tvl_usd    REAL,     -- derived here from token quantities and this indexer's prices
  tvl_approx INTEGER NOT NULL DEFAULT 0,   -- a bound was applied; see state.tvlOf
  source     TEXT NOT NULL,
  updated    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v4_market_vol ON v4_market_stats(vol24h_usd DESC, pool_id);
-- Ranking reads the preferred figure, so the index has to be on the same
-- expression the ORDER BY uses, not on either column alone.
CREATE INDEX IF NOT EXISTS idx_v4_market_depth
  ON v4_market_stats(COALESCE(tvl_usd, liq_usd) DESC, pool_id);

CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`);

// Freeze an address traversal at an insertion high-water mark without making
// the live factory tail restart it. Existing rows are sequence zero; assigning
// every legacy row would be an unnecessary multi-million-row migration.
const poolColumns = db.prepare('PRAGMA table_info(pools)').all() as Array<{
  name: string;
}>;
if (!poolColumns.some((column) => column.name === 'catalog_seq'))
  db.exec('ALTER TABLE pools ADD COLUMN catalog_seq INTEGER');
if (!poolColumns.some((column) => column.name === 'snapshot_generation'))
  db.exec('ALTER TABLE pools ADD COLUMN snapshot_generation TEXT');
if (!poolColumns.some((column) => column.name === 'unstaked_fee_ppm'))
  db.exec('ALTER TABLE pools ADD COLUMN unstaked_fee_ppm INTEGER NOT NULL DEFAULT 0');
if (!poolColumns.some((column) => column.name === 'gauge'))
  db.exec('ALTER TABLE pools ADD COLUMN gauge TEXT');
const stateColumns = db.prepare('PRAGMA table_info(pool_state)').all() as Array<{ name: string }>;
if (!stateColumns.some((column) => column.name === 'staked_liquidity'))
  db.exec("ALTER TABLE pool_state ADD COLUMN staked_liquidity TEXT NOT NULL DEFAULT '0'");
if (!stateColumns.some((column) => column.name === 'reward_rate'))
  db.exec("ALTER TABLE pool_state ADD COLUMN reward_rate TEXT NOT NULL DEFAULT '0'");
if (!stateColumns.some((column) => column.name === 'period_finish'))
  db.exec('ALTER TABLE pool_state ADD COLUMN period_finish INTEGER NOT NULL DEFAULT 0');
if (!stateColumns.some((column) => column.name === 'gauge_alive'))
  db.exec('ALTER TABLE pool_state ADD COLUMN gauge_alive INTEGER NOT NULL DEFAULT 0');
const poolStatColumns = db.prepare('PRAGMA table_info(pool_stats)').all() as Array<{ name: string }>;
for (const column of ['vol5m_usd', 'vol1h_usd', 'vol6h_usd']) {
  if (!poolStatColumns.some((existing) => existing.name === column))
    db.exec(`ALTER TABLE pool_stats ADD COLUMN ${column} REAL`);
}
// Retire the briefly-developed full-catalog form if this migration was ever
// exercised locally. Snapshot generations are CL-only; indexing millions of
// V2 rows whose value is always NULL wastes both disk and write bandwidth.
db.exec('DROP INDEX IF EXISTS idx_pools_proto_snapshot_generation');
const clSnapshotGenerationIndexSql = `CREATE INDEX IF NOT EXISTS idx_pools_cl_snapshot_generation
  ON pools(proto, snapshot_generation)
  WHERE proto = 'univ3' OR proto = 'pancakev3'`;
const normalizeSql = (sql: string): string =>
  sql
    .replace(/\bif\s+not\s+exists\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
const storedClSnapshotGenerationIndex = db
  .prepare(
    `SELECT sql FROM sqlite_master
     WHERE type = 'index' AND name = 'idx_pools_cl_snapshot_generation'`,
  )
  .get() as { sql: string } | undefined;
if (
  storedClSnapshotGenerationIndex &&
  normalizeSql(storedClSnapshotGenerationIndex.sql) !==
    normalizeSql(clSnapshotGenerationIndexSql)
)
  db.exec('DROP INDEX idx_pools_cl_snapshot_generation');
db.exec(`${clSnapshotGenerationIndexSql};`);
db.exec(`
CREATE TABLE IF NOT EXISTS v23_catalog_clock (
  singleton              INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_seq               INTEGER NOT NULL,
  generation             INTEGER NOT NULL,
  pancake_v2_generation  INTEGER NOT NULL DEFAULT 0
);
`);
// Older databases only have the global destructive generation. Seed the new
// Pancake V2 fence from it so a valid published snapshot stays valid when both
// values matched, while an already-detected mismatch remains fail-closed.
const v23CatalogClockColumns = db
  .prepare('PRAGMA table_info(v23_catalog_clock)')
  .all() as Array<{ name: string }>;
if (
  !v23CatalogClockColumns.some(
    (column) => column.name === 'pancake_v2_generation',
  )
)
  db.exec(
    'ALTER TABLE v23_catalog_clock ADD COLUMN pancake_v2_generation INTEGER',
  );
db.exec(`
  UPDATE v23_catalog_clock
  SET pancake_v2_generation = generation
  WHERE pancake_v2_generation IS NULL;
`);
// Avoid re-running MAX over a multi-million-row catalog on every process
// start. The scan is needed only once if an interrupted/older migration has
// sequence values but no clock row yet.
const hasV23CatalogClock = db
  .prepare('SELECT 1 AS present FROM v23_catalog_clock WHERE singleton = 1')
  .get();
if (!hasV23CatalogClock)
  db.exec(`
    INSERT INTO v23_catalog_clock(
      singleton, next_seq, generation, pancake_v2_generation
    )
    SELECT 1, COALESCE(MAX(catalog_seq), 0), 0, 0 FROM pools;
  `);

// Protocol-scoped landing indexes let a Pancake-only request find Pancake's
// actual top rows even when another venue owns every global top slot. Migrate
// old DBs before preparing any statements that reference the new columns.
const protoTables = ['pool_state', 'pool_stats', 'hydration_demand'] as const;
for (const table of protoTables) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === 'proto')) db.exec(`ALTER TABLE ${table} ADD COLUMN proto TEXT`);
}
for (const table of protoTables) {
  const missing = db.prepare(`SELECT 1 FROM ${table} WHERE proto IS NULL LIMIT 1`).get();
  if (missing)
    db.exec(
      `UPDATE ${table} SET proto = (SELECT proto FROM pools WHERE pools.address = ${table}.address)
       WHERE proto IS NULL`,
    );
}
db.exec(`
CREATE INDEX IF NOT EXISTS idx_state_proto_tvl
  ON pool_state(proto, tvl_usd DESC, address);
CREATE INDEX IF NOT EXISTS idx_stats_proto_vol
  ON pool_stats(proto, vol24h_usd DESC, address);
CREATE INDEX IF NOT EXISTS idx_stats_proto_liq
  ON pool_stats(proto, liq_usd DESC, address);
CREATE INDEX IF NOT EXISTS idx_pools_proto_created
  ON pools(proto, created_block DESC, pair_index DESC, address);
CREATE INDEX IF NOT EXISTS idx_hydration_demand_proto_due
  ON hydration_demand(proto, next_attempt, requested_at DESC, address);
`);

// Backfill the tiny exact counter table once for databases created before it,
// then maintain it for every write (including test/admin SQL outside insertPool).
// API polling consequently reads four rows rather than GROUP BY over millions.
const catalogCounterRows = (
  db.prepare('SELECT COUNT(*) AS n FROM pool_catalog_counts').get() as {
    n: number;
  }
).n;
if (!catalogCounterRows)
  db.exec(`
    INSERT INTO pool_catalog_counts(proto, n)
    SELECT proto, COUNT(*) FROM pools GROUP BY proto;
  `);
// UP33 reuses the pool/state tables for strategy analytics, but it is not a
// member of the public V2/V3 catalog. Replace older broad trigger bodies so an
// UP33 discovery cannot advance a public cursor or invalidate its generation.
db.exec(`
DROP TRIGGER IF EXISTS pools_catalog_fence_insert;
DROP TRIGGER IF EXISTS pools_catalog_generation_delete;
DROP TRIGGER IF EXISTS pools_catalog_generation_update;
DROP TRIGGER IF EXISTS pools_related_delete;
`);
db.exec(`
CREATE TRIGGER IF NOT EXISTS pools_catalog_count_insert
AFTER INSERT ON pools BEGIN
  INSERT INTO pool_catalog_counts(proto, n) VALUES (NEW.proto, 1)
  ON CONFLICT(proto) DO UPDATE SET n = n + 1;
END;
CREATE TRIGGER IF NOT EXISTS pools_catalog_count_delete
AFTER DELETE ON pools BEGIN
  UPDATE pool_catalog_counts SET n = n - 1 WHERE proto = OLD.proto;
END;
CREATE TRIGGER IF NOT EXISTS pools_catalog_fence_insert
AFTER INSERT ON pools
WHEN NEW.proto IN ('univ2', 'univ3', 'pancakev2', 'pancakev3') BEGIN
  UPDATE v23_catalog_clock SET next_seq = next_seq + 1 WHERE singleton = 1;
  UPDATE pools SET catalog_seq = (
    SELECT next_seq FROM v23_catalog_clock WHERE singleton = 1
  ) WHERE address = NEW.address;
END;
CREATE TRIGGER IF NOT EXISTS pools_catalog_generation_delete
AFTER DELETE ON pools
WHEN OLD.proto IN ('univ2', 'univ3', 'pancakev2', 'pancakev3') BEGIN
  UPDATE v23_catalog_clock SET generation = generation + 1 WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS pools_catalog_generation_update
AFTER UPDATE OF address, proto, token0, token1, fee_ppm, tick_spacing, created_block, pair_index
ON pools
WHEN OLD.proto IN ('univ2', 'univ3', 'pancakev2', 'pancakev3')
  OR NEW.proto IN ('univ2', 'univ3', 'pancakev2', 'pancakev3') BEGIN
  UPDATE v23_catalog_clock SET generation = generation + 1 WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS pools_pancake_v2_generation_delete
AFTER DELETE ON pools WHEN OLD.proto = 'pancakev2' BEGIN
  UPDATE v23_catalog_clock
  SET pancake_v2_generation = pancake_v2_generation + 1
  WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS pools_pancake_v2_generation_update
AFTER UPDATE OF address, proto, token0, token1, fee_ppm, tick_spacing, created_block, pair_index
ON pools WHEN OLD.proto = 'pancakev2' OR NEW.proto = 'pancakev2' BEGIN
  UPDATE v23_catalog_clock
  SET pancake_v2_generation = pancake_v2_generation + 1
  WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS pools_related_delete
AFTER DELETE ON pools BEGIN
  DELETE FROM hydration_demand WHERE address = OLD.address;
  DELETE FROM pool_state WHERE address = OLD.address;
  DELETE FROM pool_stats WHERE address = OLD.address;
  DELETE FROM pool_market_snapshots WHERE pool = OLD.address;
  DELETE FROM pool_tick_samples WHERE pool = OLD.address;
END;
CREATE TRIGGER IF NOT EXISTS pools_catalog_count_move
AFTER UPDATE OF proto ON pools WHEN OLD.proto <> NEW.proto BEGIN
  UPDATE pool_catalog_counts SET n = n - 1 WHERE proto = OLD.proto;
  INSERT INTO pool_catalog_counts(proto, n) VALUES (NEW.proto, 1)
  ON CONFLICT(proto) DO UPDATE SET n = n + 1;
END;
`);

// Existing deployments may already have the pre-generation V4 table. SQLite's
// CREATE TABLE IF NOT EXISTS does not add columns, so migrate it before any V4
// statements are prepared. A legacy completed snapshot intentionally has no
// generation and will fail readiness until it is re-imported with provenance.
const v4MarketColumns = db.prepare('PRAGMA table_info(v4_market_stats)').all() as {
  name: string;
}[];
if (!v4MarketColumns.some((column) => column.name === 'tvl_usd')) {
  db.exec(`
    ALTER TABLE v4_market_stats ADD COLUMN tvl_usd REAL;
    ALTER TABLE v4_market_stats ADD COLUMN tvl_approx INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS idx_v4_market_depth
      ON v4_market_stats(COALESCE(tvl_usd, liq_usd) DESC, pool_id);`);
for (const column of ['vol5m_usd', 'vol1h_usd', 'vol6h_usd']) {
  if (!v4MarketColumns.some((existing) => existing.name === column))
    db.exec(`ALTER TABLE v4_market_stats ADD COLUMN ${column} REAL`);
}
}

const v4PoolColumns = db.prepare('PRAGMA table_info(v4_pools)').all() as {
  name: string;
}[];
if (!v4PoolColumns.some((column) => column.name === 'snapshot_generation'))
  db.exec('ALTER TABLE v4_pools ADD COLUMN snapshot_generation TEXT');
db.exec(`
CREATE INDEX IF NOT EXISTS idx_v4_pools_generation
  ON v4_pools(snapshot_generation);
`);

// Solver adjacency is intentionally materialized instead of deriving
// DISTINCT token pairs from the identity catalogs at request time. A popular
// pair may have arbitrarily many fee tiers/PoolKeys, while these projections
// stay proportional to unique (pair, protocol) memberships.
//
// V2/V3 deletions and identity changes advance the catalog generation, so an
// in-flight traversal is rejected. Within one generation, first_seq is the
// insertion high-water mark that keeps later additions out of an older page
// traversal. That lets the live projection remain a simple active refcount
// row; no historical interval state is needed to serve a valid request.
db.exec(`
CREATE TABLE IF NOT EXISTS solver_v23_adjacency (
  proto      TEXT NOT NULL,
  token0     TEXT NOT NULL,
  token1     TEXT NOT NULL,
  first_seq  INTEGER NOT NULL,
  ref_count  INTEGER NOT NULL CHECK(ref_count > 0),
  PRIMARY KEY(proto, token0, token1)
);
CREATE INDEX IF NOT EXISTS idx_solver_v23_adjacency_t0
  ON solver_v23_adjacency(proto, token0, token1, first_seq);
CREATE INDEX IF NOT EXISTS idx_solver_v23_adjacency_t1
  ON solver_v23_adjacency(proto, token1, token0, first_seq);
-- A frozen continuation can encounter rows inserted after its fence. These
-- range-first indexes support the bounded admission query that counts at most
-- a fixed number of such rows before the token-ordered page read begins.
CREATE INDEX IF NOT EXISTS idx_solver_v23_adjacency_t0_future
  ON solver_v23_adjacency(proto, token0, first_seq, token1);
CREATE INDEX IF NOT EXISTS idx_solver_v23_adjacency_t1_future
  ON solver_v23_adjacency(proto, token1, first_seq, token0);

CREATE TABLE IF NOT EXISTS solver_v4_adjacency_snapshot (
  snapshot_generation TEXT NOT NULL,
  token0               TEXT NOT NULL,
  token1               TEXT NOT NULL,
  ref_count            INTEGER NOT NULL CHECK(ref_count > 0),
  PRIMARY KEY(snapshot_generation, token0, token1)
);
CREATE INDEX IF NOT EXISTS idx_solver_v4_adjacency_snapshot_t0
  ON solver_v4_adjacency_snapshot(snapshot_generation, token0, token1);
CREATE INDEX IF NOT EXISTS idx_solver_v4_adjacency_snapshot_t1
  ON solver_v4_adjacency_snapshot(snapshot_generation, token1, token0);

-- A PoolId can belong to both the currently-published snapshot and an
-- in-flight replacement. Keeping that membership outside v4_pools prevents a
-- resumed import from overwriting the only evidence for the published
-- generation. The canonical pair is copied here as an immutable shadow, so
-- adjacency refcounts never depend on a mutable identity join.
CREATE TABLE IF NOT EXISTS v4_pool_snapshot_membership (
  snapshot_generation TEXT NOT NULL CHECK(length(snapshot_generation) > 0),
  pool_id              TEXT NOT NULL,
  token0               TEXT NOT NULL,
  token1               TEXT NOT NULL,
  CHECK(token0 < token1),
  PRIMARY KEY(snapshot_generation, pool_id)
);
CREATE INDEX IF NOT EXISTS idx_v4_pool_snapshot_membership_pool
  ON v4_pool_snapshot_membership(pool_id, snapshot_generation);

CREATE TABLE IF NOT EXISTS solver_v4_adjacency_event (
  token0            TEXT NOT NULL,
  token1            TEXT NOT NULL,
  first_created_block INTEGER NOT NULL,
  ref_count         INTEGER NOT NULL CHECK(ref_count > 0),
  PRIMARY KEY(token0, token1)
);
CREATE INDEX IF NOT EXISTS idx_solver_v4_adjacency_event_t0
  ON solver_v4_adjacency_event(token0, token1, first_created_block);
CREATE INDEX IF NOT EXISTS idx_solver_v4_adjacency_event_t1
  ON solver_v4_adjacency_event(token1, token0, first_created_block);
CREATE INDEX IF NOT EXISTS idx_solver_v4_adjacency_event_t0_future
  ON solver_v4_adjacency_event(token0, first_created_block, token1);
CREATE INDEX IF NOT EXISTS idx_solver_v4_adjacency_event_t1_future
  ON solver_v4_adjacency_event(token1, first_created_block, token0);
`);

// Ranked connector candidates: each token's top-K neighbours by the TVL of the
// best pool on that edge. Two hub tokens on BSC have 2.4M and 241k neighbours
// and 37k in common, so a solver asking "what could connect these two" cannot
// be served by walking adjacency, and intersecting the raw projection at
// request time measures 31.7s against a 100ms handler budget.
//
// Unlike solver_v23_adjacency this cannot be trigger-maintained. A refcount is
// local and order-independent; a top-K ranking is neither, because tvl_usd
// moves on every reprice and evicting the K'th entry needs to know the K+1'th.
// So it is a whole-projection refresh published atomically inside a single
// transaction, rebuilt by the same worker that computed its input.
//
// tvl_usd is a PRE-FILTER, never a correctness input. It decides which
// candidates are considered; every pool reached through one is still
// identity-proved through its factory, and every quote is still certified by
// the routing dual. A stale or truncated ranking costs a missed candidate, not
// a bad quote — which is why an absent projection degrades the caller rather
// than failing the indexer closed the way the adjacency migration does.
//
// WITHOUT ROWID makes the primary key the table: reading one token's list is a
// prefix scan and probing the other side is an exact lookup, which is the whole
// access pattern.
db.exec(`
CREATE TABLE IF NOT EXISTS solver_connector_rank (
  token      TEXT NOT NULL,
  neighbor   TEXT NOT NULL,
  tvl_usd    REAL NOT NULL CHECK(tvl_usd > 0),
  proto_mask INTEGER NOT NULL CHECK(proto_mask > 0),
  approx     INTEGER NOT NULL CHECK(approx IN (0, 1)),
  PRIMARY KEY(token, neighbor)
) WITHOUT ROWID;
`);

// Upgrades must replace the original single-generation trigger bodies. Using
// CREATE TRIGGER IF NOT EXISTS alone would leave them installed and make the
// membership triggers below double-count projection rows.
db.exec(`
DROP TRIGGER IF EXISTS v4_pools_solver_snapshot_insert;
DROP TRIGGER IF EXISTS v4_pools_solver_snapshot_update;
DROP TRIGGER IF EXISTS solver_v4_adjacency_snapshot_gc_insert;
DROP TRIGGER IF EXISTS solver_v4_adjacency_snapshot_gc_update;
DROP TRIGGER IF EXISTS pools_solver_adjacency_insert;
DROP TRIGGER IF EXISTS pools_solver_adjacency_delete;
DROP TRIGGER IF EXISTS pools_solver_adjacency_identity_update;
`);

db.exec(`
CREATE TRIGGER IF NOT EXISTS pools_solver_adjacency_insert
AFTER INSERT ON pools
WHEN NEW.proto IN ('univ2', 'univ3', 'pancakev2', 'pancakev3') BEGIN
  INSERT INTO solver_v23_adjacency(
    proto, token0, token1, first_seq, ref_count
  ) VALUES (
    NEW.proto,
    CASE WHEN NEW.token0 < NEW.token1 THEN NEW.token0 ELSE NEW.token1 END,
    CASE WHEN NEW.token0 < NEW.token1 THEN NEW.token1 ELSE NEW.token0 END,
    COALESCE(
      (SELECT catalog_seq FROM pools WHERE address = NEW.address),
      (SELECT next_seq + 1 FROM v23_catalog_clock WHERE singleton = 1)
    ),
    1
  )
  ON CONFLICT(proto, token0, token1)
  DO UPDATE SET
    ref_count = solver_v23_adjacency.ref_count + 1,
    first_seq = MIN(
      solver_v23_adjacency.first_seq,
      excluded.first_seq
    );
END;
CREATE TRIGGER IF NOT EXISTS pools_solver_adjacency_delete
AFTER DELETE ON pools
WHEN OLD.proto IN ('univ2', 'univ3', 'pancakev2', 'pancakev3') BEGIN
  DELETE FROM solver_v23_adjacency
  WHERE proto = OLD.proto
    AND token0 = CASE WHEN OLD.token0 < OLD.token1 THEN OLD.token0 ELSE OLD.token1 END
    AND token1 = CASE WHEN OLD.token0 < OLD.token1 THEN OLD.token1 ELSE OLD.token0 END
    AND ref_count = 1;
  UPDATE solver_v23_adjacency
  SET ref_count = ref_count - 1
  WHERE proto = OLD.proto
    AND token0 = CASE WHEN OLD.token0 < OLD.token1 THEN OLD.token0 ELSE OLD.token1 END
    AND token1 = CASE WHEN OLD.token0 < OLD.token1 THEN OLD.token1 ELSE OLD.token0 END;
END;
CREATE TRIGGER IF NOT EXISTS pools_solver_adjacency_identity_update
AFTER UPDATE OF proto, token0, token1 ON pools BEGIN
  DELETE FROM solver_v23_adjacency
  WHERE proto = OLD.proto
    AND token0 = CASE WHEN OLD.token0 < OLD.token1 THEN OLD.token0 ELSE OLD.token1 END
    AND token1 = CASE WHEN OLD.token0 < OLD.token1 THEN OLD.token1 ELSE OLD.token0 END
    AND ref_count = 1;
  UPDATE solver_v23_adjacency
  SET ref_count = ref_count - 1
  WHERE proto = OLD.proto
    AND token0 = CASE WHEN OLD.token0 < OLD.token1 THEN OLD.token0 ELSE OLD.token1 END
    AND token1 = CASE WHEN OLD.token0 < OLD.token1 THEN OLD.token1 ELSE OLD.token0 END;
  INSERT INTO solver_v23_adjacency(
    proto, token0, token1, first_seq, ref_count
  ) SELECT
    NEW.proto,
    CASE WHEN NEW.token0 < NEW.token1 THEN NEW.token0 ELSE NEW.token1 END,
    CASE WHEN NEW.token0 < NEW.token1 THEN NEW.token1 ELSE NEW.token0 END,
    COALESCE(NEW.catalog_seq, 0),
    1
  WHERE NEW.proto IN ('univ2', 'univ3', 'pancakev2', 'pancakev3')
  ON CONFLICT(proto, token0, token1)
  DO UPDATE SET
    ref_count = solver_v23_adjacency.ref_count + 1,
    first_seq = MIN(
      solver_v23_adjacency.first_seq,
      excluded.first_seq
    );
END;

CREATE TRIGGER IF NOT EXISTS v4_pools_identity_immutable
BEFORE UPDATE OF pool_id, pool_manager, currency0, currency1, tick_spacing, hooks
ON v4_pools
WHEN OLD.pool_id <> NEW.pool_id
  OR OLD.pool_manager <> NEW.pool_manager
  OR OLD.currency0 <> NEW.currency0
  OR OLD.currency1 <> NEW.currency1
  OR OLD.tick_spacing <> NEW.tick_spacing
  OR OLD.hooks <> NEW.hooks BEGIN
  SELECT RAISE(ABORT, 'v4 PoolKey identity is immutable');
END;
CREATE TRIGGER IF NOT EXISTS v4_pools_snapshot_generation_validate_update
BEFORE UPDATE OF snapshot_generation ON v4_pools
WHEN OLD.snapshot_generation IS NOT NEW.snapshot_generation
  AND (NEW.snapshot_generation IS NULL OR NOT EXISTS (
    SELECT 1 FROM v4_pool_snapshot_membership m
    WHERE m.snapshot_generation = NEW.snapshot_generation
      AND m.pool_id = NEW.pool_id
  )) BEGIN
  SELECT RAISE(ABORT, 'v4 snapshot generation requires existing membership');
END;
CREATE TRIGGER IF NOT EXISTS v4_pool_snapshot_membership_validate_insert
BEFORE INSERT ON v4_pool_snapshot_membership
WHEN NOT EXISTS (
  SELECT 1 FROM v4_pools p
  WHERE p.pool_id = NEW.pool_id
    AND NEW.token0 = CASE
      WHEN p.currency0 < p.currency1 THEN p.currency0 ELSE p.currency1 END
    AND NEW.token1 = CASE
      WHEN p.currency0 < p.currency1 THEN p.currency1 ELSE p.currency0 END
) BEGIN
  SELECT RAISE(ABORT, 'v4 snapshot membership conflicts with PoolKey identity');
END;
CREATE TRIGGER IF NOT EXISTS v4_pool_snapshot_membership_immutable
BEFORE UPDATE ON v4_pool_snapshot_membership BEGIN
  SELECT RAISE(ABORT, 'v4 snapshot membership is immutable');
END;
CREATE TRIGGER IF NOT EXISTS v4_pool_snapshot_membership_protect_published
BEFORE DELETE ON v4_pool_snapshot_membership
WHEN OLD.snapshot_generation = COALESCE(
  (SELECT v FROM kv WHERE k = 'v4_snapshot_generation'), ''
) BEGIN
  SELECT RAISE(ABORT, 'cannot delete published v4 snapshot membership');
END;

CREATE TRIGGER IF NOT EXISTS v4_pools_snapshot_membership_insert
AFTER INSERT ON v4_pools WHEN NEW.snapshot_generation IS NOT NULL BEGIN
  INSERT INTO v4_pool_snapshot_membership(
    snapshot_generation, pool_id, token0, token1
  ) VALUES (
    NEW.snapshot_generation,
    NEW.pool_id,
    CASE WHEN NEW.currency0 < NEW.currency1 THEN NEW.currency0 ELSE NEW.currency1 END,
    CASE WHEN NEW.currency0 < NEW.currency1 THEN NEW.currency1 ELSE NEW.currency0 END
  )
  ON CONFLICT(snapshot_generation, pool_id) DO NOTHING;
END;
CREATE TRIGGER IF NOT EXISTS v4_pool_snapshot_membership_solver_insert
AFTER INSERT ON v4_pool_snapshot_membership BEGIN
  INSERT INTO solver_v4_adjacency_snapshot(
    snapshot_generation, token0, token1, ref_count
  ) VALUES (
    NEW.snapshot_generation,
    NEW.token0,
    NEW.token1,
    1
  )
  ON CONFLICT(snapshot_generation, token0, token1)
  DO UPDATE SET ref_count = solver_v4_adjacency_snapshot.ref_count + 1;
END;
CREATE TRIGGER IF NOT EXISTS v4_pool_snapshot_membership_solver_delete
AFTER DELETE ON v4_pool_snapshot_membership BEGIN
  DELETE FROM solver_v4_adjacency_snapshot
  WHERE snapshot_generation = OLD.snapshot_generation
    AND token0 = OLD.token0
    AND token1 = OLD.token1
    AND ref_count = 1;
  UPDATE solver_v4_adjacency_snapshot
  SET ref_count = ref_count - 1
  WHERE snapshot_generation = OLD.snapshot_generation
    AND token0 = OLD.token0
    AND token1 = OLD.token1;
END;
CREATE TRIGGER IF NOT EXISTS v4_pools_snapshot_membership_delete
BEFORE DELETE ON v4_pools BEGIN
  DELETE FROM v4_pool_snapshot_membership WHERE pool_id = OLD.pool_id;
  DELETE FROM v4_market_stats WHERE pool_id = OLD.pool_id;
END;

CREATE TRIGGER IF NOT EXISTS v4_pools_solver_event_insert
AFTER INSERT ON v4_pools
WHEN NEW.key_fee_ppm IS NOT NULL AND NEW.created_block IS NOT NULL BEGIN
  INSERT INTO solver_v4_adjacency_event(
    token0, token1, first_created_block, ref_count
  ) VALUES (
    CASE WHEN NEW.currency0 < NEW.currency1 THEN NEW.currency0 ELSE NEW.currency1 END,
    CASE WHEN NEW.currency0 < NEW.currency1 THEN NEW.currency1 ELSE NEW.currency0 END,
    NEW.created_block,
    1
  )
  ON CONFLICT(token0, token1) DO UPDATE SET
    ref_count = solver_v4_adjacency_event.ref_count + 1,
    first_created_block = MIN(
      solver_v4_adjacency_event.first_created_block,
      excluded.first_created_block
    );
END;
CREATE TRIGGER IF NOT EXISTS v4_pools_solver_event_update
AFTER UPDATE OF key_fee_ppm, created_block ON v4_pools
WHEN (OLD.key_fee_ppm IS NULL OR OLD.created_block IS NULL)
  AND NEW.key_fee_ppm IS NOT NULL AND NEW.created_block IS NOT NULL BEGIN
  -- PoolManager Initialize identities are append-only. The only supported
  -- UPDATE fills a Graph candidate's previously-null event proof; production
  -- cleanup explicitly preserves every event-proven row.
  INSERT INTO solver_v4_adjacency_event(
    token0, token1, first_created_block, ref_count
  )
  SELECT
    CASE WHEN NEW.currency0 < NEW.currency1 THEN NEW.currency0 ELSE NEW.currency1 END,
    CASE WHEN NEW.currency0 < NEW.currency1 THEN NEW.currency1 ELSE NEW.currency0 END,
    NEW.created_block,
    1
  WHERE NEW.key_fee_ppm IS NOT NULL AND NEW.created_block IS NOT NULL
  ON CONFLICT(token0, token1) DO UPDATE SET
    ref_count = solver_v4_adjacency_event.ref_count + 1,
    first_created_block = MIN(
      solver_v4_adjacency_event.first_created_block,
      excluded.first_created_block
    );
END;

-- deleteStaleV4SnapshotCandidates first arms one exact, already-validated
-- generation. Updating the public generation is then the switch point: only
-- the armed generation can update the compatibility column, GC old membership
-- shadows/projections, and remove stale Graph-only identities. Unrelated KV
-- corruption or diagnostics cannot destroy the published shadow.
CREATE TRIGGER IF NOT EXISTS solver_v4_snapshot_publish_armed_insert
BEFORE INSERT ON kv
WHEN NEW.k = 'v4_snapshot_generation' AND NEW.v <> ''
  -- INSERT ... ON CONFLICT DO UPDATE runs BEFORE INSERT triggers before it
  -- discovers the existing KV row. Preserve exact idempotent writes here too.
  AND NEW.v <> COALESCE(
    (SELECT v FROM kv WHERE k = 'v4_snapshot_generation'), ''
  )
  AND NEW.v <> COALESCE(
    (SELECT v FROM kv WHERE k = 'v4_snapshot_publish_generation'), ''
  ) BEGIN
  SELECT RAISE(ABORT, 'v4 snapshot generation switch is not armed');
END;
CREATE TRIGGER IF NOT EXISTS solver_v4_snapshot_publish_armed_update
BEFORE UPDATE OF v ON kv
WHEN NEW.k = 'v4_snapshot_generation' AND NEW.v <> ''
  AND NEW.v <> OLD.v
  AND NEW.v <> COALESCE(
    (SELECT v FROM kv WHERE k = 'v4_snapshot_publish_generation'), ''
  ) BEGIN
  SELECT RAISE(ABORT, 'v4 snapshot generation switch is not armed');
END;
CREATE TRIGGER IF NOT EXISTS solver_v4_snapshot_publish_validate_insert
BEFORE INSERT ON kv
WHEN NEW.k = 'v4_snapshot_generation' AND NEW.v <> ''
  AND NEW.v = COALESCE(
    (SELECT v FROM kv WHERE k = 'v4_snapshot_publish_generation'), ''
  )
  AND (
    (SELECT v FROM kv WHERE k = 'v4_snapshot_pool_count') IS NULL
    OR CAST((SELECT v FROM kv WHERE k = 'v4_snapshot_pool_count') AS INTEGER) <= 0
    OR CAST(CAST(
      (SELECT v FROM kv WHERE k = 'v4_snapshot_pool_count') AS INTEGER
    ) AS TEXT) <> (SELECT v FROM kv WHERE k = 'v4_snapshot_pool_count')
    OR CAST(
      (SELECT v FROM kv WHERE k = 'v4_snapshot_pool_count') AS INTEGER
    ) <> (
      SELECT COUNT(*) FROM v4_pool_snapshot_membership
      WHERE snapshot_generation = NEW.v
    )
  ) BEGIN
  SELECT RAISE(ABORT, 'cannot publish incomplete v4 snapshot membership');
END;
CREATE TRIGGER IF NOT EXISTS solver_v4_snapshot_publish_validate_update
BEFORE UPDATE OF v ON kv
WHEN NEW.k = 'v4_snapshot_generation' AND NEW.v <> ''
  AND NEW.v = COALESCE(
    (SELECT v FROM kv WHERE k = 'v4_snapshot_publish_generation'), ''
  )
  AND (
    (SELECT v FROM kv WHERE k = 'v4_snapshot_pool_count') IS NULL
    OR CAST((SELECT v FROM kv WHERE k = 'v4_snapshot_pool_count') AS INTEGER) <= 0
    OR CAST(CAST(
      (SELECT v FROM kv WHERE k = 'v4_snapshot_pool_count') AS INTEGER
    ) AS TEXT) <> (SELECT v FROM kv WHERE k = 'v4_snapshot_pool_count')
    OR CAST(
      (SELECT v FROM kv WHERE k = 'v4_snapshot_pool_count') AS INTEGER
    ) <> (
      SELECT COUNT(*) FROM v4_pool_snapshot_membership
      WHERE snapshot_generation = NEW.v
    )
  ) BEGIN
  SELECT RAISE(ABORT, 'cannot publish incomplete v4 snapshot membership');
END;
CREATE TRIGGER IF NOT EXISTS solver_v4_adjacency_snapshot_gc_insert
AFTER INSERT ON kv
WHEN NEW.k = 'v4_snapshot_generation' AND NEW.v <> ''
  AND NEW.v = COALESCE(
    (SELECT v FROM kv WHERE k = 'v4_snapshot_publish_generation'), ''
  ) BEGIN
  UPDATE v4_pools
  SET snapshot_generation = NEW.v
  WHERE EXISTS (
    SELECT 1 FROM v4_pool_snapshot_membership m
    WHERE m.snapshot_generation = NEW.v AND m.pool_id = v4_pools.pool_id
  );
  DELETE FROM v4_pool_snapshot_membership
  WHERE snapshot_generation <> NEW.v;
  DELETE FROM solver_v4_adjacency_snapshot
  WHERE snapshot_generation <> NEW.v;
  DELETE FROM v4_pools
  WHERE NOT EXISTS (
    SELECT 1 FROM v4_pool_snapshot_membership m
    WHERE m.snapshot_generation = NEW.v AND m.pool_id = v4_pools.pool_id
  ) AND NOT (key_fee_ppm IS NOT NULL AND created_block IS NOT NULL);
  DELETE FROM v4_pool_days WHERE pool_id NOT IN (SELECT pool_id FROM v4_pools);
  DELETE FROM v4_pool_stats WHERE pool_id NOT IN (SELECT pool_id FROM v4_pools);
  DELETE FROM kv WHERE k = 'v4_snapshot_publish_generation';
END;
CREATE TRIGGER IF NOT EXISTS solver_v4_adjacency_snapshot_gc_update
AFTER UPDATE OF v ON kv
WHEN NEW.k = 'v4_snapshot_generation' AND NEW.v <> ''
  AND NEW.v = COALESCE(
    (SELECT v FROM kv WHERE k = 'v4_snapshot_publish_generation'), ''
  ) BEGIN
  UPDATE v4_pools
  SET snapshot_generation = NEW.v
  WHERE EXISTS (
    SELECT 1 FROM v4_pool_snapshot_membership m
    WHERE m.snapshot_generation = NEW.v AND m.pool_id = v4_pools.pool_id
  );
  DELETE FROM v4_pool_snapshot_membership
  WHERE snapshot_generation <> NEW.v;
  DELETE FROM solver_v4_adjacency_snapshot
  WHERE snapshot_generation <> NEW.v;
  DELETE FROM v4_pools
  WHERE NOT EXISTS (
    SELECT 1 FROM v4_pool_snapshot_membership m
    WHERE m.snapshot_generation = NEW.v AND m.pool_id = v4_pools.pool_id
  ) AND NOT (key_fee_ppm IS NOT NULL AND created_block IS NOT NULL);
  DELETE FROM v4_pool_days WHERE pool_id NOT IN (SELECT pool_id FROM v4_pools);
  DELETE FROM v4_pool_stats WHERE pool_id NOT IN (SELECT pool_id FROM v4_pools);
  DELETE FROM kv WHERE k = 'v4_snapshot_publish_generation';
END;
`);

// A database opened once by the broad pre-UP33 triggers may already contain
// an unreachable UP33 adjacency row. Removing only unsupported protocol keys
// is cheap, idempotent, and avoids requiring a full offline projection rebuild.
db.exec(`DELETE FROM solver_v23_adjacency
         WHERE proto NOT IN ('univ2', 'univ3', 'pancakev2', 'pancakev3')`);

// Never rebuild a large legacy catalog during synchronous module import. A
// fresh empty DB is immediately ready because all later writes hit the
// projection triggers. A DB with existing identities stays fail-closed until
// the explicit offline migration below completes atomically.
const solverAdjacencyProjectionVersion = (
  db.prepare("SELECT v FROM kv WHERE k = 'solver_adjacency_projection_version'").get() as
    | { v: string }
    | undefined
)?.v;
const solverV4MembershipSchemaVersion = (
  db.prepare("SELECT v FROM kv WHERE k = 'solver_v4_membership_schema_version'").get() as
    | { v: string }
    | undefined
)?.v;
if (
  solverAdjacencyProjectionVersion === undefined ||
  solverV4MembershipSchemaVersion === undefined
) {
  const hasExistingCatalog =
    db.prepare('SELECT 1 AS present FROM pools LIMIT 1').get() !== undefined ||
    db.prepare('SELECT 1 AS present FROM v4_pools LIMIT 1').get() !== undefined;
  const version = hasExistingCatalog ? 'pending' : '1';
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO kv(k, v) VALUES ('solver_adjacency_projection_version', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    ).run(version);
    db.prepare(
      `INSERT INTO kv(k, v) VALUES ('solver_v4_membership_schema_version', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    ).run(version);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// ---- kv ----
const kvGetQ = db.prepare('SELECT v FROM kv WHERE k = ?');
const kvSetQ = db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
export const kvGet = (k: string): string | undefined => (kvGetQ.get(k) as { v: string } | undefined)?.v;
export const kvSet = (k: string, v: string) => void kvSetQ.run(k, v);

export const solverAdjacencyProjectionReady = (): boolean =>
  kvGet('solver_adjacency_projection_version') === '1' &&
  kvGet('solver_v4_membership_schema_version') === '1';

/**
 * Build the projection explicitly while the serving indexer is stopped. The
 * potentially large scans are never part of application startup, and readers
 * see either the previous complete projection or the fully committed rebuild.
 */
export function rebuildSolverAdjacencyProjection(): void {
  // Persist the fail-closed state before the large transaction. If the process
  // is interrupted, SQLite rolls the rebuild back but readiness stays pending.
  db.exec(`
    BEGIN IMMEDIATE;
    INSERT INTO kv(k, v) VALUES ('solver_adjacency_projection_version', 'pending')
    ON CONFLICT(k) DO UPDATE SET v = excluded.v;
    INSERT INTO kv(k, v) VALUES ('solver_v4_membership_schema_version', 'pending')
    ON CONFLICT(k) DO UPDATE SET v = excluded.v;
    COMMIT;
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      -- One-time legacy seed. Later imports add a second membership instead of
      -- overwriting the compatibility column, so repeated rebuilds preserve
      -- both the published and resumable in-flight shadows.
      INSERT OR IGNORE INTO v4_pool_snapshot_membership(
        snapshot_generation, pool_id, token0, token1
      )
      SELECT
        snapshot_generation,
        pool_id,
        CASE WHEN currency0 < currency1 THEN currency0 ELSE currency1 END,
        CASE WHEN currency0 < currency1 THEN currency1 ELSE currency0 END
      FROM v4_pools
      WHERE snapshot_generation IS NOT NULL;

      DELETE FROM solver_v23_adjacency;
      INSERT INTO solver_v23_adjacency(
        proto, token0, token1, first_seq, ref_count
      )
      SELECT
        proto,
        CASE WHEN token0 < token1 THEN token0 ELSE token1 END,
        CASE WHEN token0 < token1 THEN token1 ELSE token0 END,
        MIN(COALESCE(catalog_seq, 0)),
        COUNT(*)
      FROM pools
      WHERE proto IN ('univ2', 'univ3', 'pancakev2', 'pancakev3')
      GROUP BY
        proto,
        CASE WHEN token0 < token1 THEN token0 ELSE token1 END,
        CASE WHEN token0 < token1 THEN token1 ELSE token0 END;

      DELETE FROM solver_v4_adjacency_snapshot;
      INSERT INTO solver_v4_adjacency_snapshot(
        snapshot_generation, token0, token1, ref_count
      )
      SELECT
        snapshot_generation,
        token0,
        token1,
        COUNT(*)
      FROM v4_pool_snapshot_membership
      GROUP BY
        snapshot_generation,
        token0,
        token1;

      DELETE FROM solver_v4_adjacency_event;
      INSERT INTO solver_v4_adjacency_event(
        token0, token1, first_created_block, ref_count
      )
      SELECT
        CASE WHEN currency0 < currency1 THEN currency0 ELSE currency1 END,
        CASE WHEN currency0 < currency1 THEN currency1 ELSE currency0 END,
        MIN(created_block),
        COUNT(*)
      FROM v4_pools
      WHERE key_fee_ppm IS NOT NULL AND created_block IS NOT NULL
      GROUP BY
        CASE WHEN currency0 < currency1 THEN currency0 ELSE currency1 END,
        CASE WHEN currency0 < currency1 THEN currency1 ELSE currency0 END;

    `);

    const membershipMismatch = db.prepare(`
      SELECT 1 AS invalid
      FROM v4_pool_snapshot_membership m
      LEFT JOIN v4_pools p ON p.pool_id = m.pool_id
      WHERE p.pool_id IS NULL
         OR m.token0 <> CASE
              WHEN p.currency0 < p.currency1 THEN p.currency0 ELSE p.currency1 END
         OR m.token1 <> CASE
              WHEN p.currency0 < p.currency1 THEN p.currency1 ELSE p.currency0 END
      LIMIT 1
    `).get();
    if (membershipMismatch)
      throw new Error('solver V4 snapshot membership conflicts with the identity catalog');

    if (kvGet('v4_snapshot_complete') === '1') {
      const generation = kvGet('v4_snapshot_generation')?.trim() ?? '';
      const expected = Number(kvGet('v4_snapshot_pool_count'));
      if (
        generation.length === 0 ||
        !Number.isSafeInteger(expected) ||
        expected <= 0 ||
        v4SnapshotGenerationCount(generation) !== expected
      )
        throw new Error('published V4 snapshot membership is incomplete');
    }

    const totals = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM pools) AS v23_source,
        (SELECT COALESCE(SUM(ref_count), 0) FROM solver_v23_adjacency) AS v23_projected,
        (SELECT COUNT(*) FROM v4_pool_snapshot_membership) AS v4_snapshot_source,
        (SELECT COALESCE(SUM(ref_count), 0) FROM solver_v4_adjacency_snapshot) AS v4_snapshot_projected,
        (SELECT COUNT(*) FROM v4_pools
          WHERE key_fee_ppm IS NOT NULL AND created_block IS NOT NULL) AS v4_event_source,
        (SELECT COALESCE(SUM(ref_count), 0) FROM solver_v4_adjacency_event) AS v4_event_projected
    `).get() as {
      v23_source: number;
      v23_projected: number;
      v4_snapshot_source: number;
      v4_snapshot_projected: number;
      v4_event_source: number;
      v4_event_projected: number;
    };
    if (
      totals.v23_source !== totals.v23_projected ||
      totals.v4_snapshot_source !== totals.v4_snapshot_projected ||
      totals.v4_event_source !== totals.v4_event_projected
    )
      throw new Error('solver adjacency projection completeness validation failed');

    db.exec(`
      INSERT INTO kv(k, v) VALUES ('solver_adjacency_projection_version', '1')
      ON CONFLICT(k) DO UPDATE SET v = excluded.v;
      INSERT INTO kv(k, v) VALUES ('solver_v4_membership_schema_version', '1')
      ON CONFLICT(k) DO UPDATE SET v = excluded.v;
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Neighbours kept per token in the ranked connector projection. */
export const SOLVER_CONNECTOR_RANK_K = 256;

/**
 * Bit position of each V2/V3 protocol in a solver protocol mask. The API layer
 * extends this with univ4, so keeping the shared bits in one place is what stops
 * the two assignments from drifting apart unnoticed.
 */
export const SOLVER_PROTO_BIT: Record<Exclude<PoolProto, 'up33cl'>, number> = {
  univ2: 0,
  univ3: 1,
  pancakev2: 2,
  pancakev3: 3,
};

const rankedProtoList = Object.keys(SOLVER_PROTO_BIT)
  .map((proto) => `'${proto}'`)
  .join(', ');
const rankedProtoBitCase = `CASE p.proto ${Object.entries(SOLVER_PROTO_BIT)
  .map(([proto, bit]) => `WHEN '${proto}' THEN ${1 << bit}`)
  .join(' ')} END`;

export type SolverConnectorRankMeta = {
  builtAt: number;
  v23Seq: string;
  v23Generation: string;
  rows: number;
  tokens: number;
  k: number;
};

const connectorRankMetaQ = db.prepare(
  `SELECT k, v FROM kv WHERE k LIKE 'solver_connector_rank_%'`,
);

/** Provenance of the published ranking, or undefined when none is published. */
export function solverConnectorRankMeta(): SolverConnectorRankMeta | undefined {
  const stamps = new Map(
    (connectorRankMetaQ.all() as { k: string; v: string }[]).map((row) => [row.k, row.v]),
  );
  const builtAt = Number(stamps.get('solver_connector_rank_built_at'));
  const rows = Number(stamps.get('solver_connector_rank_rows'));
  if (!Number.isSafeInteger(builtAt) || builtAt <= 0 || !Number.isSafeInteger(rows) || rows <= 0)
    return undefined;
  return {
    builtAt,
    v23Seq: stamps.get('solver_connector_rank_v23_seq') ?? '0',
    v23Generation: stamps.get('solver_connector_rank_v23_generation') ?? '0',
    rows,
    tokens: Number(stamps.get('solver_connector_rank_tokens') ?? 0),
    k: Number(stamps.get('solver_connector_rank_k') ?? SOLVER_CONNECTOR_RANK_K),
  };
}

const RANK_STAGE_SCHEMA = `
  CREATE TABLE rankstage.rank(
    token      TEXT NOT NULL,
    neighbor   TEXT NOT NULL,
    tvl_usd    REAL NOT NULL,
    proto_mask INTEGER NOT NULL,
    approx     INTEGER NOT NULL
  );
`;

const RANK_STAGE_BUILD = `
  INSERT INTO rankstage.rank(token, neighbor, tvl_usd, proto_mask, approx)
  WITH edge AS (
    SELECT
      CASE WHEN p.token0 < p.token1 THEN p.token0 ELSE p.token1 END AS a,
      CASE WHEN p.token0 < p.token1 THEN p.token1 ELSE p.token0 END AS b,
      -- SQLite carries bare columns from the row that produced a lone
      -- MAX(), so approx describes the best pool and not the group.
      MAX(s.tvl_usd) AS tvl,
      s.tvl_approx AS approx,
      -- There is no bit_or aggregate. The protocol bits are distinct powers
      -- of two, so summing the distinct values is exactly their OR, and the
      -- proto filter below is what keeps an unmapped protocol from
      -- contributing a NULL the CHECK would then have to catch.
      SUM(DISTINCT ${rankedProtoBitCase}) AS mask
    -- CROSS JOIN pins the drive order rather than expressing a cartesian
    -- product. Left free, the planner walks all 2.8M pools by protocol and
    -- probes pool_state per row; driving from the ~360k priced rows instead
    -- measured 123s -> 78s against the production catalog.
    FROM pool_state s CROSS JOIN pools p ON p.address = s.address
    WHERE s.tvl_usd IS NOT NULL
      AND s.tvl_usd > 0
      AND p.token0 <> p.token1
      AND p.proto IN (${rankedProtoList})
    GROUP BY a, b
  ),
  directed AS (
    SELECT a AS token, b AS neighbor, tvl, approx, mask FROM edge
    UNION ALL
    SELECT b AS token, a AS neighbor, tvl, approx, mask FROM edge
  ),
  ranked AS (
    SELECT
      token, neighbor, tvl, approx, mask,
      ROW_NUMBER() OVER (
        PARTITION BY token ORDER BY tvl DESC, neighbor ASC
      ) AS rn
    FROM directed
  )
  SELECT token, neighbor, tvl, mask, approx
  FROM ranked
  WHERE rn <= ${SOLVER_CONNECTOR_RANK_K}
  -- Staged in primary-key order so the publish below appends to the
  -- WITHOUT ROWID b-tree instead of splitting pages across it.
  ORDER BY token, neighbor
`;

function discardRankStage(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
}

/**
 * Rebuild every token's top-K neighbour ranking from current pool state and
 * publish it atomically.
 *
 * The scan is built into a throwaway database attached beside the catalog, and
 * only the publish runs against the live one. Doing the whole rebuild inside
 * one `BEGIN IMMEDIATE` would hold the catalog's write lock for its full
 * duration, and the tail sync, logtail and state sweeps that share this file
 * would queue behind it until their busy timeout expired. Measured against the
 * production catalog: the staged build takes 22.3s and takes no write lock at
 * all, while the publish it feeds takes 1.0s.
 *
 * Correctness of the emitted rows is settled by fixture tests rather than by
 * asserts here: the aggregate identities this depends on (bare columns carried
 * from a lone MAX, distinct power-of-two bits summing to their OR) either hold
 * for every group or for none. The one defect that scales with the data, and so
 * is worth re-checking against real input, is a truncation that failed to bound
 * a hub token's list.
 */
export function rebuildSolverConnectorRank(): SolverConnectorRankMeta {
  const startedMs = Date.now();
  const clock = v23CatalogClock();
  // Beside the catalog, so the staging file cannot land on a filesystem with
  // different free space than the database it is sized against.
  const stagePath = `${DB_PATH}.rankstage`;
  discardRankStage(stagePath);
  db.prepare('ATTACH DATABASE ? AS rankstage').run(stagePath);
  try {
    db.exec(RANK_STAGE_SCHEMA);
    db.exec(RANK_STAGE_BUILD);

    const widest = db
      .prepare(
        `SELECT COUNT(*) AS n FROM rankstage.rank
         GROUP BY token ORDER BY n DESC LIMIT 1`,
      )
      .get() as { n: number } | undefined;
    if (widest !== undefined && widest.n > SOLVER_CONNECTOR_RANK_K)
      throw new Error('solver connector ranking exceeded its per-token cap');

    const totals = db
      .prepare(
        `SELECT COUNT(*) AS edge_rows, COUNT(DISTINCT token) AS tokens
         FROM rankstage.rank`,
      )
      .get() as { edge_rows: number; tokens: number };

    return publishSolverConnectorRank(clock, totals, startedMs);
  } finally {
    db.exec('DETACH DATABASE rankstage');
    discardRankStage(stagePath);
  }
}

/** The only part that takes the catalog's write lock. */
function publishSolverConnectorRank(
  clock: { seq: string; generation: string },
  totals: { edge_rows: number; tokens: number },
  startedMs: number,
): SolverConnectorRankMeta {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM solver_connector_rank');
    db.exec(
      `INSERT INTO solver_connector_rank(token, neighbor, tvl_usd, proto_mask, approx)
       SELECT token, neighbor, tvl_usd, proto_mask, approx FROM rankstage.rank
       ORDER BY token, neighbor`,
    );

    const meta: SolverConnectorRankMeta = {
      builtAt: now(),
      v23Seq: clock.seq,
      v23Generation: clock.generation,
      rows: totals.edge_rows,
      tokens: totals.tokens,
      k: SOLVER_CONNECTOR_RANK_K,
    };
    // Stamped inside the same transaction as the rows, so a reader sees the
    // previous complete ranking with its own provenance or this one, never a
    // ranking described by the wrong build.
    const stamp = db.prepare(
      `INSERT INTO kv(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    );
    stamp.run('solver_connector_rank_built_at', String(meta.builtAt));
    stamp.run('solver_connector_rank_v23_seq', meta.v23Seq);
    stamp.run('solver_connector_rank_v23_generation', meta.v23Generation);
    stamp.run('solver_connector_rank_rows', String(meta.rows));
    stamp.run('solver_connector_rank_tokens', String(meta.tokens));
    stamp.run('solver_connector_rank_k', String(meta.k));
    stamp.run('solver_connector_rank_ms', String(Date.now() - startedMs));
    db.exec('COMMIT');
    return meta;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export type SolverConnectorCandidate = {
  token: string;
  bottleneckUsd: number;
  aTvlUsd: number;
  bTvlUsd: number;
  /**
   * Each leg's own protocols, narrowed to the requested scope. They are
   * reported separately because a two-hop route never requires one protocol to
   * carry both legs; intersecting them would deny a route that is entirely
   * available, such as a Uniswap first hop into a Pancake second.
   */
  aProtocolMask: number;
  bProtocolMask: number;
  approx: boolean;
};

// One indexed probe per row of the smaller list. Both sides are capped at K, so
// the whole intersection is bounded work no matter how popular the endpoints
// are — which is the entire reason the ranking is materialized.
const connectorCandidatesQ = db.prepare(
  `SELECT
     a.neighbor AS token,
     a.tvl_usd AS a_tvl,
     b.tvl_usd AS b_tvl,
     (a.proto_mask & ?) AS a_mask,
     (b.proto_mask & ?) AS b_mask,
     MAX(a.approx, b.approx) AS approx,
     MIN(a.tvl_usd, b.tvl_usd) AS bottleneck
   FROM solver_connector_rank a
   JOIN solver_connector_rank b
     ON b.token = ? AND b.neighbor = a.neighbor
   WHERE a.token = ?
     AND a.neighbor <> b.token
     AND (a.proto_mask & ?) <> 0
     AND (b.proto_mask & ?) <> 0
   ORDER BY bottleneck DESC, a.neighbor ASC
   LIMIT ?`,
);

const connectorRankTokenStatsQ = db.prepare(
  `SELECT COUNT(*) AS n, MIN(tvl_usd) AS floor
   FROM solver_connector_rank WHERE token = ?`,
);

export type SolverConnectorSide = {
  /** Neighbours the ranking holds for this token, at most K. */
  ranked: number;
  /**
   * True when the list filled its budget, so neighbours below `floorUsd` exist
   * but were never considered.
   */
  truncated: boolean;
  floorUsd: number | null;
};

export function solverConnectorSide(token: string): SolverConnectorSide {
  const row = connectorRankTokenStatsQ.get(token) as { n: number; floor: number | null };
  return {
    ranked: row.n,
    truncated: row.n >= SOLVER_CONNECTOR_RANK_K,
    floorUsd: row.floor,
  };
}

/**
 * Tokens ranked highly by both endpoints, ordered by the thinner leg — what a
 * two-hop route through the candidate can actually carry.
 *
 * `tvl_usd` is the best pool on an edge across every protocol, so a caller
 * asking for a narrow protocol scope can see a figure earned by a pool outside
 * it. That over-states rather than under-states a candidate, which is the safe
 * direction for a pre-filter whose only failure mode worth avoiding is
 * discarding something worth having.
 */
export function solverConnectorCandidates(
  tokenA: string,
  tokenB: string,
  protocolMask: number,
  limit: number,
): SolverConnectorCandidate[] {
  const rows = connectorCandidatesQ.all(
    protocolMask,
    protocolMask,
    tokenB,
    tokenA,
    protocolMask,
    protocolMask,
    limit,
  ) as {
    token: string;
    a_tvl: number;
    b_tvl: number;
    a_mask: number;
    b_mask: number;
    approx: number;
    bottleneck: number;
  }[];
  return rows.map((row) => ({
    token: row.token,
    bottleneckUsd: row.bottleneck,
    aTvlUsd: row.a_tvl,
    bTvlUsd: row.b_tvl,
    aProtocolMask: row.a_mask,
    bProtocolMask: row.b_mask,
    approx: row.approx === 1,
  }));
}

const v23CatalogClockQ = db.prepare(
  `SELECT CAST(next_seq AS TEXT) AS seq, CAST(generation AS TEXT) AS generation
   FROM v23_catalog_clock WHERE singleton = 1`,
);
/** Durable V2/V3 insertion fence and destructive-change generation. */
export function v23CatalogClock(): { seq: string; generation: string } {
  return v23CatalogClockQ.get() as { seq: string; generation: string };
}

const pancakeV2CatalogGenerationQ = db.prepare(
  `SELECT CAST(pancake_v2_generation AS TEXT) AS generation
   FROM v23_catalog_clock WHERE singleton = 1`,
);
/** Destructive identity-change fence scoped to the Pancake V2 catalog. */
export function pancakeV2CatalogGeneration(): string {
  return (pancakeV2CatalogGenerationQ.get() as { generation: string }).generation;
}

// ---- pools ----
const insPoolQ = db.prepare(`
  INSERT OR IGNORE INTO pools (
    address, proto, token0, token1, fee_ppm, unstaked_fee_ppm, gauge,
    tick_spacing, created_block, pair_index, snapshot_generation, added_ts
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
/** returns true when the pool is new */
export type PoolProto = 'univ2' | 'univ3' | 'pancakev2' | 'pancakev3' | 'up33cl';

export function insertPool(p: {
  address: string;
  proto: PoolProto;
  token0: string;
  token1: string;
  feePpm: number;
  unstakedFeePpm?: number;
  gauge?: string;
  tickSpacing?: number;
  createdBlock?: number;
  pairIndex?: number;
  /** Immutable Graph import generation; live event-tail rows leave this null. */
  snapshotGeneration?: string;
  /** Historical snapshots use 0 so millions of old rows are not "new" work. */
  addedTs?: number;
}): boolean {
  const r = insPoolQ.run(
    p.address.toLowerCase(),
    p.proto,
    p.token0.toLowerCase(),
    p.token1.toLowerCase(),
    p.feePpm,
    p.unstakedFeePpm ?? 0,
    p.gauge?.toLowerCase() ?? null,
    p.tickSpacing ?? null,
    p.createdBlock ?? null,
    p.pairIndex ?? null,
    p.snapshotGeneration ?? null,
    p.addedTs ?? now(),
  );
  return Number(r.changes) > 0;
}

export type PoolRow = {
  address: string;
  proto: PoolProto;
  token0: string;
  token1: string;
  fee_ppm: number;
  unstaked_fee_ppm: number;
  gauge: string | null;
  tick_spacing: number | null;
};
const poolsByAddrQ = db.prepare(
  'SELECT address, proto, token0, token1, fee_ppm, unstaked_fee_ppm, gauge, tick_spacing FROM pools WHERE address = ?',
);
export const poolRow = (addr: string) => poolsByAddrQ.get(addr.toLowerCase()) as PoolRow | undefined;

const updatePoolStaticQ = db.prepare(
  'UPDATE pools SET fee_ppm=?, unstaked_fee_ppm=?, tick_spacing=?, gauge=? WHERE address=? AND proto=\'up33cl\'',
);
export const updateUp33PoolStatic = (
  address: string,
  feePpm: number,
  unstakedFeePpm: number,
  tickSpacing: number,
  gauge?: string,
): void => void updatePoolStaticQ.run(
  feePpm,
  unstakedFeePpm,
  tickSpacing,
  gauge?.toLowerCase() ?? null,
  address.toLowerCase(),
);

export const protocolPoolAddrs = (proto: PoolProto): string[] =>
  (db.prepare('SELECT address FROM pools WHERE proto=? ORDER BY address').all(proto) as { address: string }[])
    .map((row) => row.address);

const setPoolSnapshotGenerationQ = db.prepare(
  'UPDATE pools SET snapshot_generation = ? WHERE address = ? AND proto = ?',
);
/** Mark an already identity-verified row as present in an immutable snapshot. */
export function setPoolSnapshotGeneration(
  address: string,
  proto: Extract<PoolProto, 'univ3' | 'pancakev3'>,
  generation: string,
): void {
  if (proto !== 'univ3' && proto !== 'pancakev3')
    throw new Error('snapshot-generation marking is CL-only');
  const result = setPoolSnapshotGenerationQ.run(
    generation,
    address.toLowerCase(),
    proto,
  );
  if (Number(result.changes) !== 1)
    throw new Error(`cannot mark missing ${proto} pool snapshot generation`);
}

const deleteUniv3OutsideSnapshotGenerationQ = db.prepare(`
  DELETE FROM pools
  WHERE (proto = 'univ3' OR proto = 'pancakev3')
    AND proto = 'univ3'
    AND (snapshot_generation IS NULL OR snapshot_generation <> ?)`);
const deletePancakeV3OutsideSnapshotGenerationQ = db.prepare(`
  DELETE FROM pools
  WHERE (proto = 'univ3' OR proto = 'pancakev3')
    AND proto = 'pancakev3'
    AND (snapshot_generation IS NULL OR snapshot_generation <> ?)`);
const deleteUniv3SnapshotGenerationQ = db.prepare(`
  DELETE FROM pools
  WHERE (proto = 'univ3' OR proto = 'pancakev3')
    AND proto = 'univ3' AND snapshot_generation = ?`);
const deletePancakeV3SnapshotGenerationQ = db.prepare(`
  DELETE FROM pools
  WHERE (proto = 'univ3' OR proto = 'pancakev3')
    AND proto = 'pancakev3' AND snapshot_generation = ?`);
/**
 * Complete a protocol snapshot replacement. Pool delete triggers atomically
 * remove stale state/stats and advance the destructive catalog-generation
 * fence, so no orphan candidate survives publication.
 */
export function deletePoolsOutsideSnapshotGeneration(
  proto: Extract<PoolProto, 'univ3' | 'pancakev3'>,
  generation: string,
): number {
  const query =
    proto === 'univ3'
      ? deleteUniv3OutsideSnapshotGenerationQ
      : proto === 'pancakev3'
        ? deletePancakeV3OutsideSnapshotGenerationQ
        : null;
  if (!query) throw new Error('snapshot-generation pruning is CL-only');
  return Number(query.run(generation).changes);
}

/** Discard one interrupted/orphan CL import without touching other generations. */
export function deletePoolSnapshotGeneration(
  proto: Extract<PoolProto, 'univ3' | 'pancakev3'>,
  generation: string,
): number {
  const query =
    proto === 'univ3'
      ? deleteUniv3SnapshotGenerationQ
      : proto === 'pancakev3'
        ? deletePancakeV3SnapshotGenerationQ
        : null;
  if (!query) throw new Error('snapshot-generation deletion is CL-only');
  return Number(query.run(generation).changes);
}

export type V2PoolIdentityRow = {
  address: string;
  proto: PoolProto;
  token0: string;
  token1: string;
  fee_ppm: number;
  created_block: number | null;
  pair_index: number | null;
};
const v2PoolIdentityQ = db.prepare(`
  SELECT address, proto, token0, token1, fee_ppm, created_block, pair_index
  FROM pools WHERE address = ?`);
/** Exact persisted identity used when an immutable V2 event page is replayed. */
export const v2PoolIdentity = (address: string): V2PoolIdentityRow | undefined =>
  v2PoolIdentityQ.get(address.toLowerCase()) as V2PoolIdentityRow | undefined;

export type V2PairIndexStats = {
  count: number;
  min: number | null;
  max: number | null;
  distinct: number;
  missing: number;
};
const v2PairIndexStatsQ = db.prepare(`
  SELECT COUNT(*) AS count,
         MIN(pair_index) AS min,
         MAX(pair_index) AS max,
         COUNT(DISTINCT pair_index) AS distinct_count,
         SUM(CASE WHEN pair_index IS NULL THEN 1 ELSE 0 END) AS missing
  FROM pools WHERE proto = ?`);
/** Completeness proof for a V2 factory's contiguous allPairs ordinal space. */
export function v2PairIndexStats(proto: 'univ2' | 'pancakev2'): V2PairIndexStats {
  const row = v2PairIndexStatsQ.get(proto) as {
    count: number;
    min: number | null;
    max: number | null;
    distinct_count: number;
    missing: number | null;
  };
  return {
    count: row.count,
    min: row.min,
    max: row.max,
    distinct: row.distinct_count,
    missing: row.missing ?? 0,
  };
}
const poolRowsPageQ = db.prepare(
  `SELECT address, proto, token0, token1, fee_ppm, unstaked_fee_ppm, gauge, tick_spacing
   FROM pools WHERE address > ? ORDER BY address LIMIT ?`,
);
/** Address-keyset page used by full-catalog jobs; never materializes the catalog. */
export const poolRowsPage = (afterAddress: string, limit: number): PoolRow[] =>
  poolRowsPageQ.all(afterAddress.toLowerCase(), limit) as PoolRow[];
const clPoolRowsPageQ = db.prepare(
  `SELECT address, proto, token0, token1, fee_ppm, unstaked_fee_ppm, gauge, tick_spacing
   FROM pools
   WHERE proto IN ('univ3', 'pancakev3') AND address > ?
   ORDER BY address LIMIT ?`,
);
/** Address-keyset page containing only concentrated-liquidity venues. */
export const clPoolRowsPage = (afterAddress: string, limit: number): PoolRow[] =>
  clPoolRowsPageQ.all(afterAddress.toLowerCase(), limit) as PoolRow[];
export const poolCounts = () =>
  db.prepare(`SELECT proto, n FROM pool_catalog_counts WHERE n > 0 ORDER BY proto`).all() as {
    proto: string;
    n: number;
  }[];
const poolCountQ = db.prepare('SELECT COALESCE(SUM(n), 0) AS n FROM pool_catalog_counts');
export const poolCount = (): number => (poolCountQ.get() as { n: number }).n;

const clPoolCountQ = db.prepare(`SELECT COUNT(*) AS n FROM pools WHERE proto IN ('univ3', 'pancakev3')`);
export const clPoolCount = (): number => (clPoolCountQ.get() as { n: number }).n;
const clPoolStateCountQ = db.prepare(
  `SELECT COUNT(*) AS n
   FROM pools p JOIN pool_state s ON s.address = p.address
   WHERE p.proto IN ('univ3', 'pancakev3')
     AND s.sqrt_price IS NOT NULL AND s.liquidity IS NOT NULL`,
);
/** CL rows with the minimum state required for client-side rendering. */
export const clPoolStateCount = (): number => (clPoolStateCountQ.get() as { n: number }).n;
// ---- Uniswap v4 candidate catalog ----
export type V4PoolRow = {
  pool_id: string;
  pool_manager: string;
  currency0: string;
  currency1: string;
  key_fee_ppm: number | null;
  tick_spacing: number;
  hooks: string;
  created_block: number | null;
  snapshot_generation: string | null;
};

const insV4PoolQ = db.prepare(`
  INSERT OR IGNORE INTO v4_pools
    (pool_id, pool_manager, currency0, currency1, key_fee_ppm, tick_spacing, hooks,
     created_block, snapshot_generation, added_ts)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

/** Returns true when a PoolId was not already present. */
export function insertV4Pool(p: {
  poolId: string;
  poolManager: string;
  currency0: string;
  currency1: string;
  keyFeePpm?: number;
  tickSpacing: number;
  hooks: string;
  createdBlock?: number;
  snapshotGeneration?: string;
}): boolean {
  const result = insV4PoolQ.run(
    p.poolId.toLowerCase(),
    p.poolManager.toLowerCase(),
    p.currency0.toLowerCase(),
    p.currency1.toLowerCase(),
    p.keyFeePpm ?? null,
    p.tickSpacing,
    p.hooks.toLowerCase(),
    p.createdBlock ?? null,
    p.snapshotGeneration ?? null,
    now(),
  );
  return Number(result.changes) > 0;
}

const v4PoolRowQ = db.prepare(`
  SELECT pool_id, pool_manager, currency0, currency1, key_fee_ppm,
         tick_spacing, hooks, created_block, snapshot_generation
  FROM v4_pools WHERE pool_id = ?`);
export const v4PoolRow = (poolId: string): V4PoolRow | undefined =>
  v4PoolRowQ.get(poolId.toLowerCase()) as V4PoolRow | undefined;

const setV4EventIdentityQ = db.prepare(`
  UPDATE v4_pools SET
    key_fee_ppm = COALESCE(key_fee_ppm, ?),
    created_block = COALESCE(created_block, ?)
  WHERE pool_id = ?
    AND (key_fee_ppm IS NULL OR key_fee_ppm = ?)
    AND (created_block IS NULL OR created_block = ?)`);

/** Fill fields that are cryptographically proven by a PoolManager Initialize event. */
export function setV4EventIdentity(poolId: string, keyFeePpm: number, createdBlock: number): void {
  const result = setV4EventIdentityQ.run(keyFeePpm, createdBlock, poolId.toLowerCase(), keyFeePpm, createdBlock);
  if (Number(result.changes) !== 1)
    throw new Error(`existing v4 pool ${poolId.toLowerCase()} conflicts with Initialize event`);
}

export const v4PoolCount = (): number => (db.prepare('SELECT COUNT(*) AS n FROM v4_pools').get() as { n: number }).n;

const insLaunchpadTokenQ = db.prepare(`
  INSERT OR IGNORE INTO v4_launchpad_tokens(address, created_block, added_ts)
  VALUES (?, ?, ?)`);
const launchpadTokenQ = db.prepare('SELECT 1 AS hit FROM v4_launchpad_tokens WHERE address = ?');

/** Returns true when this launch was not already recorded. */
export function insertLaunchpadToken(address: string, createdBlock: number): boolean {
  return Number(insLaunchpadTokenQ.run(address.toLowerCase(), createdBlock, now()).changes) > 0;
}

/** Whether an RPC-sourced v4 directory should admit pools on this currency. */
export const isLaunchpadToken = (address: string): boolean =>
  launchpadTokenQ.get(address.toLowerCase()) !== undefined;

export const launchpadTokenCount = (): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM v4_launchpad_tokens').get() as { n: number }).n;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const applyV4TransferQ = db.prepare(`
  INSERT INTO v4_position_owners(token_id, owner, updated_block) VALUES (?, ?, ?)
  ON CONFLICT(token_id) DO UPDATE SET owner = excluded.owner, updated_block = excluded.updated_block`);
const deleteV4TransferQ = db.prepare('DELETE FROM v4_position_owners WHERE token_id = ?');

/**
 * Apply one PositionManager Transfer. `to` is the recipient: the zero address
 * means the tokenId was burned, so it leaves the owned set; anything else makes
 * it (or keeps it) owned by `to`. `from` is irrelevant — only the recipient
 * decides current ownership.
 */
export function applyV4Transfer(tokenId: number, to: string, block: number): void {
  const owner = to.toLowerCase()
  if (owner === ZERO_ADDRESS) void deleteV4TransferQ.run(tokenId)
  else applyV4TransferQ.run(tokenId, owner, block)
}

const v4PositionIdsByOwnerQ = db.prepare(
  'SELECT token_id FROM v4_position_owners WHERE owner = ? ORDER BY token_id ASC',
);
/** Token ids this wallet currently owns, as decimal strings (newest-last order). */
export function v4PositionIdsByOwner(owner: string): string[] {
  return (v4PositionIdsByOwnerQ.all(owner.toLowerCase()) as { token_id: number }[]).map((row) =>
    String(row.token_id),
  )
}

export const v4PositionOwnerCount = (): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM v4_position_owners').get() as { n: number }).n;

const recordStockTokenQ = db.prepare(`
  INSERT INTO stock_tokens (address, issuer, updated) VALUES (?, ?, ?)
  ON CONFLICT(address) DO UPDATE SET issuer = excluded.issuer, updated = excluded.updated`);
/**
 * Record what the chain answered about one token's issuer.
 *
 * `null` means measured and matched nobody, which is a result worth keeping.
 * Callers must not reach here for a read that FAILED — see the table comment.
 */
export const recordStockToken = (address: string, issuer: string | null): void =>
  void recordStockTokenQ.run(address.toLowerCase(), issuer, now());

const stockIssuerQ = db.prepare('SELECT issuer FROM stock_tokens WHERE address = ?');
/** The issuer proven for this token — null when none is, and when none was measured. */
export const stockIssuerOf = (address: string): string | null =>
  (stockIssuerQ.get(address.toLowerCase()) as { issuer: string | null } | undefined)?.issuer ?? null;

const stockTokenMeasuredQ = db.prepare('SELECT 1 AS hit FROM stock_tokens WHERE address = ?');
/** Whether this token has an answer on file at all, of either kind. */
export const stockTokenMeasured = (address: string): boolean =>
  stockTokenMeasuredQ.get(address.toLowerCase()) !== undefined;

/** Whether an RPC-sourced v4 directory should admit pools on this currency. */
export const isStockToken = (address: string): boolean => stockIssuerOf(address) !== null;

const stockTokenCountsQ = db.prepare(
  'SELECT COUNT(*) AS measured, COUNT(issuer) AS proven FROM stock_tokens',
);
export const stockTokenCounts = (): { measured: number; proven: number } =>
  stockTokenCountsQ.get() as { measured: number; proven: number };

const unmeasuredStockCandidatesQ = db.prepare(`
  SELECT u.address AS address, MAX(u.depth) AS depth FROM (
    SELECT p.token0 AS address, s.tvl_usd AS depth
      FROM pools p JOIN pool_state s ON s.address = p.address WHERE s.tvl_usd >= ?
    UNION ALL
    SELECT p.token1, s.tvl_usd
      FROM pools p JOIN pool_state s ON s.address = p.address WHERE s.tvl_usd >= ?
    UNION ALL
    SELECT v.currency0, m.liq_usd
      FROM v4_pools v JOIN v4_market_stats m ON m.pool_id = v.pool_id WHERE m.liq_usd >= ?
    UNION ALL
    SELECT v.currency1, m.liq_usd
      FROM v4_pools v JOIN v4_market_stats m ON m.pool_id = v.pool_id WHERE m.liq_usd >= ?
  ) u
  LEFT JOIN stock_tokens k ON k.address = u.address
  WHERE k.address IS NULL
  GROUP BY u.address
  ORDER BY depth DESC
  LIMIT ?`);
/**
 * Tokens worth asking the chain about, deepest market first.
 *
 * Bounded by liquidity rather than by name, because there is no name to bound
 * by: a share is identified by its proxy, and sweeping all 18,000 tokens in a
 * catalog to find the few dozen real ones is work with no upper bound. The
 * floor is the same one the pool list already hides below, which is what makes
 * it safe — a token too shallow to be probed is also too shallow to be on
 * screen. Measured on the BSC catalog 2026-08-06: 387 tokens sit above \$1k,
 * against 18,000 above nothing.
 *
 * A measured token never reappears here, whichever way it was answered, so the
 * backfill drains once and the steady state only sees what newly got deep
 * enough to matter.
 */
export const unmeasuredStockCandidates = (minDepthUsd: number, limit: number): string[] =>
  (
    unmeasuredStockCandidatesQ.all(
      minDepthUsd,
      minDepthUsd,
      minDepthUsd,
      minDepthUsd,
      limit,
    ) as { address: string }[]
  ).map((row) => row.address);

const addV4SnapshotMembershipQ = db.prepare(`
  INSERT OR IGNORE INTO v4_pool_snapshot_membership(
    snapshot_generation, pool_id, token0, token1
  )
  SELECT
    ?,
    pool_id,
    CASE WHEN currency0 < currency1 THEN currency0 ELSE currency1 END,
    CASE WHEN currency0 < currency1 THEN currency1 ELSE currency0 END
  FROM v4_pools WHERE pool_id = ?`);
/**
 * Mark an identity as observed in one exact, pinned Graph generation.
 *
 * Do not overwrite v4_pools.snapshot_generation here: while a replacement is
 * downloading that compatibility column continues to identify the currently
 * published generation. The armed publish trigger updates it atomically at the
 * generation switch.
 */
export const setV4SnapshotGeneration = (poolId: string, generation: string): void => {
  const normalizedGeneration = generation.trim();
  if (!normalizedGeneration)
    throw new Error('v4 snapshot generation cannot be empty');
  const normalizedPoolId = poolId.toLowerCase();
  if (v4PoolRowQ.get(normalizedPoolId) === undefined)
    throw new Error(`cannot mark missing v4 pool ${poolId.toLowerCase()} in snapshot generation`);
  addV4SnapshotMembershipQ.run(normalizedGeneration, normalizedPoolId);
};

const v4SnapshotGenerationCountQ = db.prepare(`
  SELECT COUNT(*) AS n FROM v4_pool_snapshot_membership
  WHERE snapshot_generation = ?`);
export const v4SnapshotGenerationCount = (generation: string): number =>
  (v4SnapshotGenerationCountQ.get(generation) as { n: number }).n;

const staleV4SnapshotCandidateCountQ = db.prepare(`
  SELECT COUNT(*) AS n FROM v4_pools p
  WHERE NOT EXISTS (
    SELECT 1 FROM v4_pool_snapshot_membership m
    WHERE m.snapshot_generation = ? AND m.pool_id = p.pool_id
  ) AND NOT (p.key_fee_ppm IS NOT NULL AND p.created_block IS NOT NULL)`);
const armV4SnapshotPublishQ = db.prepare(`
  INSERT INTO kv(k, v) VALUES ('v4_snapshot_publish_generation', ?)
  ON CONFLICT(k) DO UPDATE SET v = excluded.v`);
/**
 * Arm publish-time cleanup for one complete replacement snapshot. The caller
 * updates v4_snapshot_generation later in the same transaction; that switch
 * atomically GC's old memberships and stale Graph-only rows. Event-verified
 * tail rows survive even when absent from the Graph generation.
 */
export function deleteStaleV4SnapshotCandidates(generation: string): number {
  const normalizedGeneration = generation.trim();
  if (!normalizedGeneration || v4SnapshotGenerationCount(normalizedGeneration) <= 0)
    throw new Error('cannot publish an empty V4 snapshot generation');
  const stale = (
    staleV4SnapshotCandidateCountQ.get(normalizedGeneration) as { n: number }
  ).n;
  armV4SnapshotPublishQ.run(normalizedGeneration);
  return stale;
}

const upV4TokenQ = db.prepare(`
  INSERT INTO v4_tokens (address, symbol, decimals, updated) VALUES (?, ?, ?, ?)
  ON CONFLICT(address) DO UPDATE SET
    symbol = excluded.symbol, decimals = excluded.decimals, updated = excluded.updated`);
export const upsertV4TokenMeta = (address: string, symbol: string, decimals: number) =>
  void upV4TokenQ.run(address.toLowerCase(), symbol, decimals, now());

const missingV4TokensPageQ = db.prepare(`
  SELECT u.address FROM (
    SELECT currency0 AS address FROM v4_pools WHERE currency0 > ?
    UNION
    SELECT currency1 AS address FROM v4_pools WHERE currency1 > ?
  ) u
  LEFT JOIN v4_tokens t ON t.address = u.address
  WHERE t.address IS NULL
  ORDER BY u.address LIMIT ?`);
export const missingV4TokensPage = (afterAddress: string, limit: number): string[] =>
  (
    missingV4TokensPageQ.all(afterAddress.toLowerCase(), afterAddress.toLowerCase(), limit) as { address: string }[]
  ).map((row) => row.address);

const upV4StatsQ = db.prepare(`
  INSERT INTO v4_pool_stats (pool_id, tvl0, tvl1, updated) VALUES (?, ?, ?, ?)
  ON CONFLICT(pool_id) DO UPDATE SET
    tvl0 = excluded.tvl0, tvl1 = excluded.tvl1, updated = excluded.updated`);
const delV4DaysQ = db.prepare('DELETE FROM v4_pool_days WHERE pool_id = ?');
const insV4DayQ = db.prepare(`
  INSERT INTO v4_pool_days (pool_id, date, volume0, volume1) VALUES (?, ?, ?, ?)`);

/** Replace the raw, token-denominated Graph accounting for one pool. */
export function upsertV4GraphStats(
  poolId: string,
  tvl0: number | null,
  tvl1: number | null,
  days: readonly {
    date: number;
    volume0: number | null;
    volume1: number | null;
  }[],
): void {
  const id = poolId.toLowerCase();
  upV4StatsQ.run(id, tvl0, tvl1, now());
  delV4DaysQ.run(id);
  for (const day of days) insV4DayQ.run(id, day.date, day.volume0, day.volume1);
}

const upV4MarketStatsQ = db.prepare(`
  INSERT INTO v4_market_stats (
    pool_id, vol5m_usd, vol1h_usd, vol6h_usd, vol24h_usd,
    txns24h, liq_usd, source, updated
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(pool_id) DO UPDATE SET
    vol5m_usd = excluded.vol5m_usd, vol1h_usd = excluded.vol1h_usd,
    vol6h_usd = excluded.vol6h_usd, vol24h_usd = excluded.vol24h_usd,
    txns24h = excluded.txns24h,
    liq_usd = excluded.liq_usd, source = excluded.source, updated = excluded.updated`);
/** An aggregator's USD reading of one v4 pool, keyed by PoolId rather than address. */
export const upsertV4MarketStats = (
  poolId: string,
  volumes: number | null | RollingVolumes,
  txns24h: number | null,
  liqUsd: number | null,
  source: string,
): void => {
  const normalized: RollingVolumes = typeof volumes === 'number' || volumes === null
    ? { m5: null, h1: null, h6: null, h24: volumes }
    : volumes;
  const id = poolId.toLowerCase();
  const timestamp = now();
  upV4MarketStatsQ.run(
    id, normalized.m5, normalized.h1, normalized.h6, normalized.h24,
    txns24h, liqUsd, source, timestamp,
  );
  const bucket = Math.floor(timestamp / 300) * 300;
  db.prepare(`INSERT INTO pool_market_snapshots(
      pool,ts,source,vol5m_usd,vol1h_usd,vol6h_usd,vol24h_usd,tvl_usd,tick,liquidity,fee_ppm
    ) SELECT v.pool_id,?,?,?,?,?,?,COALESCE(m.tvl_usd,?),r.tick,r.liquidity,
        COALESCE(r.lp_fee,v.key_fee_ppm,0)
      FROM v4_pools v
      LEFT JOIN v4_market_stats m ON m.pool_id=v.pool_id
      LEFT JOIN v4_recommendation_state r ON r.pool_id=v.pool_id
      WHERE v.pool_id=?
    ON CONFLICT(pool,ts) DO UPDATE SET source=excluded.source,
      vol5m_usd=excluded.vol5m_usd,vol1h_usd=excluded.vol1h_usd,
      vol6h_usd=excluded.vol6h_usd,vol24h_usd=excluded.vol24h_usd,
      tvl_usd=excluded.tvl_usd,tick=excluded.tick,liquidity=excluded.liquidity,
      fee_ppm=excluded.fee_ppm`)
    .run(
      bucket, source, normalized.m5, normalized.h1, normalized.h6,
      normalized.h24, liqUsd, id,
    );
};

export type V4RecommendationTarget = {
  pool_id: string;
  key_fee_ppm: number | null;
};
export const recommendationV4Targets = (limit: number): V4RecommendationTarget[] =>
  db.prepare(`SELECT v.pool_id,v.key_fee_ppm FROM v4_pools v
    JOIN v4_market_stats m ON m.pool_id=v.pool_id
    WHERE COALESCE(m.tvl_usd,m.liq_usd,0)>=10000 AND COALESCE(m.vol24h_usd,0)>=10000
    ORDER BY (
      MIN(
        COALESCE(m.vol1h_usd,m.vol24h_usd/24.0),
        COALESCE(m.vol6h_usd/6.0,m.vol24h_usd/24.0),
        m.vol24h_usd/24.0
      ) * COALESCE(v.key_fee_ppm,0) / MAX(COALESCE(m.tvl_usd,m.liq_usd),1)
    ) DESC LIMIT ?`).all(Math.max(1, Math.floor(limit))) as V4RecommendationTarget[];

const upsertV4RecommendationStateQ = db.prepare(`
  INSERT INTO v4_recommendation_state(pool_id,sqrt_price,tick,liquidity,lp_fee,updated)
  VALUES (?,?,?,?,?,?)
  ON CONFLICT(pool_id) DO UPDATE SET sqrt_price=excluded.sqrt_price,
    tick=excluded.tick,liquidity=excluded.liquidity,lp_fee=excluded.lp_fee,
    updated=excluded.updated`);
export function upsertV4RecommendationState(
  poolId: string,
  state: { sqrtPrice: bigint; tick: number; liquidity: bigint; lpFee: number },
  blockNumber: string,
  timestamp = now(),
): void {
  const id = poolId.toLowerCase();
  upsertV4RecommendationStateQ.run(
    id, String(state.sqrtPrice), state.tick, String(state.liquidity), state.lpFee, timestamp,
  );
  const bucket = Math.floor(timestamp / 60) * 60;
  db.prepare(`INSERT OR REPLACE INTO pool_tick_samples(pool,ts,tick,block_number) VALUES(?,?,?,?)`)
    .run(id, bucket, state.tick, blockNumber);
}

const setV4ChainTvlQ = db.prepare(`
  INSERT INTO v4_market_stats (pool_id, tvl_usd, tvl_approx, source, updated)
  VALUES (?, ?, ?, 'chain', ?)
  ON CONFLICT(pool_id) DO UPDATE SET
    tvl_usd = excluded.tvl_usd, tvl_approx = excluded.tvl_approx, updated = excluded.updated`);
/**
 * The depth this indexer derived itself, from token quantities and its own
 * prices. Deliberately does not touch source: that column names where the
 * VOLUME came from, and an aggregator remains the only thing that reports one.
 */
export const setV4ChainTvl = (poolId: string, tvlUsd: number | null, approx: boolean): void =>
  void setV4ChainTvlQ.run(poolId.toLowerCase(), tvlUsd, approx ? 1 : 0, now());

const v4TvlInputsQ = db.prepare(`
  SELECT s.pool_id, s.tvl0, s.tvl1,
         p.currency0, p.currency1,
         t0.price_usd AS p0_usd, t0.price_depth_usd AS p0_depth, t0.price_src AS p0_src,
         t1.price_usd AS p1_usd, t1.price_depth_usd AS p1_depth, t1.price_src AS p1_src
  FROM v4_pool_stats s
  JOIN v4_pools p ON p.pool_id = s.pool_id
  LEFT JOIN tokens t0 ON t0.address = p.currency0
  LEFT JOIN tokens t1 ON t1.address = p.currency1
  WHERE s.tvl0 IS NOT NULL OR s.tvl1 IS NOT NULL`);
export type V4TvlInput = {
  pool_id: string;
  tvl0: number | null;
  tvl1: number | null;
  currency0: string;
  currency1: string;
  p0_usd: number | null;
  p0_depth: number | null;
  p0_src: string | null;
  p1_usd: number | null;
  p1_depth: number | null;
  p1_src: string | null;
};
/** Every v4 pool whose token quantities are known, with both sides' prices. */
export const v4TvlInputs = (): V4TvlInput[] => v4TvlInputsQ.all() as V4TvlInput[];

const v4MarketStatsCountQ = db.prepare(
  'SELECT COUNT(*) AS n FROM v4_market_stats WHERE vol24h_usd IS NOT NULL',
);
/** How many v4 pools currently carry a volume reading — the coverage measurement. */
export const v4MarketStatsCount = (): number => (v4MarketStatsCountQ.get() as { n: number }).n;

const markV4FeaturedQ = db.prepare(`
  UPDATE v4_pool_stats SET featured_snapshot = ?, featured_rank = ?, updated = ?
  WHERE pool_id = ?`);
export const markV4Featured = (poolId: string, snapshot: number, rank: number): void =>
  void markV4FeaturedQ.run(snapshot, rank, now(), poolId.toLowerCase());

const clearV4FeaturedQ = db.prepare(`
  UPDATE v4_pool_stats SET featured_snapshot = NULL, featured_rank = NULL
  WHERE featured_snapshot IS NOT NULL`);
/** Start a new featured generation; caller publishes replacements before pruning. */
export const clearV4Featured = (): void => void clearV4FeaturedQ.run();

const pruneV4DaysQ = db.prepare(`
  DELETE FROM v4_pool_days WHERE pool_id IN (
    SELECT pool_id FROM v4_pool_stats
    WHERE featured_snapshot IS NULL OR featured_snapshot <> ?
  )`);
const pruneV4StatsQ = db.prepare(`
  DELETE FROM v4_pool_stats
  WHERE featured_snapshot IS NULL OR featured_snapshot <> ?`);
/** Remove stale full-snapshot accounting after a new featured set is published. */
export function pruneV4StatsExcept(featuredSnapshot: number): void {
  pruneV4DaysQ.run(featuredSnapshot);
  pruneV4StatsQ.run(featuredSnapshot);
}

/** Durable readiness for the pinned candidate snapshot, independent of app ready. */
export function hasCompleteV4SnapshotRows(): boolean {
  const block = Number(kvGet('v4_snapshot_block'));
  const snapshotPoolCount = Number(kvGet('v4_snapshot_pool_count'));
  const generation = kvGet('v4_snapshot_generation')?.trim() ?? '';
  return (
    kvGet('v4_snapshot_source') === 'thegraph' &&
    kvGet('v4_snapshot_complete') === '1' &&
    Number.isSafeInteger(block) &&
    block > 0 &&
    Number.isSafeInteger(snapshotPoolCount) &&
    snapshotPoolCount > 0 &&
    generation.length > 0 &&
    v4SnapshotGenerationCount(generation) === snapshotPoolCount &&
    /^0x[0-9a-f]{64}$/.test(kvGet('v4_snapshot_block_hash') ?? '') &&
    /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(kvGet('v4_snapshot_subgraph_id') ?? '') &&
    (kvGet('v4_snapshot_deployment')?.trim().length ?? 0) > 0
  );
}

// ---- tokens ----
const insTokenQ = db.prepare(`
  INSERT INTO tokens (address, symbol, decimals, meta_ok) VALUES (?, ?, ?, ?)
  ON CONFLICT(address) DO UPDATE SET symbol = excluded.symbol, decimals = excluded.decimals, meta_ok = excluded.meta_ok`);
export const upsertTokenMeta = (addr: string, symbol: string, decimals: number, metaOk: boolean) =>
  void insTokenQ.run(addr.toLowerCase(), symbol, decimals, metaOk ? 1 : 0);

const priceQ = db.prepare(`
  INSERT INTO tokens (address, price_usd, price_depth_usd, price_src, price_updated) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(address) DO UPDATE SET price_usd = excluded.price_usd, price_depth_usd = excluded.price_depth_usd,
    price_src = excluded.price_src, price_updated = excluded.price_updated`);
export const setTokenPrice = (addr: string, usd: number, depthUsd: number, src: string) =>
  void priceQ.run(addr.toLowerCase(), usd, depthUsd, src, now());

// Drop every pool-derived price (reprice rebuilds them from the credible seeds
// on the same pass) plus anything outside the plausibility band, whatever its
// source — a GT quote can be garbage too, and a stored fantasy price is how one
// broken pool poisoned 138 tokens. Runs inside reprice's transaction, so the
// API never observes the gap.
const clearDerivedQ = db.prepare(
  `UPDATE tokens SET price_usd = NULL, price_depth_usd = 0, price_src = NULL, price_updated = NULL
   WHERE price_src = 'pool' OR (price_usd IS NOT NULL AND (price_usd < ? OR price_usd > ?))`,
);
export const clearDerivedPrices = () => void clearDerivedQ.run(TUNE.minTokenUsd, TUNE.maxTokenUsd);

const missingMetaTokensPageQ = db.prepare(
  `SELECT u.addr FROM (
     SELECT token0 AS addr FROM pools WHERE token0 > ?
     UNION
     SELECT token1 AS addr FROM pools WHERE token1 > ?
   ) u
   LEFT JOIN tokens t ON t.address = u.addr
   WHERE t.address IS NULL OR t.meta_ok = 0
   ORDER BY u.addr LIMIT ?`,
);
/** Missing/previously-failed catalog tokens in deterministic keyset order. */
export const missingMetaTokensPage = (afterAddress: string, limit: number): string[] =>
  (missingMetaTokensPageQ.all(afterAddress.toLowerCase(), afterAddress.toLowerCase(), limit) as { addr: string }[]).map(
    (r) => r.addr,
  );

const missingClMetaSideSql = (column: 'token0' | 'token1') => `SELECT p.${column} AS addr
   FROM pools p INDEXED BY idx_pools_cl_${column}
   LEFT JOIN tokens t ON t.address = p.${column}
   WHERE p.proto IN ('univ3', 'pancakev3') AND p.${column} > ?
     AND (t.address IS NULL OR t.meta_ok = 0)
   ORDER BY p.${column} LIMIT ?`;
const missingClMetaToken0Sql = missingClMetaSideSql('token0');
const missingClMetaToken1Sql = missingClMetaSideSql('token1');
const missingClMetaToken0Q = db.prepare(missingClMetaToken0Sql);
const missingClMetaToken1Q = db.prepare(missingClMetaToken1Sql);
/** Missing token metadata for CL pools only, in deterministic keyset order. */
export const missingClMetaTokensPage = (afterAddress: string, limit: number): string[] => {
  const after = afterAddress.toLowerCase();
  const side0 = missingClMetaToken0Q.all(after, limit) as { addr: string }[];
  const side1 = missingClMetaToken1Q.all(after, limit) as { addr: string }[];
  // Each input is already ordered by its covering partial index. A bounded
  // in-process merge avoids SQLite materializing the entire two-sided catalog
  // into temporary B-trees merely to return one metadata page.
  const merged: string[] = [];
  let i = 0;
  let j = 0;
  while (merged.length < limit && (i < side0.length || j < side1.length)) {
    const a = side0[i]?.addr;
    const b = side1[j]?.addr;
    const next = b === undefined || (a !== undefined && a <= b) ? a! : b;
    if (a === next) i++;
    if (b === next) j++;
    if (merged.at(-1) !== next) merged.push(next);
  }
  return merged;
};

/** Query-plan hook: the CL census must merge its two partial token indexes. */
export const explainMissingClMetaPlan = (): string[] =>
  [missingClMetaToken0Sql, missingClMetaToken1Sql].flatMap((sql) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('', 1_000) as Array<{ detail: string }>).map(
      (row) => row.detail,
    ));

const missingClMetaTokenCountQ = db.prepare(
  `SELECT COUNT(*) AS n FROM (
     SELECT token0 AS addr FROM pools WHERE proto IN ('univ3', 'pancakev3')
     UNION
     SELECT token1 AS addr FROM pools WHERE proto IN ('univ3', 'pancakev3')
   ) u
   LEFT JOIN tokens t ON t.address = u.addr
   WHERE t.address IS NULL OR t.meta_ok = 0`,
);
/** CL tokens whose decimals are still unsafe to use for transactions. */
export const missingClMetaTokenCount = (): number => (missingClMetaTokenCountQ.get() as { n: number }).n;

// ---- pool_state ----
const upStateQ = db.prepare(`
  INSERT INTO pool_state (
    address, proto, sqrt_price, tick, liquidity, staked_liquidity,
    reward_rate, period_finish, gauge_alive, reserve0, reserve1, total_supply, updated
  ) VALUES (?, (SELECT proto FROM pools WHERE address = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(address) DO UPDATE SET sqrt_price = excluded.sqrt_price, tick = excluded.tick,
    liquidity = excluded.liquidity, staked_liquidity = excluded.staked_liquidity,
    reward_rate = excluded.reward_rate, period_finish = excluded.period_finish,
    gauge_alive = excluded.gauge_alive, reserve0 = excluded.reserve0, reserve1 = excluded.reserve1,
    total_supply = excluded.total_supply, updated = excluded.updated,
    proto = excluded.proto`);
export const upsertState = (
  addr: string,
  s: {
    sqrtPrice?: bigint;
    tick?: number;
    liquidity?: bigint;
    stakedLiquidity?: bigint;
    rewardRate?: bigint;
    periodFinish?: bigint;
    gaugeAlive?: boolean;
    reserve0: bigint;
    reserve1: bigint;
    totalSupply?: bigint;
  },
) =>
  void upStateQ.run(
    addr.toLowerCase(),
    addr.toLowerCase(),
    s.sqrtPrice !== undefined ? String(s.sqrtPrice) : null,
    s.tick ?? null,
    s.liquidity !== undefined ? String(s.liquidity) : null,
    String(s.stakedLiquidity ?? 0n),
    String(s.rewardRate ?? 0n),
    Number(s.periodFinish ?? 0n),
    s.gaugeAlive ? 1 : 0,
    String(s.reserve0),
    String(s.reserve1),
    s.totalSupply !== undefined ? String(s.totalSupply) : null,
    now(),
  );

const tvlQ = db.prepare(
  `UPDATE pool_state SET tvl_usd = ?, tvl_approx = ?
   WHERE address = ? AND (tvl_usd IS NOT ? OR tvl_approx <> ?)`,
);
export const setTvl = (addr: string, tvl: number | null, approx: boolean) =>
  void tvlQ.run(tvl, approx ? 1 : 0, addr.toLowerCase(), tvl, approx ? 1 : 0);

// ---- pool_stats ----
const upStatsQ = db.prepare(`
  INSERT INTO pool_stats (address, proto, vol5m_usd, vol1h_usd, vol6h_usd, vol24h_usd, txns24h, liq_usd, source, updated)
  VALUES (?, (SELECT proto FROM pools WHERE address = ?), ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(address) DO UPDATE SET vol5m_usd = excluded.vol5m_usd,
    vol1h_usd = excluded.vol1h_usd, vol6h_usd = excluded.vol6h_usd,
    vol24h_usd = excluded.vol24h_usd, txns24h = excluded.txns24h,
    liq_usd = excluded.liq_usd, source = excluded.source, updated = excluded.updated,
    proto = excluded.proto`);
export type RollingVolumes = {
  m5: number | null;
  h1: number | null;
  h6: number | null;
  h24: number | null;
};
export const upsertStats = (
  addr: string,
  volumes: number | null | RollingVolumes,
  txns24h: number | null,
  liqUsd: number | null,
  source: string,
) => {
  const normalized: RollingVolumes = typeof volumes === 'number' || volumes === null
    ? { m5: null, h1: null, h6: null, h24: volumes }
    : volumes;
  const address = addr.toLowerCase();
  const timestamp = now();
  upStatsQ.run(
    address, address,
    normalized.m5, normalized.h1, normalized.h6, normalized.h24,
    txns24h, liqUsd, source, timestamp,
  );
  const bucket = Math.floor(timestamp / 300) * 300;
  db.prepare(`INSERT INTO pool_market_snapshots(
      pool,ts,source,vol5m_usd,vol1h_usd,vol6h_usd,vol24h_usd,tvl_usd,tick,liquidity,fee_ppm
    ) SELECT p.address,?,?,?,?,?,?,COALESCE(s.tvl_usd,?),s.tick,s.liquidity,p.fee_ppm
      FROM pools p LEFT JOIN pool_state s ON s.address=p.address WHERE p.address=?
    ON CONFLICT(pool,ts) DO UPDATE SET source=excluded.source,
      vol5m_usd=excluded.vol5m_usd,vol1h_usd=excluded.vol1h_usd,
      vol6h_usd=excluded.vol6h_usd,vol24h_usd=excluded.vol24h_usd,
      tvl_usd=excluded.tvl_usd,tick=excluded.tick,liquidity=excluded.liquidity,
      fee_ppm=excluded.fee_ppm`)
    .run(
      bucket, source, normalized.m5, normalized.h1, normalized.h6,
      normalized.h24, liqUsd, address,
    );
};

/** Bounded high-value CL cohort sampled for strategy modelling. */
export const recommendationAddressPoolAddrs = (limit: number): string[] => {
  const cap = Math.max(1, Math.floor(limit));
  return (db.prepare(`SELECT p.address FROM pools p
      JOIN pool_state s ON s.address=p.address
      JOIN pool_stats st ON st.address=p.address
    WHERE p.proto IN ('up33cl','univ3','pancakev3')
      AND s.sqrt_price IS NOT NULL AND s.tick IS NOT NULL AND s.liquidity IS NOT NULL
      AND COALESCE(s.tvl_usd,st.liq_usd,0)>=10000
      AND COALESCE(st.vol24h_usd,0)>=10000
    ORDER BY (
      MIN(
        COALESCE(st.vol1h_usd,st.vol24h_usd/24.0),
        COALESCE(st.vol6h_usd/6.0,st.vol24h_usd/24.0),
        st.vol24h_usd/24.0
      ) * p.fee_ppm / MAX(COALESCE(s.tvl_usd,st.liq_usd),1)
    ) DESC LIMIT ?`).all(cap) as { address: string }[]).map((row) => row.address);
};

export function captureAddressTickSamples(addresses: readonly string[], blockNumber: string, timestamp = now()): void {
  const bucket = Math.floor(timestamp / 60) * 60;
  const insert = db.prepare(`INSERT OR REPLACE INTO pool_tick_samples(pool,ts,tick,block_number)
    SELECT address,?,tick,? FROM pool_state WHERE address=? AND tick IS NOT NULL`);
  tx(() => { for (const address of addresses) insert.run(bucket, blockNumber, address.toLowerCase()); });
}

export function pruneRecommendationHistory(timestamp = now()): void {
  db.prepare('DELETE FROM pool_tick_samples WHERE ts<?').run(timestamp - 30 * 86_400);
  db.prepare('DELETE FROM pool_market_snapshots WHERE ts<?').run(timestamp - 180 * 86_400);
}

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
  ).map((r) => r.address);

const statsSeedAddrsQ = db.prepare(
  `SELECT address FROM pool_stats
   ORDER BY (liq_usd IS NULL), liq_usd DESC,
            (vol24h_usd IS NULL), vol24h_usd DESC, address
   LIMIT ?`,
);
const catalogSeedAddrsQ = db.prepare('SELECT address FROM pools ORDER BY address LIMIT ?');

/**
 * Bounded boot set for a very large catalog. Existing chain-derived TVL wins,
 * then official-catalog rows seen in GT's top lists, then an address-ordered
 * fallback keeps a fresh/offline database from advertising ready with no live
 * state at all. The result is capped even when millions of pairs share the
 * same import timestamp.
 */
export function bootstrapAddrs(limit: number): string[] {
  const cap = Math.max(0, Math.floor(limit));
  if (!cap) return [];
  const out = new Set<string>();
  const append = (rows: { address: string }[]) => {
    for (const row of rows) {
      if (out.size >= cap) break;
      out.add(row.address);
    }
  };
  append(frontpageAddrs(cap).map((address) => ({ address })));
  append(statsSeedAddrsQ.all(cap) as { address: string }[]);
  if (out.size < cap) append(catalogSeedAddrsQ.all(cap - out.size) as { address: string }[]);
  return [...out];
}

const RECENT_UNHYDRATED_CANDIDATES_PER_RESULT = 64;
const RECENT_UNHYDRATED_MAX_CANDIDATES = 4_096;
const recentUnhydratedSql = `
   WITH recent AS MATERIALIZED (
     SELECT address, proto, token0, token1, added_ts
     FROM pools INDEXED BY idx_pools_added
     WHERE added_ts > 0
     ORDER BY added_ts DESC, address
     LIMIT ?
   )
   SELECT p.address
   FROM recent AS p
   LEFT JOIN pool_state s ON s.address = p.address
   LEFT JOIN tokens t0 ON t0.address = p.token0
   LEFT JOIN tokens t1 ON t1.address = p.token1
   LEFT JOIN hydration_demand h ON h.address = p.address
   WHERE (
        t0.meta_ok IS NOT 1 OR t1.meta_ok IS NOT 1
        OR s.address IS NULL
        OR (p.proto IN ('univ3', 'pancakev3') AND
            (s.sqrt_price IS NULL OR s.tick IS NULL OR s.liquidity IS NULL))
        OR (p.proto IN ('univ2', 'pancakev2') AND s.total_supply IS NULL)
     )
     AND (h.address IS NULL OR h.next_attempt <= ?)
   ORDER BY p.added_ts DESC, p.address
   LIMIT ?`;
const recentUnhydratedQ = db.prepare(recentUnhydratedSql);

/** Newest live rows that still need either safe metadata or renderable state. */
export function recentUnhydratedAddrs(limit: number): string[] {
  const requested = Math.min(
    RECENT_UNHYDRATED_MAX_CANDIDATES,
    Math.max(0, Math.floor(limit)),
  );
  if (!requested) return [];
  // Bound the synchronous join work even when incomplete rows are sparse. The
  // durable demand queue remains the exhaustive recovery path for requested rows.
  const candidates = Math.max(
    requested,
    Math.min(
      RECENT_UNHYDRATED_MAX_CANDIDATES,
      requested * RECENT_UNHYDRATED_CANDIDATES_PER_RESULT,
    ),
  );
  return (
    recentUnhydratedQ.all(candidates, now(), requested) as Array<{
      address: string;
    }>
  ).map((row) => row.address);
}

/** Query-plan hook: recent recovery must materialize a bounded index window. */
export const explainRecentUnhydratedPlan = (): string[] =>
  (
    db.prepare(`EXPLAIN QUERY PLAN ${recentUnhydratedSql}`).all(1_024, now(), 16) as Array<{
      detail: string;
    }>
  ).map((row) => row.detail);

const enqueueHydrationQ = db.prepare(
  `INSERT INTO hydration_demand(address, proto, requested_at, attempts, next_attempt)
   SELECT address, proto, ?, 0, 0 FROM pools WHERE address = ?
   ON CONFLICT(address) DO UPDATE SET
     proto = excluded.proto,
     requested_at = excluded.requested_at`,
);
const trimHydrationQ = db.prepare(
  `DELETE FROM hydration_demand WHERE address IN (
     SELECT address FROM hydration_demand
     ORDER BY requested_at DESC, address
     LIMIT -1 OFFSET ?
   )`,
);

/** Queue API-visible rows for asynchronous hydration without trusting callers. */
export function enqueueHydrationDemand(addrs: readonly string[], maxQueued: number): void {
  const unique = [...new Set(addrs.map((address) => address.toLowerCase()))];
  if (!unique.length) return;
  const cap = Math.max(1, Math.floor(maxQueued));
  tx(() => {
    const requestedAt = now();
    for (const address of unique) enqueueHydrationQ.run(requestedAt, address);
    trimHydrationQ.run(cap);
  });
}

const dueHydrationQ = db.prepare(
  `SELECT address FROM hydration_demand INDEXED BY idx_hydration_demand_due
   WHERE next_attempt <= ?
   ORDER BY next_attempt, requested_at DESC, address
   LIMIT ?`,
);
export const takeHydrationDemand = (limit: number): string[] =>
  (
    dueHydrationQ.all(now(), Math.max(0, Math.floor(limit))) as Array<{
      address: string;
    }>
  ).map((row) => row.address);

const hydrationReadyQ = db.prepare(
  `SELECT p.address,
          CASE WHEN t0.meta_ok = 1 AND t1.meta_ok = 1 AND
            CASE WHEN p.proto IN ('univ3', 'pancakev3')
              THEN s.sqrt_price IS NOT NULL AND s.tick IS NOT NULL AND s.liquidity IS NOT NULL
              ELSE s.total_supply IS NOT NULL
            END AND s.updated >= h.requested_at
          THEN 1 ELSE 0 END AS ready
   FROM pools p
   JOIN hydration_demand h ON h.address = p.address
   LEFT JOIN pool_state s ON s.address = p.address
   LEFT JOIN tokens t0 ON t0.address = p.token0
   LEFT JOIN tokens t1 ON t1.address = p.token1
   WHERE p.address = ?`,
);
const deleteHydrationQ = db.prepare('DELETE FROM hydration_demand WHERE address = ?');
const hydrationAttemptsQ = db.prepare('SELECT attempts FROM hydration_demand WHERE address = ?');
const retryHydrationQ = db.prepare(
  `UPDATE hydration_demand
   SET attempts = attempts + 1,
       next_attempt = ?,
       last_error = ?
   WHERE address = ?`,
);

/** Remove complete rows and back off incomplete/failed rows for a later retry. */
export function settleHydrationDemand(
  addrs: readonly string[],
  lastError = 'metadata/state incomplete',
): { ready: number; retry: number } {
  let ready = 0;
  let retry = 0;
  tx(() => {
    for (const address of new Set(addrs.map((value) => value.toLowerCase()))) {
      const row = hydrationReadyQ.get(address) as { ready: number } | undefined;
      if (!row || row.ready === 1) {
        deleteHydrationQ.run(address);
        ready++;
        continue;
      }
      const attempts = (hydrationAttemptsQ.get(address) as { attempts: number } | undefined)?.attempts ?? 0;
      const delay = Math.min(900, 15 * 2 ** Math.min(attempts, 6));
      retryHydrationQ.run(now() + delay, lastError.slice(0, 120), address);
      retry++;
    }
  });
  return { ready, retry };
}

const hydrationDemandCountQ = db.prepare('SELECT COUNT(*) AS n FROM hydration_demand');
export const hydrationDemandCount = (): number => (hydrationDemandCountQ.get() as { n: number }).n;

/** hot set: real TVL, or GT-visible activity, or freshly created */
export const hotAddrs = (limit?: number): string[] => {
  if (limit === undefined)
    return (
      db
        .prepare(
          `SELECT address FROM pool_state WHERE tvl_usd BETWEEN ? AND ?
           UNION SELECT address FROM pool_stats WHERE vol24h_usd > 0
           UNION SELECT address FROM pools WHERE added_ts > ?`,
        )
        .all(TUNE.hotTvlUsd, TUNE.maxPoolTvlUsd, now() - 3_600) as {
        address: string;
      }[]
    ).map((r) => r.address);

  const cap = Math.max(0, Math.floor(limit));
  if (!cap) return [];
  const out = new Set<string>();
  const add = (rows: { address: string }[]) => {
    for (const row of rows) {
      if (out.size >= cap) break;
      out.add(row.address);
    }
  };
  add(
    db
      .prepare(
        `SELECT address FROM pool_state
         WHERE tvl_usd BETWEEN ? AND ? ORDER BY tvl_usd DESC LIMIT ?`,
      )
      .all(TUNE.hotTvlUsd, TUNE.maxPoolTvlUsd, cap) as { address: string }[],
  );
  add(
    db
      .prepare(
        `SELECT address FROM pool_stats WHERE vol24h_usd > 0
         ORDER BY vol24h_usd DESC, address LIMIT ?`,
      )
      .all(cap) as { address: string }[],
  );
  return [...out];
};

/**
 * Active set for the periodic sweep. Small catalogs also include every pool
 * younger than 48h; progressive multi-million-row catalogs pass a hard limit
 * and spend that budget on the highest credible TVL instead of dust census.
 */
export const activeAddrs = (limit?: number): string[] => {
  if (limit === undefined)
    return (
      db
        .prepare(
          `SELECT address FROM pool_state WHERE tvl_usd >= ?
           UNION SELECT address FROM pools WHERE added_ts > ?`,
        )
        .all(100, now() - 172_800) as { address: string }[]
    ).map((r) => r.address);

  const cap = Math.max(0, Math.floor(limit));
  if (!cap) return [];
  return (
    db
      .prepare(
        `SELECT address FROM pool_state
         WHERE tvl_usd >= ? AND tvl_usd < ?
         ORDER BY tvl_usd DESC LIMIT ?`,
      )
      .all(100, TUNE.maxPoolTvlUsd, cap) as { address: string }[]
  ).map((r) => r.address);
};

export const tx = (fn: () => void) => {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
};
