// Signal state machine (docs/EMERGING-POOL-LP-PRD.zh-CN.md §6.3, EMG-B03).
//
// The conjunction, evaluated only over FRESH evidence:
//   eight gates pass ∧ behaviorRisk=low_observed ∧ inventory release
//   confirmed ∧ retention pass ∧ stabilization pass → watch_candidate.
//
// The state lives as IMMUTABLE decision rows: a candidate row is never edited
// — invalidation appends an 'invalidated' row, and re-satisfaction mints a
// NEW signalId (§6.3: 再满足时新建 signalId，保留旧记录). anchorLow freezes at
// first candidacy from trades observed since reductionStartedAt and never
// moves down (§6.2). Nothing here can create a strategy: canCreateStrategy
// stays false at every layer.
import { CHAIN, now } from './config';
import { db, kvGet, kvSet } from './store';
import { EMERGING_POLICY, EMERGING_THRESHOLDS as T, DEFAULT_PROFILE_HASH, researchProfile } from './emergingPolicy';
import { evaluateGates, type GateBundle } from './emergingGates';
import { assessBehavior, assessRetention, assessStabilization, type BehaviorTrade, type PriceBar } from './emergingMetrics';
import { loadReduction } from './emergingReduction';

const signalSeq = () => Number(kvGet('emerging_signal_seq') ?? '0') + 1;

const insertSignalQ = db.prepare(`
  INSERT INTO emerging_signal_events(
    signal_id, pool_key, research_profile_hash, state, decision_at,
    anchor_low, metrics, gates, threshold_version, policy_version
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const latestSignalQ = db.prepare(`
  SELECT signal_id, state, anchor_low, decision_at FROM emerging_signal_events
  WHERE pool_key = ? AND research_profile_hash = ?
  ORDER BY decision_at DESC, signal_id DESC LIMIT 1
`);
const lastSignalsQ = db.prepare(`
  SELECT state FROM emerging_signal_events
  WHERE pool_key = ? AND research_profile_hash = ?
  ORDER BY decision_at DESC, signal_id DESC LIMIT 1
`);

const activePoolsQ = db.prepare(`
  SELECT pool_key AS poolKey, base_token AS baseToken, canonical_id AS canonicalId
  FROM emerging_discovery
  WHERE admitted_rank IS NOT NULL AND state != 'aged_out'
`);

const hourlyQ = db.prepare(`
  SELECT minute_ts / 3600 * 3600 AS hour_ts, SUM(CAST(vol_quote AS REAL)) AS v
  FROM pool_minute_buckets
  WHERE pool_key = ? AND complete = 1 AND minute_ts >= ? AND minute_ts < ?
  GROUP BY hour_ts ORDER BY hour_ts
`);
const barsQ = db.prepare(`
  SELECT close_price, swap_count FROM pool_minute_buckets
  WHERE pool_key = ? AND complete = 1 AND minute_ts >= ? AND minute_ts < ?
  ORDER BY minute_ts
`);
const swapsSinceQ = db.prepare(`
  SELECT block_ts AS ts, payload FROM emerging_chain_events
  WHERE pool_key = ? AND canonical = 1 AND kind = 'swap' AND block_ts >= ?
  ORDER BY block_ts, tx_index, log_index
`);

function recordSignal(args: {
  poolKey: string; profileHash: string; state: 'watch_candidate' | 'invalidated';
  anchorLow: number | null; metrics: Record<string, unknown>; gates: GateBundle;
}): string {
  const seq = signalSeq();
  kvSet('emerging_signal_seq', String(seq));
  const id = `${args.poolKey}:${args.profileHash}:${now()}:${seq}`;
  insertSignalQ.run(
    id, args.poolKey, args.profileHash, args.state, now(),
    args.anchorLow, JSON.stringify(args.metrics), JSON.stringify(args.gates),
    '1', String(EMERGING_POLICY.policyVersion),
  );
  return id;
}

function lowSince(state: { startedAt: number | null }): number | null {
  return state.startedAt;
}

/**
 * One signal-evaluation pass over the tracked young set. Returns counters for
 * the log line; every decision lands in emerging_signal_events.
 */
export function runEmergingSignalSweep(): { pools: number; candidates: number; invalidated: number } {
  const counters = { pools: 0, candidates: 0, invalidated: 0 };
  const pools = activePoolsQ.all() as Array<{ poolKey: string; baseToken: string | null; canonicalId: string }>;
  const t = now();

  for (const pool of pools) {
    counters.pools++;
    const last = lastSignalsQ.get(pool.poolKey, DEFAULT_PROFILE_HASH) as { state: string } | undefined;
    const currentlyCandidate = last?.state === 'watch_candidate';

    const { gates, allPass } = evaluateGates(pool.poolKey, DEFAULT_PROFILE_HASH);

    // --- invalidation short-circuit for a live candidate ---
    if (currentlyCandidate) {
      const latest = latestSignalQ.get(pool.poolKey, DEFAULT_PROFILE_HASH) as { anchor_low: number | null };
      const broken =
        !allPass ||
        behaviorOf(pool.poolKey).class !== 'low_observed' ||
        priceBelowAnchor(pool.poolKey, latest.anchor_low);
      if (broken) {
        recordSignal({
          poolKey: pool.poolKey, profileHash: DEFAULT_PROFILE_HASH, state: 'invalidated',
          anchorLow: latest.anchor_low,
          metrics: { reason: !allPass ? 'gates' : priceBelowAnchor(pool.poolKey, latest.anchor_low) ? 'below_anchor' : 'behavior' },
          gates,
        });
        counters.invalidated++;
      }
      continue;
    }

    // --- candidacy requires everything, over fresh evidence ---
    if (!allPass) continue;
    const reduction = pool.baseToken !== null ? loadReduction(pool.baseToken) : null;
    if (reduction === null || reduction.confirmedAt === null) continue;

    const behavior = behaviorOf(pool.poolKey);
    if (behavior.class !== 'low_observed') continue;

    const since = t - (T.persistenceHours + 1) * 3600;
    const hourRows = hourlyQ.all(pool.poolKey, since, t) as Array<{ hour_ts: number; v: number | null }>;
    if (hourRows.length < T.persistenceHours) continue;
    const retention = assessRetention(hourRows.slice(-T.persistenceHours).map((r) => r.v ?? 0), T.quietVolumeQuotePerHour);
    if (!retention.pass) continue;

    const bars = (barsQ.all(pool.poolKey, t - T.stabilizationHours * 3600, t) as Array<{ close_price: number | null; swap_count: number }>)
      .map((b): PriceBar => ({ close: b.close_price ?? 0, hasVolume: b.swap_count > 0 }));
    const anchorLow = anchorLowFor(pool.poolKey, lowSince(reduction));
    if (anchorLow === null) continue;
    const stab = assessStabilization(bars, anchorLow);
    if (!stab.pass) continue;

    const id = recordSignal({
      poolKey: pool.poolKey, profileHash: DEFAULT_PROFILE_HASH, state: 'watch_candidate',
      anchorLow,
      metrics: {
        behavior: behavior, retention: retention,
        stabilization: { sigmaRatio: stab.sigmaRatio, rebound: stab.rebound },
      },
      gates,
    });
    void id;
    counters.candidates++;
  }
  return counters;
}

/** §5.4 behavior over the pool's recent swaps; recipient = economic actor. */
function behaviorOf(poolKey: string) {
  const since = now() - T.stabilizationHours * 3600;
  const rows = swapsSinceQ.all(poolKey, since) as Array<{ ts: number | null; payload: string }>;
  const usdg = CHAIN.addr.STABLE.toLowerCase();
  const trades: BehaviorTrade[] = [];
  let hasGap = false;
  for (const r of rows) {
    const p = JSON.parse(r.payload) as { amount0?: string; amount1?: string; sender?: string; recipient?: string };
    if (r.ts === null || p.amount0 === undefined || p.amount1 === undefined) { hasGap = true; continue; }
    const a0 = BigInt(p.amount0);
    const buy = a0 < 0n;
    const vol = buy ? BigInt(p.amount1) : -BigInt(p.amount1);
    const recipient = (p.recipient ?? '').toLowerCase();
    trades.push({
      ts: r.ts,
      volumeQuote: vol,
      direction: buy ? 'buy' : 'sell',
      // v3's recipient receives the output side — the economic actor when it
      // is not the pool itself. Router filtering refines this later.
      actor: recipient && recipient !== poolKey.split(':')[2] ? recipient : null,
    });
    void usdg;
  }
  return assessBehavior({ trades, hasDataGap: hasGap });
}

function priceBelowAnchor(poolKey: string, anchorLow: number | null): boolean {
  if (anchorLow === null || anchorLow <= 0) return true;
  const row = db
    .prepare(`SELECT close_price FROM pool_minute_buckets WHERE pool_key = ? AND complete = 1 AND close_price IS NOT NULL ORDER BY minute_ts DESC LIMIT 1`)
    .get(poolKey) as { close_price: number } | undefined;
  if (!row) return false; // no price evidence yet — not a price break
  return row.close_price < anchorLow;
}

/** anchorLow = lowest observed close (or trade-implied price) since the
 *  reduction started; frozen at first candidacy by the caller's flow. */
function anchorLowFor(poolKey: string, sinceTs: number | null): number | null {
  if (sinceTs === null) return null;
  const rows = swapsSinceQ.all(poolKey, sinceTs) as Array<{ payload: string }>;
  let low: number | null = null;
  for (const r of rows) {
    const p = JSON.parse(r.payload) as { sqrtPriceX96?: string };
    if (p.sqrtPriceX96 === undefined) continue;
    const price = Number(BigInt(p.sqrtPriceX96)) / Number(1n << 96n);
    const sq = price * price;
    if (Number.isFinite(sq) && sq > 0 && (low === null || sq < low)) low = sq;
  }
  return low;
}

export function researchProfileOrThrow(hash: string) {
  const p = researchProfile(hash);
  if (p === null) throw new Error(`unknown research profile ${hash}`);
  return p;
}
