// Read-only HTTP API. Response shapes mirror the frontend's PoolsData /
// PoolStat structures so the POOLS tab maps rows 1:1 (bigints travel as
// strings). Served same-origin in production (nginx /api → this) and through
// the vite dev/preview proxy locally.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import { ADDR, CHAIN, INDEX_V2, PORT, TUNE, UNI, V4, log, now } from './config';
import { safeError } from './rpc';
import {
  db,
  enqueueHydrationDemand,
  hasCompleteV4SnapshotRows,
  hydrationDemandCount,
  kvGet,
  pancakeV2CatalogGeneration,
  poolCounts,
  solverAdjacencyProjectionReady,
  solverConnectorCandidates,
  solverConnectorRankMeta,
  solverConnectorSide,
  SOLVER_CONNECTOR_RANK_K,
  SOLVER_PROTO_BIT,
  SQLITE_BUSY_TIMEOUT_MS,
  v4PoolCount,
  v4PositionIdsByOwner,
  v23CatalogClock,
} from './store';
import {
  BSC_PANCAKE_V3_SUBGRAPH_DEPLOYMENT,
  BSC_PANCAKE_V3_SUBGRAPH_ID,
} from './pancakeV3Subgraph';
import {
  BSC_UNI_V3_SUBGRAPH_DEPLOYMENT,
  BSC_UNI_V3_SUBGRAPH_ID,
} from './v3Subgraph';
import { getPoolRankApi, getPoolRankSnapshot, POOL_RANK_ENABLED, type PoolRankRow } from './poolRank';
import { SerializedResponseCache, type SerializedResponse } from './responseCache';

const JSONH = { 'content-type': 'application/json; charset=utf-8' };

type Params = URLSearchParams;
type ExactPair = readonly [string, string];

const PROTOS = new Set(['univ2', 'univ3', 'pancakev2', 'pancakev3']);
const V2_PROTOS = new Set(['univ2', 'pancakev2']);
const ENABLED_PROTOS = new Set([...PROTOS].filter((proto) => INDEX_V2 || !V2_PROTOS.has(proto)));
const SOLVER_PROTOCOLS = new Set([...ENABLED_PROTOS, 'univ4']);
const HEX40 = /^0x[0-9a-f]{40}$/;
const HEX64 = /^0x[0-9a-f]{64}$/;

/**
 * A user's search term as a LIKE pattern that can only match itself.
 *
 * Unescaped, the two LIKE metacharacters are a match-everything: `%` alone
 * becomes the pattern `%%`, which selects the entire token table and hands the
 * result to an `IN` over a multi-million-row catalog. `_` is the same bug one
 * row at a time. Searching for a literal `%` should find symbols containing a
 * percent sign, which is what this makes it do.
 */
export const escapeLikePattern = (term: string): string =>
  term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

/**
 * Both orientations of a `weth/usdt` search, in a shape the planner cannot square.
 *
 * `token0 IN (…a…) AND token1 IN (…b…)` reads like two filters, but those are
 * the leading columns of one index, so SQLite answers it by seeking that index
 * once per `(a, b)` — the CARTESIAN PRODUCT of the two symbol sets. Neither
 * factor is ours to pick: a permissionless catalog decides how many tokens
 * claim a symbol, and `?` — the fallback symbol when `symbol()` reverts — is
 * the largest class of all. Measured on the BSC catalog, `?/usdt` is 3,828 x
 * 2,390 x 2 = 18.3M seeks and takes 29.4s. The 2026-08-10 outage was this shape
 * with both sides matching every token; matching exactly shrinks the factors
 * without stopping them multiplying, and a mint regrows either one.
 *
 * Constraining one column with an indexable term and testing its partner with a
 * correlated EXISTS takes the choice away from the planner: it seeks once per
 * address on the driving side, then checks the partner per matched row, which
 * an EXISTS cannot be folded into a seek. Same 702 rows, 0.30s instead of 29.4s.
 *
 * Placeholders bind in the order `(a, b, a, b)`.
 */
const pairSearchClause = (table: string, col0: string, col1: string): string => {
  const named = `SELECT address FROM ${table} WHERE symbol = ? COLLATE NOCASE`;
  const partnerNamed = (col: string) =>
    `EXISTS (SELECT 1 FROM ${table} t WHERE t.address = p.${col} AND t.symbol = ? COLLATE NOCASE)`;
  return `((p.${col0} IN (${named}) AND ${partnerNamed(col1)})
        OR (p.${col1} IN (${named}) AND ${partnerNamed(col0)}))`;
};

const lexical = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const POOLS_CACHE_CONTROL = 'public, max-age=30';
const POOLS_EDGE_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=240, stale-if-error=3600';
const NO_STORE = 'no-store';
export const FIRST_POOL_CURSOR = '0x0000000000000000000000000000000000000000';
export const FIRST_V4_POOL_CURSOR = `0x${'0'.repeat(64)}`;

const poolResponseCache = new SerializedResponseCache(
  TUNE.apiPoolCacheEntries,
  TUNE.apiPoolCacheMs,
  TUNE.apiPoolCacheStaleMs,
);

/** The largest page any caller may ask for, on every paged endpoint. */
const MAX_PAGE_LIMIT = 500;

/**
 * Its own LRU, not a share of the one above.
 *
 * A full traversal of the grouped catalog is ~200 cursor pages, which would
 * evict every cached pool response from a 256-entry budget and leave the
 * landing page — the request that actually repeats — recomputing each time.
 * Same freshness windows, separate eviction.
 */
const poolGroupsCache = new SerializedResponseCache(
  TUNE.apiPoolCacheEntries,
  TUNE.apiPoolCacheMs,
  TUNE.apiPoolCacheStaleMs,
);

export class ApiInputError extends Error {}
export class ApiConflictError extends Error {}
/** A valid solver request whose bounded, single-response result is too large. */
export class ApiCapacityError extends Error {}

export const SOLVER_TOPOLOGY_SCHEMA_VERSION = 2;
// The ceiling a solver's topology request may name. Raised from 16 on
// 2026-08-06: measured against this catalog, a request's latency is flat from
// 2 to 16 pairs (103-138ms median, no slope) and 16 pairs return 189 pools
// against the 2,048 cap below, so the pair count was rationing nothing. A
// solver spends its own chain profile's budget, which may be lower.
export const SOLVER_TOPOLOGY_MAX_PAIRS = 24;
export const SOLVER_TOPOLOGY_MAX_POOLS = 2_048;
export const SOLVER_ADJACENCY_SCHEMA_VERSION = 2;
export const SOLVER_ADJACENCY_DEFAULT_LIMIT = 512;
export const SOLVER_ADJACENCY_MAX_LIMIT = 1_024;
export const SOLVER_ADJACENCY_MAX_CURSOR_BYTES = 512;
export const SOLVER_ADJACENCY_MAX_RESPONSE_BYTES = 256 * 1_024;
// A keyset page may have to skip additions newer than its frozen fence. Admit
// at most this many across both token orientations for one protocol. With all
// five protocols selected, main-query future skips are therefore <= 10,240;
// admission reads at most one extra sentinel before rejecting an overflow.
export const SOLVER_ADJACENCY_MAX_FUTURE_ROWS_PER_PROTOCOL = 2_048;
// Up to twelve protocol/direction branches, each capped at limit + 1. This is
// an assertion over bounded projection reads, not a tuning knob that can
// silently truncate a neighbor's protocol list.
export const SOLVER_ADJACENCY_MAX_QUERY_ROWS =
  2 * (SOLVER_ADJACENCY_MAX_LIMIT + 1) * 4 +
  4 * (SOLVER_ADJACENCY_MAX_LIMIT + 1);
const SOLVER_ADJACENCY_DB_BUDGET_MS = 100;
export const SOLVER_CONNECTORS_SCHEMA_VERSION = 1;
export const SOLVER_CONNECTORS_DEFAULT_LIMIT = 64;
// Both ranked lists are capped at K, so this can never ask for more than an
// intersection could hold.
export const SOLVER_CONNECTORS_MAX_LIMIT = SOLVER_CONNECTOR_RANK_K;
const SOLVER_CONNECTORS_PARAMS = new Set(['a', 'b', 'protocol', 'limit']);

function singleParam(params: Params, key: string): string | null {
  const values = params.getAll(key);
  if (values.length > 1) throw new ApiInputError(`duplicate ${key}`);
  return values[0] ?? null;
}

/**
 * Contract-address pair filter used by the solver. Both values are required,
 * canonical and distinct: silently sorting a reversed request would hide a
 * caller identity bug, while a one-sided filter would recreate the expensive
 * popular-token scan this endpoint is meant to avoid.
 */
function exactPair(params: Params): ExactPair | null {
  const raw0 = singleParam(params, 'token0');
  const raw1 = singleParam(params, 'token1');
  if (raw0 === null && raw1 === null) return null;
  if (raw0 === null || raw1 === null) throw new ApiInputError('exact pair requires both token0 and token1');
  if ((params.get('q') ?? '').trim()) throw new ApiInputError('exact pair cannot be combined with q');
  const token0 = raw0.trim().toLowerCase();
  const token1 = raw1.trim().toLowerCase();
  if (!HEX40.test(token0) || !HEX40.test(token1)) throw new ApiInputError('invalid exact pair address');
  if (token0 >= token1) throw new ApiInputError('exact pair must use canonical token0 < token1 order');
  return [token0, token1];
}

/** Strict repeated `pair=token0,token1` parser for the solver-only endpoint. */
function solverTopologyPairs(params: Params): ExactPair[] {
  for (const key of params.keys())
    if (key !== 'pair' && key !== 'protocol')
      throw new ApiInputError(`unknown solver topology parameter ${key}`);

  const rawPairs = params.getAll('pair');
  if (!rawPairs.length || rawPairs.length > SOLVER_TOPOLOGY_MAX_PAIRS)
    throw new ApiInputError(`solver topology requires 1..${SOLVER_TOPOLOGY_MAX_PAIRS} pairs`);

  const pairs = new Map<string, ExactPair>();
  for (const raw of rawPairs) {
    const parts = raw.split(',');
    if (parts.length !== 2) throw new ApiInputError('invalid solver topology pair');
    const token0 = parts[0].trim().toLowerCase();
    const token1 = parts[1].trim().toLowerCase();
    if (!HEX40.test(token0) || !HEX40.test(token1))
      throw new ApiInputError('invalid solver topology pair address');
    if (token0 >= token1)
      throw new ApiInputError('solver topology pair must use canonical token0 < token1 order');
    pairs.set(`${token0},${token1}`, [token0, token1]);
  }
  return [...pairs.values()].sort(([a0, a1], [b0, b1]) => lexical(a0, b0) || lexical(a1, b1));
}

function solverTopologyProtocols(params: Params): SolverTopologyPool['proto'][] {
  const raw = params.getAll('protocol');
  if (!raw.length || raw.length > SOLVER_PROTOCOLS.size)
    throw new ApiInputError(`solver topology requires 1..${SOLVER_PROTOCOLS.size} protocols`);
  const protocols = new Set<SolverTopologyPool['proto']>();
  for (const value of raw) {
    const protocol = value.trim().toLowerCase();
    if (!SOLVER_PROTOCOLS.has(protocol)) throw new ApiInputError('invalid solver topology protocol');
    protocols.add(protocol as SolverTopologyPool['proto']);
  }
  return [...protocols].sort((a, b) => SOLVER_PROTO_RANK[a] - SOLVER_PROTO_RANK[b]);
}

function v4Limit(params: Params): number {
  const raw = singleParam(params, 'limit');
  if (raw === null) return 100;
  if (!/^[1-9]\d*$/.test(raw)) throw new ApiInputError('invalid univ4 limit');
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_PAGE_LIMIT)
    throw new ApiInputError('invalid univ4 limit');
  return parsed;
}

export function poolsWhere(params: Params): {
  where: string;
  args: (string | number)[];
  exactPair: ExactPair | null;
} {
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  const pair = exactPair(params);

  const requestedProto = requestedProtocols(params);
  if (requestedProto.length) {
    clauses.push(`p.proto IN (${requestedProto.map(() => '?').join(',')})`);
    args.push(...requestedProto);
  } else {
    // UP33 shares the address/state substrate for recommendation sampling, but
    // it is not part of this public Uniswap/Pancake catalog contract. Keep the
    // default just as narrow as an explicit request; otherwise an internal
    // strategy venue leaks into counts, cursors and clients that cannot render
    // its protocol value.
    // Express the exclusion as an anti-set (the official UP33 registry is small
    // relative to the public factory catalogs). A direct `p.proto <> ...`
    // predicate makes SQLite abandon
    // the composite token-pair index for symbol-pair searches; this shape
    // materializes the small internal set once and preserves the bounded pair
    // seek on the multi-million-row public catalog.
    if (INDEX_V2) clauses.push("p.address NOT IN (SELECT address FROM pools WHERE proto = 'up33cl')");
    else {
      clauses.push(`p.proto IN (${[...ENABLED_PROTOS].map(() => '?').join(',')})`);
      args.push(...ENABLED_PROTOS);
    }
  }

  const minTvl = Number(params.get('min_tvl'));
  if (Number.isFinite(minTvl) && minTvl > 0) {
    clauses.push('s.tvl_usd >= ?');
    args.push(minTvl);
  }

  if (pair) {
    clauses.push('p.token0 = ? AND p.token1 = ?');
    args.push(...pair);
  }

  const q = (params.get('q') ?? '').trim().toLowerCase();
  if (q) {
    if (HEX40.test(q)) {
      clauses.push('(p.address = ? OR p.token0 = ? OR p.token1 = ?)');
      args.push(q, q, q);
    } else if (q.includes('/')) {
      // pair search: "weth/usdg" — both sides must match, in either orientation.
      //
      // Symbols match exactly here while a bare term below matches by prefix.
      // That is a deliberate difference: naming two sides is a precise request,
      // and every extra symbol a prefix admits becomes another index seek on
      // the driving side.
      //
      // An empty side carries no constraint, and reading it as "match
      // everything" is the opposite of what someone typing `weth/` is asking
      // for. `q=/` is two empty sides, which is how 2026-08-10 began.
      const [a, b] = q.split('/', 2).map((s) => s.trim());
      if (a && b) {
        clauses.push(pairSearchClause('tokens', 'token0', 'token1'));
        args.push(a, b, a, b);
      } else {
        clauses.push('0 = 1');
      }
    } else {
      // Prefix search, deliberately: the univ4 path matches substrings, this one
      // matches from the start of the symbol, and that difference is UX rather
      // than an accident. The escape is what stops `q=%` from reaching the
      // catalog as a match-everything.
      const prefix = `${escapeLikePattern(q)}%`;
      const side = `SELECT address FROM tokens WHERE symbol LIKE ? ESCAPE '\\'`;
      clauses.push(`(p.token0 IN (${side}) OR p.token1 IN (${side}))`);
      args.push(prefix, prefix);
    }
  }
  return {
    where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '',
    args,
    exactPair: pair,
  };
}

function requestedProtocols(params: Params): string[] {
  const requestedProto = (params.get('proto') ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (requestedProto.some((proto) => !PROTOS.has(proto))) throw new ApiInputError('invalid pool protocol');
  if (requestedProto.some((proto) => !ENABLED_PROTOS.has(proto)))
    throw new ApiInputError('pool protocol is disabled');
  return [...new Set(requestedProto)];
}

const POOLS_PARAMS = new Set([
  'after',
  'catalog_block',
  'catalog_generation',
  'catalog_seq',
  'limit',
  'min_tvl',
  'proto',
  'q',
  'sort',
  'token0',
  'token1',
]);
const PROTO_RANK = new Map(['univ2', 'univ3', 'pancakev2', 'pancakev3', 'univ4'].map((proto, i) => [proto, i]));

export type CanonicalPoolsRequest = {
  key: string;
  params: URLSearchParams;
  protocolFamily: 'v23' | 'v4';
  /** Set only when a DB read failed and the last-known namespace was reused. */
  generationError?: unknown;
};

type PoolProtocolFamily = CanonicalPoolsRequest['protocolFamily'];
const lastCatalogGeneration: Partial<Record<PoolProtocolFamily, string>> = {};

/**
 * The v4 catalog's generation, from whichever directory this chain has.
 *
 * A subgraph chain publishes it as `v4_snapshot_generation`, which is also the
 * solver's guarded snapshot-publish switch. An RPC directory has no snapshot
 * and must not touch that switch, so it publishes its own identity separately
 * — but every reader wants the same answer: which directory is this.
 */
export const v4CatalogGeneration = (): string | null =>
  (V4?.rpcDirectory ? kvGet('v4_rpc_generation') : kvGet('v4_snapshot_generation')) || null;

const readCatalogGeneration = (family: PoolProtocolFamily): string =>
  family === 'v4' ? v4CatalogGeneration() ?? 'none' : v23CatalogClock().generation;

/** Validate once, then use the normalized parameters for both SQL and cache identity. */
export function canonicalPoolsRequest(
  params: Params,
  generationReader: (family: PoolProtocolFamily) => string = readCatalogGeneration,
): CanonicalPoolsRequest {
  for (const key of params.keys()) {
    if (!POOLS_PARAMS.has(key)) throw new ApiInputError(`unknown pool parameter ${key}`);
  }
  for (const key of POOLS_PARAMS) {
    if (params.getAll(key).length > 1) throw new ApiInputError(`duplicate ${key}`);
  }

  const rawProtocols = (singleParam(params, 'proto') ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (rawProtocols.some((proto) => !PROTO_RANK.has(proto))) throw new ApiInputError('invalid pool protocol');
  const protocols = [...new Set(rawProtocols)].sort(
    (a, b) => (PROTO_RANK.get(a) ?? Number.MAX_SAFE_INTEGER) - (PROTO_RANK.get(b) ?? Number.MAX_SAFE_INTEGER),
  );
  const protocolFamily = protocols.includes('univ4') ? 'v4' : 'v23';
  if (protocolFamily === 'v4' && (protocols.length !== 1 || protocols[0] !== 'univ4'))
    throw new ApiInputError('univ4 uses a PoolId cursor and cannot be mixed with address-keyed protocols');

  const normalized = new URLSearchParams();
  if (protocols.length) normalized.set('proto', protocols.join(','));

  const q = (singleParam(params, 'q') ?? '').trim().toLowerCase();
  if (q.length > 96) throw new ApiInputError('pool search is too long');
  if (q) normalized.set('q', q);

  const pair = exactPair(params);
  if (pair) {
    normalized.set('token0', pair[0]);
    normalized.set('token1', pair[1]);
  }

  const rawLimit = singleParam(params, 'limit');
  let limit = 100;
  if (rawLimit !== null) {
    if (!/^[1-9]\d*$/.test(rawLimit)) throw new ApiInputError('invalid pool limit');
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit > MAX_PAGE_LIMIT) throw new ApiInputError('invalid pool limit');
  }
  normalized.set('limit', String(limit));

  const rawMinTvl = singleParam(params, 'min_tvl');
  if (rawMinTvl !== null) {
    if (protocolFamily === 'v4') throw new ApiInputError('min_tvl is unavailable for univ4');
    const minTvl = Number(rawMinTvl);
    if (!Number.isFinite(minTvl) || minTvl < 0) throw new ApiInputError('invalid min_tvl');
    if (minTvl > 0) normalized.set('min_tvl', String(minTvl));
  }

  const rawSort = singleParam(params, 'sort');
  if (rawSort !== null) {
    if (protocolFamily === 'v4') throw new ApiInputError('sort is unavailable for univ4');
    const sort = rawSort.trim().toLowerCase();
    if (!Object.hasOwn(ORDER, sort)) throw new ApiInputError('invalid pool sort');
    if (sort !== 'tvl') normalized.set('sort', sort);
  }

  const rawAfter = singleParam(params, 'after');
  if (rawAfter !== null) {
    const after = rawAfter.trim().toLowerCase();
    if (!(protocolFamily === 'v4' ? HEX64 : HEX40).test(after))
      throw new ApiInputError(`invalid ${protocolFamily === 'v4' ? 'univ4' : 'v2/v3'} after cursor`);
    normalized.set('after', after);
  }

  const rawCatalogSeq = singleParam(params, 'catalog_seq');
  const rawCatalogBlock = singleParam(params, 'catalog_block');
  const rawGeneration = singleParam(params, 'catalog_generation');
  if (protocolFamily === 'v4') {
    if (rawCatalogSeq !== null) throw new ApiInputError('catalog_seq is unavailable for univ4');
    if (rawCatalogBlock !== null) {
      if (!/^[1-9]\d*$/.test(rawCatalogBlock) || !Number.isSafeInteger(Number(rawCatalogBlock)))
        throw new ApiInputError('invalid univ4 catalog_block');
      normalized.set('catalog_block', String(Number(rawCatalogBlock)));
    }
    if (rawGeneration !== null) normalized.set('catalog_generation', rawGeneration.trim().toLowerCase());
  } else {
    if (rawCatalogBlock !== null) throw new ApiInputError('catalog_block is unavailable for v2/v3');
    if (rawCatalogSeq !== null) {
      if (!/^(0|[1-9]\d*)$/.test(rawCatalogSeq) || !Number.isSafeInteger(Number(rawCatalogSeq)))
        throw new ApiInputError('invalid v2/v3 catalog_seq');
      normalized.set('catalog_seq', String(Number(rawCatalogSeq)));
    }
    if (rawGeneration !== null) {
      if (!/^(0|[1-9]\d*)$/.test(rawGeneration)) throw new ApiInputError('invalid v2/v3 catalog_generation');
      normalized.set('catalog_generation', String(BigInt(rawGeneration)));
    }
  }

  // A destructive catalog change gets a new namespace immediately. If SQLite
  // itself is temporarily unavailable, retain the last namespace only so an
  // already-built last-good response remains reachable; callers must not build
  // a new response under that fallback namespace.
  let generation: string;
  let generationError: unknown;
  try {
    generation = generationReader(protocolFamily);
    lastCatalogGeneration[protocolFamily] = generation;
  } catch (error) {
    const last = lastCatalogGeneration[protocolFamily];
    if (last === undefined) throw error;
    generation = last;
    generationError = error;
  }
  const query = normalized.toString();
  return {
    key: `${CHAIN.key}:${CHAIN.id}|/api/pools|${protocolFamily}:${generation}|${query}`,
    params: normalized,
    protocolFamily,
    ...(generationError === undefined ? {} : { generationError }),
  };
}

// TVL ranking sinks corrupt figures to the bottom instead of filtering them:
// this chain's whole TVL is ~8 orders under maxPoolTvlUsd, so anything above it
// is a pricing artefact, not a whale — but it must stay reachable by address or
// symbol search so it can still be diagnosed. (2026-07-22: without this guard
// 120 of the 120 rows the POOLS tab fetches were fabricated.)
const ORDER: Record<string, string> = {
  tvl: `ORDER BY (s.tvl_usd IS NULL OR s.tvl_usd >= ${TUNE.maxPoolTvlUsd}), s.tvl_usd DESC, p.address ASC`,
  vol: 'ORDER BY (st.vol24h_usd IS NULL), st.vol24h_usd DESC, p.address ASC',
  created: 'ORDER BY (p.created_block IS NULL), p.created_block DESC, p.pair_index DESC, p.address ASC',
};

type PoolOut = Record<string, unknown>;

function addressCatalogTotals(): Record<string, number> {
  const totals: Record<string, number> = {
    univ2: 0,
    univ3: 0,
    pancakev2: 0,
    pancakev3: 0,
  };
  for (const row of poolCounts())
    if (ENABLED_PROTOS.has(row.proto)) totals[row.proto] = row.n;
  return totals;
}

function v2CatalogCapability(supported: boolean, countKey: string, factoryCountKey: string, localCount: number) {
  const cursor = Number(kvGet(countKey) ?? 0);
  const factoryCount = Number(kvGet(factoryCountKey) ?? 0);
  const ready =
    supported &&
    Number.isSafeInteger(cursor) &&
    Number.isSafeInteger(factoryCount) &&
    factoryCount > 0 &&
    cursor === factoryCount &&
    localCount === cursor;
  return { supported, ready, localCount, cursor, factoryCount };
}

/**
 * Pancake V2's multi-million-pair bootstrap is published atomically from an
 * Ankr bulk-log snapshot, then advanced by the ordinary RPC tail. Only the
 * published provenance keys participate here: resumable
 * `pancake_v2_snapshot_import_*` checkpoints are intentionally neither exposed
 * nor accepted as evidence of a complete catalog.
 */
function pancakeV2CatalogCapability(localCount: number) {
  const catalog = v2CatalogCapability(
    INDEX_V2 && CHAIN.id === 56,
    'pancake_v2_count',
    'pancake_v2_factory_count',
    localCount,
  );
  const snapshotSource = kvGet('pancake_v2_snapshot_source') ?? null;
  const snapshotBlock = Number(kvGet('pancake_v2_snapshot_block')) || null;
  const snapshotBlockHash = kvGet('pancake_v2_snapshot_block_hash') || null;
  const snapshotPoolCount = Number(kvGet('pancake_v2_snapshot_pool_count')) || null;
  const snapshotCatalogGeneration = kvGet('pancake_v2_snapshot_catalog_generation') || null;
  const snapshotComplete = kvGet('pancake_v2_snapshot_complete') === '1';
  const liveCatalogGeneration = pancakeV2CatalogGeneration();
  const snapshotReady =
    snapshotSource === 'ankr_getLogs' &&
    snapshotComplete &&
    snapshotBlock !== null &&
    Number.isSafeInteger(snapshotBlock) &&
    snapshotBlock > 0 &&
    snapshotBlockHash !== null &&
    HEX64.test(snapshotBlockHash) &&
    snapshotPoolCount !== null &&
    Number.isSafeInteger(snapshotPoolCount) &&
    snapshotPoolCount > 0 &&
    snapshotPoolCount <= catalog.cursor &&
    snapshotCatalogGeneration !== null &&
    /^(0|[1-9]\d*)$/.test(snapshotCatalogGeneration) &&
    snapshotCatalogGeneration === liveCatalogGeneration;
  return {
    ...catalog,
    ready: catalog.ready && snapshotReady,
    snapshotSource,
    snapshotBlock,
    snapshotBlockHash,
    snapshotPoolCount,
    snapshotCatalogGeneration,
    catalogGeneration: liveCatalogGeneration,
    snapshotComplete,
  };
}

function v3CatalogCapability(pancake: boolean, localCount: number) {
  const supported = !pancake || CHAIN.id === 56;
  const prefix = pancake ? 'pancake_v3_' : 'v3_';
  const cursorBlock = Number(kvGet(`${prefix}cursor`) ?? 0);
  const targetBlock = Number(kvGet(`${prefix}target_block`) ?? 0);
  const backfilled = kvGet(`${prefix}backfilled`) === '1';
  const snapshotSource = kvGet(`${prefix}snapshot_source`) ?? null;
  const snapshotBlock = Number(kvGet(`${prefix}snapshot_block`)) || null;
  const snapshotBlockHash = kvGet(`${prefix}snapshot_block_hash`) || null;
  const snapshotPoolCount = Number(kvGet(`${prefix}snapshot_pool_count`)) || null;
  const snapshotDeployment = kvGet(`${prefix}snapshot_deployment`) || null;
  const snapshotSubgraphId = kvGet(`${prefix}snapshot_subgraph_id`) || null;
  const snapshotComplete = kvGet(`${prefix}snapshot_complete`) === '1';
  const defaultSubgraphId = pancake
    ? BSC_PANCAKE_V3_SUBGRAPH_ID
    : BSC_UNI_V3_SUBGRAPH_ID;
  const defaultDeployment = pancake
    ? BSC_PANCAKE_V3_SUBGRAPH_DEPLOYMENT
    : BSC_UNI_V3_SUBGRAPH_DEPLOYMENT;
  const configuredSubgraphId =
    (pancake
      ? process.env.INDEXER_PANCAKE_V3_SUBGRAPH_ID
      : process.env.INDEXER_V3_SUBGRAPH_ID
    )?.trim() || defaultSubgraphId;
  const configuredDeployment =
    (pancake
      ? process.env.INDEXER_PANCAKE_V3_SUBGRAPH_DEPLOYMENT
      : process.env.INDEXER_V3_SUBGRAPH_DEPLOYMENT
    )?.trim() ||
    (configuredSubgraphId === defaultSubgraphId ? defaultDeployment : null);
  const tailReady =
    backfilled &&
    Number.isSafeInteger(cursorBlock) &&
    Number.isSafeInteger(targetBlock) &&
    cursorBlock > 0 &&
    targetBlock > 0 &&
    cursorBlock >= targetBlock;
  const graphReady =
    CHAIN.id !== 56 ||
    (snapshotSource === 'thegraph' &&
      snapshotComplete &&
      snapshotBlock !== null &&
      snapshotBlock > 0 &&
      snapshotBlock <= cursorBlock &&
      snapshotPoolCount !== null &&
      snapshotPoolCount > 0 &&
      localCount >= snapshotPoolCount &&
      snapshotDeployment === configuredDeployment &&
      snapshotSubgraphId === configuredSubgraphId &&
      snapshotBlockHash !== null &&
      HEX64.test(snapshotBlockHash));
  return {
    supported,
    ready: supported && tailReady && graphReady,
    localCount,
    cursorBlock,
    targetBlock,
    backfilled,
    snapshotSource,
    snapshotBlock,
    snapshotBlockHash,
    snapshotPoolCount,
    snapshotDeployment,
    snapshotSubgraphId,
    snapshotComplete,
  };
}

function addressCatalogCapabilities(totals = addressCatalogTotals()) {
  const v2 = v2CatalogCapability(INDEX_V2, 'v2_count', 'v2_factory_count', totals.univ2);
  const v3 = v3CatalogCapability(false, totals.univ3);
  const pancakeV2 = pancakeV2CatalogCapability(totals.pancakev2);
  const pancakeV3 = v3CatalogCapability(true, totals.pancakev3);
  const lastError = kvGet('v23_tail_error') || null;
  const degraded = lastError !== null;
  return {
    v2,
    v3,
    pancakeV2,
    pancakeV3,
    degraded,
    lastError,
    lastErrorAt: Number(kvGet('v23_tail_error_at')) || null,
    lastSuccessAt: Number(kvGet('v23_tail_success_at')) || null,
    ready:
      !degraded &&
      (!v2.supported || v2.ready) &&
      v3.ready &&
      (!pancakeV2.supported || pancakeV2.ready) &&
      (!pancakeV3.supported || pancakeV3.ready),
  };
}

type LandingCandidates = { cte: string; args: Array<string | number> };

/**
 * Build the no-cursor landing set from small index-driven top lists. The final
 * COALESCE/order expression therefore sorts O(candidate cap), never the entire
 * multi-million-row catalog. Search and address-cursor traversal stay exact.
 */
function landingCandidates(params: Params, requestedLimit: number): LandingCandidates {
  const perSource = Math.max(requestedLimit, Math.min(20_000, Math.floor(TUNE.landingCandidateN)));
  const parts: string[] = [];
  const args: Array<string | number> = [];
  const add = (sql: string, ...values: Array<string | number>) => {
    parts.push(`SELECT address FROM (${sql})`);
    args.push(...values);
  };

  const protocols = requestedProtocols(params);
  const scopes: Array<string | null> = protocols.length
    ? protocols
    : INDEX_V2
      ? [null]
      : [...ENABLED_PROTOS];
  for (const proto of scopes) {
    const protoFilter = proto === null ? '' : 'proto = ? AND ';
    const protoValue = proto === null ? [] : [proto];
    add(
      `SELECT address FROM pool_state INDEXED BY ${proto === null ? 'idx_state_tvl' : 'idx_state_proto_tvl'}
       WHERE ${protoFilter}tvl_usd IS NOT NULL AND tvl_usd < ?
       ORDER BY tvl_usd DESC LIMIT ?`,
      ...protoValue,
      TUNE.maxPoolTvlUsd,
      perSource,
    );
    add(
      `SELECT address FROM pool_stats INDEXED BY ${proto === null ? 'idx_stats_vol' : 'idx_stats_proto_vol'}
       WHERE ${protoFilter}vol24h_usd IS NOT NULL
       ORDER BY vol24h_usd DESC LIMIT ?`,
      ...protoValue,
      perSource,
    );
    add(
      `SELECT address FROM pool_stats INDEXED BY ${proto === null ? 'idx_stats_liq' : 'idx_stats_proto_liq'}
       WHERE ${protoFilter}liq_usd IS NOT NULL
       ORDER BY liq_usd DESC LIMIT ?`,
      ...protoValue,
      perSource,
    );
    add(
      `SELECT address FROM pools INDEXED BY ${proto === null ? 'idx_pools_created' : 'idx_pools_proto_created'}
       ${proto === null ? '' : 'WHERE proto = ?'}
       ORDER BY created_block DESC, pair_index DESC, address LIMIT ?`,
      ...protoValue,
      perSource,
    );
    add(
      `SELECT address FROM hydration_demand INDEXED BY ${
        proto === null ? 'idx_hydration_demand_due' : 'idx_hydration_demand_proto_due'
      }
       ${proto === null ? '' : 'WHERE proto = ?'}
       ORDER BY next_attempt, requested_at DESC, address LIMIT ?`,
      ...protoValue,
      perSource,
    );

    // A protocol-only landing page must not be starved when another venue owns
    // every global top slot. Both slices remain bounded and index-driven.
    const filter = proto === null ? '' : 'WHERE proto = ?';
    const values = proto === null ? [perSource] : [proto, perSource];
    add(
      `SELECT address FROM pools INDEXED BY ${proto === null ? 'idx_pools_added' : 'idx_pools_proto_added'}
       ${filter} ORDER BY added_ts DESC, address LIMIT ?`,
      ...values,
    );
    add(`SELECT address FROM pools ${filter} ORDER BY address LIMIT ?`, ...values);
  }

  return {
    cte: `WITH candidates(address) AS (${parts.join('\nUNION\n')})`,
    args,
  };
}

const V23_FIELDS = `p.address, p.proto, p.token0, p.token1, p.fee_ppm, p.tick_spacing, p.created_block,
  s.sqrt_price, s.tick, s.liquidity, s.reserve0, s.reserve1, s.total_supply,
  s.tvl_usd, s.tvl_approx, s.updated AS state_updated,
  st.vol5m_usd, st.vol1h_usd, st.vol6h_usd, st.vol24h_usd,
  st.txns24h, st.liq_usd, st.source AS stats_source`;

/** A match count, and whether it is the total or only a floor. */
type MatchCount = { n: number; capped: boolean };

const exactly = (n: number): MatchCount => ({ n, capped: false });

function fastV23Count(
  params: Params,
  totals: Record<string, number>,
  pair: ExactPair | null,
): MatchCount | null {
  if ((params.get('q') ?? '').trim() || pair) return null;
  const protocols = requestedProtocols(params);
  const minTvl = Number(params.get('min_tvl'));
  if (Number.isFinite(minTvl) && minTvl > 0) {
    const countProtocols = protocols.length ? protocols : [...ENABLED_PROTOS];
    const protoClause = ` AND proto IN (${countProtocols.map(() => '?').join(',')})`;
    const { n } = db
      .prepare(`SELECT COUNT(*) AS n FROM pool_state WHERE tvl_usd >= ?${protoClause}`)
      .get(minTvl, ...countProtocols) as { n: number };
    return exactly(n);
  }
  return exactly(
    protocols.length
      ? protocols.reduce((sum, proto) => sum + (totals[proto] ?? 0), 0)
      : Object.values(totals).reduce((sum, count) => sum + count, 0),
  );
}

/**
 * How far a search counts its matches before it answers "at least this many".
 *
 * `fastV23Count` above covers every filter a running total or an index can
 * answer. A search falls past it onto a plain `COUNT(*)` over the whole match
 * set — the one query `LIMIT` cannot help, because a count has to visit every
 * matching row to produce its number. Measured on the BSC catalog with the
 * event loop held throughout: `q=a` (31,634 matches) 16.4s, `q=usd` (298,448)
 * ~25s. Counting to a ceiling costs ~1s.
 *
 * A multiple of the page limit rather than a free-standing number: `hasMore`
 * compares this count against a page, so a capped count has to outrank the
 * largest page anyone can ask for.
 */
const SEARCH_COUNT_CAP = 10 * MAX_PAGE_LIMIT;

/** Exact while the match set is small, `cap`-and-capped once it is not. */
export function boundedCount(base: string, args: (string | number)[], cap: number): MatchCount {
  const { n } = db
    .prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 ${base} LIMIT ${cap + 1})`)
    .get(...args) as { n: number };
  return n > cap ? { n: cap, capped: true } : exactly(n);
}

function getV23Pools(params: Params) {
  const { where, args, exactPair: pair } = poolsWhere(params);
  const limit = Math.min(Math.max(Number(params.get('limit')) || 100, 1), MAX_PAGE_LIMIT);
  const rawAfter = (params.get('after') ?? '').trim().toLowerCase();
  const after = HEX40.test(rawAfter) ? rawAfter : null;
  const cursorPage = after !== null;
  const rawCatalogSeq = singleParam(params, 'catalog_seq');
  const rawCatalogGeneration = singleParam(params, 'catalog_generation');
  if (!cursorPage && (rawCatalogSeq !== null || rawCatalogGeneration !== null))
    throw new ApiInputError('v2/v3 landing page cannot carry a catalog fence');
  if (cursorPage && (rawCatalogSeq === null) !== (rawCatalogGeneration === null))
    throw new ApiInputError('v2/v3 continuation requires both catalog_seq and catalog_generation');

  const startClock = v23CatalogClock();
  let catalogSeq = startClock.seq;
  if (rawCatalogSeq !== null) {
    if (!/^(0|[1-9]\d*)$/.test(rawCatalogSeq) || !Number.isSafeInteger(Number(rawCatalogSeq)))
      throw new ApiInputError('invalid v2/v3 catalog_seq');
    if (BigInt(rawCatalogSeq) > BigInt(startClock.seq))
      throw new ApiConflictError('v2/v3 catalog fence is no longer available; restart pagination');
    catalogSeq = rawCatalogSeq;
  }
  let catalogGeneration = startClock.generation;
  if (rawCatalogGeneration !== null) {
    if (!/^(0|[1-9]\d*)$/.test(rawCatalogGeneration))
      throw new ApiInputError('invalid v2/v3 catalog_generation');
    if (rawCatalogGeneration !== startClock.generation)
      throw new ApiConflictError('v2/v3 catalog generation changed; restart pagination');
    catalogGeneration = rawCatalogGeneration;
  }

  const fencedWhere = `${where}${where ? ' AND' : 'WHERE'} COALESCE(p.catalog_seq, 0) <= ?`;
  const fencedArgs = [...args, Number(catalogSeq)];
  const base = `FROM pools p LEFT JOIN pool_state s ON s.address = p.address LEFT JOIN pool_stats st ON st.address = p.address ${fencedWhere}`;
  const totals = addressCatalogTotals();
  // Keep the fast counter on cursor pages: recounting 2.6m rows for every
  // continuation would make browsing unusable. It is live metadata, while the
  // row set itself is frozen by catalogSeq; mergeUniIndexPages retains the
  // landing page's count for the lifetime of that fence. A search is the case
  // it cannot answer, and counting one out is unbounded — so count to a ceiling.
  const counted = fastV23Count(params, totals, pair) ?? boundedCount(base, fencedArgs, SEARCH_COUNT_CAP);
  const count = counted.n;
  // The landing page stays useful (TVL/volume/newest ordering). Every later
  // page restarts from address zero and advances by the pool's immutable
  // address under the exact same filters. That deliberately overlaps the
  // landing page; the client de-duplicates it, and browsing is complete without
  // OFFSET's shifting-page behaviour or the former 20k ceiling.
  const cursorClause = cursorPage ? ' AND p.address > ?' : '';
  const pageArgs = cursorPage ? [...fencedArgs, after] : fencedArgs;
  const order = cursorPage ? 'ORDER BY p.address ASC' : (ORDER[params.get('sort') ?? 'tvl'] ?? ORDER.tvl);
  let fetched: Record<string, unknown>[];
  if (!cursorPage && !(params.get('q') ?? '').trim() && !pair) {
    const candidates = landingCandidates(params, limit);
    fetched = db
      .prepare(
        `${candidates.cte}
         SELECT ${V23_FIELDS}
         FROM candidates c
         CROSS JOIN pools p ON p.address = c.address
         LEFT JOIN pool_state s ON s.address = p.address
         LEFT JOIN pool_stats st ON st.address = p.address
         ${fencedWhere} ${order} LIMIT ?`,
      )
      .all(...candidates.args, ...fencedArgs, limit) as Record<string, unknown>[];
  } else {
    fetched = db
      .prepare(`SELECT ${V23_FIELDS} ${base} ${cursorClause} ${order} LIMIT ?`)
      .all(...pageArgs, cursorPage ? limit + 1 : limit) as Record<string, unknown>[];
  }
  const hasMore = cursorPage ? fetched.length > limit : count > fetched.length;
  const rows = cursorPage ? fetched.slice(0, limit) : fetched;
  const nextCursor = hasMore
    ? cursorPage
      ? ((rows.at(-1)?.address as string | undefined) ?? null)
      : FIRST_POOL_CURSOR
    : null;

  const tokenAddrs = new Set<string>();
  const needsHydration = new Set<string>();
  const rawQuery = (params.get('q') ?? '').trim().toLowerCase();
  const exactPoolAddress = HEX40.test(rawQuery) ? rawQuery : null;
  const staleBefore = Math.floor((Date.now() - TUNE.targetedStateStaleMs) / 1_000);
  const pools: PoolOut[] = rows.map((r) => {
    tokenAddrs.add(r.token0 as string);
    tokenAddrs.add(r.token1 as string);
    const concentrated = r.proto === 'univ3' || r.proto === 'pancakev3';
    const stateReady = concentrated
      ? r.sqrt_price !== null && r.tick !== null && r.liquidity !== null
      : r.reserve0 !== null && r.reserve1 !== null && r.total_supply !== null;
    const stateUpdated = typeof r.state_updated === 'number' ? r.state_updated : null;
    const exactStateStale = exactPoolAddress === r.address && (stateUpdated === null || stateUpdated <= staleBefore);
    if (!stateReady || exactStateStale) needsHydration.add(r.address as string);
    return {
      proto: r.proto,
      address: r.address,
      token0: r.token0,
      token1: r.token1,
      feePpm: r.fee_ppm,
      tickSpacing: r.tick_spacing,
      createdBlock: r.created_block,
      sqrtPriceX96: r.sqrt_price,
      tick: r.tick,
      liquidity: r.liquidity,
      reserve0: r.reserve0 ?? '0',
      reserve1: r.reserve1 ?? '0',
      totalSupply: r.total_supply,
      tvlUsd: r.tvl_usd,
      tvlApprox: r.tvl_approx === 1,
      vol5mUsd: r.vol5m_usd,
      vol1hUsd: r.vol1h_usd,
      vol6hUsd: r.vol6h_usd,
      vol24hUsd: r.vol24h_usd,
      txns24h: r.txns24h,
      gtLiqUsd: r.liq_usd,
      statsSource: r.stats_source,
      stateUpdated,
      stateReady,
    };
  });

  const tokens: Record<string, unknown> = {};
  const safeTokenMetadata = new Set<string>();
  if (tokenAddrs.size) {
    const list = [...tokenAddrs];
    const trs = db
      .prepare(
        `SELECT address, symbol, decimals, meta_ok, price_usd FROM tokens WHERE address IN (${list.map(() => '?').join(',')})`,
      )
      .all(...list) as {
      address: string;
      symbol: string;
      decimals: number;
      meta_ok: number;
      price_usd: number | null;
    }[];
    for (const t of trs) {
      tokens[t.address] = {
        address: t.address,
        symbol: t.symbol,
        decimals: t.decimals,
        metaOk: t.meta_ok === 1,
        priceUsd: t.price_usd,
      };
      if (t.meta_ok === 1) safeTokenMetadata.add(t.address);
    }
  }

  for (const row of rows)
    if (!safeTokenMetadata.has(row.token0 as string) || !safeTokenMetadata.has(row.token1 as string))
      needsHydration.add(row.address as string);
  enqueueHydrationDemand([...needsHydration], TUNE.hydrationDemandMax);

  // Additions are harmless because the query is bounded by catalogSeq. A
  // delete or identity mutation cannot be reconstructed from that high-water
  // mark, so fail the traversal if one raced this page.
  if (v23CatalogClock().generation !== catalogGeneration)
    throw new ApiConflictError('v2/v3 catalog generation changed; restart pagination');

  const catalogs = addressCatalogCapabilities(totals);
  // One indexer instance owns one chain's catalog. Emit both the structured
  // identity used by health/deployment checks and the scalar compatibility
  // field used by chain-switching clients.
  return {
    schemaVersion: 1,
    chainId: CHAIN.id,
    ready: kvGet('ready') === '1' && catalogs.ready,
    chain: { key: CHAIN.key, id: CHAIN.id },
    asof: Number(kvGet('snapshot_asof')) || null,
    totals,
    count,
    // Present only when `count` is a floor rather than the total, so a client
    // that has never heard of it keeps reading `count` the way it always did.
    ...(counted.capped ? { countCapped: true } : {}),
    nextCursor,
    catalogSeq,
    catalogGeneration,
    pools,
    tokens,
  };
}

/** Query-plan hook used by the large-catalog regression test. */
export function explainV23Landing(params: Params): string[] {
  if ((params.get('after') ?? '').trim() || (params.get('q') ?? '').trim() || exactPair(params))
    throw new ApiInputError('landing plan accepts neither cursor nor search');
  const { where, args } = poolsWhere(params);
  const limit = Math.min(Math.max(Number(params.get('limit')) || 100, 1), MAX_PAGE_LIMIT);
  const candidates = landingCandidates(params, limit);
  const order = ORDER[params.get('sort') ?? 'tvl'] ?? ORDER.tvl;
  return (
    db
      .prepare(
        `EXPLAIN QUERY PLAN ${candidates.cte}
         SELECT ${V23_FIELDS}
         FROM candidates c
         CROSS JOIN pools p ON p.address = c.address
         LEFT JOIN pool_state s ON s.address = p.address
         LEFT JOIN pool_stats st ON st.address = p.address
         ${where} ${order} LIMIT ?`,
      )
      .all(...candidates.args, ...args, limit) as Array<{ detail: string }>
  ).map((row) => row.detail);
}

function v4Capability() {
  // Two directory sources, one readiness question. A subgraph chain must prove
  // its pinned snapshot is the configured one; an RPC chain has no snapshot to
  // pin — its scan IS the directory, so reaching the target block is the whole
  // proof. Everything after that (cursor, target, backfilled, degraded) is
  // shared, because both paths write the same cursor through the same scanner.
  const rpcDirectory = V4?.rpcDirectory ?? null;
  const supported = V4 !== null && (V4.poolSubgraph !== null || rpcDirectory !== null);
  const localCount = v4PoolCount();
  const cursorBlock = Number(kvGet('v4_cursor') ?? 0);
  const targetBlock = Number(kvGet('v4_target_block') ?? 0);
  const configuredSubgraphId = process.env.INDEXER_V4_SUBGRAPH_ID?.trim() || V4?.poolSubgraph || '';
  const snapshotComplete = rpcDirectory
    ? supported && kvGet('v4_rpc_directory') === '1'
    : supported && hasCompleteV4SnapshotRows() && kvGet('v4_snapshot_subgraph_id') === configuredSubgraphId;
  const lastError = kvGet('v4_tail_error') || null;
  const degraded = supported && lastError !== null;
  const ready =
    snapshotComplete &&
    kvGet('v4_backfilled') === '1' &&
    cursorBlock > 0 &&
    targetBlock > 0 &&
    cursorBlock >= targetBlock &&
    !degraded;
  return {
    supported,
    ready,
    degraded,
    lastError,
    lastErrorAt: Number(kvGet('v4_tail_error_at')) || null,
    localCount,
    cursorBlock,
    targetBlock,
    backfilled: kvGet('v4_backfilled') === '1',
    snapshotSource: kvGet('v4_snapshot_source') ?? null,
    snapshotBlock: Number(kvGet('v4_snapshot_block')) || null,
    snapshotBlockHash: kvGet('v4_snapshot_block_hash') || null,
    snapshotPoolCount: Number(kvGet('v4_snapshot_pool_count')) || null,
    snapshotDeployment: kvGet('v4_snapshot_deployment') || null,
    snapshotSubgraphId: kvGet('v4_snapshot_subgraph_id') || null,
    snapshotGeneration: v4CatalogGeneration(),
    snapshotComplete,
    featuredBlock: Number(kvGet('v4_featured_block')) || null,
    featuredCount: Number(kvGet('v4_featured_count')) || null,
    featuredAsof: Number(kvGet('v4_featured_asof')) || null,
  };
}

/** Stable schema placeholder for a topology scope that did not request V4. */
function neutralV4Capability(): ReturnType<typeof v4Capability> {
  return {
    supported: false,
    ready: false,
    degraded: false,
    lastError: null,
    lastErrorAt: null,
    localCount: 0,
    cursorBlock: 0,
    targetBlock: 0,
    backfilled: false,
    snapshotSource: null,
    snapshotBlock: null,
    snapshotBlockHash: null,
    snapshotPoolCount: null,
    snapshotDeployment: null,
    snapshotSubgraphId: null,
    snapshotGeneration: null,
    snapshotComplete: false,
    featuredBlock: null,
    featuredCount: null,
    featuredAsof: null,
  };
}

type SolverV23Pool = {
  proto: 'univ2' | 'univ3' | 'pancakev2' | 'pancakev3';
  address: string;
  token0: string;
  token1: string;
  feePpm: number;
  tickSpacing: number | null;
  createdBlock: number | null;
};

type SolverV4Pool = {
  proto: 'univ4';
  address: string;
  poolId: string;
  token0: string;
  token1: string;
  keyFeePpm: number | null;
  tickSpacing: number;
  hooks: string;
  createdBlock: number | null;
};

type SolverTopologyPool = SolverV23Pool | SolverV4Pool;

// The V2/V3 bits come from the store, which stamps them into the ranked
// connector projection. Restating them here is how the two would drift.
const SOLVER_PROTO_RANK: Record<SolverTopologyPool['proto'], number> = {
  ...SOLVER_PROTO_BIT,
  univ4: 4,
};

type SolverProtocol = SolverTopologyPool['proto'];
type SolverV23Protocol = Exclude<SolverProtocol, 'univ4'>;

const SOLVER_ADJACENCY_PARAMS = new Set([
  'token',
  'protocol',
  'limit',
  'page_token',
  'v23_seq',
  'v23_generation',
  'v4_block',
  'v4_generation',
]);
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const CURSOR_VERSION = 1;

type SolverAdjacencyCursor = {
  v: number;
  schemaVersion: number;
  chainId: number;
  token: string;
  protocolMask: number;
  limit: number;
  v23Seq: string;
  v23Generation: string;
  v4Block: number;
  v4Generation: string | null;
  lastNeighbor: string;
};

type SolverAdjacencyScope = {
  token: string;
  protocols: SolverProtocol[];
  v23Protocols: SolverV23Protocol[];
  includeV4: boolean;
  protocolMask: number;
  limit: number;
};

type SolverAdjacencyFence = {
  v23Seq: string;
  v23Generation: string;
  v4Block: number;
  v4Generation: string | null;
};

function canonicalUnsignedInteger(raw: string, label: string): string {
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new ApiInputError(`invalid ${label}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new ApiInputError(`invalid ${label}`);
  return raw;
}

function solverAdjacencyScope(params: Params): SolverAdjacencyScope {
  for (const key of params.keys())
    if (!SOLVER_ADJACENCY_PARAMS.has(key))
      throw new ApiInputError(`unknown solver adjacency parameter ${key}`);

  const rawToken = singleParam(params, 'token');
  if (rawToken === null || !HEX40.test(rawToken))
    throw new ApiInputError('solver adjacency requires one canonical lowercase token');

  const rawProtocols = params.getAll('protocol');
  if (!rawProtocols.length || rawProtocols.length > SOLVER_PROTOCOLS.size)
    throw new ApiInputError(`solver adjacency requires 1..${SOLVER_PROTOCOLS.size} protocols`);
  const protocolSet = new Set<SolverProtocol>();
  for (const value of rawProtocols) {
    const protocol = value.trim().toLowerCase();
    if (!SOLVER_PROTOCOLS.has(protocol))
      throw new ApiInputError('invalid solver adjacency protocol');
    protocolSet.add(protocol as SolverProtocol);
  }
  const protocols = [...protocolSet].sort(
    (a, b) => SOLVER_PROTO_RANK[a] - SOLVER_PROTO_RANK[b],
  );
  const includeV4 = protocols.includes('univ4');
  if (rawToken === ZERO_ADDRESS && !includeV4)
    throw new ApiInputError('address zero is valid only for univ4 adjacency');

  const rawLimit = singleParam(params, 'limit');
  let limit = SOLVER_ADJACENCY_DEFAULT_LIMIT;
  if (rawLimit !== null) {
    const canonical = canonicalUnsignedInteger(rawLimit, 'solver adjacency limit');
    limit = Number(canonical);
    if (limit < 1 || limit > SOLVER_ADJACENCY_MAX_LIMIT)
      throw new ApiInputError('invalid solver adjacency limit');
  }

  return {
    token: rawToken,
    protocols,
    v23Protocols: protocols.filter(
      (protocol): protocol is SolverV23Protocol => protocol !== 'univ4',
    ),
    includeV4,
    protocolMask: protocols.reduce(
      (mask, protocol) => mask | (1 << SOLVER_PROTO_RANK[protocol]),
      0,
    ),
    limit,
  };
}

function encodeSolverAdjacencyCursor(cursor: SolverAdjacencyCursor): string {
  const encoded = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  if (Buffer.byteLength(encoded, 'utf8') > SOLVER_ADJACENCY_MAX_CURSOR_BYTES)
    throw new ApiCapacityError('solver adjacency cursor exceeds byte cap');
  return encoded;
}

function decodeSolverAdjacencyCursor(raw: string): SolverAdjacencyCursor {
  if (
    !raw ||
    Buffer.byteLength(raw, 'utf8') > SOLVER_ADJACENCY_MAX_CURSOR_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(raw)
  )
    throw new ApiInputError('invalid solver adjacency page_token');

  let parsed: unknown;
  try {
    const bytes = Buffer.from(raw, 'base64url');
    if (
      bytes.byteLength > SOLVER_ADJACENCY_MAX_CURSOR_BYTES ||
      bytes.toString('base64url') !== raw
    )
      throw new Error('non-canonical base64url');
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ApiInputError('invalid solver adjacency page_token');
  }

  const expectedKeys = [
    'v',
    'schemaVersion',
    'chainId',
    'token',
    'protocolMask',
    'limit',
    'v23Seq',
    'v23Generation',
    'v4Block',
    'v4Generation',
    'lastNeighbor',
  ];
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(parsed, key))
  )
    throw new ApiInputError('invalid solver adjacency page_token');

  const value = parsed as Record<string, unknown>;
  if (
    value.v !== CURSOR_VERSION ||
    value.schemaVersion !== SOLVER_ADJACENCY_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.chainId) ||
    typeof value.token !== 'string' ||
    !HEX40.test(value.token) ||
    !Number.isSafeInteger(value.protocolMask) ||
    (value.protocolMask as number) < 1 ||
    (value.protocolMask as number) >= 1 << SOLVER_PROTOCOLS.size ||
    !Number.isSafeInteger(value.limit) ||
    (value.limit as number) < 1 ||
    (value.limit as number) > SOLVER_ADJACENCY_MAX_LIMIT ||
    typeof value.v23Seq !== 'string' ||
    typeof value.v23Generation !== 'string' ||
    !/^(0|[1-9]\d*)$/.test(value.v23Seq) ||
    !/^(0|[1-9]\d*)$/.test(value.v23Generation) ||
    !Number.isSafeInteger(Number(value.v23Seq)) ||
    !Number.isSafeInteger(Number(value.v23Generation)) ||
    !Number.isSafeInteger(value.v4Block) ||
    (value.v4Block as number) < 0 ||
    !(
      value.v4Generation === null ||
      (typeof value.v4Generation === 'string' && HEX64.test(value.v4Generation))
    ) ||
    typeof value.lastNeighbor !== 'string' ||
    !HEX40.test(value.lastNeighbor)
  )
    throw new ApiInputError('invalid solver adjacency page_token');

  // Rebuild in the one canonical field order. Re-stringifying the parsed
  // attacker object would accidentally bless arbitrary key ordering.
  const cursor: SolverAdjacencyCursor = {
    v: value.v as number,
    schemaVersion: value.schemaVersion as number,
    chainId: value.chainId as number,
    token: value.token as string,
    protocolMask: value.protocolMask as number,
    limit: value.limit as number,
    v23Seq: value.v23Seq as string,
    v23Generation: value.v23Generation as string,
    v4Block: value.v4Block as number,
    v4Generation: value.v4Generation as string | null,
    lastNeighbor: value.lastNeighbor as string,
  };
  if (encodeSolverAdjacencyCursor(cursor) !== raw)
    throw new ApiInputError('non-canonical solver adjacency page_token');
  return cursor;
}

function currentSolverAdjacencyFence(
  scope: SolverAdjacencyScope,
  v23: ReturnType<typeof v23CatalogClock>,
  v4: ReturnType<typeof v4Capability>,
): SolverAdjacencyFence {
  const v4Block = scope.includeV4 ? v4.cursorBlock || v4.snapshotBlock || 0 : 0;
  const v4Generation = scope.includeV4 ? v4.snapshotGeneration : null;
  if (
    !/^(0|[1-9]\d*)$/.test(v23.seq) ||
    !/^(0|[1-9]\d*)$/.test(v23.generation) ||
    !Number.isSafeInteger(Number(v23.seq)) ||
    !Number.isSafeInteger(Number(v23.generation)) ||
    !Number.isSafeInteger(v4Block) ||
    v4Block < 0 ||
    (v4Generation !== null && !HEX64.test(v4Generation))
  )
    throw new ApiCapacityError('published solver adjacency fence is invalid');
  return {
    v23Seq: v23.seq,
    v23Generation: v23.generation,
    v4Block,
    v4Generation,
  };
}

function validateSolverAdjacencyFence(
  fence: SolverAdjacencyFence,
  current: SolverAdjacencyFence,
  v4SnapshotBlock: number | null,
): void {
  if (Number(fence.v23Seq) > Number(current.v23Seq))
    throw new ApiInputError('solver adjacency v23_seq is in the future');
  if (fence.v23Generation !== current.v23Generation)
    throw new ApiConflictError('v2/v3 catalog generation changed; restart adjacency');
  if (fence.v4Block > current.v4Block)
    throw new ApiInputError('solver adjacency v4_block is in the future');
  if (fence.v4Generation !== current.v4Generation)
    throw new ApiConflictError('univ4 catalog generation changed; restart adjacency');
  if (v4SnapshotBlock !== null && fence.v4Block < v4SnapshotBlock)
    throw new ApiInputError('solver adjacency v4_block predates its snapshot');
}

function requestedSolverAdjacencyFence(
  params: Params,
  scope: SolverAdjacencyScope,
  current: SolverAdjacencyFence,
  v4SnapshotBlock: number | null,
): { fence: SolverAdjacencyFence; lastNeighbor: string | null } {
  const rawPageToken = singleParam(params, 'page_token');
  const rawV23Seq = singleParam(params, 'v23_seq');
  const rawV23Generation = singleParam(params, 'v23_generation');
  const rawV4Block = singleParam(params, 'v4_block');
  const rawV4Generation = singleParam(params, 'v4_generation');
  const hasExplicitFence =
    rawV23Seq !== null ||
    rawV23Generation !== null ||
    rawV4Block !== null ||
    rawV4Generation !== null;

  if (rawPageToken !== null) {
    if (hasExplicitFence)
      throw new ApiInputError('solver adjacency continuation cannot include explicit fences');
    const cursor = decodeSolverAdjacencyCursor(rawPageToken);
    if (
      cursor.chainId !== CHAIN.id ||
      cursor.token !== scope.token ||
      cursor.protocolMask !== scope.protocolMask ||
      cursor.limit !== scope.limit ||
      cursor.lastNeighbor === scope.token
    )
      throw new ApiInputError('solver adjacency page_token scope mismatch');
    if (
      (!scope.includeV4 &&
        (cursor.v4Block !== 0 || cursor.v4Generation !== null)) ||
      (scope.includeV4 && cursor.v4Generation === null && current.v4Generation !== null)
    )
      throw new ApiInputError('solver adjacency page_token protocol scope mismatch');
    const fence = {
      v23Seq: cursor.v23Seq,
      v23Generation: cursor.v23Generation,
      v4Block: cursor.v4Block,
      v4Generation: cursor.v4Generation,
    };
    validateSolverAdjacencyFence(
      fence,
      current,
      scope.includeV4 ? v4SnapshotBlock : null,
    );
    return { fence, lastNeighbor: cursor.lastNeighbor };
  }

  if (!hasExplicitFence) return { fence: current, lastNeighbor: null };
  if (rawV23Seq === null || rawV23Generation === null)
    throw new ApiInputError('solver adjacency requires a complete v2/v3 fence');
  if (
    scope.includeV4 !== (rawV4Block !== null && rawV4Generation !== null) ||
    (!scope.includeV4 && (rawV4Block !== null || rawV4Generation !== null))
  )
    throw new ApiInputError('solver adjacency requires a selected-scope v4 fence');

  const v23Seq = canonicalUnsignedInteger(rawV23Seq, 'solver adjacency v23_seq');
  const v23Generation = canonicalUnsignedInteger(
    rawV23Generation,
    'solver adjacency v23_generation',
  );
  let v4Block = 0;
  let v4Generation: string | null = null;
  if (scope.includeV4) {
    v4Block = Number(
      canonicalUnsignedInteger(rawV4Block as string, 'solver adjacency v4_block'),
    );
    if (rawV4Generation === 'null') v4Generation = null;
    else if (rawV4Generation !== null && HEX64.test(rawV4Generation))
      v4Generation = rawV4Generation;
    else throw new ApiInputError('invalid solver adjacency v4_generation');
  }
  const fence = { v23Seq, v23Generation, v4Block, v4Generation };
  validateSolverAdjacencyFence(
    fence,
    current,
    scope.includeV4 ? v4SnapshotBlock : null,
  );
  return { fence, lastNeighbor: null };
}

type SolverAdjacencyRow = { neighbor: string; proto: SolverV23Protocol };

function boundedAdjacencyRows<T>(
  sql: string,
  args: Array<string | number>,
  started: number,
): T[] {
  try {
    const rows = db.prepare(sql).all(...args) as T[];
    if (performance.now() - started > SOLVER_ADJACENCY_DB_BUDGET_MS)
      throw new ApiCapacityError('solver adjacency database deadline exceeded');
    return rows;
  } catch (error) {
    if (
      error instanceof ApiCapacityError ||
      /interrupted|database is (?:busy|locked)/i.test(String(error))
    )
      throw new ApiCapacityError('solver adjacency database capacity unavailable');
    throw error;
  }
}

function admitSolverAdjacencyFutureRows(
  sql: string,
  args: Array<string | number>,
  started: number,
): void {
  const rows = boundedAdjacencyRows<{ future_row: 1 }>(
    sql,
    [...args, SOLVER_ADJACENCY_MAX_FUTURE_ROWS_PER_PROTOCOL + 1],
    started,
  );
  if (rows.length > SOLVER_ADJACENCY_MAX_FUTURE_ROWS_PER_PROTOCOL)
    throw new ApiCapacityError('solver adjacency future-row cap exceeded');
}

function solverReadSnapshot<T>(label: string, read: () => T): T {
  let active = false;
  try {
    db.exec('BEGIN');
    active = true;
    const result = read();
    db.exec('COMMIT');
    active = false;
    return result;
  } catch (error) {
    if (active) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the original validation/capacity/database failure.
      }
    }
    if (/database is (?:busy|locked)/i.test(String(error)))
      throw new ApiCapacityError(`solver ${label} database capacity unavailable`);
    throw error;
  }
}

function selectedSolverCatalogEnvelope(
  scope: { v23Protocols: SolverV23Protocol[]; includeV4: boolean },
  addressCatalogs: ReturnType<typeof addressCatalogCapabilities>,
  v4: ReturnType<typeof v4Capability>,
) {
  const selectedV23Ready = scope.v23Protocols.every((protocol) => {
    switch (protocol) {
      case 'univ2':
        return addressCatalogs.v2.supported && addressCatalogs.v2.ready && !addressCatalogs.degraded;
      case 'univ3':
        return addressCatalogs.v3.supported && addressCatalogs.v3.ready && !addressCatalogs.degraded;
      case 'pancakev2':
        return addressCatalogs.pancakeV2.supported && addressCatalogs.pancakeV2.ready && !addressCatalogs.degraded;
      case 'pancakev3':
        return addressCatalogs.pancakeV3.supported && addressCatalogs.pancakeV3.ready && !addressCatalogs.degraded;
    }
  });
  const selectedReady =
    selectedV23Ready &&
    (!scope.includeV4 || (v4.supported && v4.ready && !v4.degraded));
  const selectedBootReady =
    (scope.v23Protocols.length === 0 || kvGet('solver_v23_boot_ready') === '1') &&
    (!scope.includeV4 || kvGet('solver_v4_boot_ready') === '1');
  return {
    ready: selectedBootReady && selectedReady,
    catalogs: {
      v23: {
        ready: scope.v23Protocols.length > 0 && selectedV23Ready,
        degraded: scope.v23Protocols.length > 0 && addressCatalogs.degraded,
        lastError: scope.v23Protocols.length > 0 ? addressCatalogs.lastError : null,
        lastErrorAt: scope.v23Protocols.length > 0 ? addressCatalogs.lastErrorAt : null,
        lastSuccessAt: scope.v23Protocols.length > 0 ? addressCatalogs.lastSuccessAt : null,
      },
      univ2: {
        supported: addressCatalogs.v2.supported,
        ready: addressCatalogs.v2.ready && !addressCatalogs.degraded,
      },
      univ3: {
        supported: addressCatalogs.v3.supported,
        ready: addressCatalogs.v3.ready && !addressCatalogs.degraded,
      },
      pancakev2: {
        supported: addressCatalogs.pancakeV2.supported,
        ready: addressCatalogs.pancakeV2.ready && !addressCatalogs.degraded,
      },
      pancakev3: {
        supported: addressCatalogs.pancakeV3.supported,
        ready: addressCatalogs.pancakeV3.ready && !addressCatalogs.degraded,
      },
      univ4: v4,
    },
    factories: {
      univ2: UNI.V2_FACTORY.toLowerCase(),
      univ3: UNI.V3_FACTORY.toLowerCase(),
      pancakev2: CHAIN.id === 56 ? ADDR.V2_FACTORY.toLowerCase() : null,
      pancakev3: CHAIN.id === 56 ? ADDR.CL_FACTORY.toLowerCase() : null,
      univ4: V4?.POOL_MANAGER.toLowerCase() ?? null,
    },
  };
}

/**
 * Bounded, identity-free neighbor directory for the solver. Every SQL branch
 * reads a compact adjacency projection and is capped before TypeScript merges
 * protocols by complete neighbor; no request scans raw pool identities.
 */
export function getSolverAdjacency(params: Params) {
  const scope = solverAdjacencyScope(params);
  return solverReadSnapshot('adjacency', () => {
    if (!solverAdjacencyProjectionReady())
      throw new ApiCapacityError('solver adjacency projection migration is incomplete');
    return getSolverAdjacencySnapshot(scope, params);
  });
}

type SolverConnectorScope = {
  a: string;
  b: string;
  protocols: SolverV23Protocol[];
  protocolMask: number;
  limit: number;
};

function solverConnectorScope(params: Params): SolverConnectorScope {
  for (const key of params.keys())
    if (!SOLVER_CONNECTORS_PARAMS.has(key))
      throw new ApiInputError(`unknown solver connectors parameter ${key}`);

  const a = singleParam(params, 'a');
  const b = singleParam(params, 'b');
  if (a === null || b === null || !HEX40.test(a) || !HEX40.test(b))
    throw new ApiInputError('solver connectors requires two canonical lowercase tokens');
  if (a === b) throw new ApiInputError('solver connectors requires distinct tokens');

  const rawProtocols = params.getAll('protocol');
  if (!rawProtocols.length || rawProtocols.length > ENABLED_PROTOS.size)
    throw new ApiInputError(`solver connectors requires 1..${ENABLED_PROTOS.size} protocols`);
  const protocolSet = new Set<SolverV23Protocol>();
  for (const value of rawProtocols) {
    const protocol = value.trim().toLowerCase();
    // The ranking is built from pool_state.tvl_usd, which V4 pools do not
    // carry. Ranking the V2/V3 subset while the caller believes V4 was weighed
    // is exactly the silent bias this design refuses everywhere else, so an
    // unrankable protocol is declined instead.
    if (protocol === 'univ4')
      throw new ApiInputError('solver connectors ranks v2/v3 protocols only');
    if (!ENABLED_PROTOS.has(protocol)) throw new ApiInputError('invalid solver connectors protocol');
    protocolSet.add(protocol as SolverV23Protocol);
  }
  const protocols = [...protocolSet].sort(
    (x, y) => SOLVER_PROTO_RANK[x] - SOLVER_PROTO_RANK[y],
  );

  const rawLimit = singleParam(params, 'limit');
  let limit = SOLVER_CONNECTORS_DEFAULT_LIMIT;
  if (rawLimit !== null) {
    limit = Number(canonicalUnsignedInteger(rawLimit, 'solver connectors limit'));
    if (limit < 1 || limit > SOLVER_CONNECTORS_MAX_LIMIT)
      throw new ApiInputError('invalid solver connectors limit');
  }

  return {
    a,
    b,
    protocols,
    protocolMask: protocols.reduce(
      (mask, protocol) => mask | (1 << SOLVER_PROTO_RANK[protocol]),
      0,
    ),
    limit,
  };
}

function protocolsFromMask(mask: number): SolverV23Protocol[] {
  return ([...ENABLED_PROTOS] as SolverV23Protocol[])
    .filter((protocol) => (mask & (1 << SOLVER_PROTO_RANK[protocol])) !== 0)
    .sort((x, y) => SOLVER_PROTO_RANK[x] - SOLVER_PROTO_RANK[y]);
}

/**
 * Tokens that could connect one pair, ranked by what a two-hop route through
 * each could carry.
 *
 * Two BSC hub tokens have 2.4M and 241k neighbours with 37k in common, so this
 * question cannot be answered by handing a caller two adjacency walks, and
 * intersecting the raw projection here measures 31.7s against a 100ms budget.
 * It is served instead from a ranking the reprice worker materializes, which
 * reduces the request to two capped list reads.
 *
 * The ranking is a PRE-FILTER: it decides which candidates a solver considers,
 * while every pool reached through one is still identity-proved through its
 * factory and every quote is still certified independently. That is why the
 * response carries where each side's ranking stopped and how old it is — a
 * caller can only audit what a pre-filter discarded if it knows the reach the
 * pre-filter had.
 */
export function getSolverConnectors(params: Params) {
  const scope = solverConnectorScope(params);
  return solverReadSnapshot('connectors', () => {
    const started = performance.now();
    const ranking = solverConnectorRankMeta();
    // Distinguishable from an empty candidate list on purpose: no ranking means
    // the question was never asked, which is not the same answer as "none".
    if (ranking === undefined)
      throw new ApiCapacityError('solver connector ranking is not published');

    const candidates = solverConnectorCandidates(
      scope.a,
      scope.b,
      scope.protocolMask,
      scope.limit,
    );
    const sides = {
      a: solverConnectorSide(scope.a),
      b: solverConnectorSide(scope.b),
    };
    if (performance.now() - started > SOLVER_ADJACENCY_DB_BUDGET_MS)
      throw new ApiCapacityError('solver connectors database deadline exceeded');

    const envelope = selectedSolverCatalogEnvelope(
      { v23Protocols: scope.protocols, includeV4: false },
      addressCatalogCapabilities(),
      v4Capability(),
    );
    return {
      schemaVersion: SOLVER_CONNECTORS_SCHEMA_VERSION,
      chainId: CHAIN.id,
      chain: { key: CHAIN.key, id: CHAIN.id },
      ready: envelope.ready,
      protocols: scope.protocols,
      catalogs: envelope.catalogs,
      factories: envelope.factories,
      a: scope.a,
      b: scope.b,
      ranking: {
        builtAt: ranking.builtAt,
        ageSeconds: Math.max(0, now() - ranking.builtAt),
        perTokenLimit: ranking.k,
        edges: ranking.rows,
        tokens: ranking.tokens,
        // The catalog the ranking was built from. A caller comparing this
        // against a live fence learns the ranking is stale, never that a
        // candidate is invalid: identity is proved downstream regardless.
        v23Fence: { seq: ranking.v23Seq, generation: ranking.v23Generation },
      },
      sides,
      count: candidates.length,
      candidates: candidates.map((candidate) => ({
        token: candidate.token,
        bottleneckUsd: candidate.bottleneckUsd,
        aTvlUsd: candidate.aTvlUsd,
        bTvlUsd: candidate.bTvlUsd,
        aProtocols: protocolsFromMask(candidate.aProtocolMask),
        bProtocols: protocolsFromMask(candidate.bProtocolMask),
        approx: candidate.approx,
      })),
    };
  });
}

function getSolverAdjacencySnapshot(scope: SolverAdjacencyScope, params: Params) {
  const startV23 = v23CatalogClock();
  const addressCatalogs = addressCatalogCapabilities(addressCatalogTotals());
  const v4 = scope.includeV4 ? v4Capability() : neutralV4Capability();
  const currentFence = currentSolverAdjacencyFence(scope, startV23, v4);
  const { fence, lastNeighbor } = requestedSolverAdjacencyFence(
    params,
    scope,
    currentFence,
    v4.snapshotBlock,
  );
  const started = performance.now();
  const rows: Array<{ neighbor: string; proto: SolverProtocol }> = [];
  const afterForward = lastNeighbor === null ? '' : ' AND token1 > ?';
  const afterReverse = lastNeighbor === null ? '' : ' AND token0 > ?';
  const afterArgs = lastNeighbor === null ? [] : [lastNeighbor];

  if (scope.v23Protocols.length) {
    const rowLimit = scope.limit + 1;
    for (const proto of scope.v23Protocols) {
      // UNION ALL streams both range-indexed orientations and the outer LIMIT
      // stops after cap + 1 rows. The following keyset reads share this SQLite
      // snapshot, so each can skip only an admitted number of post-fence rows.
      admitSolverAdjacencyFutureRows(
        `SELECT 1 AS future_row FROM (
           SELECT 1
           FROM solver_v23_adjacency
             INDEXED BY idx_solver_v23_adjacency_t0_future
           WHERE proto = ? AND token0 = ? AND first_seq > ?
           UNION ALL
           SELECT 1
           FROM solver_v23_adjacency
             INDEXED BY idx_solver_v23_adjacency_t1_future
           WHERE proto = ? AND token1 = ? AND first_seq > ?
         ) LIMIT ?`,
        [
          proto,
          scope.token,
          Number(fence.v23Seq),
          proto,
          scope.token,
          Number(fence.v23Seq),
        ],
        started,
      );
      rows.push(
        ...boundedAdjacencyRows<{ neighbor: string }>(
          `SELECT token1 AS neighbor
           FROM solver_v23_adjacency INDEXED BY idx_solver_v23_adjacency_t0
           WHERE proto = ? AND token0 = ?${afterForward}
             AND first_seq <= ?
           ORDER BY token1 LIMIT ?`,
          [proto, scope.token, ...afterArgs, Number(fence.v23Seq), rowLimit],
          started,
        ).map((row): SolverAdjacencyRow => ({ ...row, proto })),
        ...boundedAdjacencyRows<{ neighbor: string }>(
          `SELECT token0 AS neighbor
           FROM solver_v23_adjacency INDEXED BY idx_solver_v23_adjacency_t1
           WHERE proto = ? AND token1 = ?${afterReverse}
             AND first_seq <= ?
           ORDER BY token0 LIMIT ?`,
          [proto, scope.token, ...afterArgs, Number(fence.v23Seq), rowLimit],
          started,
        ).map((row): SolverAdjacencyRow => ({ ...row, proto })),
      );
    }
  }

  if (scope.includeV4) {
    const rowLimit = scope.limit + 1;
    if (fence.v4Generation !== null) {
      rows.push(
        ...boundedAdjacencyRows<{ neighbor: string }>(
          `SELECT token1 AS neighbor
           FROM solver_v4_adjacency_snapshot
             INDEXED BY idx_solver_v4_adjacency_snapshot_t0
           WHERE snapshot_generation = ? AND token0 = ?${afterForward}
           ORDER BY token1 LIMIT ?`,
          [fence.v4Generation, scope.token, ...afterArgs, rowLimit],
          started,
        ).map((row) => ({ ...row, proto: 'univ4' as const })),
        ...boundedAdjacencyRows<{ neighbor: string }>(
          `SELECT token0 AS neighbor
           FROM solver_v4_adjacency_snapshot
             INDEXED BY idx_solver_v4_adjacency_snapshot_t1
           WHERE snapshot_generation = ? AND token1 = ?${afterReverse}
           ORDER BY token0 LIMIT ?`,
          [fence.v4Generation, scope.token, ...afterArgs, rowLimit],
          started,
        ).map((row) => ({ ...row, proto: 'univ4' as const })),
      );
    }
    admitSolverAdjacencyFutureRows(
      `SELECT 1 AS future_row FROM (
         SELECT 1
         FROM solver_v4_adjacency_event
           INDEXED BY idx_solver_v4_adjacency_event_t0_future
         WHERE token0 = ? AND first_created_block > ?
         UNION ALL
         SELECT 1
         FROM solver_v4_adjacency_event
           INDEXED BY idx_solver_v4_adjacency_event_t1_future
         WHERE token1 = ? AND first_created_block > ?
       ) LIMIT ?`,
      [scope.token, fence.v4Block, scope.token, fence.v4Block],
      started,
    );
    rows.push(
      ...boundedAdjacencyRows<{ neighbor: string }>(
        `SELECT token1 AS neighbor
         FROM solver_v4_adjacency_event INDEXED BY idx_solver_v4_adjacency_event_t0
         WHERE token0 = ?${afterForward} AND first_created_block <= ?
         ORDER BY token1 LIMIT ?`,
        [scope.token, ...afterArgs, fence.v4Block, rowLimit],
        started,
      ).map((row) => ({ ...row, proto: 'univ4' as const })),
      ...boundedAdjacencyRows<{ neighbor: string }>(
        `SELECT token0 AS neighbor
         FROM solver_v4_adjacency_event INDEXED BY idx_solver_v4_adjacency_event_t1
         WHERE token1 = ?${afterReverse} AND first_created_block <= ?
         ORDER BY token0 LIMIT ?`,
        [scope.token, ...afterArgs, fence.v4Block, rowLimit],
        started,
      ).map((row) => ({ ...row, proto: 'univ4' as const })),
    );
  }

  if (rows.length > SOLVER_ADJACENCY_MAX_QUERY_ROWS)
    throw new ApiCapacityError('solver adjacency query row cap exceeded');
  const byNeighbor = new Map<string, Set<SolverProtocol>>();
  for (const row of rows) {
    if (
      !HEX40.test(row.neighbor) ||
      row.neighbor === scope.token ||
      !scope.protocols.includes(row.proto) ||
      ((scope.token === ZERO_ADDRESS || row.neighbor === ZERO_ADDRESS) &&
        row.proto !== 'univ4')
    )
      throw new ApiCapacityError('solver adjacency projection is invalid');
    const protocols = byNeighbor.get(row.neighbor) ?? new Set<SolverProtocol>();
    protocols.add(row.proto);
    byNeighbor.set(row.neighbor, protocols);
  }

  const neighbors = [...byNeighbor.keys()].sort(lexical);
  const hasMore = neighbors.length > scope.limit;
  const emitted = neighbors.slice(0, scope.limit);
  const edges = emitted.map((neighbor) => {
    const token0 = scope.token < neighbor ? scope.token : neighbor;
    const token1 = scope.token < neighbor ? neighbor : scope.token;
    const protocols = [...(byNeighbor.get(neighbor) as Set<SolverProtocol>)].sort(
      (a, b) => SOLVER_PROTO_RANK[a] - SOLVER_PROTO_RANK[b],
    );
    return { token0, token1, protocols };
  });
  const nextPageToken = hasMore
    ? encodeSolverAdjacencyCursor({
        v: CURSOR_VERSION,
        schemaVersion: SOLVER_ADJACENCY_SCHEMA_VERSION,
        chainId: CHAIN.id,
        token: scope.token,
        protocolMask: scope.protocolMask,
        limit: scope.limit,
        v23Seq: fence.v23Seq,
        v23Generation: fence.v23Generation,
        v4Block: fence.v4Block,
        v4Generation: fence.v4Generation,
        lastNeighbor: emitted[emitted.length - 1],
      })
    : null;

  // Additions are excluded by high-water marks; destructive changes make the
  // page unusable rather than mixing adjacency generations.
  if (v23CatalogClock().generation !== fence.v23Generation)
    throw new ApiConflictError('v2/v3 catalog generation changed; retry adjacency');
  const endV4 = scope.includeV4 ? v4Capability() : v4;
  if (scope.includeV4 && endV4.snapshotGeneration !== fence.v4Generation)
    throw new ApiConflictError('univ4 catalog generation changed; retry adjacency');

  const envelope = selectedSolverCatalogEnvelope(scope, addressCatalogs, v4);
  const response = {
    schemaVersion: SOLVER_ADJACENCY_SCHEMA_VERSION,
    chainId: CHAIN.id,
    chain: { key: CHAIN.key, id: CHAIN.id },
    ready: envelope.ready,
    protocols: scope.protocols,
    catalogs: envelope.catalogs,
    factories: envelope.factories,
    v23Fence: { seq: fence.v23Seq, generation: fence.v23Generation },
    v4Fence: { block: fence.v4Block, generation: fence.v4Generation },
    token: scope.token,
    count: edges.length,
    nextPageToken,
    edges,
  };
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') > SOLVER_ADJACENCY_MAX_RESPONSE_BYTES)
    throw new ApiCapacityError('solver adjacency response exceeds byte cap');
  return response;
}

/**
 * One bounded identity-only topology snapshot for solver pair lookups.
 *
 * This endpoint deliberately never joins mutable state/stats tables and never
 * schedules hydration. The address-keyed catalog is frozen by its insertion
 * sequence; the V4 directory is frozen by both the published Graph generation
 * and finalized Initialize block. Consumers still prove every identity and
 * read executable state from their chain RPC.
 */
export function getSolverTopology(params: Params) {
  const pairs = solverTopologyPairs(params);
  const protocols = solverTopologyProtocols(params);
  const v23Protocols = protocols.filter((protocol) => protocol !== 'univ4');
  const includeV4 = protocols.includes('univ4');
  const pairWhere = pairs.map(() => '(p.token0 = ? AND p.token1 = ?)').join(' OR ');
  const pairArgs = pairs.flatMap(([token0, token1]) => [token0, token1]);
  const v4PairWhere = pairs.map(() => '(p.currency0 = ? AND p.currency1 = ?)').join(' OR ');

  const startV23 = v23CatalogClock();
  const totals = addressCatalogTotals();
  const addressCatalogs = addressCatalogCapabilities(totals);
  // V4 may have a large or independently degraded catalog. Keep it wholly
  // outside an address-only request, including its persisted capability KV.
  const v4 = includeV4 ? v4Capability() : neutralV4Capability();
  const v4Block = includeV4 ? v4.cursorBlock || v4.snapshotBlock || 0 : 0;
  const v4Generation = includeV4 ? v4.snapshotGeneration : null;

  type V23Row = {
    proto: SolverV23Pool['proto'];
    address: string;
    token0: string;
    token1: string;
    fee_ppm: number;
    tick_spacing: number | null;
    created_block: number | null;
  };
  const v23Rows = v23Protocols.length
    ? (db
        .prepare(
          `SELECT p.proto, p.address, p.token0, p.token1, p.fee_ppm,
                  p.tick_spacing, p.created_block
           FROM pools p INDEXED BY idx_pools_pair
           WHERE p.proto IN (${v23Protocols.map(() => '?').join(',')})
             AND (${pairWhere})
             AND COALESCE(p.catalog_seq, 0) <= ?
           LIMIT ?`,
        )
        .all(
          ...v23Protocols,
          ...pairArgs,
          Number(startV23.seq),
          SOLVER_TOPOLOGY_MAX_POOLS + 1,
        ) as V23Row[])
    : [];
  if (v23Rows.length > SOLVER_TOPOLOGY_MAX_POOLS)
    throw new ApiCapacityError(`solver topology exceeds ${SOLVER_TOPOLOGY_MAX_POOLS} pools`);

  type V4Row = {
    pool_id: string;
    pool_manager: string;
    currency0: string;
    currency1: string;
    key_fee_ppm: number | null;
    tick_spacing: number;
    hooks: string;
    created_block: number | null;
  };
  const remaining = SOLVER_TOPOLOGY_MAX_POOLS - v23Rows.length;
  const v4Rows = includeV4 && V4
    ? (db
        .prepare(
          `SELECT p.pool_id, p.pool_manager, p.currency0, p.currency1,
                  p.key_fee_ppm, p.tick_spacing, p.hooks, p.created_block
           FROM v4_pools p INDEXED BY idx_v4_pools_pair
           WHERE p.pool_manager = ?
             AND (${v4PairWhere})
             AND ((? IS NOT NULL AND p.snapshot_generation = ?)
                  OR (p.key_fee_ppm IS NOT NULL AND p.created_block IS NOT NULL))
             AND (p.created_block IS NULL OR p.created_block <= ?)
           LIMIT ?`,
        )
        .all(
          V4.POOL_MANAGER.toLowerCase(),
          ...pairArgs,
          v4Generation,
          v4Generation,
          v4Block,
          remaining + 1,
        ) as V4Row[])
    : [];
  if (v23Rows.length + v4Rows.length > SOLVER_TOPOLOGY_MAX_POOLS)
    throw new ApiCapacityError(`solver topology exceeds ${SOLVER_TOPOLOGY_MAX_POOLS} pools`);

  const pools: SolverTopologyPool[] = [
    ...v23Rows.map((row): SolverV23Pool => ({
      proto: row.proto,
      address: row.address.toLowerCase(),
      token0: row.token0.toLowerCase(),
      token1: row.token1.toLowerCase(),
      feePpm: row.fee_ppm,
      tickSpacing: row.tick_spacing,
      createdBlock: row.created_block,
    })),
    ...v4Rows.map((row): SolverV4Pool => ({
      proto: 'univ4',
      address: row.pool_manager.toLowerCase(),
      poolId: row.pool_id.toLowerCase(),
      token0: row.currency0.toLowerCase(),
      token1: row.currency1.toLowerCase(),
      keyFeePpm: row.key_fee_ppm,
      tickSpacing: row.tick_spacing,
      hooks: row.hooks.toLowerCase(),
      createdBlock: row.created_block,
    })),
  ];
  pools.sort((a, b) => {
    const pairOrder = lexical(a.token0, b.token0) || lexical(a.token1, b.token1);
    if (pairOrder) return pairOrder;
    const protoOrder = SOLVER_PROTO_RANK[a.proto] - SOLVER_PROTO_RANK[b.proto];
    if (protoOrder) return protoOrder;
    const aIdentity = a.proto === 'univ4' ? a.poolId : a.address;
    const bIdentity = b.proto === 'univ4' ? b.poolId : b.address;
    return lexical(aIdentity, bIdentity);
  });

  // Additions are excluded by the two high-water marks. Deletions or identity
  // changes require a full retry because neither snapshot can reconstruct them.
  if (v23CatalogClock().generation !== startV23.generation)
    throw new ApiConflictError('v2/v3 catalog generation changed; retry solver topology');
  const endV4 = includeV4 ? v4Capability() : v4;
  if (includeV4 && endV4.snapshotGeneration !== v4Generation)
    throw new ApiConflictError('univ4 catalog generation changed; retry solver topology');

  const selectedV23Ready = v23Protocols.every((protocol) => {
    switch (protocol) {
      case 'univ2':
        return addressCatalogs.v2.supported && addressCatalogs.v2.ready && !addressCatalogs.degraded;
      case 'univ3':
        return addressCatalogs.v3.supported && addressCatalogs.v3.ready && !addressCatalogs.degraded;
      case 'pancakev2':
        return addressCatalogs.pancakeV2.supported && addressCatalogs.pancakeV2.ready && !addressCatalogs.degraded;
      case 'pancakev3':
        return addressCatalogs.pancakeV3.supported && addressCatalogs.pancakeV3.ready && !addressCatalogs.degraded;
    }
  });
  const selectedReady =
    selectedV23Ready &&
    (!includeV4 || (v4.supported && v4.ready && !v4.degraded));
  const selectedBootReady =
    (v23Protocols.length === 0 || kvGet('solver_v23_boot_ready') === '1') &&
    (!includeV4 || kvGet('solver_v4_boot_ready') === '1');

  return {
    schemaVersion: SOLVER_TOPOLOGY_SCHEMA_VERSION,
    chainId: CHAIN.id,
    chain: { key: CHAIN.key, id: CHAIN.id },
    ready: selectedBootReady && selectedReady,
    protocols,
    catalogs: {
      v23: {
        ready: v23Protocols.length > 0 && selectedV23Ready,
        degraded: v23Protocols.length > 0 && addressCatalogs.degraded,
        lastError: v23Protocols.length > 0 ? addressCatalogs.lastError : null,
        lastErrorAt: v23Protocols.length > 0 ? addressCatalogs.lastErrorAt : null,
        lastSuccessAt: v23Protocols.length > 0 ? addressCatalogs.lastSuccessAt : null,
      },
      univ2: { supported: addressCatalogs.v2.supported, ready: addressCatalogs.v2.ready && !addressCatalogs.degraded },
      univ3: { supported: addressCatalogs.v3.supported, ready: addressCatalogs.v3.ready && !addressCatalogs.degraded },
      pancakev2: {
        supported: addressCatalogs.pancakeV2.supported,
        ready: addressCatalogs.pancakeV2.ready && !addressCatalogs.degraded,
      },
      pancakev3: {
        supported: addressCatalogs.pancakeV3.supported,
        ready: addressCatalogs.pancakeV3.ready && !addressCatalogs.degraded,
      },
      univ4: v4,
    },
    factories: {
      univ2: UNI.V2_FACTORY.toLowerCase(),
      univ3: UNI.V3_FACTORY.toLowerCase(),
      pancakev2: CHAIN.id === 56 ? ADDR.V2_FACTORY.toLowerCase() : null,
      pancakev3: CHAIN.id === 56 ? ADDR.CL_FACTORY.toLowerCase() : null,
      univ4: V4?.POOL_MANAGER.toLowerCase() ?? null,
    },
    v23Fence: { seq: startV23.seq, generation: startV23.generation },
    v4Fence: { block: v4Block, generation: v4Generation },
    pairs: pairs.map(([token0, token1]) => ({ token0, token1 })),
    count: pools.length,
    pools,
  };
}

export function v4PoolsWhere(params: Params): {
  where: string;
  args: (string | number)[];
} {
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  const pair = exactPair(params);
  if (pair) {
    clauses.push('p.currency0 = ? AND p.currency1 = ?');
    args.push(...pair);
  }
  const q = (params.get('q') ?? '').trim().toLowerCase().slice(0, 96);
  if (q && q !== '*') {
    if (HEX64.test(q)) {
      clauses.push('p.pool_id = ?');
      args.push(q);
    } else if (HEX40.test(q)) {
      clauses.push('(p.currency0 = ? OR p.currency1 = ?)');
      args.push(q, q);
    } else if (q.includes('/')) {
      const [a, b] = q.split('/', 2).map((side) => side.trim());
      if (a && b) {
        clauses.push(pairSearchClause('v4_tokens', 'currency0', 'currency1'));
        args.push(a, b, a, b);
      } else {
        clauses.push('0 = 1');
      }
    } else {
      const escaped = escapeLikePattern(q);
      const token = `SELECT address FROM v4_tokens WHERE symbol LIKE ? ESCAPE '\\'`;
      clauses.push(`(p.currency0 IN (${token}) OR p.currency1 IN (${token}))`);
      args.push(`%${escaped}%`, `%${escaped}%`);
    }
  }
  return {
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    args,
  };
}

/** Protocol-scoped PoolId catalog; historic rows remain non-executable candidates. */
export function getV4Pools(params: Params) {
  const capability = v4Capability();
  const { where, args } = v4PoolsWhere(params);
  const rawCatalogBlock = singleParam(params, 'catalog_block');
  const rawGeneration = singleParam(params, 'catalog_generation');
  const rawAfter = singleParam(params, 'after');
  const after = rawAfter === null ? null : rawAfter.toLowerCase();
  if (after !== null && !HEX64.test(after)) throw new ApiInputError('invalid univ4 after cursor');

  let catalogGeneration = capability.snapshotGeneration;
  if (rawGeneration !== null) {
    const requested = rawGeneration.toLowerCase();
    if (!HEX64.test(requested)) throw new ApiInputError('invalid univ4 catalog_generation');
    if (requested !== capability.snapshotGeneration)
      throw new ApiConflictError('univ4 catalog generation changed; restart pagination');
    catalogGeneration = requested;
  }
  if (after !== null && (rawCatalogBlock === null || rawGeneration === null))
    throw new ApiInputError('univ4 continuation requires catalog_block and catalog_generation');

  let catalogBlock = capability.cursorBlock || capability.snapshotBlock || 0;
  if (rawCatalogBlock !== null) {
    const requested = Number(rawCatalogBlock);
    if (
      !/^[1-9]\d*$/.test(rawCatalogBlock) ||
      !Number.isSafeInteger(requested) ||
      (capability.snapshotBlock !== null && requested < capability.snapshotBlock) ||
      (capability.cursorBlock > 0 && requested > capability.cursorBlock)
    )
      throw new ApiInputError('invalid univ4 catalog_block');
    catalogBlock = requested;
  }
  const limit = v4Limit(params);
  // Freeze one traversal at the first response's finalized tail cursor. Graph
  // snapshot identities have no creation block and are always in scope; rows
  // learned later from Initialize are visible only after their block. Without
  // this fence a busy tail can change count/page boundaries between clicks.
  const scopedWhere = `${where}${where ? ' AND' : 'WHERE'}
    (p.created_block IS NULL OR p.created_block <= ?)`;
  const scopedArgs = [...args, catalogBlock];
  const featuredBlock = capability.featuredBlock;
  // Only a search is bounded. An unfiltered count is this catalog's own size —
  // the number the landing page exists to report — so a ceiling there would
  // replace a fact. This catalog is two orders smaller than the v2/v3 one,
  // which is the only reason the same shape has not bitten here yet.
  const scoped = `FROM v4_pools p ${scopedWhere}`;
  const counted = (params.get('q') ?? '').trim()
    ? boundedCount(scoped, scopedArgs, SEARCH_COUNT_CAP)
    : exactly((db.prepare(`SELECT COUNT(*) AS n ${scoped}`).get(...scopedArgs) as { n: number }).n);
  const count = counted.n;
  const cursorPage = after !== null;
  type V4ApiRow = {
    pool_id: string;
    pool_manager: string;
    currency0: string;
    currency1: string;
    tick_spacing: number;
    hooks: string;
    created_block: number | null;
    tvl0: number | null;
    tvl1: number | null;
    stats_featured_snapshot: number | null;
    m_vol24h_usd: number | null;
    m_txns24h: number | null;
    m_liq_usd: number | null;
    m_tvl_usd: number | null;
    m_tvl_approx: number | null;
    m_source: string | null;
  };
  // Market stats are joined on every path, cursor page and landing alike: they
  // are keyed by PoolId and have no featured generation, so unlike the Graph
  // accounting above there is no snapshot to match them against.
  const fields = `p.pool_id, p.pool_manager, p.currency0, p.currency1,
    p.tick_spacing, p.hooks, p.created_block,
    m.vol24h_usd AS m_vol24h_usd, m.txns24h AS m_txns24h, m.liq_usd AS m_liq_usd,
    m.tvl_usd AS m_tvl_usd, m.tvl_approx AS m_tvl_approx, m.source AS m_source`;
  const marketJoin = 'LEFT JOIN v4_market_stats m ON m.pool_id = p.pool_id';
  let fetched: V4ApiRow[];
  if (cursorPage) {
    const statsJoin =
      featuredBlock === null
        ? 'LEFT JOIN v4_pool_stats s ON 0 = 1'
        : 'LEFT JOIN v4_pool_stats s ON s.pool_id = p.pool_id AND s.featured_snapshot = ?';
    const pageArgs = featuredBlock === null ? [...scopedArgs, after] : [featuredBlock, ...scopedArgs, after];
    fetched = db
      .prepare(
        `SELECT ${fields}, s.tvl0, s.tvl1,
                s.featured_snapshot AS stats_featured_snapshot
         FROM v4_pools p ${statsJoin} ${marketJoin} ${scopedWhere}
           AND p.pool_id > ?
         ORDER BY p.pool_id ASC LIMIT ?`,
      )
      .all(...pageArgs, limit + 1) as V4ApiRow[];
  } else {
    const target = Math.min(limit, count);
    let featured: V4ApiRow[] = [];
    if (featuredBlock !== null && target > 0) {
      // Drive the landing page from the few current featured rows. The former
      // LEFT JOIN ordered all 162k PoolIds into a TEMP B-TREE on every request.
      featured = db
        .prepare(
          `SELECT ${fields}, s.tvl0, s.tvl1,
                  s.featured_snapshot AS stats_featured_snapshot
           FROM v4_pool_stats s INDEXED BY idx_v4_stats_featured
           JOIN v4_pools p ON p.pool_id = s.pool_id
           ${marketJoin}
           ${scopedWhere} AND s.featured_snapshot = ?
           ORDER BY s.featured_rank ASC, p.pool_id ASC LIMIT ?`,
        )
        .all(...scopedArgs, featuredBlock, target) as V4ApiRow[];
    }
    const remaining = target - featured.length;
    let filler: V4ApiRow[] = [];
    if (remaining > 0) {
      const excludeCurrent =
        featuredBlock === null
          ? ''
          : `AND NOT EXISTS (
             SELECT 1 FROM v4_pool_stats fs
             WHERE fs.pool_id = p.pool_id AND fs.featured_snapshot = ?
           )`;
      const fillerArgs = featuredBlock === null ? scopedArgs : [...scopedArgs, featuredBlock];
      filler = db
        .prepare(
          `SELECT ${fields}, NULL AS tvl0, NULL AS tvl1,
                  NULL AS stats_featured_snapshot
           FROM v4_pools p ${marketJoin} ${scopedWhere} ${excludeCurrent}
           ORDER BY p.pool_id ASC LIMIT ?`,
        )
        .all(...fillerArgs, remaining) as V4ApiRow[];
    }
    fetched = [...featured, ...filler];
  }
  const hasMore = cursorPage ? fetched.length > limit : count > fetched.length;
  const rows = cursorPage ? fetched.slice(0, limit) : fetched;
  const nextCursor = hasMore ? (cursorPage ? (rows.at(-1)?.pool_id ?? null) : FIRST_V4_POOL_CURSOR) : null;

  const ids = rows.filter((row) => row.stats_featured_snapshot !== null).map((row) => row.pool_id);
  const days = new Map<string, Array<{ date: number; volume0: number | null; volume1: number | null }>>();
  if (ids.length) {
    const dayRows = db
      .prepare(
        `SELECT pool_id, date, volume0, volume1 FROM v4_pool_days
         WHERE pool_id IN (${ids.map(() => '?').join(',')})
         ORDER BY pool_id, date DESC`,
      )
      .all(...ids) as Array<{
      pool_id: string;
      date: number;
      volume0: number | null;
      volume1: number | null;
    }>;
    for (const day of dayRows) {
      const list = days.get(day.pool_id) ?? [];
      list.push({ date: day.date, volume0: day.volume0, volume1: day.volume1 });
      days.set(day.pool_id, list);
    }
  }

  const tokenAddresses = [...new Set(rows.flatMap((row) => [row.currency0, row.currency1]))];
  const tokens: Record<string, unknown> = {};
  if (tokenAddresses.length) {
    const tokenRows = db
      .prepare(
        `SELECT address, symbol, decimals FROM v4_tokens
         WHERE address IN (${tokenAddresses.map(() => '?').join(',')})`,
      )
      .all(...tokenAddresses) as Array<{
      address: string;
      symbol: string;
      decimals: number;
    }>;
    for (const token of tokenRows)
      tokens[token.address] = {
        address: token.address,
        symbol: token.symbol,
        decimals: token.decimals,
        priceUsd: null,
      };
  }

  return {
    schemaVersion: 1,
    chainId: CHAIN.id,
    // V4 readiness is independent and explicit so a rolling deployment cannot
    // mistake an old indexer's silently ignored proto filter for a valid empty
    // catalog.
    ready: kvGet('ready') === '1' && capability.ready,
    chain: { key: CHAIN.key, id: CHAIN.id },
    catalogs: { univ4: capability },
    asof: Number(kvGet('v4_featured_asof')) || Number(kvGet('snapshot_asof')) || null,
    subgraphBlock: capability.snapshotBlock,
    catalogBlock,
    catalogGeneration,
    totals: { univ4: capability.localCount },
    count,
    ...(counted.capped ? { countCapped: true } : {}),
    nextCursor,
    pools: rows.map((row) => ({
      proto: 'univ4' as const,
      address: row.pool_manager,
      poolId: row.pool_id,
      token0: row.currency0,
      token1: row.currency1,
      tickSpacing: row.tick_spacing,
      hooks: row.hooks,
      createdBlock: row.created_block,
      // The ranked figure and the material it was derived from, together —
      // the browser recomputes from rawTvl/rawDays and can disagree out loud.
      tvlUsd: row.m_tvl_usd ?? row.m_liq_usd,
      tvlApprox: row.m_tvl_usd !== null ? row.m_tvl_approx === 1 : row.m_liq_usd !== null,
      vol24hUsd: row.m_vol24h_usd,
      txns24h: row.m_txns24h,
      gtLiqUsd: row.m_liq_usd,
      statsSource: row.m_source,
      rawTvl0: row.tvl0,
      rawTvl1: row.tvl1,
      rawDays: days.get(row.pool_id) ?? [],
    })),
    tokens,
  };
}

// ---- pool groups ----
//
// One row per token whose ORIGIN this chain has proven, carrying every pool
// that token trades in, across every protocol.
//
// It exists because a market filter over a fetched page is not a market filter.
// The pools tab asked for the top rows by TVL and then kept the ones whose
// token happened to be a launchpad mint, so "pools.trade" showed two markets
// and "bStock" four — the ones that made the page, not the ones that exist.
// Answering "which tokens, and what are their pools" is a question only the
// catalog can answer, so it is asked here.
//
// Grouping by TOKEN rather than by pool is the other half. A tokenized share
// spreads across fee tiers and protocols, so a flat list buries the same
// company under six rows of its own; one row per token, opening onto its
// markets, is the shape the thing actually has.

/** v4's dynamic-fee sentinel: the LP fee is whatever the hook says, per swap. */
const DYNAMIC_FEE_FLAG = 0x800000;
const HOOKLESS = '0x0000000000000000000000000000000000000000';

const STOCK_ORIGIN_PREFIX = 'stock:';

/**
 * The membership set behind one chip, as SQL over a proven-origin table.
 *
 * Both tables hold nothing but addresses the chain itself vouched for — a
 * CREATE2 derivation from a known factory, or a proxy codehash together with
 * the ERC-1967 slot naming an issuer's anchor. Neither is a list anyone typed.
 */
function originTokensSql(origin: string): { sql: string; args: string[] } {
  if (origin === 'launchpad') return { sql: 'SELECT address FROM v4_launchpad_tokens', args: [] };
  if (origin.startsWith(STOCK_ORIGIN_PREFIX)) {
    const issuer = origin.slice(STOCK_ORIGIN_PREFIX.length);
    if (!CHAIN.stockIssuers.some((anchor) => anchor.issuer === issuer))
      throw new ApiInputError(`unknown issuer in origin ${origin}`);
    return { sql: 'SELECT address FROM stock_tokens WHERE issuer = ?', args: [issuer] };
  }
  throw new ApiInputError(`unknown origin ${origin}`);
}

/**
 * Every (token, pool) pair for the origin, both catalogs, both sides.
 *
 * The sides are UNIONed rather than OR'd so each branch can use its own index —
 * `token0 = ?` and `token1 = ?` are separate indexes and an OR across them
 * scans. A pool with a proven token on BOTH sides appears twice on purpose: it
 * is a market in each of them and belongs to both groups.
 *
 * `fee_usable` is what decides whether a pool's trading fee can be stated at
 * all. A v4 pool with a dynamic fee has no fixed rate to multiply by, and one
 * with a hook may route part of the fee somewhere this cannot see; claiming a
 * number for either would be inventing one.
 */
function groupMembersSql(origin: string): { sql: string; args: string[] } {
  const origins = originTokensSql(origin);
  const args = [...origins.args, ...origins.args, ...origins.args, ...origins.args];
  const v23ProtocolFilter = INDEX_V2 ? '' : " AND p.proto IN ('univ3', 'pancakev3')";
  return {
    args,
    sql: `
      SELECT p.token0 AS token, 'v23' AS family, p.address AS pool_key,
             s.tvl_usd AS tvl_usd, st.vol24h_usd AS vol24h_usd,
             p.fee_ppm AS fee_ppm, 1 AS fee_usable
        FROM (${origins.sql}) o
        JOIN pools p ON p.token0 = o.address${v23ProtocolFilter}
        LEFT JOIN pool_state s ON s.address = p.address
        LEFT JOIN pool_stats st ON st.address = p.address
      UNION ALL
      SELECT p.token1, 'v23', p.address,
             s.tvl_usd, st.vol24h_usd, p.fee_ppm, 1
        FROM (${origins.sql}) o
        JOIN pools p ON p.token1 = o.address${v23ProtocolFilter}
        LEFT JOIN pool_state s ON s.address = p.address
        LEFT JOIN pool_stats st ON st.address = p.address
      UNION ALL
      SELECT v.currency0, 'univ4', v.pool_id,
             COALESCE(m.tvl_usd, m.liq_usd), m.vol24h_usd, v.key_fee_ppm,
             CASE WHEN v.key_fee_ppm = ${DYNAMIC_FEE_FLAG} OR v.hooks <> '${HOOKLESS}'
                  THEN 0 ELSE 1 END
        FROM (${origins.sql}) o
        JOIN v4_pools v ON v.currency0 = o.address
        LEFT JOIN v4_market_stats m ON m.pool_id = v.pool_id
      UNION ALL
      SELECT v.currency1, 'univ4', v.pool_id,
             COALESCE(m.tvl_usd, m.liq_usd), m.vol24h_usd, v.key_fee_ppm,
             CASE WHEN v.key_fee_ppm = ${DYNAMIC_FEE_FLAG} OR v.hooks <> '${HOOKLESS}'
                  THEN 0 ELSE 1 END
        FROM (${origins.sql}) o
        JOIN v4_pools v ON v.currency1 = o.address
        LEFT JOIN v4_market_stats m ON m.pool_id = v.pool_id`,
  };
}

type GroupRow = {
  token: string;
  pool_count: number;
  tvl_usd: number | null;
  vol24h_usd: number | null;
  fees24h_usd: number | null;
  fee_pools: number;
  fee_apr: number | null;
};

/**
 * Every column the grouped table lets you sort by.
 *
 * All four, deliberately: a header that highlights when clicked and does not
 * reorder is worse than a header that cannot be clicked, and the two the flat
 * table offers beyond depth and volume are both derivable from figures this
 * aggregate already has. `rewards` is absent because emissions are a property
 * of a gauge on one pool, and a token is not one pool.
 */
type GroupSortKey = 'tvl' | 'vol' | 'fees' | 'feeApr';
const GROUP_SORT_COLUMN: Record<GroupSortKey, string> = {
  tvl: 'tvl_usd',
  vol: 'vol24h_usd',
  fees: 'fees24h_usd',
  feeApr: 'fee_apr',
};

/**
 * Keyset over an aggregate, on `(sort value DESC, token ASC)`.
 *
 * A group with no measurable figure sorts last and pages after every group that
 * has one, which is why the cursor carries an explicit "unmeasured" marker
 * rather than a zero — a zero would sort between real values and silently claim
 * the group had been measured at nothing.
 */
const GROUP_CURSOR_UNMEASURED = '-';

const GROUP_SORT_VALUE: Record<GroupSortKey, (row: GroupRow) => number | null> = {
  tvl: (row) => row.tvl_usd,
  vol: (row) => row.vol24h_usd,
  fees: (row) => row.fees24h_usd,
  feeApr: (row) => row.fee_apr,
};

function encodeGroupCursor(row: GroupRow, sort: GroupSortKey): string {
  const value = GROUP_SORT_VALUE[sort](row);
  return `${value === null ? GROUP_CURSOR_UNMEASURED : value}|${row.token}`;
}

function decodeGroupCursor(raw: string): { value: number | null; token: string } {
  const separator = raw.lastIndexOf('|');
  if (separator <= 0) throw new ApiInputError('invalid group cursor');
  const value = raw.slice(0, separator);
  const token = raw.slice(separator + 1).toLowerCase();
  if (!HEX40.test(token)) throw new ApiInputError('invalid group cursor token');
  if (value === GROUP_CURSOR_UNMEASURED) return { value: null, token };
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ApiInputError('invalid group cursor value');
  return { value: parsed, token };
}

const GROUP_PARAMS = ['origin', 'sort', 'limit', 'pools', 'min_tvl', 'after'] as const;

type GroupRequest = {
  origin: string;
  sort: GroupSortKey;
  limit: number;
  poolsPerGroup: number;
  minTvl: number;
  after: { value: number | null; token: string } | null;
  rawAfter: string | null;
};

/**
 * Validate once, then use the normalized request for both the SQL and the cache
 * identity — the same rule canonicalPoolsRequest follows, for the same reason.
 * Keying on raw parameters would make `?origin=x` and `?origin=x&sort=tvl` two
 * entries for one question, and would let the defaults drift apart from the
 * query they are supposed to describe.
 */
function canonicalGroupsRequest(params: Params): GroupRequest {
  for (const key of params.keys())
    if (!(GROUP_PARAMS as readonly string[]).includes(key))
      throw new ApiInputError(`unknown parameter ${key}`);
  const origin = (singleParam(params, 'origin') ?? '').trim().toLowerCase();
  if (!origin) throw new ApiInputError('origin is required');
  const rawSort = (singleParam(params, 'sort') ?? 'tvl').trim();
  if (!Object.hasOwn(GROUP_SORT_COLUMN, rawSort))
    throw new ApiInputError(`sort must be one of ${Object.keys(GROUP_SORT_COLUMN).join(', ')}`);
  const rawMinTvl = Number(params.get('min_tvl'));
  const rawAfter = singleParam(params, 'after');
  return {
    origin,
    sort: rawSort as GroupSortKey,
    limit: Math.min(Math.max(Number(params.get('limit')) || 25, 1), 100),
    poolsPerGroup: Math.min(Math.max(Number(params.get('pools')) || 5, 1), 20),
    minTvl: Number.isFinite(rawMinTvl) && rawMinTvl > 0 ? rawMinTvl : 0,
    after: rawAfter === null ? null : decodeGroupCursor(rawAfter),
    rawAfter,
  };
}

export function getPoolGroups(params: Params) {
  return getPoolGroupsFor(canonicalGroupsRequest(params));
}

function getPoolGroupsFor(request: GroupRequest) {
  const { origin, sort, limit, poolsPerGroup, minTvl, after } = request;
  const members = groupMembersSql(origin);
  const sortColumn = GROUP_SORT_COLUMN[sort];

  // SUM() over an all-NULL group is NULL, which is the answer we want: nothing
  // was measured. It is deliberately not COALESCEd to zero — see the cursor.
  // Two layers because fee APR is a ratio of two aggregates, and SQLite may not
  // reference an output alias from the SELECT list that defines it.
  const aggregate = `
    SELECT g.*,
           CASE WHEN g.tvl_usd > 0 AND g.fees24h_usd IS NOT NULL
                THEN g.fees24h_usd * 365.0 / g.tvl_usd END AS fee_apr
      FROM (
        SELECT token,
               COUNT(*) AS pool_count,
               SUM(tvl_usd) AS tvl_usd,
               SUM(vol24h_usd) AS vol24h_usd,
               SUM(CASE WHEN fee_usable = 1 AND fee_ppm IS NOT NULL AND vol24h_usd IS NOT NULL
                        THEN vol24h_usd * fee_ppm / 1000000.0 END) AS fees24h_usd,
               SUM(CASE WHEN fee_usable = 1 AND fee_ppm IS NOT NULL AND vol24h_usd IS NOT NULL
                        THEN 1 ELSE 0 END) AS fee_pools
          FROM members
         GROUP BY token
      ) g`;
  const having = minTvl > 0 ? 'WHERE tvl_usd >= ?' : '';
  const havingArgs = minTvl > 0 ? [minTvl] : [];

  // Only on the landing page. Recomputing the whole aggregate to count it again
  // on every continuation is what getV23Pools grew `fastV23Count` to avoid —
  // the row set is what a page is for, and the total does not change under a
  // cursor. Clients carry the first page's figure for the traversal.
  const count = after
    ? null
    : (
        db
          .prepare(`WITH members AS (${members.sql}), groups AS (${aggregate})
                    SELECT COUNT(*) AS n FROM groups ${having}`)
          .get(...members.args, ...havingArgs) as { n: number }
      ).n;

  // NULLs last: an unmeasured group only ever follows another unmeasured one,
  // and a measured group can never page in behind them.
  const cursorArgs: (string | number)[] = [];
  let cursorClause = '';
  if (after) {
    const join = having ? 'AND' : 'WHERE';
    if (after.value === null) {
      cursorClause = `${join} ${sortColumn} IS NULL AND token > ?`;
      cursorArgs.push(after.token);
    } else {
      cursorClause = `${join} (${sortColumn} < ? OR ${sortColumn} IS NULL
        OR (${sortColumn} = ? AND token > ?))`;
      cursorArgs.push(after.value, after.value, after.token);
    }
  }

  const rows = db
    .prepare(`WITH members AS (${members.sql}), groups AS (${aggregate})
              SELECT * FROM groups ${having} ${cursorClause}
              ORDER BY ${sortColumn} DESC NULLS LAST, token ASC
              LIMIT ?`)
    .all(...members.args, ...havingArgs, ...cursorArgs, limit + 1) as GroupRow[];

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const nextCursor = hasMore && page.length ? encodeGroupCursor(page[page.length - 1], sort) : null;

  // The pools inside each group, deepest first, bounded per group so one token
  // with four hundred dust pools cannot fill the response.
  const tokens = page.map((row) => row.token);
  const membersByToken = new Map<string, Array<{ family: string; pool_key: string }>>();
  if (tokens.length) {
    const placeholders = tokens.map(() => '?').join(',');
    const picked = db
      .prepare(`WITH members AS (${members.sql})
                SELECT token, family, pool_key FROM (
                  SELECT token, family, pool_key,
                         ROW_NUMBER() OVER (
                           PARTITION BY token ORDER BY tvl_usd DESC NULLS LAST, pool_key ASC
                         ) AS rn
                    FROM members WHERE token IN (${placeholders})
                ) WHERE rn <= ?`)
      .all(...members.args, ...tokens, poolsPerGroup) as Array<{
      token: string;
      family: string;
      pool_key: string;
    }>;
    for (const row of picked) {
      const list = membersByToken.get(row.token) ?? [];
      list.push({ family: row.family, pool_key: row.pool_key });
      membersByToken.set(row.token, list);
    }
  }

  const addressKeys = [...new Set([...membersByToken.values()].flat()
    .filter((m) => m.family === 'v23').map((m) => m.pool_key))];
  const poolIdKeys = [...new Set([...membersByToken.values()].flat()
    .filter((m) => m.family === 'univ4').map((m) => m.pool_key))];

  const poolsByKey = new Map<string, PoolOut>();
  const tokenAddrs = new Set<string>(tokens);
  if (addressKeys.length) {
    const rowsV23 = db
      .prepare(
        `SELECT ${V23_FIELDS} FROM pools p
         LEFT JOIN pool_state s ON s.address = p.address
         LEFT JOIN pool_stats st ON st.address = p.address
         WHERE p.address IN (${addressKeys.map(() => '?').join(',')})`,
      )
      .all(...addressKeys) as Record<string, unknown>[];
    for (const r of rowsV23) {
      tokenAddrs.add(r.token0 as string);
      tokenAddrs.add(r.token1 as string);
      poolsByKey.set(r.address as string, {
        proto: r.proto,
        address: r.address,
        token0: r.token0,
        token1: r.token1,
        feePpm: r.fee_ppm,
        tickSpacing: r.tick_spacing,
        createdBlock: r.created_block,
        sqrtPriceX96: r.sqrt_price,
        tick: r.tick,
        liquidity: r.liquidity,
        reserve0: r.reserve0 ?? '0',
        reserve1: r.reserve1 ?? '0',
        totalSupply: r.total_supply,
        tvlUsd: r.tvl_usd,
        tvlApprox: r.tvl_approx === 1,
        vol24hUsd: r.vol24h_usd,
        txns24h: r.txns24h,
        gtLiqUsd: r.liq_usd,
        statsSource: r.stats_source,
        stateUpdated: typeof r.state_updated === 'number' ? r.state_updated : null,
        stateReady:
          r.proto === 'univ3' || r.proto === 'pancakev3'
            ? r.sqrt_price !== null && r.tick !== null && r.liquidity !== null
            : r.reserve0 !== null && r.reserve1 !== null && r.total_supply !== null,
      });
    }
  }
  if (poolIdKeys.length) {
    const rowsV4 = db
      .prepare(
        `SELECT p.pool_id, p.pool_manager, p.currency0, p.currency1, p.tick_spacing, p.hooks,
                p.created_block, s.tvl0, s.tvl1,
                m.vol24h_usd, m.txns24h, m.liq_usd, m.tvl_usd, m.tvl_approx, m.source
         FROM v4_pools p
         LEFT JOIN v4_pool_stats s ON s.pool_id = p.pool_id
         LEFT JOIN v4_market_stats m ON m.pool_id = p.pool_id
         WHERE p.pool_id IN (${poolIdKeys.map(() => '?').join(',')})`,
      )
      .all(...poolIdKeys) as Array<Record<string, unknown>>;
    for (const r of rowsV4) {
      tokenAddrs.add(r.currency0 as string);
      tokenAddrs.add(r.currency1 as string);
      poolsByKey.set(r.pool_id as string, {
        proto: 'univ4',
        address: r.pool_manager,
        poolId: r.pool_id,
        token0: r.currency0,
        token1: r.currency1,
        tickSpacing: r.tick_spacing,
        hooks: r.hooks,
        createdBlock: r.created_block,
        tvlUsd: (r.tvl_usd as number | null) ?? (r.liq_usd as number | null),
        tvlApprox: r.tvl_usd !== null ? r.tvl_approx === 1 : r.liq_usd !== null,
        vol24hUsd: r.vol24h_usd,
        txns24h: r.txns24h,
        gtLiqUsd: r.liq_usd,
        statsSource: r.source,
        rawTvl0: r.tvl0,
        rawTvl1: r.tvl1,
        rawDays: [],
      });
    }
  }

  const tokenMeta: Record<string, unknown> = {};
  if (tokenAddrs.size) {
    const list = [...tokenAddrs];
    const placeholders = list.map(() => '?').join(',');
    // Both metadata tables, because a group can span both catalogs and a v4
    // currency may never have appeared in an address-keyed pool.
    for (const row of db
      .prepare(
        `SELECT address, symbol, decimals, meta_ok, price_usd FROM tokens
          WHERE address IN (${placeholders})`,
      )
      .all(...list) as Array<{
      address: string;
      symbol: string;
      decimals: number;
      meta_ok: number;
      price_usd: number | null;
    }>)
      tokenMeta[row.address] = {
        address: row.address,
        symbol: row.symbol,
        decimals: row.decimals,
        metaOk: row.meta_ok === 1,
        priceUsd: row.price_usd,
      };
    for (const row of db
      .prepare(
        `SELECT address, symbol, decimals FROM v4_tokens WHERE address IN (${placeholders})`,
      )
      .all(...list) as Array<{ address: string; symbol: string; decimals: number }>)
      tokenMeta[row.address] ??= {
        address: row.address,
        symbol: row.symbol,
        decimals: row.decimals,
        priceUsd: null,
      };
  }

  return {
    schemaVersion: 1,
    chainId: CHAIN.id,
    ready: kvGet('ready') === '1',
    chain: { key: CHAIN.key, id: CHAIN.id },
    asof: Number(kvGet('snapshot_asof')) || null,
    origin,
    sort,
    count,
    nextCursor,
    groups: page.map((row) => ({
      token: row.token,
      poolCount: row.pool_count,
      tvlUsd: row.tvl_usd,
      vol24hUsd: row.vol24h_usd,
      // Summed over the pools whose rate is knowable. `feePools` says how many
      // of `poolCount` that was, so a partial figure can be read as partial
      // instead of as the whole token's fees.
      fees24hUsd: row.fees24h_usd,
      feePools: row.fee_pools,
      pools: (membersByToken.get(row.token) ?? [])
        .map((member) => poolsByKey.get(member.pool_key))
        .filter((pool): pool is PoolOut => pool !== undefined),
    })),
    tokens: tokenMeta,
  };
}

/**
 * Cache identity for one normalized request.
 *
 * Both catalog generations ride along: a destructive change to either directory
 * has to evict, and the freshness window is too long to wait one out.
 */
function poolGroupsCacheKey(request: GroupRequest): string {
  return [
    v4CatalogGeneration() ?? 'none',
    v23CatalogClock().generation,
    request.origin,
    request.sort,
    request.limit,
    request.poolsPerGroup,
    request.minTvl,
    request.rawAfter ?? '',
  ].join('\n');
}

/** Exported for the same cache/failure contract tests /api/pools has. */
export function preparePoolGroupsResponse(params: Params): PreparedPoolResponse {
  const request = canonicalGroupsRequest(params);
  const key = poolGroupsCacheKey(request);
  const cached = poolGroupsCache.get(key);
  if (cached?.freshness === 'fresh') return { response: cached.response, status: 'HIT' };
  try {
    const body = JSON.stringify(getPoolGroupsFor(request));
    return { response: poolGroupsCache.set(key, body, responseEtag(body)), status: 'MISS' };
  } catch (error) {
    // A rejected request is part of the contract and must never be answered
    // from a last-good body; an unexpected origin failure may be.
    if (cached?.freshness === 'stale' && !(error instanceof ApiInputError))
      return { response: cached.response, status: 'STALE' };
    throw error;
  }
}

export function clearPoolGroupsCache(): void {
  poolGroupsCache.clear();
}

export function getPools(params: Params) {
  const requested = (params.get('proto') ?? '')
    .split(',')
    .map((proto) => proto.trim().toLowerCase())
    .filter(Boolean);
  if (requested.includes('univ4')) {
    if (requested.length !== 1)
      throw new ApiInputError('univ4 uses a PoolId cursor and cannot be mixed with address-keyed protocols');
    return getV4Pools(params);
  }
  return getV23Pools(params);
}

/**
 * How many symbol matches may reach the pool-count subquery.
 *
 * `LIMIT 20` on the outer query buys nothing on its own: `ORDER BY pools DESC`
 * has to evaluate the correlated COUNT(*) for EVERY match before it can sort,
 * so the cost tracks the match count, not the page size. Measured on the BSC
 * catalog: `weth%` (86 matches) 0.19s, `a%` (23,353) 3.6s, and an unescaped `%`
 * — every one of the 460,023 tokens — extrapolates to ~72s. Each of those
 * seconds is the whole API blocked: `node:sqlite`'s DatabaseSync runs every
 * statement on the main thread and exposes no interrupt, so a query that has
 * started cannot be called off by anything short of killing the process.
 */
const TOKEN_SEARCH_CANDIDATES = 2_000;

export function getTokens(params: Params) {
  const q = (params.get('q') ?? '').trim().toLowerCase();
  if (!q) return { tokens: [], truncated: false };
  if (HEX40.test(q))
    return {
      tokens: db
        .prepare('SELECT address, symbol, decimals, price_usd FROM tokens WHERE address = ?')
        .all(q),
      truncated: false,
    };
  const prefix = `${escapeLikePattern(q)}%`;
  const matching = `FROM tokens WHERE symbol LIKE ? ESCAPE '\\'`;
  // The bound sits INSIDE the CTE, in front of the subquery it is there to
  // protect. Rows past it are dropped in scan order rather than by pool count,
  // so `truncated` is reported rather than left for a caller to infer from a
  // suspiciously round result set.
  const tokens = db
    .prepare(
      `WITH matches AS (
         SELECT address, symbol, decimals, price_usd ${matching}
         LIMIT ${TOKEN_SEARCH_CANDIDATES + 1}
       )
       SELECT m.address, m.symbol, m.decimals, m.price_usd,
              (SELECT COUNT(*) FROM pools p WHERE p.token0 = m.address OR p.token1 = m.address) AS pools
       FROM matches m ORDER BY pools DESC LIMIT 20`,
    )
    .all(prefix);
  return { tokens, truncated: boundedCount(matching, [prefix], TOKEN_SEARCH_CANDIDATES).capped };
}

const MAX_PRICE_ADDRESSES = 100;

/** Exact-address price marks for portfolio valuation. */
export function getPrices(params: Params) {
  if (params.getAll('addresses').length > 1)
    throw new ApiInputError('duplicate addresses');
  const requested = (params.get('addresses') ?? '')
    .split(',')
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean);
  if (requested.length > MAX_PRICE_ADDRESSES)
    throw new ApiInputError(`addresses exceeds ${MAX_PRICE_ADDRESSES}`);
  if (requested.some((address) => !HEX40.test(address)))
    throw new ApiInputError('invalid token address');

  const addresses = [...new Set(requested)].sort();
  const rows = addresses.length
    ? db.prepare(
        `SELECT address, price_usd, price_depth_usd, price_src, price_updated
         FROM tokens WHERE address IN (${addresses.map(() => '?').join(',')})`,
      ).all(...addresses) as Array<{
        address: string;
        price_usd: number | null;
        price_depth_usd: number;
        price_src: string | null;
        price_updated: number | null;
      }>
    : [];
  const byAddress = new Map(rows.map((row) => [row.address, row]));
  return {
    schemaVersion: 1,
    chainId: CHAIN.id,
    ready: kvGet('ready') === '1',
    prices: Object.fromEntries(addresses.map((address) => {
      const row = byAddress.get(address);
      return [address, {
        priceUsd: row?.price_usd ?? null,
        depthUsd: row?.price_depth_usd ?? 0,
        source: row?.price_src ?? null,
        updatedAt: row?.price_updated ?? null,
      }];
    })),
  };
}

export function getHealth() {
  const totals = addressCatalogTotals();
  const addressCatalogs = addressCatalogCapabilities(totals);
  const v4 = v4Capability();
  if (v4.supported) totals.univ4 = v4.localCount;
  const tokens = (db.prepare('SELECT COUNT(*) AS n FROM tokens').get() as { n: number }).n;
  const priced = (db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE price_usd > 0').get() as { n: number }).n;
  const tvl = (
    db.prepare('SELECT COUNT(*) AS n FROM pool_state WHERE tvl_usd IS NOT NULL').get() as {
      n: number;
    }
  ).n;
  // pricing-health canary: a healthy chain has zero of these
  const corrupt = (
    db.prepare('SELECT COUNT(*) AS n FROM pool_state WHERE tvl_usd >= ?').get(TUNE.maxPoolTvlUsd) as { n: number }
  ).n;
  const stateFreshness = db.prepare('SELECT MIN(updated) AS oldest, MAX(updated) AS newest FROM pool_state').get();
  const statsFreshness = db.prepare('SELECT MAX(updated) AS newest FROM pool_stats').get();
  return {
    schemaVersion: 1,
    chainId: CHAIN.id,
    ready: kvGet('ready') === '1' && addressCatalogs.ready && (!v4.supported || v4.ready),
    chain: { key: CHAIN.key, id: CHAIN.id },
    uniswap: {
      v2Factory: UNI.V2_FACTORY,
      v3Factory: UNI.V3_FACTORY,
      v4PoolManager: V4?.POOL_MANAGER ?? null,
    },
    pancake: {
      v2Factory: CHAIN.id === 56 ? ADDR.V2_FACTORY : null,
      v3Factory: CHAIN.id === 56 ? ADDR.CL_FACTORY : null,
    },
    asof: Number(kvGet('snapshot_asof')) || null,
    lastBootError: kvGet('boot_error') || null,
    pools: totals,
    tokens,
    pricedTokens: priced,
    tvlPools: tvl,
    corruptTvlPools: corrupt,
    stateFreshness,
    statsFreshness,
    clHydration: {
      policy: kvGet('cl_hydration_policy') || null,
      strictReadyGate: false,
      targetCount: totals.univ3 + totals.pancakev3,
      metaCursor: kvGet('cl_meta_census_cursor') || null,
      stateCursor: kvGet('cl_state_census_cursor') || null,
      metaCompletedAt: Number(kvGet('cl_meta_census_completed_at')) || null,
      stateCompletedAt: Number(kvGet('cl_state_census_completed_at')) || null,
      lastMetaPageFailures: Number(kvGet('cl_meta_census_failed')) || 0,
      lastStatePageFailures: Number(kvGet('cl_state_census_failed')) || 0,
    },
    reprice: {
      busy: kvGet('reprice_busy') === '1',
      requestedAt: Number(kvGet('reprice_requested_at')) || null,
      requestedTrigger: kvGet('reprice_requested_trigger') || null,
      startedAt: Number(kvGet('reprice_started_at')) || null,
      completedAt: Number(kvGet('reprice_completed_at')) || null,
      durationMs: Number(kvGet('reprice_duration_ms')) || null,
      trigger: kvGet('reprice_trigger') || null,
      catalogCount: Number(kvGet('reprice_catalog_count')) || null,
      pricedTokens: Number(kvGet('reprice_priced_tokens')) || null,
      tvlPools: Number(kvGet('reprice_tvl_pools')) || null,
      error: kvGet('reprice_error') || null,
      errorAt: Number(kvGet('reprice_error_at')) || null,
    },
    hydrationDemand: hydrationDemandCount(),
    apiPoolCache: poolResponseCache.stats(),
    solverAdjacency: {
      schemaVersion: SOLVER_ADJACENCY_SCHEMA_VERSION,
      ready: solverAdjacencyProjectionReady(),
      projectionVersion: kvGet('solver_adjacency_projection_version') ?? null,
    },
    sqliteBusyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS,
    v3Cursor: Number(kvGet('v3_cursor') ?? 0),
    v2Count: Number(kvGet('v2_count') ?? 0),
    catalog: {
      v2: addressCatalogs.v2,
      v3: addressCatalogs.v3,
      pancakeV2: addressCatalogs.pancakeV2,
      pancakeV3: addressCatalogs.pancakeV3,
      v4,
    },
    rssMb: Math.round(process.memoryUsage.rss() / 1e6),
  };
}

type RecommendationRow = Record<string, string | number | null>;

/** Raw, explainable inputs for the executor-side recommendation model. The
 * indexer never turns these observations into financial advice or calldata. */
/**
 * The pool-rank prior index for the recommendation candidates: one entry per
 * ranked pool, keyed by lowercase address, only while the snapshot is fresh.
 * The rank table is a half-day reference; once it is more than two cycles old
 * it stops being a prior and becomes misinformation, so it is dropped whole —
 * the recommender degrades to its own observations instead of anchoring on a
 * stale LVR floor. Null when the rank pipeline is off (other chains) or has
 * never produced a snapshot.
 */
function rankPriorIndex(): { generatedAt: number; byAddress: Map<string, PoolRankRow> } | null {
  if (!POOL_RANK_ENABLED) return null;
  const snapshot = getPoolRankSnapshot();
  if (!snapshot) return null;
  if (now() - snapshot.generatedAt > 2 * (TUNE.poolRankMs / 1000)) return null;
  const byAddress = new Map<string, PoolRankRow>();
  for (const row of snapshot.rows) byAddress.set(row.address.toLowerCase(), row);
  return { generatedAt: snapshot.generatedAt, byAddress };
}

/**
 * How many of the rank table's best-coverage pools get a second chance at the
 * candidate universe. The volume×fee/TVL ordering that picks the main cohort is
 * a yield proxy the rank table deliberately is not: a deep, quiet, well-covered
 * pool can sit below a hot shallow one on that proxy while being the better LP
 * market over the rank's 45-day window. Coverage top-20, and the pool must
 * still clear the same min TVL/volume bars as everyone else — seeding widens
 * WHO is evaluated, never lowers the bar.
 */
const RANK_SEED_CAP = 20;

/** The rank table's best-coverage pool addresses, best first, capped. Empty
 * whenever the priors are absent (rank off, no snapshot, stale) — the seed
 * entry closes with exactly the same key as the prior attach does. */
export function rankSeedIdentities(): string[] {
  const index = rankPriorIndex();
  if (!index) return [];
  return [...index.byAddress.values()]
    .sort((a, b) => b.coverage - a.coverage)
    .slice(0, RANK_SEED_CAP)
    .map((row) => row.address.toLowerCase());
}

// ── recommendation candidates: off-loop snapshot + bounded caches ──────────
// The candidates handler is SYNCHRONOUS, and at steady-state sample volume one
// run costs ~30s of range queries (minutes on a cold page cache). On the API's
// single event loop that froze EVERY endpoint for its duration — pool-rank and
// health starved behind it, which surfaced to users as "no rank snapshot"
// while the recommender spun forever. Two layers fix it:
//
//   snapshot (worker thread) — the canonical executor payload (limit=80,
//     min_tvl=10000, min_volume=10000) is computed in a WORKER on a 2-minute
//     cadence and stored as a ready-to-send string; the route never computes
//     while one exists. node:sqlite opens a per-thread reader connection, so
//     WAL keeps the worker concurrent with the main thread's writes.
//   response cache (60s TTL) — non-canonical parameter combinations, which
//     only internal callers use.
//
// The boot window falls back to one on-demand compute that seeds the snapshot.

const RECOMMENDATION_SNAPSHOT_WORKER_KIND = 'lp-terminal-recommendation-snapshot';
const RECOMMENDATION_CANONICAL_PARAMS = new URLSearchParams({ limit: '80', min_tvl: '10000', min_volume: '10000' });
const RECOMMENDATION_CANONICAL_KEY = '80|10000|10000';
const RECOMMENDATION_HISTORY_TTL_MS = 60_000;
const RECOMMENDATION_RESPONSE_TTL_MS = 60_000;
const RECOMMENDATION_HISTORY_MEMO_CAP = 512;

type RecommendationHistoryRow = Record<string, unknown>;
type RecommendationHistory = { marketHistory: RecommendationHistoryRow[]; tickHistory: RecommendationHistoryRow[]; at: number };
const recommendationHistoryMemo = new Map<string, RecommendationHistory>();
const recommendationResponseCache = new Map<string, { at: number; body: string }>();
let recommendationSnapshot: { at: number; body: string } | null = null;
let recommendationSnapshotRequestedAt: number | null = null;
let recommendationSnapshotWorkerRunning = false;

const recommendationMarketQ = db.prepare(`SELECT CAST(ts/3600 AS INTEGER)*3600 AS ts,
    AVG(vol1h_usd) AS vol1hUsd,AVG(vol6h_usd) AS vol6hUsd,
    AVG(vol24h_usd) AS vol24hUsd
  FROM pool_market_snapshots WHERE pool=? AND ts>=?
  GROUP BY CAST(ts/3600 AS INTEGER) ORDER BY ts`);
const recommendationRecentTickQ = db.prepare(
  'SELECT ts,tick FROM pool_tick_samples WHERE pool=? AND ts>=? ORDER BY ts',
);
const recommendationHistoricTickQ = db.prepare(`SELECT sample.ts,sample.tick
  FROM pool_tick_samples sample JOIN (
    SELECT MAX(ts) AS ts FROM pool_tick_samples
    WHERE pool=? AND ts>=? AND ts<? GROUP BY CAST(ts/600 AS INTEGER)
  ) bucket ON bucket.ts=sample.ts
  WHERE sample.pool=? ORDER BY sample.ts`);

function recommendationHistoryFor(identity: string, timestamp: number): RecommendationHistory {
  const memoed = recommendationHistoryMemo.get(identity);
  if (memoed && Date.now() - memoed.at < RECOMMENDATION_HISTORY_TTL_MS) return memoed;
  const marketHistory = recommendationMarketQ.all(identity, timestamp - 30 * 86_400) as RecommendationHistoryRow[];
  const tickHistory = [
    ...recommendationHistoricTickQ.all(identity, timestamp - 7 * 86_400, timestamp - 30 * 3_600, identity),
    ...recommendationRecentTickQ.all(identity, timestamp - 30 * 3_600),
  ] as RecommendationHistoryRow[];
  const entry: RecommendationHistory = { marketHistory, tickHistory, at: Date.now() };
  if (recommendationHistoryMemo.size >= RECOMMENDATION_HISTORY_MEMO_CAP) {
    const nowMs = Date.now();
    for (const [key, value] of recommendationHistoryMemo)
      if (nowMs - value.at >= RECOMMENDATION_HISTORY_TTL_MS) recommendationHistoryMemo.delete(key);
    while (recommendationHistoryMemo.size >= RECOMMENDATION_HISTORY_MEMO_CAP)
      recommendationHistoryMemo.delete(recommendationHistoryMemo.keys().next().value!);
  }
  recommendationHistoryMemo.set(identity, entry);
  return entry;
}

/** The canonical executor payload, built OFF the API event loop in a worker
 * thread and stored as a ready-to-send string. Skips when a build is already
 * in flight — overlapping runs would only contend for the same rows. */
export function refreshRecommendationSnapshotInBackground(): Promise<void> {
  if (recommendationSnapshotWorkerRunning) return Promise.resolve();
  recommendationSnapshotWorkerRunning = true;
  if (recommendationSnapshotRequestedAt === null) recommendationSnapshotRequestedAt = Date.now();
  const startedMs = Date.now();
  return new Promise((resolve, reject) => {
    // Same tsx bootstrap as the reprice worker: a native module registers tsx
    // first, then imports this TypeScript module, whose bottom half detects
    // the worker kind, computes, and posts the ready-to-send body back.
    const worker = new Worker(new URL('./tsxWorker.mjs', import.meta.url), {
      workerData: { kind: RECOMMENDATION_SNAPSHOT_WORKER_KIND, entry: new URL('./api.ts', import.meta.url).href },
    });
    let settled = false;
    worker.once('message', (message: { ok: true; body: string } | { ok: false; error: string }) => {
      settled = true;
      recommendationSnapshotWorkerRunning = false;
      if (message.ok) {
        recommendationSnapshot = { at: Date.now(), body: message.body };
        log(`[recommendation-snapshot] built in ${((Date.now() - startedMs) / 1000).toFixed(1)}s (${Math.round(message.body.length / 1024)}KB)`);
        resolve();
      } else reject(new Error(message.error));
    });
    worker.once('error', (error) => {
      if (!settled) { settled = true; recommendationSnapshotWorkerRunning = false; reject(error); }
    });
    worker.once('exit', (code) => {
      if (!settled) { settled = true; recommendationSnapshotWorkerRunning = false; reject(new Error(`recommendation snapshot worker exited before publishing a result (code ${code})`)); }
    });
  });
}

/** Route entry: the canonical executor parameters are served from the
 * worker-built snapshot — NO compute on the request path, ever. Before the
 * first build lands the route fails fast with 503: a fallback compute here is
 * exactly the event-loop freeze this whole section exists to prevent (an
 * executor poll arrives seconds after a restart, blocks the loop for the
 * compute's full duration, and every other endpoint starves behind it). The
 * executor already treats a non-ok response as a transient warming error. */
export function getRecommendationCandidatesCached(params: Params): string {
  const key = `${params.get('limit') ?? ''}|${params.get('min_tvl') ?? ''}|${params.get('min_volume') ?? ''}`;
  if (key === RECOMMENDATION_CANONICAL_KEY) {
    if (!recommendationSnapshot) {
      const age = recommendationSnapshotRequestedAt === null
        ? 'first build queued'
        : `first build running for ${Math.round((Date.now() - recommendationSnapshotRequestedAt) / 1000)}s`;
      throw new ApiCapacityError(`recommendation candidates snapshot is warming up (${age})`);
    }
    return recommendationSnapshot.body;
  }
  const hit = recommendationResponseCache.get(key);
  if (hit && Date.now() - hit.at < RECOMMENDATION_RESPONSE_TTL_MS) return hit.body;
  // Non-canonical combinations are internal-only and rare; a bounded 60s
  // response cache keeps even those from recomputing per request.
  const body = JSON.stringify(getRecommendationCandidates(params));
  recommendationResponseCache.set(key, { at: Date.now(), body });
  if (recommendationResponseCache.size > 16) recommendationResponseCache.clear();
  return body;
}

/** Test/operational hook; normal expiry is bounded and automatic. */
export function clearRecommendationCaches(): void {
  recommendationSnapshot = null;
  recommendationResponseCache.clear();
  recommendationHistoryMemo.clear();
}

export function getRecommendationCandidates(params: Params) {
  const rawLimit = params.get('limit');
  const limit = Math.min(Math.max(Number(rawLimit) || 50, 1), 80);
  const minTvl = Math.max(Number(params.get('min_tvl')) || 10_000, 0);
  const minVolume = Math.max(Number(params.get('min_volume')) || 10_000, 0);
  const timestamp = now();
  const addressSelect = `SELECT
      p.address AS identity,p.address AS pool,NULL AS pool_id,p.proto,
      p.token0,p.token1,p.fee_ppm,p.fee_ppm AS key_fee_ppm,
      p.unstaked_fee_ppm,p.tick_spacing,NULL AS hooks,
      t0.symbol AS symbol0,t0.decimals AS decimals0,t0.price_usd AS token0_usd,
      t1.symbol AS symbol1,t1.decimals AS decimals1,t1.price_usd AS token1_usd,
      s.sqrt_price,s.tick,s.liquidity,s.staked_liquidity,s.reward_rate,
      s.period_finish,s.gauge_alive,s.updated AS state_updated,
      COALESCE(s.tvl_usd,st.liq_usd) AS tvl_usd,
      st.vol1h_usd,st.vol6h_usd,st.vol24h_usd,st.updated AS stats_updated
    FROM pools p
    JOIN pool_state s ON s.address=p.address
    JOIN pool_stats st ON st.address=p.address
    JOIN tokens t0 ON t0.address=p.token0
    JOIN tokens t1 ON t1.address=p.token1
    WHERE p.proto IN ('up33cl','univ3','pancakev3')
      AND s.sqrt_price IS NOT NULL AND s.tick IS NOT NULL AND s.liquidity IS NOT NULL
      AND COALESCE(s.tvl_usd,st.liq_usd,0)>=?
      AND COALESCE(st.vol24h_usd,0)>=?`;
  const feeOrder = ` ORDER BY (
      MIN(
        COALESCE(st.vol1h_usd,st.vol24h_usd/24.0),
        COALESCE(st.vol6h_usd/6.0,st.vol24h_usd/24.0),
        st.vol24h_usd/24.0
      ) * p.fee_ppm / MAX(COALESCE(s.tvl_usd,st.liq_usd),1)
    ) DESC LIMIT ?`;
  const addressRows = db.prepare(addressSelect + feeOrder)
    .all(minTvl, minVolume, limit) as RecommendationRow[];
  const rewardRows = CHAIN.gov ? db.prepare(`${addressSelect}
      AND p.proto='up33cl' AND s.gauge_alive=1 AND s.period_finish>?
      AND CAST(s.reward_rate AS REAL)>0
    ORDER BY CAST(s.reward_rate AS REAL) DESC LIMIT ?`)
    .all(minTvl, minVolume, timestamp, Math.min(30, limit)) as RecommendationRow[] : [];

  const v4Rows = V4 ? db.prepare(`SELECT
      v.pool_id AS identity,v.pool_manager AS pool,v.pool_id,'univ4' AS proto,
      v.currency0 AS token0,v.currency1 AS token1,r.lp_fee AS fee_ppm,
      v.key_fee_ppm,0 AS unstaked_fee_ppm,v.tick_spacing,v.hooks,
      t0.symbol AS symbol0,t0.decimals AS decimals0,
      COALESCE(p0.price_usd,CASE WHEN v.currency0=? THEN pn.price_usd END) AS token0_usd,
      t1.symbol AS symbol1,t1.decimals AS decimals1,
      COALESCE(p1.price_usd,CASE WHEN v.currency1=? THEN pn.price_usd END) AS token1_usd,
      r.sqrt_price,r.tick,r.liquidity,r.liquidity AS staked_liquidity,
      '0' AS reward_rate,0 AS period_finish,0 AS gauge_alive,r.updated AS state_updated,
      COALESCE(m.tvl_usd,m.liq_usd) AS tvl_usd,
      m.vol1h_usd,m.vol6h_usd,m.vol24h_usd,m.updated AS stats_updated
    FROM v4_pools v
    JOIN v4_recommendation_state r ON r.pool_id=v.pool_id
    JOIN v4_market_stats m ON m.pool_id=v.pool_id
    JOIN v4_tokens t0 ON t0.address=v.currency0
    JOIN v4_tokens t1 ON t1.address=v.currency1
    LEFT JOIN tokens p0 ON p0.address=v.currency0
    LEFT JOIN tokens p1 ON p1.address=v.currency1
    LEFT JOIN tokens pn ON pn.address=?
    WHERE COALESCE(m.tvl_usd,m.liq_usd,0)>=? AND COALESCE(m.vol24h_usd,0)>=?
    ORDER BY (
      MIN(
        COALESCE(m.vol1h_usd,m.vol24h_usd/24.0),
        COALESCE(m.vol6h_usd/6.0,m.vol24h_usd/24.0),
        m.vol24h_usd/24.0
      ) * r.lp_fee / MAX(COALESCE(m.tvl_usd,m.liq_usd),1)
    ) DESC LIMIT ?`)
    .all(
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      ADDR.WNATIVE.toLowerCase(), minTvl, minVolume, limit,
    ) as RecommendationRow[] : [];
  // Merge, first writer wins: the volume×fee/TVL cohort, the rewards cohort and
  // v4 keep their place; only pools NONE of them took can enter via the rank
  // seeds, and those carry rankSeeded so the model (and any debugging) can tell
  // which candidates the coverage table vouched in.
  const merged = new Map<string, RecommendationRow>();
  for (const row of [...addressRows, ...rewardRows, ...v4Rows]) merged.set(String(row.identity), row);
  const seededIdentities = new Set<string>();
  const seedAddresses = rankSeedIdentities();
  if (seedAddresses.length) {
    const placeholders = seedAddresses.map(() => '?').join(',');
    const seededRows = db.prepare(`${addressSelect} AND LOWER(p.address) IN (${placeholders})`)
      .all(minTvl, minVolume, ...seedAddresses) as RecommendationRow[];
    for (const row of seededRows) {
      const identity = String(row.identity);
      if (merged.has(identity)) continue;
      merged.set(identity, row);
      seededIdentities.add(identity);
    }
  }
  const rows = [...merged.values()];
  const up = CHAIN.gov
    ? db.prepare('SELECT price_usd FROM tokens WHERE address=?').get(CHAIN.gov.UP.toLowerCase()) as { price_usd: number | null } | undefined
    : undefined;
  const stable = ADDR.STABLE.toLowerCase();
  const wrapped = ADDR.WNATIVE.toLowerCase();
  const rankPriors = rankPriorIndex();
  return {
    ready: kvGet('ready') === '1',
    chainId: CHAIN.id,
    asof: timestamp,
    candidates: rows.map((row) => {
      const identity = String(row.identity);
      const token0 = String(row.token0);
      const token1 = String(row.token1);
      const proto = String(row.proto);
      const rankPrior = rankPriors?.byAddress.get(String(row.pool).toLowerCase());
      const rankSeeded = seededIdentities.has(identity);
      const history = recommendationHistoryFor(identity, timestamp);
      return {
        pool: String(row.pool),
        ...(row.pool_id ? { poolId: String(row.pool_id) } : {}),
        ...(row.hooks ? { hooks: String(row.hooks) } : {}),
        protocol: proto === 'up33cl' ? 'up33' : proto === 'pancakev3' ? 'pancakeswap-v3' : proto,
        token0, token1,
        symbol0: String(row.symbol0), symbol1: String(row.symbol1),
        decimals0: Number(row.decimals0), decimals1: Number(row.decimals1),
        token0Usd: row.token0_usd === null ? null : Number(row.token0_usd),
        token1Usd: row.token1_usd === null ? null : Number(row.token1_usd),
        token0IsRisk: token1 === stable ? true : token0 === stable ? false : token0 === wrapped ? false : true,
        hasStableQuote: token0 === stable || token1 === stable,
        feePpm: Number(row.fee_ppm),
        keyFeePpm: row.key_fee_ppm === null ? null : Number(row.key_fee_ppm),
        unstakedFeePpm: Number(row.unstaked_fee_ppm),
        tickSpacing: Number(row.tick_spacing), tick: Number(row.tick),
        sqrtPriceX96: String(row.sqrt_price), liquidity: String(row.liquidity),
        stakedLiquidity: String(row.staked_liquidity),
        tvlUsd: Number(row.tvl_usd),
        vol1hUsd: row.vol1h_usd === null ? null : Number(row.vol1h_usd),
        vol6hUsd: row.vol6h_usd === null ? null : Number(row.vol6h_usd),
        vol24hUsd: row.vol24h_usd === null ? null : Number(row.vol24h_usd),
        statsUpdatedAt: Number(row.stats_updated), stateUpdatedAt: Number(row.state_updated),
        gaugeAlive: Number(row.gauge_alive) === 1, rewardRate: String(row.reward_rate),
        periodFinish: Number(row.period_finish), upUsd: up?.price_usd ?? null,
        marketHistory: history.marketHistory,
        tickHistory: history.tickHistory,
        ...(rankPrior
          ? {
              poolRank: {
                generatedAt: rankPriors!.generatedAt,
                coverage: rankPrior.coverage,
                sigmaDaily: rankPrior.sigmaDaily,
                sigmaAnnual: rankPrior.sigmaAnnual,
                feeApr7d: rankPrior.feeApr,
                volDayUsd: rankPrior.volDayUsd,
                emitApr: rankPrior.emitApr,
              },
            }
          : {}),
        ...(rankSeeded ? { rankSeeded: true } : {}),
      };
    }),
  };
}

const responseEtag = (body: string): string =>
  `W/"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`;

const weakTag = (value: string): string => value.trim().replace(/^W\//i, '');

function ifNoneMatch(req: IncomingMessage, etag: string): boolean {
  const value = req.headers['if-none-match'];
  if (value === undefined) return false;
  const joined = Array.isArray(value) ? value.join(',') : value;
  return joined
    .split(',')
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === '*' || weakTag(candidate) === weakTag(etag));
}

type PreparedPoolResponse = {
  response: SerializedResponse;
  status: 'HIT' | 'MISS' | 'STALE';
};

/** Exported for deterministic cache/failure contract tests. */
export function preparePoolsResponse(
  params: Params,
  generationReader: (family: PoolProtocolFamily) => string = readCatalogGeneration,
): PreparedPoolResponse {
  const request = canonicalPoolsRequest(params, generationReader);
  const cached = poolResponseCache.get(request.key);
  if (request.generationError !== undefined) {
    if (cached) return { response: cached.response, status: 'STALE' };
    throw request.generationError;
  }
  if (cached?.freshness === 'fresh') return { response: cached.response, status: 'HIT' };

  try {
    const body = JSON.stringify(getPools(request.params));
    const response = poolResponseCache.set(request.key, body, responseEtag(body));
    return { response, status: 'MISS' };
  } catch (error) {
    // Validation/fence/capacity responses are part of the API contract and
    // must never be hidden behind a last-good body. Unexpected origin failures
    // may use the bounded stale entry advertised to the CDN.
    if (
      cached?.freshness === 'stale' &&
      !(error instanceof ApiInputError) &&
      !(error instanceof ApiConflictError) &&
      !(error instanceof ApiCapacityError)
    )
      return { response: cached.response, status: 'STALE' };
    throw error;
  }
}

function sendPoolsResponse(req: IncomingMessage, res: ServerResponse, prepared: PreparedPoolResponse): void {
  const age = Math.max(0, Math.floor((Date.now() - prepared.response.createdAt) / 1_000));
  const headers: Record<string, string> = {
    ...JSONH,
    'cache-control': POOLS_CACHE_CONTROL,
    'cloudflare-cdn-cache-control': POOLS_EDGE_CACHE_CONTROL,
    etag: prepared.response.etag,
    age: String(age),
    'x-indexer-cache': prepared.status,
  };
  if (prepared.status === 'STALE') headers.warning = '110 - "Response is stale"';
  if (ifNoneMatch(req, prepared.response.etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  res.end(prepared.response.body);
}

/** Test/operational hook; normal expiry is bounded and automatic. */
export function clearPoolResponseCache(): void {
  poolResponseCache.clear();
}

export function poolResponseCacheStats(): ReturnType<SerializedResponseCache['stats']> {
  return poolResponseCache.stats();
}

/**
 * v4 positions for one wallet, from the RPC-sourced Transfer replay. Asked the
 * same single question the subgraph answers — which token ids might this wallet
 * own — and trusted with nothing: the reader re-reads ownership on-chain.
 */
export function getV4Positions(params: Params): {
  schemaVersion: number
  chainId: number
  ready: boolean
  chain: { key: string; id: number }
  positions: string[]
} {
  const rawOwner = singleParam(params, 'owner');
  if (rawOwner === null) throw new ApiInputError('v4 positions requires owner');
  const owner = rawOwner.toLowerCase();
  if (!HEX40.test(owner)) throw new ApiInputError('invalid v4 positions owner');
  const indexReady = V4?.positionRpcIndex !== null && kvGet('v4_positions_backfilled') === '1';
  return {
    schemaVersion: 1,
    chainId: CHAIN.id,
    ready: kvGet('ready') === '1' && indexReady,
    chain: { key: CHAIN.key, id: CHAIN.id },
    positions: indexReady ? v4PositionIdsByOwner(owner) : [],
  };
}

export function createApiServer(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    try {
      const url = new URL(req.url ?? '/', 'http://indexer');
      if (req.method !== 'GET') {
        res.writeHead(405, { ...JSONH, 'cache-control': NO_STORE });
        res.end('{"error":"GET only"}');
        return;
      }
      let body: unknown;
      let cache = POOLS_CACHE_CONTROL;
      if (url.pathname === '/api/pools') {
        sendPoolsResponse(req, res, preparePoolsResponse(url.searchParams));
        if (Date.now() - started > 500) log(`[api] slow ${url.pathname} ${Date.now() - started}ms`);
        return;
      } else if (url.pathname === '/api/solver/topology') {
        body = getSolverTopology(url.searchParams);
        cache = NO_STORE;
      } else if (url.pathname === '/api/solver/adjacency') {
        body = getSolverAdjacency(url.searchParams);
        cache = NO_STORE;
      } else if (url.pathname === '/api/solver/connectors') {
        body = getSolverConnectors(url.searchParams);
        cache = NO_STORE;
      } else if (url.pathname === '/api/pool-groups') {
        sendPoolsResponse(req, res, preparePoolGroupsResponse(url.searchParams));
        if (Date.now() - started > 500) log(`[api] slow ${url.pathname} ${Date.now() - started}ms`);
        return;
      } else if (url.pathname === '/api/recommendation-candidates') {
        // Compute FIRST: the warming path throws ApiCapacityError, and the
        // outer catch must still be free to writeHead(503) — writing this
        // branch's 200 before the body would turn that into
        // ERR_HTTP_HEADERS_SENT and kill the process.
        const candidatesBody = getRecommendationCandidatesCached(url.searchParams);
        res.writeHead(200, { ...JSONH, 'cache-control': 'public, max-age=60' });
        res.end(candidatesBody);
        if (Date.now() - started > 500) log(`[api] slow ${url.pathname} ${Date.now() - started}ms`);
        return;
      } else if (url.pathname === '/api/pool-rank') {
        body = getPoolRankApi();
        cache = 'public, max-age=300';
      } else if (url.pathname === '/api/v4/positions') {
        body = getV4Positions(url.searchParams);
        cache = NO_STORE;
      }
      else if (url.pathname === '/api/tokens') body = getTokens(url.searchParams);
      else if (url.pathname === '/api/prices') {
        body = getPrices(url.searchParams);
        cache = 'public, max-age=30';
      }
      else if (url.pathname === '/api/health') {
        body = getHealth();
        cache = NO_STORE;
      } else {
        res.writeHead(404, { ...JSONH, 'cache-control': NO_STORE });
        res.end('{"error":"not found"}');
        return;
      }
      res.writeHead(200, { ...JSONH, 'cache-control': cache });
      res.end(JSON.stringify(body));
      if (Date.now() - started > 500) log(`[api] slow ${url.pathname} ${Date.now() - started}ms`);
    } catch (e) {
      res.writeHead(
        e instanceof ApiInputError
          ? 400
          : e instanceof ApiConflictError
            ? 409
            : e instanceof ApiCapacityError
              ? 503
              : 500,
        { ...JSONH, 'cache-control': NO_STORE },
      );
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
}

export function startApi(): Server {
  const srv = createApiServer();
  srv.listen(PORT, () => log(`[api] listening on :${PORT}`));
  return srv;
}

if (!isMainThread && (workerData as { kind?: string } | null)?.kind === RECOMMENDATION_SNAPSHOT_WORKER_KIND) {
  // The tsxWorker bootstrap imported this module inside the worker thread:
  // compute the whole payload HERE — off the API's event loop — and hand back
  // the ready-to-send body. node:sqlite opens a per-thread reader connection,
  // so WAL keeps this concurrent with the main thread's writes.
  try {
    const body = JSON.stringify(getRecommendationCandidates(RECOMMENDATION_CANONICAL_PARAMS));
    parentPort!.postMessage({ ok: true, body });
  } catch (e) {
    parentPort!.postMessage({ ok: false, error: safeError(e) });
  }
}
