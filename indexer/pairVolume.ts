// Pair-volume attribution — docs/VOLUME-TREND-PRD.zh-CN.md §5.1 FR-CALC-2/3/4
// and the data contract of GET /api/volume/pair (§5.2 FR-API-2).
//
// This module is the ASSEMBLY half of the volume-trend feature: it turns the
// rank cycle's already-fetched daily series (UP33 subgraph poolDayData, GT
// OHLCV) plus the v4 store rows into per-pair family snapshots — aligned 45-day
// volume series, share series, migration events, newcomer alerts, and the
// four-way diagnosis (migration / retreat / expansion-shift / both-rising).
// All judgment lives in volumeTrend.ts's pure functions; nothing here decides
// a threshold. v2 venues are deliberately out (PRD decision 2): they are not
// grouped, not summed, and the retreat diagnosis carries the blind-spot caveat.
//
// Runs inside the 12h pool-rank cycle, off the request path; the API serves
// the kv string verbatim.
import { log } from './config';
import { ADDR } from '../src/config/addresses';
import { db, kvGet, kvSet, snapshotRawVolumes } from './store';
import {
  classifyVolumeTrend,
  dailyFromSnapshotPairs,
  detectMigrationEvent,
  diagnosePair,
  pairShares,
  pairTotals,
  type PairDiagnosisKind,
  type TrendClass,
  type VolumeTrend,
} from './volumeTrend';

const DAY_SECONDS = 86_400;
const WINDOW_DAYS = 45;
/** Families kept in the kv snapshot — pairs nobody ranked are not analyzed.
 * Sized above the rank table's own row count plus the catalog-snapshot leg's
 * active-pool families (§7.2 differencing leg). */
const MAX_FAMILIES = 200;
/** A snapshot-derived member qualifies a family once it carries at least this
 * many daily buckets (fewer cannot support a classification) … */
const SNAPSHOT_MIN_DAYS = 5;
/** … and its latest day moved at least this much. */
const SNAPSHOT_MIN_LAST_DAY_USD = 10_000;
const NEWCOMER_AGE_DAYS = 14;
const NEWCOMER_SHARE_STEP = 0.05;
const NEWCOMER_MIN_DAY_USD = 1_000;
/** §9.3: an event detected within 48h of a Thursday flip may be vote-driven. */
const EPOCH_FLIP_PROXIMITY_DAYS = 2;
const kvSnapshot = 'pair_volume_snapshot';

export const pairKeyOf = (a: string, b: string): string =>
  a.toLowerCase() < b.toLowerCase() ? `${a.toLowerCase()}:${b.toLowerCase()}` : `${b.toLowerCase()}:${a.toLowerCase()}`;

const dayStartSec = (ts: number): number => Math.floor(ts / DAY_SECONDS) * DAY_SECONDS;
/** Graph day fields are unix seconds; tolerate a day-index integer just in case. */
const normalizeDay = (date: number): number => (date > 10_000_000_000 ? date : date > 10_000_000 ? dayStartSec(date) : date * DAY_SECONDS);

export type PairAlert = MigrationEventItem | NewcomerEventItem;

export type MigrationEventItem = {
  type: 'migration';
  fromPool: string;
  toPool: string;
  pair: string;
  venueFrom: MemberProto;
  venueTo: MemberProto;
  feeFromBps: number | null;
  feeToBps: number | null;
  fromShareStart: number;
  fromShareEnd: number;
  toShareStart: number;
  toShareEnd: number;
  windowDays: number;
  magnitudeUsd: number;
  nearEpochFlip: boolean;
  detectedAt: number;
};

export type NewcomerEventItem = {
  type: 'newcomer';
  pool: string;
  pair: string;
  shareGainPpDay: number;
  ageDays: number;
  volLastDayUsd: number;
  detectedAt: number;
};

export type MemberProto = 'up33-cl' | 'univ3' | 'univ4';

export type PairVolumeMember = {
  identity: string;
  proto: MemberProto;
  feeBps: number | null;
  tickSpacing: number | null;
  tvlUsd: number | null;
  gaugeAlive: boolean;
  /** aligned to `days`, oldest→newest; null = no priced figure that day */
  dailyVol: (number | null)[];
  share: (number | null)[];
  trend: VolumeTrend;
  ageDaysLowerBound: number;
  isNewcomer: boolean;
  /** priced-day fraction — v4 without token prices degrades here (PRD §9.6) */
  usdCoverage: number;
};

export type PairVolumePayload = {
  pairKey: string;
  token0: string;
  token1: string;
  symbol0: string;
  symbol1: string;
  /** 45 full UTC day starts (seconds), oldest→newest — today is never included */
  days: number[];
  pairTotal: (number | null)[];
  pools: PairVolumeMember[];
  diagnosis: { kind: PairDiagnosisKind; caveats: string[] };
  /** L3 token heat (PRD FR-CALC-5): the token's whole-book trend class */
  tokenHeat: { token0: TrendClass; token1: TrendClass };
  events: MigrationEventItem[];
  newcomer: NewcomerEventItem | null;
};

export type PairVolumeSnapshot = {
  generatedAt: number;
  windowDays: number;
  pairs: Record<string, PairVolumePayload>;
  byPool: Record<string, string>;
};

// ── structural inputs (kept decoupled from poolRank's own types) ───────────

export type SubgraphPoolLite = {
  id: string;
  tickSpacing: number;
  totalValueLockedUSD: string;
  token0: { id: string; symbol: string };
  token1: { id: string; symbol: string };
  poolDayData: { date: number; volumeUSD: string; txCount: string }[];
};

export type Up33OnchainLite = {
  feePpm: number | null;
  rewardRateWeiPerSec: bigint | null;
};

export type Univ3CandidateLite = {
  name: string;
  address: string;
  tvlUsd: number;
  token0: string | null;
  token1: string | null;
};

type MemberSeed = {
  identity: string;
  proto: MemberProto;
  name: string;
  feeBps: number | null;
  tickSpacing: number | null;
  tvlUsd: number | null;
  gaugeAlive: boolean;
  /** day-start seconds → full-day USD volume */
  series: Map<number, number>;
  ageDays: number;
};

type FamilySeed = {
  pairKey: string;
  token0: string;
  token1: string;
  symbol0: string;
  symbol1: string;
  members: MemberSeed[];
};

/** Symbols from a GT pool name like "WETH / FOO (0.3%)" — best effort. */
const symbolsFromGtName = (name: string): [string, string] => {
  const head = name.split('(')[0] ?? name;
  const parts = head.split('/').map((s) => s.trim()).filter(Boolean);
  return [parts[0] ?? '?', parts[1] ?? '?'];
};

const feeBpsFromGtName = (name: string): number | null => {
  const m = name.match(/([\d.]+)%/);
  const v = m ? Number(m[1]) * 100 : NaN;
  return Number.isFinite(v) ? v : null;
};

/** Thursday 00:00 UTC — the ve(3,3) epoch flip (docs §3). */
export function nearEpochFlip(nowSec: number): boolean {
  const dow = new Date(nowSec * 1000).getUTCDay();
  const daysSinceFlip = (dow - 4 + 7) % 7;
  const prevFlip = dayStartSec(nowSec) - daysSinceFlip * DAY_SECONDS;
  const nextFlip = prevFlip + 7 * DAY_SECONDS;
  const distance = Math.min(nowSec - prevFlip, nextFlip - nowSec);
  return distance < EPOCH_FLIP_PROXIMITY_DAYS * DAY_SECONDS;
}

/** The v4 singleton keys native value as address(0); pairs group by WNATIVE. */
const canonicalCurrency = (currency: string): string => {
  const c = currency.toLowerCase();
  return c === '0x0000000000000000000000000000000000000000' ? ADDR.WNATIVE.toLowerCase() : c;
};

// ── v4 store reads (own try/catch: a v4 hiccup must not kill the snapshot) ──

type V4MemberRow = { pool_id: string; currency0: string; currency1: string; key_fee_ppm: number | null; tick_spacing: number };

function v4MembersForKeys(keys: ReadonlySet<string>): V4MemberRow[] {
  const out: V4MemberRow[] = [];
  const q = db.prepare('SELECT pool_id, currency0, currency1, key_fee_ppm, tick_spacing FROM v4_pools WHERE currency0=? AND currency1=?');
  for (const key of keys) {
    const [a, b] = key.split(':');
    for (const row of q.all(a, b) as V4MemberRow[]) out.push(row);
    for (const row of q.all(b, a) as V4MemberRow[]) out.push(row);
  }
  return out;
}

const pairKeyFromCurrencies = (c0: string, c1: string): string => pairKeyOf(canonicalCurrency(c0), canonicalCurrency(c1));

/**
 * Build the kv-served pair snapshot. Fail-soft by design: any v4 read error
 * logs and continues without v4 members; a thrown error here would kill the
 * whole rank cycle for data the rank table itself does not need.
 */
export function buildPairVolumeSnapshot(input: {
  subgraphPools: readonly SubgraphPoolLite[];
  onchain: ReadonlyMap<string, { feePpm: number | null; rewardRateWeiPerSec: bigint | null }>;
  univ3Candidates: readonly Univ3CandidateLite[];
  univ3Candles: ReadonlyMap<string, readonly { ts: number; vol: number }[]>;
  rankedIdentities: ReadonlySet<string>;
  nowTs: number;
}): PairVolumeSnapshot {
  const today = dayStartSec(input.nowTs);
  const days: number[] = [];
  for (let i = WINDOW_DAYS; i >= 1; i--) days.push(today - i * DAY_SECONDS);
  const dayIdx = new Map(days.map((d, i) => [d, i]));
  const fullDay = (ts: number): number | null => {
    const d = dayStartSec(normalizeDay(ts));
    return d < today ? (dayIdx.get(d) ?? null) : null;
  };

  const families = new Map<string, FamilySeed>();
  /** L3 accumulation: every seeded member's volume, per token, per day. */
  const tokenVolume = new Map<string, Map<number, number>>();
  const addTokenVolume = (token: string, series: Map<number, number>): void => {
    const key = token.toLowerCase();
    let acc = tokenVolume.get(key);
    if (!acc) {
      acc = new Map();
      tokenVolume.set(key, acc);
    }
    for (const [day, vol] of series) acc.set(day, (acc.get(day) ?? 0) + vol);
  };
  const familyFor = (t0: string, t1: string, s0: string, s1: string): FamilySeed => {
    const key = pairKeyOf(t0, t1);
    let f = families.get(key);
    if (!f) {
      f = { pairKey: key, token0: t0.toLowerCase(), token1: t1.toLowerCase(), symbol0: s0, symbol1: s1, members: [] };
      families.set(key, f);
    }
    return f;
  };

  // UP33 CL members — the subgraph top-100 covers most family depth on this venue.
  for (const pool of input.subgraphPools) {
    const oc = input.onchain.get(pool.id.toLowerCase());
    const series = new Map<number, number>();
    for (const day of pool.poolDayData) {
      const idx = fullDay(day.date);
      const vol = Number(day.volumeUSD);
      if (idx !== null && Number.isFinite(vol) && vol > 0) series.set(days[idx], vol);
    }
    addTokenVolume(pool.token0.id, series);
    addTokenVolume(pool.token1.id, series);
    familyFor(pool.token0.id, pool.token1.id, pool.token0.symbol, pool.token1.symbol).members.push({
      identity: pool.id.toLowerCase(),
      proto: 'up33-cl',
      name: `${pool.token0.symbol}/${pool.token1.symbol}`,
      feeBps: oc?.feePpm != null ? oc.feePpm / 100 : null,
      tickSpacing: pool.tickSpacing,
      tvlUsd: Number(pool.totalValueLockedUSD) || null,
      gaugeAlive: oc?.rewardRateWeiPerSec != null,
      series,
      ageDays: Math.max(0, pool.poolDayData.length - 1),
    });
  }

  // Official Uniswap v3 members — the rank's own 12 candidates, candles reused.
  for (const candidate of input.univ3Candidates) {
    if (!candidate.token0 || !candidate.token1) continue;
    const candles = input.univ3Candles.get(candidate.address.toLowerCase());
    if (!candles?.length) continue;
    const series = new Map<number, number>();
    for (const candle of candles) {
      const idx = fullDay(candle.ts);
      if (idx !== null && candle.vol > 0) series.set(days[idx], candle.vol);
    }
    const [s0, s1] = symbolsFromGtName(candidate.name);
    addTokenVolume(candidate.token0, series);
    addTokenVolume(candidate.token1, series);
    familyFor(candidate.token0, candidate.token1, s0, s1).members.push({
      identity: candidate.address.toLowerCase(),
      proto: 'univ3',
      name: candidate.name,
      feeBps: feeBpsFromGtName(candidate.name),
      tickSpacing: null,
      tvlUsd: candidate.tvlUsd,
      gaugeAlive: false,
      series,
      ageDays: series.size,
    });
  }

  // v4 members for the KEPT families only — never a whole-directory sweep.
  try {
    const keptCandidates = new Set<string>();
    for (const f of families.values())
      if (f.members.some((m) => input.rankedIdentities.has(m.identity))) keptCandidates.add(f.pairKey);
    if (keptCandidates.size) {
      const v4Rows = v4MembersForKeys(keptCandidates);
      const priceQ = db.prepare('SELECT symbol, price_usd FROM tokens WHERE address=?');
      const daysQ = db.prepare('SELECT date, volume0, volume1 FROM v4_pool_days WHERE pool_id=?');
      const tvlQ = db.prepare('SELECT COALESCE(tvl_usd, liq_usd) AS tvl FROM v4_market_stats WHERE pool_id=?');
      for (const row of v4Rows) {
        const key = pairKeyFromCurrencies(row.currency0, row.currency1);
        const family = families.get(key);
        if (!family) continue;
        const p0 = (priceQ.get(row.currency0.toLowerCase()) as { symbol: string; price_usd: number | null } | undefined) ?? null;
        const p1 = (priceQ.get(row.currency1.toLowerCase()) as { symbol: string; price_usd: number | null } | undefined) ?? null;
        const series = new Map<number, number>();
        let pricedDays = 0;
        for (const day of daysQ.all(row.pool_id) as { date: number; volume0: number | null; volume1: number | null }[]) {
          const idx = fullDay(day.date);
          if (idx === null) continue;
          // A swap values both sides equally; average the priced sides rather
          // than summing (that would double-count the flow — PRD FR-CALC-2).
          const legs: number[] = [];
          if (p0?.price_usd != null && day.volume0 != null) legs.push(day.volume0 * p0.price_usd);
          if (p1?.price_usd != null && day.volume1 != null) legs.push(day.volume1 * p1.price_usd);
          if (!legs.length) continue;
          pricedDays++;
          const vol = legs.reduce((a, b) => a + b, 0) / legs.length;
          if (vol > 0) series.set(days[idx], vol);
        }
        const tvl = (tvlQ.get(row.pool_id) as { tvl: number | null } | undefined)?.tvl ?? null;
        family.members.push({
          identity: row.pool_id.toLowerCase(),
          proto: 'univ4',
          name: `${p0?.symbol ?? '?'}${p1?.symbol ?? '?'} v4 ts${row.tick_spacing}`,
          feeBps: row.key_fee_ppm != null ? row.key_fee_ppm / 100 : null,
          tickSpacing: row.tick_spacing,
          tvlUsd: tvl,
          gaugeAlive: false,
          series,
          ageDays: pricedDays,
        });
      }
    }
  } catch (e) {
    log(`[pair-volume] v4 leg skipped: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Third leg — the pools-page universe from OWN 5-min snapshots (PRD §7.2
  // differencing). GT's volume ranking and the catalog's TVL ranking are two
  // different universes, so the most-watched univ3 pools never made the
  // candidate set; their daily series live in pool_market_snapshots, and
  // midnight-boundary differencing turns those into independent day buckets.
  try {
    const seeded = new Set<string>();
    for (const f of families.values()) for (const m of f.members) seeded.add(m.identity);
    const rows = db.prepare(`SELECT p.address, p.token0, p.token1, p.fee_ppm, p.tick_spacing,
        COALESCE(s.tvl_usd, st.liq_usd, 0) AS tvl, ta.symbol AS sym0, tb.symbol AS sym1
      FROM pools p
      LEFT JOIN pool_state s ON s.address = p.address
      LEFT JOIN pool_stats st ON st.address = p.address
      LEFT JOIN tokens ta ON ta.address = p.token0
      LEFT JOIN tokens tb ON tb.address = p.token1
      WHERE p.proto IN ('univ3','pancakev3') AND COALESCE(s.tvl_usd, st.liq_usd, 0) >= 10000
      ORDER BY COALESCE(s.tvl_usd, st.liq_usd) DESC LIMIT 150`).all() as {
      address: string; token0: string; token1: string; fee_ppm: number; tick_spacing: number | null;
      tvl: number; sym0: string | null; sym1: string | null;
    }[];
    for (const row of rows) {
      const identity = row.address.toLowerCase();
      if (seeded.has(identity)) continue;
      const raw = snapshotRawVolumes(identity, input.nowTs - (WINDOW_DAYS + 1) * DAY_SECONDS);
      const daily = dailyFromSnapshotPairs(raw);
      if (daily.length < SNAPSHOT_MIN_DAYS) continue;
      const series = new Map(daily.map((d) => [d.day, d.vol]));
      const family = familyFor(row.token0, row.token1, row.sym0 ?? '?', row.sym1 ?? '?');
      seeded.add(identity);
      addTokenVolume(row.token0, series);
      addTokenVolume(row.token1, series);
      family.members.push({
        identity,
        proto: 'univ3',
        name: `${row.sym0 ?? '?'}/${row.sym1 ?? '?'}`,
        feeBps: row.fee_ppm != null ? row.fee_ppm / 100 : null,
        tickSpacing: row.tick_spacing,
        tvlUsd: row.tvl || null,
        gaugeAlive: false,
        series,
        ageDays: series.size,
      });
    }
  } catch (e) {
    log(`[pair-volume] catalog-snapshot leg skipped: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Keep families a ranked pool belongs to, or that a snapshot-derived member
  // with real recent volume belongs to (the pools-page universe); cap by
  // latest pair volume. Single-member families are kept: "this pair has only
  // one monitored pool" is a real answer, and the retreat diagnosis still
  // reads through the pair total (events simply cannot fire —
  // detectMigrationEvent needs two).
  const kept = [...families.values()]
    .filter((f) => f.members.some((m) =>
      input.rankedIdentities.has(m.identity)
      || (m.series.size >= SNAPSHOT_MIN_DAYS && ([...m.series.values()].at(-1) ?? 0) >= SNAPSHOT_MIN_LAST_DAY_USD)
    ))
    .map((f) => ({ f, last: Math.max(0, ...f.members.map((m) => [...m.series.values()].at(-1) ?? 0)) }))
    .sort((a, b) => b.last - a.last)
    .slice(0, MAX_FAMILIES);

  const flipNear = nearEpochFlip(input.nowTs);
  const pairs: Record<string, PairVolumePayload> = {};
  const byPool: Record<string, string> = {};
  const allMigrations: MigrationEventItem[] = [];

  for (const { f } of kept) {
    const aligned = f.members.map((m) => days.map((d) => m.series.get(d) ?? null));
    const totals = pairTotals(aligned);
    const shares = pairShares(aligned);
    const members: PairVolumeMember[] = f.members.map((m, i) => {
      const trend = classifyVolumeTrend({ dailyVol: aligned[i], ageDaysLowerBound: m.ageDays, rankQualified: false });
      const lastShare = shares[i][days.length - 1];
      const prevShare = shares[i][days.length - 2];
      const volLastDay = aligned[i][days.length - 1];
      const isNewcomer =
        m.ageDays < NEWCOMER_AGE_DAYS &&
        lastShare !== null && prevShare !== null &&
        lastShare - prevShare >= NEWCOMER_SHARE_STEP &&
        volLastDay !== null && volLastDay >= NEWCOMER_MIN_DAY_USD;
      const priced = aligned[i].filter((v) => v !== null).length;
      return {
        identity: m.identity,
        proto: m.proto,
        feeBps: m.feeBps,
        tickSpacing: m.tickSpacing,
        tvlUsd: m.tvlUsd,
        gaugeAlive: m.gaugeAlive,
        dailyVol: aligned[i],
        share: shares[i],
        trend,
        ageDaysLowerBound: m.ageDays,
        isNewcomer,
        usdCoverage: Math.round((priced / days.length) * 100) / 100,
      };
    });

    // Diagnosis: focus on the pool that lost the most share over the window —
    // the "what happened to THIS pair" story the panel's headline tells.
    const wStart = days.length - 7;
    let focusIdx = -1;
    let focusLoss = 0;
    let bestPeerGain = 0;
    const shareAt = (i: number, idx: number): number | null => {
      const v = shares[i][idx];
      return v != null && Number.isFinite(v) ? v : null;
    };
    for (let i = 0; i < members.length; i++) {
      const s = shareAt(i, wStart);
      const e = shareAt(i, days.length - 1);
      if (s === null || e === null) continue;
      if (s - e > focusLoss) {
        focusLoss = s - e;
        focusIdx = i;
      }
    }
    if (focusIdx < 0) {
      // No pool lost share — the retreat / both-rising story, where the
      // dominant pool's flat share IS the signal. Focus it.
      let bestStart = -1;
      for (let i = 0; i < members.length; i++) {
        const s = shareAt(i, wStart);
        if (s !== null && s > bestStart) {
          bestStart = s;
          focusIdx = i;
        }
      }
    }
    if (focusIdx >= 0) {
      for (let i = 0; i < members.length; i++) {
        if (i === focusIdx) continue;
        const s = shareAt(i, wStart);
        const e = shareAt(i, days.length - 1);
        if (s !== null && e !== null) bestPeerGain = Math.max(bestPeerGain, e - s);
      }
    }
    const focusStart = focusIdx >= 0 ? shareAt(focusIdx, wStart) : null;
    const focusEnd = focusIdx >= 0 ? shareAt(focusIdx, days.length - 1) : null;
    let totalStart: number | null = totals[wStart];
    let totalEnd: number | null = totals[days.length - 1];
    if (totalStart != null && !(totalStart > 0)) totalStart = null;
    if (totalEnd != null && !(totalEnd > 0)) totalEnd = null;
    const diagnosis = diagnosePair({
      pairTotalStart: totalStart,
      pairTotalEnd: totalEnd,
      focusShareStart: focusStart,
      focusShareEnd: focusEnd,
      bestPeerShareGain: bestPeerGain,
    });
    // §9.4: v2 venues are not monitored, so "the pair retreated" can never
    // rule out the flow hiding in a v2 pool — the caveat is mandatory.
    const caveats = diagnosis.kind === 'retreat' ? ['v2_not_monitored'] : [];
    // L3 token heat: is the token itself fading, or just this pair? (FR-CALC-5)
    const tokenHeatOf = (token: string): TrendClass => {
      const acc = tokenVolume.get(token.toLowerCase());
      if (!acc) return 'unknown';
      return classifyVolumeTrend({ dailyVol: days.map((d) => acc.get(d) ?? null), ageDaysLowerBound: days.length, rankQualified: false }).class;
    };

    const event = detectMigrationEvent({ pairTotal: totals, shares: Object.fromEntries(f.members.map((m, i) => [m.identity, shares[i]])), now: input.nowTs });
    const events: MigrationEventItem[] = [];
    if (event) {
      const from = f.members.find((m) => m.identity === event.fromPool);
      const to = f.members.find((m) => m.identity === event.toPool);
      if (from && to) {
        const item: MigrationEventItem = {
          type: 'migration',
          fromPool: event.fromPool,
          toPool: event.toPool,
          pair: `${f.symbol0}/${f.symbol1}`,
          venueFrom: from.proto,
          venueTo: to.proto,
          feeFromBps: from.feeBps,
          feeToBps: to.feeBps,
          fromShareStart: event.fromShareStart,
          fromShareEnd: event.fromShareEnd,
          toShareStart: event.toShareStart,
          toShareEnd: event.toShareEnd,
          windowDays: event.windowDays,
          magnitudeUsd: event.magnitudeUsd,
          nearEpochFlip: flipNear,
          detectedAt: input.nowTs,
        };
        events.push(item);
        allMigrations.push(item);
      }
    }

    const newcomerMember = members.find((m) => m.isNewcomer) ?? null;
    const newcomer: NewcomerEventItem | null = newcomerMember
      ? {
          type: 'newcomer',
          pool: newcomerMember.identity,
          pair: `${f.symbol0}/${f.symbol1}`,
          shareGainPpDay: Math.round(((newcomerMember.share[days.length - 1] ?? 0) - (newcomerMember.share[days.length - 2] ?? 0)) * 10000) / 100,
          ageDays: newcomerMember.ageDaysLowerBound,
          volLastDayUsd: newcomerMember.dailyVol[days.length - 1] ?? 0,
          detectedAt: input.nowTs,
        }
      : null;

    for (const m of members) byPool[m.identity] = f.pairKey;
    pairs[f.pairKey] = {
      pairKey: f.pairKey,
      token0: f.token0,
      token1: f.token1,
      symbol0: f.symbol0,
      symbol1: f.symbol1,
      days,
      pairTotal: totals,
      pools: members,
      diagnosis: { kind: diagnosis.kind, caveats },
      tokenHeat: { token0: tokenHeatOf(f.token0), token1: tokenHeatOf(f.token1) },
      events,
      newcomer,
    };
  }

  return {
    generatedAt: input.nowTs,
    windowDays: WINDOW_DAYS,
    pairs,
    byPool,
  };
}

// ── kv persistence + API read ──────────────────────────────────────────────

export function storePairVolumeSnapshot(snapshot: PairVolumeSnapshot): void {
  kvSet(kvSnapshot, JSON.stringify(snapshot));
}

export type PairVolumeApi =
  | ({ ready: true } & PairVolumePayload)
  | { ready: false; reason: 'pool_not_grouped' | 'not_ready' };

/**
 * Route read: an exact pool identity routes through byPool; a token PAIR
 * (token0/token1 params, order-insensitive) routes through the pair key —
 * the fallback that lets a position on an unmonitored pool of a MONITORED
 * pair still see its family's volume (launchpad tokens sprout dozens of
 * sibling pools; only the deepest get ranked).
 */
export function getPairVolumeApi(params: { pool?: string; token0?: string; token1?: string }): PairVolumeApi {
  const raw = kvGet(kvSnapshot);
  if (!raw) return { ready: false, reason: 'not_ready' };
  let snapshot: PairVolumeSnapshot;
  try {
    snapshot = JSON.parse(raw) as PairVolumeSnapshot;
  } catch {
    return { ready: false, reason: 'not_ready' };
  }
  const key = params.pool
    ? snapshot.byPool?.[params.pool.toLowerCase()]
    : params.token0 && params.token1
      ? pairKeyOf(params.token0, params.token1)
      : undefined;
  const payload = key ? snapshot.pairs?.[key] : undefined;
  if (!key || !payload) return { ready: false, reason: 'pool_not_grouped' };
  return { ready: true, ...payload };
}
