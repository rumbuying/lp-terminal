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
import { getAmountsForLiquidity, getSqrtRatioAtTick, MIN_TICK, MAX_TICK } from '../src/lib/clmath';
import type { EmergingObservationReason, EmergingObservationState, EmergingPoolView, EmergingVenue } from '../shared/emerging/types';

const GENERATION_KEY = 'emerging_generation';

/** Native-ETH pricing anchor: the Wrapped-native row's pricing-graph price. */
const wnativePriceQ = db.prepare(`SELECT price_usd AS p FROM tokens WHERE address = ?`);
function wnativePrice(): number | null {
  const r = wnativePriceQ.get(CHAIN.addr.WNATIVE.toLowerCase()) as { p: number | null } | undefined;
  return r?.p ?? null;
}
const sidePriceQ = db.prepare(`SELECT price_usd AS p FROM tokens WHERE address = ?`);
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

let buildViewWarned = false

function buildView(row: {
  poolKey: string; venue: string; canonicalId: string;
  token0?: string | null; token1?: string | null;
  baseToken: string | null; quoteIsUsdg: number;
  poolCreatedAt: number | null; tokenCreatedAt: number | null;
  state: string; reason: string | null; pinnedUntil: number | null;
  basePriceUsd?: number | null; baseDecimals?: number | null; baseTotalSupply?: string | null;
  statsLiqUsd?: number | null; v4TvlUsd?: number | null; v4LiqUsd?: number | null;
  t0PriceUsd?: number | null; t0Decimals?: number | null;
  t1PriceUsd?: number | null; t1Decimals?: number | null;
  v3SqrtPrice?: string | null; v3Liquidity?: string | null;
  v4SqrtPrice?: string | null; v4Liquidity?: string | null;
}): EmergingPoolView {
  // --- display-grade self-computed figures (§8.2; NOT trading inputs) ---
  // Liquidity: v4 from the StateView cache, v3/UP33 from pool_state's swept
  // active L — full-range amounts at the pool's own price, in USD via the
  // pricing graph (WETH/USDG prices are deep; the speculative side prices
  // THROUGH the pool itself when the major side is priced).
  const sqrtText = row.venue === 'univ4' ? row.v4SqrtPrice : row.v3SqrtPrice
  const liqText = row.venue === 'univ4' ? row.v4Liquidity : row.v3Liquidity
  const external = row.venue === 'univ4'
    ? (row.v4TvlUsd ?? row.v4LiqUsd ?? null)
    : (row.statsLiqUsd ?? null)
  const zero = '0x' + '0'.repeat(40)
  const stable = CHAIN.addr.STABLE.toLowerCase()
  const wnative = CHAIN.addr.WNATIVE.toLowerCase()
  const sideUsd = (addr: string | null): number | null => {
    if (addr === null) return null
    const a = addr.toLowerCase()
    if (a === zero) return wnativePrice() // native priced at Wrapped parity
    if (a === stable) return 1 // the audited stable ≈ its peg (§4.4 note)
    const r = sidePriceQ.get(a) as { p: number | null } | undefined
    return r?.p ?? null
  }
  const t0 = row.token0 ?? null
  const t1 = row.token1 ?? null
  const t0Low = t0?.toLowerCase() ?? null
  const t1Low = t1?.toLowerCase() ?? null
  const isMajor = (a: string | null) => a !== null && (a === zero || a === stable || a === wnative)
  const spec: 't0' | 't1' | null = isMajor(t0Low) && !isMajor(t1Low) ? 't1'
    : isMajor(t1Low) && !isMajor(t0Low) ? 't0' : null
  const majorUsd = spec === 't1' ? sideUsd(t0) : spec === 't0' ? sideUsd(t1) : null

  let liquidityUsd: number | null = external
  let priceUsd: number | null = row.basePriceUsd ?? null
  let marketCapUsd: number | null = null
  // Per-row isolation: one pool's malformed figures must never 500 the whole
  // list — the three display fields simply stay null for that row, and the
  // first failure logs its shape for diagnosis.
  try {
  // Numeric-string defense: garbage in the depth cache ("undefined",
  // "[object Object]") must never reach BigInt — skip the row's figures.
  const numeric = (v: string | null | undefined): v is string => v !== undefined && v !== null && /^\d+$/.test(v)
  if (numeric(sqrtText) && numeric(liqText) && spec !== null && majorUsd !== null && majorUsd > 0) {
    const sqrtP = BigInt(sqrtText)
    const L = BigInt(liqText)
    const amounts = getAmountsForLiquidity(sqrtP, getSqrtRatioAtTick(MIN_TICK), getSqrtRatioAtTick(MAX_TICK), L)
    // The pool's own ratio makes the two sides' values EQUAL at mid price, so
    // the whole active-L value prices from the MAJOR side alone (whose USD
    // price the graph carries) — the speculative side's price is then read
    // BACK out of the same ratio. Display-grade; the $300 trading gate stays.
    const majorAmount = spec === 't1' ? amounts.amount0 : amounts.amount1
    const majorDec = spec === 't1' ? (row.t0Decimals ?? 18) : (row.t1Decimals ?? 18)
    const liqUsdSelf = 2 * Number(majorAmount) / 10 ** majorDec * majorUsd
    if (Number.isFinite(liqUsdSelf) && liqUsdSelf > 0)
      liquidityUsd = liquidityUsd === null ? liqUsdSelf : Math.max(liquidityUsd, liqUsdSelf)
    const nSqrt = Number(sqrtP) / 2 ** 96
    const raw = nSqrt * nSqrt // token1_raw per token0_raw
    const decAdj = 10 ** ((row.t0Decimals ?? 18) - (row.t1Decimals ?? 18))
    const t1PerT0 = raw * decAdj
    const specUsd = spec === 't0' ? majorUsd / t1PerT0 : majorUsd * t1PerT0
    if (Number.isFinite(specUsd) && specUsd > 0) {
      priceUsd = priceUsd ?? specUsd
      const sup = row.baseTotalSupply !== null && row.baseTotalSupply !== undefined
        ? Number(row.baseTotalSupply) / 10 ** (row.baseDecimals ?? 18) : null
      // FDV only when the speculative side IS the proven base (§5.2 supply
      // ledger denominator); otherwise the figure would be meaningless.
      const specAddr = spec === 't0' ? t0Low : t1Low
      const baseAddr = row.baseToken?.toLowerCase() ?? null
      if (sup !== null && sup > 0 && specAddr === baseAddr)
        marketCapUsd = specUsd * sup
    }
  }
  } catch (error) {
    if (!buildViewWarned) {
      buildViewWarned = true
      console.log('[emerging-api] display-figure compute failed once:', String(error).slice(0, 160),
        JSON.stringify({ venue: row.venue, v3Sqrt: row.v3SqrtPrice?.slice(0, 10), v3Liq: row.v3Liquidity?.slice(0, 10),
          v4Sqrt: row.v4SqrtPrice?.slice(0, 10), v4Liq: row.v4Liquidity?.slice(0, 10),
          t0: row.t0PriceUsd, t1: row.t1PriceUsd }))
    }
  }
  // Liquidity per venue: external figures (v4 chain-derived TVL / GT) win
  // when present; otherwise the self-computed active-L value stands in —
  // display-grade, labeled as估算 in the UI.
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
    token0: row.token0 ?? null,
    token1: row.token1 ?? null,
    token0Symbol: (row as { token0Symbol?: string | null }).token0Symbol ?? null,
    token1Symbol: (row as { token1Symbol?: string | null }).token1Symbol ?? null,
    poolId: row.canonicalId,
    liquidityUsd,
    priceUsd: row.basePriceUsd ?? null,
    marketCapUsd,
    totalSupply: row.baseTotalSupply ?? null,
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
  const clauses: string[] = ['d.pool_key > ?'];
  const args: string[] = [afterKey];
  if (status) { clauses.push('d.state = ?'); args.push(status); }
  if (venue) { clauses.push('d.venue = ?'); args.push(venue); }
  const rows = db
    .prepare(`SELECT d.pool_key AS poolKey, d.venue, d.canonical_id AS canonicalId,
                     d.token0, d.token1,
                     d.base_token AS baseToken, d.quote_is_usdg AS quoteIsUsdg,
                     d.pool_created_at AS poolCreatedAt, d.token_created_at AS tokenCreatedAt,
                     d.state, d.reason, d.pinned_until AS pinnedUntil, d.updated_at AS updatedAt,
                     tb.symbol AS baseTokenSymbol, t0s.symbol AS token0Symbol, t1s.symbol AS token1Symbol,
                     tb.price_usd AS basePriceUsd, tb.decimals AS baseDecimals,
                     ss.total_supply AS baseTotalSupply,
                     ps.liq_usd AS statsLiqUsd,
                     vm.tvl_usd AS v4TvlUsd, vm.liq_usd AS v4LiqUsd,
                     t0s.price_usd AS t0PriceUsd, t0s.decimals AS t0Decimals,
                     t1s.price_usd AS t1PriceUsd, t1s.decimals AS t1Decimals,
                     pst.sqrt_price AS v3SqrtPrice, pst.liquidity AS v3Liquidity,
                     vs.sqrt_price AS v4SqrtPrice, vs.liquidity AS v4Liquidity
              FROM emerging_discovery d
              LEFT JOIN tokens tb ON tb.address = d.base_token
              LEFT JOIN tokens t0s ON t0s.address = d.token0
              LEFT JOIN tokens t1s ON t1s.address = d.token1
              LEFT JOIN emerging_supply_state ss ON ss.token = d.base_token
              LEFT JOIN pool_stats ps ON ps.address = d.canonical_id
              LEFT JOIN v4_market_stats vm ON vm.pool_id = d.canonical_id
              LEFT JOIN pool_state pst ON pst.address = d.canonical_id
              LEFT JOIN emerging_v4_state vs ON vs.pool_key = d.pool_key
              WHERE ${clauses.join(' AND ')}
              ORDER BY d.pool_key LIMIT ${limit + 1}`)
    .all(...args) as Array<Parameters<typeof buildView>[0]>;

  // Trailing-hour activity per pool in one aggregate pass — the honest
  // heartbeat even for v4 pools whose decode is still pending (v4raw counts).
  const hourAgo = Math.floor(Date.now() / 1000) - 3_600;
  const tradesByPool = new Map<string, number>(
    (db.prepare(`
      SELECT pool_key AS k, COUNT(*) AS n FROM emerging_chain_events
      WHERE canonical = 1 AND kind IN ('swap', 'v4raw') AND block_ts >= ?
        AND pool_key IS NOT NULL
      GROUP BY pool_key`).all(hourAgo) as Array<{ k: string; n: number }>)
      .map((r) => [r.k, r.n]),
  );

  const page = rows.slice(0, limit).map((row) => ({
    view: buildView(row),
    trades1h: tradesByPool.get(row.poolKey) ?? 0,
  }));
  const generation = emergingGeneration();
  const counts = emergingCounts();
  return {
    schemaVersion: 1,
    generation,
    generatedAt: Math.floor(Date.now() / 1000),
    nextCursor: rows.length > limit ? `${generation}:${page[page.length - 1].view.poolKey}` : null,
    phase: 'observe',
    ready: true,
    readyReason: null,
    counts,
    pools: page.map((p) => ({ ...p.view, trades1h: p.trades1h })),
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
