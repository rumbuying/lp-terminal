// Emerging aggregation (docs/EMERGING-POOL-LP-PRD.zh-CN.md §4.4, EMG-A05):
// dated canonical events → minute buckets → the public 1h pool_history rows.
//
// Completeness is the whole point of this module. A minute bucket exists only
// when its window is CLOSED and every stream that owes this pool facts has
// proven (via its cursor's complete_through_ts) that it scanned past that
// close. Everything else stays unwritten: a missing bucket is the honest
// representation of "not scanned yet", and a zero-volume bucket is written
// only for a complete scan that saw no swaps (§3.2's unknown-vs-zero rule).
//
// v4 pools are aggregated only after this deployment's raw event shapes are
// decoded and pinned (an aggregate_version bump); until then their buckets
// stay absent and their dataQuality reads 'unsupported' — never zeros that
// look like a dead market.
import { CHAIN, EMERGING_TUNE, log } from './config';
import { pc } from './rpc';
import { db, kvGet, kvSet } from './store';

const AGGREGATE_VERSION = 1;
const SECOND = 1;
const MINUTE = 60 * SECOND;

type TrackedPool = {
  poolKey: string;
  venue: string;
  canonicalId: string;
  token0: string | null;
  token1: string | null;
  baseToken: string | null;
  quoteToken: string | null;
};

const trackedPoolsQ = db.prepare(`
  SELECT pool_key AS poolKey, venue, canonical_id AS canonicalId,
         token0, token1, base_token AS baseToken
  FROM emerging_discovery
  WHERE admitted_rank IS NOT NULL AND state != 'aged_out'
`);

const streamCompleteQ = db.prepare(`
  SELECT MAX(complete_through_ts) AS t
  FROM emerging_scan_cursors
  WHERE chain_id = ? AND status = 'active' AND complete_through_ts IS NOT NULL
`);

const undatedBlocksQ = db.prepare(`
  SELECT DISTINCT block_number AS b FROM emerging_chain_events
  WHERE canonical = 1 AND block_ts IS NULL AND block_number <= ?
  LIMIT ?
`);

const dateBlockQ = db.prepare(`
  UPDATE emerging_chain_events SET block_ts = ?
  WHERE chain_id = ? AND block_number = ? AND block_ts IS NULL
`);

const swapsQ = db.prepare(`
  SELECT block_ts AS ts, tx_hash AS txHash, payload
  FROM emerging_chain_events
  WHERE chain_id = ? AND pool_key = ? AND canonical = 1 AND kind = 'swap'
    AND block_ts IS NOT NULL AND block_ts >= ? AND block_ts < ?
  ORDER BY block_ts, tx_index, log_index
`);

const upsertMinuteQ = db.prepare(`
  INSERT INTO pool_minute_buckets(
    pool_key, minute_ts, complete, missing_sources, source_through_block,
    aggregate_version, swap_count, amount0, amount1, vol_quote, vol_usd,
    buy_count, sell_count, buy_vol_quote, sell_vol_quote,
    open_price, high_price, low_price, close_price, vwap_price, price_coverage
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(pool_key, minute_ts) DO UPDATE SET
    complete = excluded.complete,
    missing_sources = excluded.missing_sources,
    source_through_block = excluded.source_through_block,
    aggregate_version = excluded.aggregate_version,
    swap_count = excluded.swap_count,
    amount0 = excluded.amount0,
    amount1 = excluded.amount1,
    vol_quote = excluded.vol_quote,
    vol_usd = excluded.vol_usd,
    buy_count = excluded.buy_count,
    sell_count = excluded.sell_count,
    buy_vol_quote = excluded.buy_vol_quote,
    sell_vol_quote = excluded.sell_vol_quote,
    open_price = excluded.open_price,
    high_price = excluded.high_price,
    low_price = excluded.low_price,
    close_price = excluded.close_price,
    vwap_price = excluded.vwap_price,
    price_coverage = excluded.price_coverage
`);

const watermarkedMinuteQ = db.prepare(
  `SELECT v FROM kv WHERE k = ?`,
);
const upsertHistoryQ = db.prepare(`
  INSERT INTO pool_history(
    address, bucket, bucket_ts, proto, state_updated,
    interval_volume_quote, interval_volume_usd, interval_ohlc, quality,
    source_block, aggregate_version
  ) VALUES (?, '1h', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(address, bucket, bucket_ts) DO UPDATE SET
    interval_volume_quote = excluded.interval_volume_quote,
    interval_volume_usd = excluded.interval_volume_usd,
    interval_ohlc = excluded.interval_ohlc,
    quality = excluded.quality,
    source_block = excluded.source_block,
    aggregate_version = excluded.aggregate_version
`);

const minuteRowsQ = db.prepare(`
  SELECT minute_ts AS minuteTs, swap_count AS swapCount, vol_quote AS volQuote,
         open_price AS openPrice, high_price AS highPrice, low_price AS lowPrice,
         close_price AS closePrice, source_through_block AS sourceThroughBlock
  FROM pool_minute_buckets
  WHERE pool_key = ? AND complete = 1 AND minute_ts >= ? AND minute_ts < ?
  ORDER BY minute_ts
`);

const USDG = CHAIN.addr.STABLE.toLowerCase();

/** Quote denomination requires PROOF, not convention (§3.1): the only quote
 *  series this aggregation writes is USDG against a ledger-proven base —
 *  the pool's other side must be the audited USDG itself. */
function provenQuoteUsdg(pool: TrackedPool): boolean {
  if (pool.baseToken === null) return false;
  const base = pool.baseToken.toLowerCase();
  return (base === pool.token0?.toLowerCase() && pool.token1?.toLowerCase() === USDG)
    || (base === pool.token1?.toLowerCase() && pool.token0?.toLowerCase() === USDG);
}

/**
 * Date undated event blocks within the shared per-sweep budget. Timestamps
 * are chain truth from getBlock — never interpolated from a block-time
 * estimate (§3.1). Returns how many blocks were dated.
 */
export async function dateEmergingBlocks(): Promise<number> {
  const finalityHead = Number(await pc.getBlockNumber());
  const rows = undatedBlocksQ.all(finalityHead, EMERGING_TUNE.blockTsFetchesPerSweep) as Array<{ b: number }>;
  let dated = 0;
  for (const { b } of rows) {
    try {
      const ts = Number((await pc.getBlock({ blockNumber: BigInt(b) })).timestamp);
      dateBlockQ.run(ts, CHAIN.id, b);
      dated++;
    } catch {
      break; // keep the budget for a later sweep; NULL stays NULL
    }
  }
  return dated;
}

type SwapRow = { ts: number; txHash: string; payload: string };

/**
 * Aggregate one pool's closed minutes into bucket rows. Two honest classes:
 *  - minutes CONTAINING events are always materialized (they are facts);
 *  - empty minutes materialize as zeros only inside the proven-coverage
 *    window — after the stream's seed (never-scanned minutes stay gaps) and
 *    within the bounded zero-backfill window (§4.4/§4.5: the first pass must
 *    not synthesize a week of zero rows per pool).
 * `completeThrough` is the newest chain-time every required stream has
 * scanned through; windows closing after it are left for later sweeps.
 */
export function aggregatePoolMinutes(
  pool: TrackedPool,
  completeThrough: number | null,
  aggregateVersion: number,
): { written: number; completeMinutes: number } {
  if (completeThrough === null) return { written: 0, completeMinutes: 0 };
  const wmKey = `emerging_agg_wm:${pool.poolKey}`;
  const lastRow = watermarkedMinuteQ.get(wmKey) as { v: string } | undefined;
  const lastMinute = lastRow !== undefined ? Number(lastRow.v) : null;
  const fromMinute = (lastMinute !== null ? lastMinute : 0) - MINUTE;
  const lastClosedMinute = Math.floor(Math.min(completeThrough, nowSecond()) / MINUTE) * MINUTE - MINUTE;
  if (lastClosedMinute < fromMinute) return { written: 0, completeMinutes: 0 };

  const swaps = swapsQ.all(CHAIN.id, pool.poolKey, fromMinute, completeThrough + 1) as unknown as SwapRow[];
  const byMinute = new Map<number, SwapRow[]>();
  for (const s of swaps) {
    const m = Math.floor(s.ts / MINUTE) * MINUTE;
    const list = byMinute.get(m);
    if (list) list.push(s);
    else byMinute.set(m, [s]);
  }

  // Zero-bucket window: the provable floor is the stream seed — minutes
  // before it were never scanned; inside it, only the bounded trailing span
  // materializes (§4.5's write-burst budget).
  const seedTs = Number((watermarkedMinuteQ.get('emerging_stream_seed:cl-pools') as { v: string } | undefined)?.v ?? 0);
  const zeroFloorMinute = Math.max(
    Math.floor(seedTs / MINUTE) * MINUTE,
    lastClosedMinute - EMERGING_TUNE.zeroBackfillHours * 3600,
    fromMinute,
  );

  // Existing rows in range: rewrites happen only when completeness actually
  // flips (0→1) — idempotent re-runs write nothing (§4.4).
  const existing = new Map<number, number>();
  for (const r of db.prepare('SELECT minute_ts AS m, complete FROM pool_minute_buckets WHERE pool_key = ? AND minute_ts >= ? AND minute_ts <= ?')
    .all(pool.poolKey, fromMinute, lastClosedMinute) as unknown as Array<{ m: number; complete: number }>)
    existing.set(r.m, r.complete);

  let written = 0;
  let newWatermark = lastMinute ?? 0;

  // Pass 1 — evented minutes. A minute inside proven coverage is complete;
  // one outside it keeps the row (the swap is a fact) but stays incomplete.
  for (const [m, rows] of byMinute) {
    if (m > lastClosedMinute) continue;
    const withinCoverage = m >= zeroFloorMinute;
    const complete = withinCoverage ? 1 : 0;
    if (existing.get(m) === complete) continue; // nothing would change
    writeMinute(pool, m, rows, aggregateVersion, complete);
    written++;
    if (m > newWatermark) newWatermark = m;
  }
  // Pass 2 — zero minutes inside the proven, bounded window.
  const zeroStart = Math.max(zeroFloorMinute, byMinute.size ? Math.max(...byMinute.keys()) + MINUTE : fromMinute);
  for (let m = zeroStart; m <= lastClosedMinute; m += MINUTE) {
    if (byMinute.has(m) || existing.get(m) === 1) continue;
    writeMinute(pool, m, [], aggregateVersion, 1);
    written++;
    if (m > newWatermark) newWatermark = m;
  }
  if (newWatermark !== lastMinute) kvSet(wmKey, String(newWatermark));
  return { written, completeMinutes: written };
}

function writeMinute(pool: TrackedPool, m: number, rows: SwapRow[], aggregateVersion: number, complete: 0 | 1): void {
  const prices: number[] = [];
  let buyCount = 0;
  let sellCount = 0;
  let volQuote = 0n;
  let buyVol = 0n;
  let sellVol = 0n;
  let amount0 = 0n;
  let amount1 = 0n;
  for (const s of rows) {
    const p = JSON.parse(s.payload) as { amount0?: string; amount1?: string; sqrtPriceX96?: string };
    const a0 = p.amount0 !== undefined ? BigInt(p.amount0) : 0n;
    const a1 = p.amount1 !== undefined ? BigInt(p.amount1) : 0n;
    amount0 += a0;
    amount1 += a1;
    // A v3 swap moves one side negative: negative amount0 = base sold into
    // the pool = a BUY of the base (quote flows out to the seller). Volume
    // is always the QUOTE leg's size — |amount1| whichever way it flows.
    if (a0 < 0n) {
      buyCount++;
      volQuote += a1 > 0n ? a1 : -a1;
      buyVol += a1 > 0n ? a1 : -a1;
    } else if (a1 < 0n) {
      sellCount++;
      volQuote += -a1;
      sellVol += -a1;
    }
    if (p.sqrtPriceX96 !== undefined) {
      const raw = Number(BigInt(p.sqrtPriceX96)) / 2 ** 96;
      if (Number.isFinite(raw) && raw > 0) prices.push(raw * raw);
    }
  }
  upsertMinuteQ.run(
    pool.poolKey, m, complete, JSON.stringify([]), null,
    aggregateVersion, rows.length,
    amount0.toString(), amount1.toString(),
    pool.quoteToken ? volQuote.toString() : null, null,
    rows.length ? buyCount : null, rows.length ? sellCount : null,
    pool.quoteToken ? buyVol.toString() : null, pool.quoteToken ? sellVol.toString() : null,
    prices[0] ?? null, prices.length ? Math.max(...prices) : null,
    prices.length ? Math.min(...prices) : null, prices[prices.length - 1] ?? null,
    prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null,
    prices.length,
  );
}

const nowSecond = () => Math.floor(Date.now() / 1000);

/** Roll complete minutes of the LAST closed hour into the public 1h row. */
export function rollUpHour(pool: TrackedPool): boolean {
  const hourStart = Math.floor(nowSecond() / 3600) * 3600 - 3600;
  const rows = minuteRowsQ.all(pool.poolKey, hourStart, hourStart + 3600) as unknown as Array<{
    minuteTs: number; swapCount: number; volQuote: string | null;
    openPrice: number | null; highPrice: number | null; lowPrice: number | null;
    closePrice: number | null; sourceThroughBlock: number | null;
  }>;
  if (rows.length < 60) return false; // an hour with missing buckets is not an hour
  const vol = rows.reduce((a, r) => a + (r.volQuote !== null ? BigInt(r.volQuote) : 0n), 0n);
  const opens = rows.filter((r) => r.openPrice !== null);
  const ohlc = opens.length
    ? [
        opens[0].openPrice,
        Math.max(...rows.map((r) => r.highPrice ?? -Infinity)),
        Math.min(...rows.map((r) => r.lowPrice ?? Infinity)),
        opens[opens.length - 1].closePrice,
      ]
    : null;
  upsertHistoryQ.run(
    pool.canonicalId, hourStart, pool.venue,
    nowSecond(), pool.quoteToken ? vol.toString() : null, null,
    ohlc !== null ? JSON.stringify(ohlc) : null,
    'complete', rows[rows.length - 1].sourceThroughBlock ?? null, AGGREGATE_VERSION,
  );
  return true;
}

/**
 * One aggregation pass: date blocks within budget, then per tracked pool
 * aggregate newly closed minutes and roll up the last closed hour.
 */
export async function runEmergingAggregateSweep(): Promise<{
  datedBlocks: number; minutes: number; hours: number; pools: number;
}> {
  const datedBlocks = await dateEmergingBlocks();
  const completeThrough = (streamCompleteQ.get(CHAIN.id) as { t: number | null } | null)?.t ?? null;
  const pools = trackedPoolsQ.all() as unknown as TrackedPool[];
  let minutes = 0;
  let hours = 0;
  for (const pool of pools) {
    if (pool.venue === 'univ4') continue; // shapes unproven → unsupported, not zeros
    // The quote series exists only where the ledger proved a USDG pair; the
    // snapshot type's quoteToken is that proven series, never a convention.
    pool.quoteToken = provenQuoteUsdg(pool) ? USDG : null;
    const r = aggregatePoolMinutes(pool, completeThrough, AGGREGATE_VERSION);
    minutes += r.written;
    if (rollUpHour(pool)) hours++;
  }
  if (minutes || datedBlocks)
    log(`[emerging-agg] dated ${datedBlocks} blocks, ${minutes} minute buckets, ${hours} hourly rollups over ${pools.length} pools`);
  return { datedBlocks, minutes, hours, pools: pools.length };
}
