// LP pool ranking — a reference table for LP capital allocation, refreshed on
// a fixed half-day cadence (TUNE.poolRankMs) and served from kv, so a restart
// keeps answering with the last good table instead of nothing.
//
// Data sources, one per question:
//   UP33 Slipstream subgraph — per-pool day history (volume, sqrtPrice) and
//     current TVL for the home CL venues. GT does not list UP33.
//   On-chain multicall — the DYNAMIC fee tier, the unstaked levy, the staked
//     share and the post-cap gauge rewardRate. The subgraph's feesUSD is
//     tier-implied and therefore wrong whenever the SwapFeeModule overrides a
//     pool (WETH/UP has traded at 125bps against a nominal 2%); only
//     volume × actual fee() is trustworthy. docs/up33-contract-map.md §6.6.
//   GeckoTerminal — official Uniswap v3 listings (GT has no up33 dex entry)
//     and daily OHLCV. OHLCV is pulled twice per pool: `currency=usd` gives
//     USD volume, `currency=token` gives the pool's own exchange rate, which
//     is what volatility must be measured on (a USD close series measures the
//     base token against the dollar, not the market the LP sits in).
//
// Metrics:
//   feeApr    gross annualized fee APR = 7d-mean volume × on-chain fee × 365 / TVL.
//   netFeeApr the unstaked take on UP33: feeApr × (1 − unstakedFee). Staking
//             forgoes ALL fees to voters, so feeApr and emitApr are
//             alternatives, never additive.
//   sigma     daily log-return stdev of the pool's exchange rate (subgraph
//             sqrtPrice for UP33, token-currency OHLCV closes for v3).
//   coverage  feeApr ÷ (sigmaAnnual²/8) — the loss-versus-rebalancing floor.
//             Concentrating multiplies fee capture and LVR by the same factor,
//             so the ratio is a property of the POOL, not of the position:
//             below 1 a passive in-range LP cannot beat a hedged rebalancer
//             before costs, no matter how the range is shaped.
//   emitApr   staked-side emissions at the post-cap gauge rewardRate, priced
//             in UP at the GT mark. Parameters change every epoch (weights,
//             cap mode, weekly emission), so this is the snapshot's value,
//             not a promise.
//
// Robinhood-only for now: every source above is pinned to this chain's
// deployment. Other chains need their own sources before the flag can open.
import { CHAIN, GT, log, now, sleep, TUNE } from './config';
import { clGaugeAbi, clPoolAbi, voterAbi } from '../src/abi';
import { mc, ok, safeError, type Call } from './rpc';
import { kvGet, kvSet } from './store';
import { classifyVolumeTrend, type VolumeTrend } from './volumeTrend';
import { buildPairVolumeSnapshot, storePairVolumeSnapshot, type MigrationEventItem } from './pairVolume';

export const POOL_RANK_ENABLED = CHAIN.key === 'robinhood';

const UP33_CL_SUBGRAPH =
  'https://api.goldsky.com/api/public/project_cmhef02640198x7p2cz2w70u8/subgraphs/up-robinhood-v3-mainnet/0.1.1/gn';
/** Annualization basis and the LVR benchmark denominator (loss-vs-rebalancing ≈ σ²/8). */
const YEAR_DAYS = 365;
const SECONDS_PER_YEAR = 31_536_000;
/** Pools below this much 7d fee volume are dust to an LP, whatever the ratios say. */
const MIN_FEE_VOLUME_7D_USD = 50;
/** V3 candidate cap: each pool costs two paced GT OHLCV calls per cycle.
 * 30 (GT volume top-30, two listing pages) covers the pools page's active
 * univ3 rows — the token-pair attribution fallback inherits every candidate's
 * daily series, so this number is the coverage knob for the whole feature. */
const UNIV3_CANDIDATES = 30;
/** GT listing pages pulled for the candidate set (20 pools per page). */
const UNIV3_LIST_PAGES = 2;
/** Daily sigma at or above this is data corruption (a pulled pool re-anchoring), not a market. */
const MAX_PLAUSIBLE_DAILY_SIGMA = 1.0;
/** OHLCV history kept per request; ≥8 closes are required for a sigma estimate. */
const OHLCV_DAYS = 45;
/** Minimum spacing between GT calls. stats.ts paces at TUNE.gtPaceMs for small
 * JSON listings; OHLCV responses are heavier and GT enforces its burst window
 * aggressively, so the ranking pays a wider gap plus one long-backoff retry. */
const OHLCV_PACE_MS = 10_000;
const OHLCV_RETRY_BACKOFF_MS = 36_000;
const kv = {
  snapshot: 'pool_rank_snapshot',
  running: 'pool_rank_running',
  error: 'pool_rank_error',
  errorAt: 'pool_rank_error_at',
  successAt: 'pool_rank_success_at',
  cache: (key: string) => `pool_rank_gt_cache:${key}`,
};

export type PoolRankVenue = 'up33-cl' | 'univ3';

/** A pool too young for the rank's σ/coverage gates but with real volume —
 * surfaced with its trend badge only, never entry semantics (PRD §9.1). */
export type EmergingRow = {
  venue: PoolRankVenue;
  pool: string;
  address: string;
  feeBps: number;
  tickSpacing: number | null;
  tvlUsd: number;
  volDayUsd: number;
  trend: VolumeTrend;
};

export type PoolRankRow = {
  venue: PoolRankVenue;
  pool: string;
  address: string;
  feeBps: number;
  tickSpacing: number | null;
  tvlUsd: number;
  volDayUsd: number;
  feeApr: number;
  netFeeApr: number;
  sigmaDaily: number;
  sigmaAnnual: number;
  coverage: number;
  stakedShare: number | null;
  emitApr: number | null;
  volumePersistence: number;
  daysActive: number;
  /** volume-trend classification — docs/VOLUME-TREND-PRD.zh-CN.md §5.1 */
  trend: VolumeTrend;
};

export type PoolRankSnapshot = {
  generatedAt: number;
  durationMs: number;
  windowDays: number;
  upPriceUsd: number | null;
  rows: PoolRankRow[];
  dropped: { pool: string; reason: string }[];
  /** young pools below the σ gate, trend-badged only (PRD §9.1) */
  emerging: EmergingRow[];
  /** pair-level migration events, freshest magnitude first (§ FR-CALC-3) */
  migrationEvents: MigrationEventItem[];
};

// ── pure metric math (unit-tested) ─────────────────────────────────────────

export function dailyLogReturns(closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const curr = closes[i];
    if (prev > 0 && curr > 0 && Number.isFinite(prev) && Number.isFinite(curr)) {
      out.push(Math.log(curr / prev));
    }
  }
  return out;
}

/** Sample stdev of daily log returns; null when the history is too short. */
export function dailySigma(closes: readonly number[]): number | null {
  const rets = dailyLogReturns(closes);
  if (rets.length < 7) return null;
  const mean = rets.reduce((sum, r) => sum + r, 0) / rets.length;
  const variance = rets.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (rets.length - 1);
  const sigma = Math.sqrt(variance);
  return Number.isFinite(sigma) && sigma > 0 ? sigma : null;
}

export const annualizeSigma = (sigmaDaily: number): number => sigmaDaily * Math.sqrt(YEAR_DAYS);

/** The hedged-rebalancer coverage multiple; null when sigma is degenerate. */
export function coverageOf(feeApr: number, sigmaDaily: number): number | null {
  if (!(sigmaDaily > 0) || !Number.isFinite(sigmaDaily)) return null;
  const sigmaAnnual = annualizeSigma(sigmaDaily);
  return feeApr / ((sigmaAnnual * sigmaAnnual) / 8);
}

/** Recent-week share of lifetime daily volume: >1 accelerating, <0.5 fading. */
export function volumePersistence(last7DailyAvg: number, lifetimeDailyAvg: number): number {
  if (!(lifetimeDailyAvg > 0)) return 0;
  return last7DailyAvg / lifetimeDailyAvg;
}

/** Day-level trend helpers (PRD §7.2): only INDEPENDENT full-day buckets may
 * reach classifyVolumeTrend — a rolling-window snapshot never does. */
const DAY_SECONDS = 86_400;
const dayStartSec = (ts: number): number => Math.floor(ts / DAY_SECONDS) * DAY_SECONDS;
const todayStartSec = (): number => dayStartSec(now());

/**
 * Independent full-day volumes, oldest→newest. Entries dated in the CURRENT
 * UTC day are the in-progress bucket and are stripped before classification —
 * a half-filled day would read as a collapse to every ratio here.
 */
function fullDayDailyVol(entries: readonly { ts: number; vol: number }[], limit = 14): { vol: (number | null)[]; days: number } {
  const today = todayStartSec();
  const full = entries.filter((e) => dayStartSec(e.ts) < today);
  const window = full.slice(-limit);
  return { vol: window.map((e) => (Number.isFinite(e.vol) && e.vol > 0 ? e.vol : null)), days: full.length };
}

// ── GeckoTerminal access (paced, kv-cached, stale-on-failure) ──────────────

let lastGtCall = 0;

type GtCandle = [timestamp: number, open: number, high: number, low: number, close: number, volume: number];

async function gtFetch(path: string, cacheKey: string): Promise<unknown | null> {
  const wait = lastGtCall + OHLCV_PACE_MS - Date.now();
  if (wait > 0) await sleep(wait);
  for (let attempt = 0; attempt < 2; attempt++) {
    lastGtCall = Date.now();
    try {
      const r = await fetch(`${GT}${path}`, {
        headers: { accept: 'application/json', 'user-agent': 'up33-lp-indexer/0.1 (pool-rank)' },
      });
      if (r.status === 429) throw new Error(`gt rate limited (${r.status})`);
      if (!r.ok) throw new Error(`gt ${r.status}`);
      const body = (await r.json()) as unknown;
      kvSet(kv.cache(cacheKey), JSON.stringify({ at: now(), body }));
      return body;
    } catch (e) {
      log(`[pool-rank] ${cacheKey}: ${safeError(e)}`);
      if (attempt === 0) await sleep(OHLCV_RETRY_BACKOFF_MS);
    }
  }
  // Both attempts failed: last good cached body beats a hole in the table.
  const cached = kvGet(kv.cache(cacheKey));
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as { at: number; body: unknown };
      log(`[pool-rank] ${cacheKey}: serving cache from ${new Date(parsed.at * 1000).toISOString()}`);
      return parsed.body;
    } catch {
      return null;
    }
  }
  return null;
}

type GtPoolList = {
  data?: {
    id: string;
    attributes: { name?: string; reserve_in_usd?: string; volume_usd?: { h24?: string } };
    relationships?: {
      token0?: { data?: { id?: string } };
      token1?: { data?: { id?: string } };
      base_token?: { data?: { id?: string } };
      quote_token?: { data?: { id?: string } };
    };
  }[];
};

/** GT relationship ids: some listings use "/networks/<net>/tokens/0x…",
 * this chain's dex listing uses "robinhood_0x…" — the trailing segment is
 * the address the pair key needs either way. */
const addressFromRelation = (id: string | undefined): string | null => {
  const last = id?.split(/[/_]/).pop();
  return last && last.startsWith('0x') && last.length === 42 ? last.toLowerCase() : null;
};

/** token addresses off a GT pool entry. Listings name the sides
 * base_token/quote_token (this chain) or token0/token1 (others); a candidate
 * without BOTH addresses can still rank but cannot join a pair family. */
function gtPoolTokens(p: NonNullable<GtPoolList['data']>[number]): { token0: string | null; token1: string | null } {
  const rel = p.relationships ?? {};
  const token0 = addressFromRelation(rel.token0?.data?.id) ?? addressFromRelation(rel.base_token?.data?.id);
  const token1 = addressFromRelation(rel.token1?.data?.id) ?? addressFromRelation(rel.quote_token?.data?.id);
  return { token0, token1 };
}

type GtCandidate = { name: string; address: string; tvlUsd: number; volDayUsd: number; token0: string | null; token1: string | null };

async function gtUniv3TopPools(network: string, dex: string): Promise<GtCandidate[]> {
  const out: GtCandidate[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= UNIV3_LIST_PAGES; page++) {
    const body = (await gtFetch(`/networks/${network}/dexes/${dex}/pools?page=${page}&sort=h24_volume_usd_desc`, `v3list${page}`)) as GtPoolList | null;
    for (const p of body?.data ?? []) {
      const address = p.id?.replace(`${network}_`, '');
      const name = p.attributes?.name ?? '';
      const tvlUsd = Number(p.attributes?.reserve_in_usd ?? 0);
      const volDayUsd = Number(p.attributes?.volume_usd?.h24 ?? 0);
      if (!address || !name || !(tvlUsd > 0)) continue;
      const k = address.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      const tokens = gtPoolTokens(p);
      out.push({
        name,
        address,
        tvlUsd,
        volDayUsd,
        token0: tokens.token0,
        token1: tokens.token1,
      });
    }
  }
  out.sort((a, b) => b.volDayUsd - a.volDayUsd);
  return out.slice(0, UNIV3_CANDIDATES);
}

async function gtOhlcv(network: string, poolAddress: string, currency: 'usd' | 'token'): Promise<GtCandle[] | null> {
  const body = (await gtFetch(
    `/networks/${network}/pools/${poolAddress}/ohlcv/day?aggregate=1&limit=${OHLCV_DAYS}&currency=${currency}`,
    `ohlc-${currency}-${poolAddress}`,
  )) as { data?: { attributes?: { ohlcv_list?: GtCandle[] } } } | null;
  const list = body?.data?.attributes?.ohlcv_list;
  return Array.isArray(list) && list.length >= 8 ? [...list].reverse() : null;
}

async function gtTokenPriceUsd(network: string, address: string): Promise<number | null> {
  const body = (await gtFetch(`/networks/${network}/tokens/${address}`, `price-${address}`)) as {
    data?: { attributes?: { price_usd?: string } };
  } | null;
  const price = Number(body?.data?.attributes?.price_usd);
  return Number.isFinite(price) && price > 0 ? price : null;
}

// ── UP33 Slipstream leg ────────────────────────────────────────────────────

type SubgraphDay = { date: number; volumeUSD: string; sqrtPrice: string; txCount: string };

type SubgraphPool = {
  id: string;
  tickSpacing: number;
  totalValueLockedUSD: string;
  token0: { id: string; symbol: string };
  token1: { id: string; symbol: string };
  poolDayData: SubgraphDay[];
};

async function fetchUp33Subgraph(): Promise<SubgraphPool[]> {
  const query = `{
    pools(first: 100, orderBy: totalValueLockedUSD, orderDirection: desc) {
      id tickSpacing totalValueLockedUSD
      token0 { id symbol } token1 { id symbol }
      poolDayData(first: 40, orderBy: date, orderDirection: desc) {
        date volumeUSD sqrtPrice txCount
      }
    }
  }`;
  const res = await fetch(UP33_CL_SUBGRAPH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`up33 subgraph ${res.status}`);
  const json = (await res.json()) as { errors?: unknown[]; data?: { pools?: SubgraphPool[] } };
  if (json.errors?.length) throw new Error(`up33 subgraph errors: ${JSON.stringify(json.errors).slice(0, 200)}`);
  return json.data?.pools ?? [];
}

type Up33Onchain = {
  feePpm: number | null;
  unstakedFeePpm: number | null;
  liquidity: bigint;
  stakedLiquidity: bigint;
  rewardRateWeiPerSec: bigint | null;
};

async function fetchUp33Onchain(addresses: readonly string[]): Promise<Map<string, Up33Onchain>> {
  if (!CHAIN.gov) return new Map();
  const voter = CHAIN.gov.VOTER;
  const calls: Call[] = addresses.flatMap((address) => [
    { abi: clPoolAbi, address: address as `0x${string}`, functionName: 'fee' },
    { abi: clPoolAbi, address: address as `0x${string}`, functionName: 'unstakedFee' },
    { abi: clPoolAbi, address: address as `0x${string}`, functionName: 'liquidity' },
    { abi: clPoolAbi, address: address as `0x${string}`, functionName: 'stakedLiquidity' },
    { abi: voterAbi, address: voter, functionName: 'gauges', args: [address as `0x${string}`] },
  ]);
  const results = await mc(calls);
  const per: Up33Onchain[] = addresses.map((_, i) => {
    const [fee, unstakedFee, liquidity, stakedLiquidity] = results.slice(i * 5, i * 5 + 5);
    return {
      feePpm: ok<number>(fee) ?? null,
      unstakedFeePpm: ok<number>(unstakedFee) ?? null,
      liquidity: ok<bigint>(liquidity) ?? 0n,
      stakedLiquidity: ok<bigint>(stakedLiquidity) ?? 0n,
      rewardRateWeiPerSec: null,
    };
  });
  // Second pass: each discovered alive gauge's post-cap rewardRate — the cap
  // makes the nominal weekly emission × vote share a fiction (§6.6), while
  // rewardRate() is the enforced truth the gauge actually streams at.
  const gauged = per
    .map((p, i) => ({ p, gauge: ok<string>(results[i * 5 + 4]) }))
    .filter((row): row is { p: Up33Onchain; gauge: string } =>
      Boolean(row.gauge) && row.gauge !== '0x0000000000000000000000000000000000000000');
  if (gauged.length) {
    const rewardCalls: Call[] = gauged.flatMap(({ gauge }) => [
      { abi: voterAbi, address: voter, functionName: 'isAlive', args: [gauge as `0x${string}`] },
      { abi: clGaugeAbi, address: gauge as `0x${string}`, functionName: 'rewardRate' },
    ]);
    const rewardResults = await mc(rewardCalls);
    gauged.forEach(({ p }, i) => {
      const [alive, rateRes] = rewardResults.slice(i * 2, i * 2 + 2);
      const aliveFlag = ok<boolean>(alive);
      const rate = ok<bigint>(rateRes);
      p.rewardRateWeiPerSec = aliveFlag && rate !== undefined ? rate : null;
    });
  }
  return new Map(addresses.map((address, i) => [address.toLowerCase(), per[i]]));
}

export function up33Rows(pools: SubgraphPool[], onchain: Map<string, Up33Onchain>, upPriceUsd: number | null): { rows: PoolRankRow[]; dropped: { pool: string; reason: string }[]; emerging: EmergingRow[] } {
  const rows: PoolRankRow[] = [];
  const dropped: { pool: string; reason: string }[] = [];
  const emerging: EmergingRow[] = [];
  for (const pool of pools) {
    const name = `${pool.token0.symbol}/${pool.token1.symbol}`;
    const days = pool.poolDayData;
    const vol7 = days.slice(0, 7).reduce((sum, d) => sum + Number(d.volumeUSD), 0);
    if (vol7 / 7 < MIN_FEE_VOLUME_7D_USD) continue; // dust: not ranked, not "dropped"
    const oc = onchain.get(pool.id.toLowerCase());
    const feePpm = oc?.feePpm ?? null;
    const tvlUsd = Number(pool.totalValueLockedUSD);
    const closes = days.slice(0, 31).map((d) => Number(d.sqrtPrice)).reverse();
    const sigmaDaily = dailySigma(closes);
    const daysActive = days.filter((d) => BigInt(d.txCount || '0') > 0n).length;
    const volAll = days.reduce((sum, d) => sum + Number(d.volumeUSD), 0);
    const lifetimeAvg = volAll / Math.max(daysActive, 1);
    if (!oc || feePpm === null || !(tvlUsd > 0)) {
      dropped.push({ pool: name, reason: 'on-chain reads unavailable' });
      continue;
    }
    // Volume trend from INDEPENDENT full-day buckets: subgraph poolDayData is
    // newest-first and its first entry is the in-progress day, so it is
    // dropped before classification (PRD §7.2). The span of full days is the
    // age lower bound that routes hot young pools to new_hot.
    const daily = fullDayDailyVol([...days].reverse().map((d) => ({ ts: d.date, vol: Number(d.volumeUSD) })));
    const trend = classifyVolumeTrend({ dailyVol: daily.vol, ageDaysLowerBound: Math.max(0, days.length - 1), rankQualified: true });
    if (sigmaDaily === null) {
      // Young pool: no σ → no coverage → not rankable, but with real volume it
      // belongs in the emerging list with its trend badge (PRD §9.1).
      if (trend.class !== 'unknown')
        emerging.push({
          venue: 'up33-cl',
          pool: name,
          address: pool.id,
          feeBps: feePpm / 100,
          tickSpacing: pool.tickSpacing,
          tvlUsd,
          volDayUsd: vol7 / 7,
          trend,
        });
      dropped.push({ pool: name, reason: 'insufficient price history' });
      continue;
    }
    if (sigmaDaily >= MAX_PLAUSIBLE_DAILY_SIGMA) {
      dropped.push({ pool: name, reason: `corrupted price series (σ/d=${(sigmaDaily * 100).toFixed(0)}%)` });
      continue;
    }
    const liquidity = oc.liquidity;
    const stakedLiquidity = oc.stakedLiquidity;
    const stakedShare = liquidity > 0n ? Number(stakedLiquidity * 10_000n / liquidity) / 10_000 : null;
    const stakedTvl = liquidity > 0n ? tvlUsd * Number(stakedLiquidity) / Number(liquidity) : 0;
    const emitApr =
      upPriceUsd !== null && oc.rewardRateWeiPerSec !== null && stakedTvl > 0
        ? (Number(oc.rewardRateWeiPerSec) / 1e18) * SECONDS_PER_YEAR * upPriceUsd / stakedTvl
        : null;
    const feeApr = (vol7 / 7) * (feePpm / 1e6) * YEAR_DAYS / tvlUsd;
    const levy = oc.unstakedFeePpm === null ? 0.1 : oc.unstakedFeePpm / 1e6;
    const coverage = coverageOf(feeApr, sigmaDaily);
    if (coverage === null) {
      dropped.push({ pool: name, reason: 'degenerate sigma' });
      continue;
    }
    rows.push({
      venue: 'up33-cl',
      pool: name,
      address: pool.id,
      feeBps: feePpm / 100,
      tickSpacing: pool.tickSpacing,
      tvlUsd,
      volDayUsd: vol7 / 7,
      feeApr,
      netFeeApr: feeApr * (1 - levy),
      sigmaDaily,
      sigmaAnnual: annualizeSigma(sigmaDaily),
      coverage,
      stakedShare,
      emitApr,
      volumePersistence: volumePersistence(vol7 / 7, lifetimeAvg),
      daysActive,
      trend,
    });
  }
  return { rows, dropped, emerging };
}

// ── official Uniswap v3 leg ────────────────────────────────────────────────

async function univ3Rows(network: string, dex: string): Promise<{
  rows: PoolRankRow[];
  dropped: { pool: string; reason: string }[];
  emerging: EmergingRow[];
  candidates: GtCandidate[];
  candles: Map<string, GtCandle[]>;
}> {
  const rows: PoolRankRow[] = [];
  const dropped: { pool: string; reason: string }[] = [];
  const emerging: EmergingRow[] = [];
  const candles = new Map<string, GtCandle[]>();
  const candidates = await gtUniv3TopPools(network, dex);
  for (const candidate of candidates) {
    const feeMatch = candidate.name.match(/([\d.]+)%/);
    const feeBps = feeMatch ? Number(feeMatch[1]) * 100 : null;
    if (feeBps === null || !Number.isFinite(feeBps)) {
      dropped.push({ pool: candidate.name, reason: 'fee tier not parseable' });
      continue;
    }
    const [usdCandles, tokenCandles] = [await gtOhlcv(network, candidate.address, 'usd'), await gtOhlcv(network, candidate.address, 'token')];
    if (!usdCandles || !tokenCandles) {
      dropped.push({ pool: candidate.name, reason: 'OHLCV unavailable' });
      continue;
    }
    candles.set(candidate.address.toLowerCase(), usdCandles);
    const sigmaDaily = dailySigma(tokenCandles.map((c) => c[4]));
    // Same independent-buckets rule as the UP33 leg: GT's latest daily candle
    // for the running UTC day is partial and must not reach the classifier.
    const daily = fullDayDailyVol(usdCandles.map((c) => ({ ts: c[0], vol: c[5] })));
    if (sigmaDaily === null) {
      const trend = classifyVolumeTrend({ dailyVol: daily.vol, ageDaysLowerBound: daily.days, rankQualified: false });
      if (trend.class !== 'unknown')
        emerging.push({
          venue: 'univ3',
          pool: candidate.name,
          address: candidate.address,
          feeBps,
          tickSpacing: null,
          tvlUsd: candidate.tvlUsd,
          volDayUsd: candidate.volDayUsd,
          trend,
        });
      dropped.push({ pool: candidate.name, reason: 'insufficient price history' });
      continue;
    }
    if (sigmaDaily >= MAX_PLAUSIBLE_DAILY_SIGMA) {
      dropped.push({ pool: candidate.name, reason: `corrupted price series (σ/d=${(sigmaDaily * 100).toFixed(0)}%)` });
      continue;
    }
    const window = Math.min(7, usdCandles.length);
    const volDayUsd = usdCandles.slice(-window).reduce((sum, c) => sum + c[5], 0) / window;
    const lifetimeDaily = usdCandles.reduce((sum, c) => sum + c[5], 0) / usdCandles.length;
    const tvlUsd = candidate.tvlUsd;
    if (!(tvlUsd > 0) || !(volDayUsd > 0)) {
      dropped.push({ pool: candidate.name, reason: 'no measurable volume' });
      continue;
    }
    const feeApr = volDayUsd * (feeBps / 10_000) * YEAR_DAYS / tvlUsd;
    const coverage = coverageOf(feeApr, sigmaDaily);
    if (coverage === null) {
      dropped.push({ pool: candidate.name, reason: 'degenerate sigma' });
      continue;
    }
    rows.push({
      venue: 'univ3',
      pool: candidate.name,
      address: candidate.address,
      feeBps,
      tickSpacing: null,
      tvlUsd,
      volDayUsd,
      feeApr,
      netFeeApr: feeApr, // official v3 has no unstaked levy
      sigmaDaily,
      sigmaAnnual: annualizeSigma(sigmaDaily),
      coverage,
      stakedShare: null,
      emitApr: null,
      volumePersistence: volumePersistence(volDayUsd, lifetimeDaily),
      daysActive: usdCandles.length,
      trend: classifyVolumeTrend({ dailyVol: daily.vol, ageDaysLowerBound: daily.days, rankQualified: true }),
    });
  }
  return { rows, dropped, emerging, candidates, candles };
}

// ── cycle orchestration + kv snapshot ──────────────────────────────────────

const RUNNING_TTL_MS = 30 * 60_000;

export function getPoolRankSnapshot(): PoolRankSnapshot | null {
  const raw = kvGet(kv.snapshot);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PoolRankSnapshot;
    return Array.isArray(parsed?.rows) && Number.isFinite(parsed?.generatedAt) ? parsed : null;
  } catch {
    return null;
  }
}

export type PoolRankApi = {
  enabled: boolean;
  ready: boolean;
  generatedAt: number | null;
  ageSeconds: number | null;
  nextRefreshSeconds: number | null;
  rows: PoolRankRow[];
  emerging: EmergingRow[];
  dropped: { pool: string; reason: string }[];
  migrationEvents: MigrationEventItem[];
  upPriceUsd: number | null;
  windowDays: number;
};

/** Legacy kv snapshots (written before the trend fields shipped) may still be
 * served right after a deploy; rows without a trend read as explicit unknown
 * instead of crashing the badge. */
const UNKNOWN_TREND: VolumeTrend = {
  class: 'unknown',
  vsBaseline: null,
  slope7dPct: null,
  consecutiveRiseDays: null,
  consecutiveFallDays: null,
  daysToVerified: null,
  confidence: 0,
  dailyVol: [],
  daysSampled: 0,
};

function withTrend(rows: PoolRankRow[]): PoolRankRow[] {
  return rows.map((row) => ({ ...row, trend: row.trend ?? UNKNOWN_TREND }));
}

export function getPoolRankApi(): PoolRankApi {
  const snapshot = getPoolRankSnapshot();
  const successAt = Number(kvGet(kv.successAt) ?? 0);
  return {
    enabled: POOL_RANK_ENABLED,
    ready: snapshot !== null,
    generatedAt: snapshot?.generatedAt ?? null,
    ageSeconds: snapshot ? Math.max(0, now() - snapshot.generatedAt) : null,
    nextRefreshSeconds:
      successAt > 0 ? Math.max(0, Math.round((TUNE.poolRankMs - (Date.now() - successAt * 1000)) / 1000)) : null,
    rows: withTrend(snapshot?.rows ?? []),
    emerging: snapshot?.emerging ?? [],
    dropped: snapshot?.dropped ?? [],
    migrationEvents: snapshot?.migrationEvents ?? [],
    upPriceUsd: snapshot?.upPriceUsd ?? null,
    windowDays: snapshot?.windowDays ?? 0,
  };
}

export async function runPoolRankCycle(): Promise<PoolRankSnapshot> {
  if (!POOL_RANK_ENABLED) throw new Error('pool rank is not enabled on this chain');
  const runningSince = Number(kvGet(kv.running) ?? 0);
  if (runningSince && Date.now() - runningSince < RUNNING_TTL_MS) throw new Error('pool rank cycle already running');
  const started = Date.now();
  kvSet(kv.running, String(Date.now()));
  try {
    const network = CHAIN.slugs.gecko?.network ?? CHAIN.key;
    const v3Dex = CHAIN.slugs.gecko?.v3Dex;
    const upPriceUsd = CHAIN.gov ? await gtTokenPriceUsd(network, CHAIN.gov.UP) : null;
    const subgraphPools = await fetchUp33Subgraph();
    const onchain = await fetchUp33Onchain(subgraphPools.map((p) => p.id));
    const up33 = up33Rows(subgraphPools, onchain, upPriceUsd);
    const univ3 = v3Dex
      ? await univ3Rows(network, v3Dex)
      : { rows: [] as PoolRankRow[], dropped: [] as { pool: string; reason: string }[], emerging: [] as EmergingRow[], candidates: [] as GtCandidate[], candles: new Map<string, GtCandle[]>() };
    const rows = [...up33.rows, ...univ3.rows].sort((a, b) => b.coverage - a.coverage);
    const emerging = [...up33.emerging, ...univ3.emerging].sort((a, b) => b.volDayUsd - a.volDayUsd).slice(0, 8);
    // Pair attribution is fail-soft: the rank table must survive a hiccup in
    // data it does not itself need (v4 reads, GT relationship gaps).
    let migrationEvents: MigrationEventItem[] = [];
    try {
      const pairSnapshot = buildPairVolumeSnapshot({
        subgraphPools,
        onchain,
        univ3Candidates: univ3.candidates,
        univ3Candles: new Map([...univ3.candles].map(([k, v]) => [k, v.map((c) => ({ ts: c[0], vol: c[5] }))])),
        rankedIdentities: new Set(rows.map((r) => r.address.toLowerCase())),
        nowTs: now(),
      });
      storePairVolumeSnapshot(pairSnapshot);
      migrationEvents = pairSnapshot ? [...new Map(Object.values(pairSnapshot.pairs).flatMap((p) => p.events).map((e) => [`${e.fromPool}->${e.toPool}`, e] as const)).values()]
        .sort((a, b) => b.magnitudeUsd - a.magnitudeUsd).slice(0, 10) : [];
    } catch (e) {
      log(`[pool-rank] pair volume snapshot failed: ${safeError(e)}`);
    }
    const snapshot: PoolRankSnapshot = {
      generatedAt: now(),
      durationMs: Date.now() - started,
      windowDays: OHLCV_DAYS,
      upPriceUsd,
      rows,
      dropped: [...up33.dropped, ...univ3.dropped],
      emerging,
      migrationEvents,
    };
    kvSet(kv.snapshot, JSON.stringify(snapshot));
    kvSet(kv.successAt, String(now()));
    kvSet(kv.error, '');
    kvSet(kv.errorAt, '');
    log(`[pool-rank] ${rows.length} pools ranked (${up33.rows.length} up33-cl, ${univ3.rows.length} univ3), ${emerging.length} emerging, ${migrationEvents.length} migration events in ${(snapshot.durationMs / 1000).toFixed(0)}s`);
    return snapshot;
  } catch (e) {
    kvSet(kv.error, safeError(e));
    kvSet(kv.errorAt, String(now()));
    throw e;
  } finally {
    kvSet(kv.running, '0');
  }
}
