// Read-only API surface for the emerging-pool observation pipeline
// (docs/EMERGING-POOL-LP-PRD.zh-CN.md §8.1, EMG-A04).
//
// The contract's load-bearing rule is the compile-time one: EmergingPoolView
//['canCreateStrategy'] is `false` for the entire A/B/C lifetime, enforced by
// the shared type — there is no code path, flag or field that can serve true.
// Gate/signal research fields render as their unregistered defaults rather
// than being omitted, so clients can rely on the shape from day one.
import { CHAIN } from './config';
import { ApiCapacityError, ApiConflictError, ApiInputError } from './api';
import { db, emergingCounts, kvGet, kvSet } from './store';
import { emergingObserveEnabled } from './emerging';
import type { EmergingObservationReason, EmergingObservationState, EmergingPoolView, EmergingVenue } from '../shared/emerging/types';

const GENERATION_KEY = 'emerging_generation';
const VIEW_SCHEMA_VERSION = 1;
/** A young set with no complete minute newer than this is 'stale' (§6.1). */
const FRESHNESS_SECONDS = 180;

export const emergingGeneration = (): string => kvGet(GENERATION_KEY) ?? '0';
export const bumpEmergingGeneration = (): void => {
  kvSet(GENERATION_KEY, String(Number(kvGet(GENERATION_KEY) ?? '0') + 1));
};

const lastCompleteMinuteQ = db.prepare(`
  SELECT MAX(minute_ts) AS t FROM pool_minute_buckets
  WHERE pool_key = ? AND complete = 1
`);

function buildView(row: {
  poolKey: string; venue: string; canonicalId: string;
  baseToken: string | null; quoteIsUsdg: number;
  poolCreatedAt: number | null; tokenCreatedAt: number | null;
  state: string; reason: string | null; pinnedUntil: number | null;
}): EmergingPoolView {
  const lastMinute = (lastCompleteMinuteQ.get(row.poolKey) as { t: number | null } | null)?.t ?? null;
  // v4 stays 'unsupported' until this deployment's raw event shapes are
  // decoded and pinned (§4.4) — never zeros that read like a dead market.
  const dataQuality: EmergingPoolView['dataQuality'] = row.venue === 'univ4'
    ? { status: 'unsupported', completeThroughTs: null, missingStreams: ['v4-decode'] }
    : lastMinute === null
      ? { status: 'partial', completeThroughTs: null, missingStreams: ['cl-pools'] }
      : lastMinute < Math.floor(Date.now() / 1000) - FRESHNESS_SECONDS
        ? { status: 'stale', completeThroughTs: lastMinute, missingStreams: [] }
        : { status: 'complete', completeThroughTs: lastMinute, missingStreams: [] };
  return {
    schemaVersion: VIEW_SCHEMA_VERSION,
    poolKey: row.poolKey,
    researchProfileHash: null,
    venue: row.venue as EmergingVenue,
    baseToken: row.baseToken,
    baseTokenSymbol: (row as { baseTokenSymbol?: string | null }).baseTokenSymbol ?? null,
    quoteToken: row.quoteIsUsdg ? CHAIN.addr.STABLE.toLowerCase() : null,
    poolCreatedAt: row.poolCreatedAt,
    tokenCreatedAt: row.tokenCreatedAt,
    observation: {
      state: row.state as EmergingObservationState,
      reasons: (row.reason !== null ? [row.reason] : []) as EmergingObservationReason[],
      pinnedUntil: row.pinnedUntil,
    },
    dataQuality,
    gates: {},
    behaviorRisk: 'unknown',
    signal: { id: null, state: 'observing', decisionAt: null },
    observedNetFeeYield6h: null,
    thresholdVersion: '0',
    policyVersion: '0',
    // §8.1: the A/B/C compile-time contract. Never signal-dependent.
    canCreateStrategy: false,
  };
}

export type EmergingApiEnvelope = {
  schemaVersion: 1
  generation: string
  generatedAt: number
  nextCursor: string | null
  phase: 'observe'
  ready: boolean
  readyReason: string | null
  counts: Record<string, number>
  pools: EmergingPoolView[]
};

export function getEmergingPools(params: URLSearchParams): EmergingApiEnvelope {
  if (!emergingObserveEnabled()) disabled();
  const limitRaw = Number(params.get('limit') ?? '50');
  const limit = Number.isSafeInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 200 ? limitRaw : 50;
  const status = params.get('status')?.trim();
  const venue = params.get('venue')?.trim();

  const cursor = params.get('cursor');
  let afterKey = '';
  if (cursor !== null && cursor !== '') {
    const sep = cursor.indexOf(':');
    const generation = sep > 0 ? cursor.slice(0, sep) : '';
    const key = sep > 0 ? cursor.slice(sep + 1) : '';
    if (generation !== emergingGeneration() || !key)
      throw new ApiConflictError('emerging cursor is stale: refetch without cursor');
    afterKey = key.toLowerCase();
  }

  // Filters map onto the ledger's own columns; the list stays poolKey-ordered
  // so a cursor page is a stable slice of one generation (§8.1).
  const clauses: string[] = ['pool_key > ?'];
  const args: string[] = [afterKey];
  if (status) { clauses.push('state = ?'); args.push(status); }
  if (venue) { clauses.push('venue = ?'); args.push(venue); }
  const rows = db
    .prepare(`SELECT d.pool_key AS poolKey, d.venue, d.canonical_id AS canonicalId,
                     d.base_token AS baseToken, d.quote_is_usdg AS quoteIsUsdg,
                     d.pool_created_at AS poolCreatedAt, d.token_created_at AS tokenCreatedAt,
                     d.state, d.reason, d.pinned_until AS pinnedUntil, d.updated_at AS updatedAt,
                     tb.symbol AS baseTokenSymbol
              FROM emerging_discovery d
              LEFT JOIN tokens tb ON tb.address = d.base_token
              WHERE ${clauses.join(' AND ')}
              ORDER BY d.pool_key LIMIT ${limit + 1}`)
    .all(...args) as Array<Parameters<typeof buildView>[0]>;

  const page = rows.slice(0, limit);
  const generation = emergingGeneration();
  const counts = emergingCounts();
  return {
    schemaVersion: 1,
    generation,
    generatedAt: Math.floor(Date.now() / 1000),
    nextCursor: rows.length > limit ? `${generation}:${page[page.length - 1].poolKey}` : null,
    phase: 'observe',
    ready: true,
    readyReason: null,
    counts,
    pools: page.map(buildView),
  };
}

export function getEmergingPool(poolKey: string): EmergingApiEnvelope & { pools: EmergingPoolView[] } {
  if (!emergingObserveEnabled()) disabled();
  if (!/^\d+:(up33-cl|univ3|univ4):0x[0-9a-f]{40,64}$/.test(poolKey))
    throw new ApiInputError('malformed poolKey');
  const row = db
    .prepare(`SELECT pool_key AS poolKey, venue, canonical_id AS canonicalId,
                     base_token AS baseToken, quote_is_usdg AS quoteIsUsdg,
                     pool_created_at AS poolCreatedAt, token_created_at AS tokenCreatedAt,
                     state, reason, pinned_until AS pinnedUntil, updated_at AS updatedAt
              FROM emerging_discovery WHERE pool_key = ?`)
    .get(poolKey) as Parameters<typeof buildView>[0] | undefined;
  if (!row) throw new ApiInputError('unknown poolKey');
  return {
    schemaVersion: 1,
    generation: emergingGeneration(),
    generatedAt: Math.floor(Date.now() / 1000),
    nextCursor: null,
    phase: 'observe',
    ready: true,
    readyReason: null,
    counts: emergingCounts(),
    pools: [buildView(row)],
  };
}

function disabled(): never {
  // The code travels in the message so the §10.1 contract surfaces verbatim.
  throw new ApiCapacityError('E_EMERGING_DISABLED: observation pipeline is off (INDEXER_EMERGING_OBSERVE != 1)');
}
