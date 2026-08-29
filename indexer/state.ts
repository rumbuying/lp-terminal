// On-chain state sweeps + USD pricing.
//
// State per pool (multicall):
//   v3:    slot0 + liquidity + erc20 balanceOf(token0/1) — balances (not L)
//          are the TVL basis, matching how GT/dexscreener report "reserve".
//   univ2: getReserves + totalSupply.
//
// Pricing: GeckoTerminal token prices (stats.ts, depth = pool reserve/2) plus
// the USDG anchor are the only CREDIBLE seeds; every other price is propagated
// from them through pools, using the pool's SPOT — v2 reserve ratio, v3 slot0
// sqrt price. v3 BALANCES are liquidity-shape artifacts, never a price
// (measured: a near-edge pool priced a token 11,000× off spot, turning a ~$1.4k
// pool into $10.85M of "TVL").
//
// Four rails keep a manipulated pool from minting a price (2026-07-22 autopsy:
// ONE v3 pool parked at MAX_TICK with zero in-range liquidity, holding $1,464
// of real USDG, priced its counter-token at $3.5e50 — which then poisoned 138
// tokens and put 120 fake rows on the POOLS frontpage, burying every real one):
//
//  1. spot must be usable — a v3 pool with no in-range liquidity, or parked at
//     a boundary tick, has a slot0 anyone can move for free: not a price.
//  2. propagation is a BFS by HOP from the seeds. A token settles at the
//     shortest hop that can price it and never re-prices from a longer path, so
//     a chain of junk pools can't out-shout the WETH pool next door.
//  3. depth (the weight behind a quote) is CREDIBLE dollars: past hop 1 it is
//     capped by the depth backing the known side. The old `balance × its price`
//     let a fabricated price fabricate its own authority — the bigger the lie,
//     the more it outranked every honest quote, permanently.
//  4. within a hop, a token's quotes are combined by DEPTH-WEIGHTED MEDIAN, so
//     one manipulated pool has to outweigh every honest pool to move a price.
//
// Nothing pool-derived is inherited across passes (loadSeeds reads GT/anchor
// only) — a poisoned price cannot survive a reprice. TVL = sum of priced sides,
// bounded by tvlOf(): one-sided → 2× that side; a pool-priced side that dwarfs
// the credible side → clamped to 2× credible; and any pool-priced side is
// capped at maxSideOverDepth × the credible depth that established its price.
// Every bounded figure flags tvl_approx.
import { erc20Abi, formatUnits } from 'viem';
import { clGaugeAbi, clPoolAbi, uniV2PairAbi, uniV3PoolAbi, voterAbi } from '../src/abi';
import { ADDR, CHAIN, TUNE, log, now } from './config';
import { mc, ok, type Call } from './rpc';
import {
  clPoolRowsPage,
  clearDerivedPrices,
  db,
  missingClMetaTokensPage,
  missingMetaTokensPage,
  poolRowsPage,
  setTvl,
  setV4ChainTvl,
  tx,
  upsertState,
  upsertTokenMeta,
  v4TvlInputs,
  type PoolRow,
} from './store';

// A page bounds decoded rows, contract descriptors and RPC results at every
// full-catalog stage. Keep this independent of TUNE.batch: mc() applies its own
// smaller per-request chunking inside each page.
const CATALOG_PAGE_SIZE = 1_000;

const printable = (s: unknown): string | null => {
  if (typeof s !== 'string') return null;
  const t = s.replace(/[^\x20-\x7e]/g, '').trim();
  return t ? t.slice(0, 24) : null;
};

export type CatalogPageResult = {
  done: number;
  total: number;
  nextCursor: string;
  complete: boolean;
};

export type StateCatalogPageResult = CatalogPageResult & {
  addresses: string[];
};

async function fetchTokenMeta(tokens: string[]): Promise<number> {
  if (!tokens.length) return 0;
  const res = await mc(
    tokens.flatMap((t) => [
      { abi: erc20Abi, address: t as `0x${string}`, functionName: 'symbol' },
      { abi: erc20Abi, address: t as `0x${string}`, functionName: 'decimals' },
    ]),
  );
  let done = 0;
  tx(() => {
    tokens.forEach((t, j) => {
      const sym = printable(ok<string>(res[j * 2]));
      const dec = ok<number>(res[j * 2 + 1]);
      const metaOk = dec !== undefined && Number.isInteger(dec) && dec >= 0 && dec <= 255;
      if (metaOk) done++;
      upsertTokenMeta(t, sym ?? t.slice(0, 6) + '…', metaOk ? dec : 18, metaOk);
    });
  });
  return done;
}

/** One bounded, restart-friendly page of the catalog metadata census. */
export async function ensureTokenMetaPage(afterAddress: string, limit = CATALOG_PAGE_SIZE): Promise<CatalogPageResult> {
  const pageLimit = Math.max(1, Math.floor(limit));
  const missing = missingMetaTokensPage(afterAddress, pageLimit);
  const done = await fetchTokenMeta(missing);
  const complete = missing.length < pageLimit;
  return {
    done,
    total: missing.length,
    nextCursor: complete ? '' : missing[missing.length - 1],
    complete,
  };
}

/** One bounded metadata page for Uniswap/Pancake concentrated-liquidity pools. */
export async function ensureClTokenMetaPage(
  afterAddress: string,
  limit = CATALOG_PAGE_SIZE,
): Promise<CatalogPageResult> {
  const pageLimit = Math.max(1, Math.floor(limit));
  const missing = missingClMetaTokensPage(afterAddress, pageLimit);
  const done = await fetchTokenMeta(missing);
  const complete = missing.length < pageLimit;
  return {
    done,
    total: missing.length,
    nextCursor: complete ? '' : missing[missing.length - 1],
    complete,
  };
}

/** Fetch symbol/decimals for catalog tokens we haven't met yet, keyset-paged. */
export async function ensureTokenMeta(): Promise<number> {
  let cursor = '';
  let total = 0;
  for (;;) {
    const page = await ensureTokenMetaPage(cursor);
    total += page.done;
    if (page.complete) break;
    cursor = page.nextCursor;
  }
  return total;
}

const poolRowsQ = (addrs: string[]): PoolRow[] => {
  const out: PoolRow[] = [];
  const q = db.prepare('SELECT address, proto, token0, token1, fee_ppm, tick_spacing FROM pools WHERE address = ?');
  for (const a of addrs) {
    const r = q.get(a.toLowerCase()) as PoolRow | undefined;
    if (r) out.push(r);
  }
  return out;
};

const tokenMetaOkQ = db.prepare('SELECT meta_ok FROM tokens WHERE address = ?');
const storedPoolReservesQ = db.prepare('SELECT reserve0, reserve1 FROM pool_state WHERE address = ?');

/** Fetch metadata only for the explicit pool set selected for boot/tail. */
export async function ensurePoolTokenMeta(addrs: string[]): Promise<number> {
  const tokens = [...new Set(poolRowsQ(addrs).flatMap((pool) => [pool.token0, pool.token1]))]
    .filter((address) => {
      const row = tokenMetaOkQ.get(address) as { meta_ok: number } | undefined;
      return row?.meta_ok !== 1;
    })
    .sort();
  let done = 0;
  for (let i = 0; i < tokens.length; i += CATALOG_PAGE_SIZE)
    done += await fetchTokenMeta(tokens.slice(i, i + CATALOG_PAGE_SIZE));
  return done;
}

/** Refresh raw on-chain state for an explicit pool subset (memory-bounded). */
export async function sweepState(addrs: string[]): Promise<number> {
  let done = 0;
  for (let i = 0; i < addrs.length; i += CATALOG_PAGE_SIZE) {
    done += await sweepRows(poolRowsQ(addrs.slice(i, i + CATALOG_PAGE_SIZE)));
  }
  if (done < addrs.length)
    log(`[sweep] ${done}/${addrs.length} pools updated; kept last-good state for ${addrs.length - done}`);
  return done;
}

/** Full-catalog state sweep without ever allocating the full address list. */
export async function sweepAllState(): Promise<{
  done: number;
  total: number;
}> {
  let cursor = '';
  let done = 0;
  let total = 0;
  for (;;) {
    const rows = poolRowsPage(cursor, CATALOG_PAGE_SIZE);
    if (!rows.length) break;
    total += rows.length;
    done += await sweepRows(rows);
    cursor = rows[rows.length - 1].address;
  }
  if (done < total) log(`[sweep] ${done}/${total} pools updated; kept last-good state for ${total - done}`);
  return { done, total };
}

/** One bounded, restart-friendly page of the address-keyed state census. */
export async function sweepStatePage(afterAddress: string, limit = CATALOG_PAGE_SIZE): Promise<StateCatalogPageResult> {
  const pageLimit = Math.max(1, Math.floor(limit));
  const rows = poolRowsPage(afterAddress, pageLimit);
  const done = await sweepRows(rows);
  const complete = rows.length < pageLimit;
  return {
    done,
    total: rows.length,
    nextCursor: complete ? '' : rows[rows.length - 1].address,
    complete,
    addresses: rows.map((row) => row.address),
  };
}

/** One bounded state page for Uniswap/Pancake concentrated-liquidity pools. */
export async function sweepClStatePage(
  afterAddress: string,
  limit = CATALOG_PAGE_SIZE,
): Promise<StateCatalogPageResult> {
  const pageLimit = Math.max(1, Math.floor(limit));
  const rows = clPoolRowsPage(afterAddress, pageLimit);
  const done = await sweepRows(rows, true);
  const complete = rows.length < pageLimit;
  return {
    done,
    total: rows.length,
    nextCursor: complete ? '' : rows[rows.length - 1].address,
    complete,
    addresses: rows.map((row) => row.address),
  };
}

const isClPool = (proto: PoolRow['proto'] | string): boolean =>
  proto === 'univ3' || proto === 'pancakev3' || proto === 'up33cl';

async function sweepRows(rows: PoolRow[], countReadableCl = false): Promise<number> {
  if (!rows.length) return 0;
  const calls: Call[] = [];
  for (const p of rows) {
    const a = p.address as `0x${string}`;
    if (p.proto === 'up33cl') {
      if (!CHAIN.gov) throw new Error('UP33 pool found on a chain without governance contracts');
      calls.push(
        { abi: clPoolAbi, address: a, functionName: 'slot0' },
        { abi: clPoolAbi, address: a, functionName: 'liquidity' },
        { abi: clPoolAbi, address: a, functionName: 'stakedLiquidity' },
        { abi: erc20Abi, address: p.token0 as `0x${string}`, functionName: 'balanceOf', args: [a] },
        { abi: erc20Abi, address: p.token1 as `0x${string}`, functionName: 'balanceOf', args: [a] },
        ...(p.gauge ? [
          { abi: clGaugeAbi, address: p.gauge as `0x${string}`, functionName: 'rewardRate' },
          { abi: clGaugeAbi, address: p.gauge as `0x${string}`, functionName: 'periodFinish' },
          { abi: voterAbi, address: CHAIN.gov.VOTER, functionName: 'isAlive', args: [p.gauge] },
        ] : []),
      );
    } else if (isClPool(p.proto))
      calls.push(
        { abi: uniV3PoolAbi, address: a, functionName: 'slot0' },
        { abi: uniV3PoolAbi, address: a, functionName: 'liquidity' },
        {
          abi: erc20Abi,
          address: p.token0 as `0x${string}`,
          functionName: 'balanceOf',
          args: [a],
        },
        {
          abi: erc20Abi,
          address: p.token1 as `0x${string}`,
          functionName: 'balanceOf',
          args: [a],
        },
      );
    else
      calls.push(
        { abi: uniV2PairAbi, address: a, functionName: 'getReserves' },
        { abi: uniV2PairAbi, address: a, functionName: 'totalSupply' },
      );
  }
  const res = await mc(calls);
  let i = 0;
  let done = 0;
  tx(() => {
    for (const p of rows) {
      if (p.proto === 'up33cl') {
        const s0 = ok<readonly [bigint, number, ...unknown[]]>(res[i++]);
        const liq = ok<bigint>(res[i++]);
        const staked = ok<bigint>(res[i++]);
        const b0 = ok<bigint>(res[i++]);
        const b1 = ok<bigint>(res[i++]);
        const rewardRate = p.gauge ? ok<bigint>(res[i++]) : 0n;
        const periodFinish = p.gauge ? ok<bigint>(res[i++]) : 0n;
        const gaugeAlive = p.gauge ? ok<boolean>(res[i++]) : false;
        if (!s0 || liq === undefined || staked === undefined) continue;
        const stored = b0 === undefined || b1 === undefined
          ? storedPoolReservesQ.get(p.address) as { reserve0: string; reserve1: string } | undefined
          : undefined;
        upsertState(p.address, {
          sqrtPrice: s0[0], tick: s0[1], liquidity: liq,
          stakedLiquidity: staked,
          rewardRate: rewardRate ?? 0n,
          periodFinish: periodFinish ?? 0n,
          gaugeAlive: gaugeAlive ?? false,
          reserve0: b0 ?? BigInt(stored?.reserve0 ?? 0),
          reserve1: b1 ?? BigInt(stored?.reserve1 ?? 0),
        });
        done++;
      } else if (isClPool(p.proto)) {
        const s0 = ok<readonly [bigint, number, ...unknown[]]>(res[i++]);
        const liq = ok<bigint>(res[i++]);
        const b0 = ok<bigint>(res[i++]);
        const b1 = ok<bigint>(res[i++]);
        if (!s0 || liq === undefined) continue;
        // balanceOf is auxiliary TVL data, not CL identity/state. A hostile
        // token must not hide an otherwise valid factory pool on first boot;
        // use zero for its failed side. Once a row has good state, preserve it
        // wholesale on a partial balance read rather than degrading its TVL.
        const stored =
          b0 === undefined || b1 === undefined
            ? (storedPoolReservesQ.get(p.address) as { reserve0: string; reserve1: string } | undefined)
            : undefined;
        if (stored) {
          // The CL bootstrap only needs to prove that fresh slot0/liquidity are
          // readable. Existing last-good balances remain a safe TVL fallback.
          if (countReadableCl) done++;
          continue;
        }
        upsertState(p.address, {
          sqrtPrice: s0[0],
          tick: s0[1],
          liquidity: liq,
          reserve0: b0 ?? 0n,
          reserve1: b1 ?? 0n,
        });
        done++;
      } else {
        const rs = ok<readonly [bigint, bigint, number]>(res[i++]);
        const ts = ok<bigint>(res[i++]);
        if (!rs || ts === undefined) continue;
        upsertState(p.address, {
          reserve0: rs[0],
          reserve1: rs[1],
          totalSupply: ts,
        });
        done++;
      }
    }
  });
  return done;
}

/** `hops` = distance from a credible seed: 0 = GT/anchor, 1..n = propagated */
type PriceEntry = { usd: number; depth: number; src: string; hops: number };

/** a price outside this band is a broken pool, not a market */
export const plausibleUsd = (x: number | null | undefined): x is number =>
  x != null && Number.isFinite(x) && x >= TUNE.minTokenUsd && x <= TUNE.maxTokenUsd;

type StateRow = {
  address: string;
  proto: string;
  token0: string;
  token1: string;
  reserve0: string;
  reserve1: string;
  sqrt_price: string | null;
  liquidity: string | null;
  tick: number | null;
};

type RawStateRow = StateRow & { dec0: number; dec1: number };
const rawStatePageQ = db.prepare(
  `SELECT p.address, p.proto, p.token0, p.token1,
          s.reserve0, s.reserve1, s.sqrt_price, s.liquidity, s.tick,
          COALESCE(t0.decimals, 18) AS dec0, COALESCE(t1.decimals, 18) AS dec1
   FROM pools p
   JOIN pool_state s ON s.address = p.address
   LEFT JOIN tokens t0 ON t0.address = p.token0
   LEFT JOIN tokens t1 ON t1.address = p.token1
   WHERE p.address > ? ORDER BY p.address LIMIT ?`,
);
const rawStatePage = (afterAddress: string): RawStateRow[] =>
  rawStatePageQ.all(afterAddress, CATALOG_PAGE_SIZE) as RawStateRow[];

const Q96 = 2 ** 96;
/** univ3 spot from slot0: HUMAN token1 per token0 (null when absent/degenerate) */
export function v3Price1Per0(sqrtPrice: string | null, dec0: number, dec1: number): number | null {
  if (!sqrtPrice) return null;
  const r = Number(sqrtPrice) / Q96;
  const p = r * r * 10 ** (dec0 - dec1);
  return Number.isFinite(p) && p > 0 ? p : null;
}

/**
 * Is a univ3 pool's slot0 a price at all? Two ways it isn't:
 *  - no in-range liquidity: slot0 is wherever the last poke left it and the
 *    next dust swap moves it anywhere, for free.
 *  - parked at a boundary tick (|tick| → MAX_TICK 887272): a pool initialized
 *    at the extreme, which is how the $3.5e50 quote got minted.
 * Such pools still get TVL from the OTHER side's price — they just don't vote.
 */
export function v3SpotOk(liquidity: string | null, tick: number | null): boolean {
  if (tick === null || Math.abs(tick) > TUNE.maxAbsTick) return false;
  try {
    return liquidity !== null && BigInt(liquidity) > 0n;
  } catch {
    return false;
  }
}

/** HUMAN token1-per-token0 spot, or null when this pool may not set a price */
const spotOf = (s: StateRow, b0: number, b1: number, dec0: number, dec1: number): number | null => {
  if (!isClPool(s.proto)) return b0 > 0 && b1 > 0 ? b1 / b0 : null;
  if (!v3SpotOk(s.liquidity, s.tick)) return null;
  return v3Price1Per0(s.sqrt_price, dec0, dec1);
};

/**
 * Depth-weighted median of a token's candidate quotes. A single manipulated
 * pool now has to bring more than half the credible depth backing a token to
 * move its price — with "deepest wins" it only had to claim a bigger number.
 */
export function weightedMedian(quotes: readonly { usd: number; depth: number }[]): number {
  if (quotes.length === 1) return quotes[0].usd;
  const sorted = [...quotes].sort((a, b) => a.usd - b.usd);
  const half = sorted.reduce((a, q) => a + q.depth, 0) / 2;
  let acc = 0;
  for (const q of sorted) {
    acc += q.depth;
    if (acc >= half) return q.usd;
  }
  return sorted[sorted.length - 1].usd;
}

/**
 * TVL from two priced sides. `credible` = the side's price came from GT or the
 * USDG anchor rather than pool propagation. Three bounds, all flagging approx:
 *  - `cap0/cap1`: a pool-priced side may not claim more than
 *    maxSideOverDepth × the credible depth that established its price. This is
 *    the absolute ceiling — without it a $1.4k pool's fabricated quote turned
 *    into a $2.95e49 "TVL" that no ratio test could catch.
 *  - a side claiming more than maxUncredibleRatio × its credible counterparty
 *    is capped at 2× the credible side.
 *  - junk-vs-junk pools are bounded by the smaller side.
 */
export function tvlOf(
  u0: number | null,
  cred0: boolean,
  u1: number | null,
  cred1: boolean,
  cap0 = Infinity,
  cap1 = Infinity,
): { tvl: number | null; approx: boolean } {
  let capped = false;
  if (u0 != null && u0 > cap0) {
    u0 = cap0;
    capped = true;
  }
  if (u1 != null && u1 > cap1) {
    u1 = cap1;
    capped = true;
  }
  const bounded = (r: { tvl: number | null; approx: boolean }) => (capped ? { ...r, approx: true } : r);
  if (u0 == null && u1 == null) return { tvl: null, approx: false };
  if (u0 == null || u1 == null) return { tvl: (u0 ?? u1)! * 2, approx: true };
  if (cred0 !== cred1) {
    const cu = cred0 ? u0 : u1;
    const ju = cred0 ? u1 : u0;
    if (ju > cu * TUNE.maxUncredibleRatio) return { tvl: cu * 2, approx: true };
  } else if (!cred0 && !cred1) {
    const lo = Math.min(u0, u1);
    if (Math.max(u0, u1) > lo * TUNE.maxUncredibleRatio) return { tvl: lo * 2, approx: true };
  }
  return bounded({ tvl: u0 + u1, approx: false });
}

const credible = (e?: PriceEntry) => !!e && e.src !== 'pool';
/** ceiling on what a pool-priced side may claim; credible seeds are unbounded */
const capOf = (e?: PriceEntry) => (e && e.src === 'pool' ? e.depth * TUNE.maxSideOverDepth : Infinity);

/** at most this many quotes retained per token per hop (memory bound) */
const MAX_QUOTES = 32;

// Pricing can touch hundreds of thousands of rows. These FILE-backed TEMP
// tables keep its working set out of V8 while remaining private to this SQLite
// connection. The final publication into `tokens`/`pool_state` is still one
// transaction, so API readers never observe half of a pricing pass.
db.exec(`
PRAGMA temp_store = FILE;
CREATE TEMP TABLE IF NOT EXISTS reprice_states (
  address TEXT PRIMARY KEY,
  token0 TEXT NOT NULL,
  token1 TEXT NOT NULL,
  balance0 REAL NOT NULL,
  balance1 REAL NOT NULL,
  spot1_per_0 REAL
) WITHOUT ROWID;
CREATE TEMP TABLE IF NOT EXISTS reprice_prices (
  address TEXT PRIMARY KEY,
  usd REAL NOT NULL,
  depth REAL NOT NULL,
  src TEXT NOT NULL,
  hops INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TEMP TABLE IF NOT EXISTS reprice_quotes (
  token TEXT NOT NULL,
  usd REAL NOT NULL,
  depth REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS temp.idx_reprice_quotes_token_depth
  ON reprice_quotes(token, depth DESC, usd);
CREATE TEMP TABLE IF NOT EXISTS reprice_tvl (
  address TEXT PRIMARY KEY,
  tvl_usd REAL,
  tvl_approx INTEGER NOT NULL
) WITHOUT ROWID;
`);

const clearRepriceStage = () =>
  db.exec(`
    DELETE FROM temp.reprice_quotes;
    DELETE FROM temp.reprice_tvl;
    DELETE FROM temp.reprice_states;
    DELETE FROM temp.reprice_prices;
  `);

const insertRepriceStateQ = db.prepare(
  `INSERT INTO temp.reprice_states (address, token0, token1, balance0, balance1, spot1_per_0)
   VALUES (?, ?, ?, ?, ?, ?)`,
);
const insertQuoteQ = db.prepare('INSERT INTO temp.reprice_quotes (token, usd, depth) VALUES (?, ?, ?)');
const insertRepricePriceQ = db.prepare(
  `INSERT INTO temp.reprice_prices (address, usd, depth, src, hops)
   VALUES (?, ?, ?, 'pool', ?)`,
);
const insertRepriceTvlQ = db.prepare('INSERT INTO temp.reprice_tvl (address, tvl_usd, tvl_approx) VALUES (?, ?, ?)');

type HopStateRow = {
  address: string;
  token0: string;
  token1: string;
  balance0: number;
  balance1: number;
  spot1_per_0: number | null;
  p0_usd: number | null;
  p0_depth: number | null;
  p0_src: string | null;
  p0_hops: number | null;
  p1_usd: number | null;
  p1_depth: number | null;
  p1_src: string | null;
  p1_hops: number | null;
};

const pricedStatePageQ = db.prepare(
  `SELECT s.address, s.token0, s.token1, s.balance0, s.balance1, s.spot1_per_0,
          p0.usd AS p0_usd, p0.depth AS p0_depth, p0.src AS p0_src, p0.hops AS p0_hops,
          p1.usd AS p1_usd, p1.depth AS p1_depth, p1.src AS p1_src, p1.hops AS p1_hops
   FROM temp.reprice_states s
   LEFT JOIN temp.reprice_prices p0 ON p0.address = s.token0
   LEFT JOIN temp.reprice_prices p1 ON p1.address = s.token1
   WHERE s.address > ? ORDER BY s.address LIMIT ?`,
);
const pricedStatePage = (afterAddress: string): HopStateRow[] =>
  pricedStatePageQ.all(afterAddress, CATALOG_PAGE_SIZE) as HopStateRow[];

const quoteTokensPageQ = db.prepare(
  `SELECT DISTINCT token FROM temp.reprice_quotes
   WHERE token > ? ORDER BY token LIMIT ?`,
);
const topQuotesQ = db.prepare(
  `SELECT usd, depth FROM temp.reprice_quotes
   WHERE token = ? ORDER BY depth DESC, usd LIMIT ?`,
);

const stagedPrice = (
  usd: number | null,
  depth: number | null,
  src: string | null,
  hops: number | null,
): PriceEntry | undefined =>
  plausibleUsd(usd) && depth !== null && hops !== null ? { usd, depth, src: src ?? '?', hops } : undefined;

/**
 * Full pricing pass: BFS USD prices out from the GT/anchor seeds, then
 * recompute every pool's TVL. Catalog/state traversal is address-keyset paged;
 * disk-backed TEMP tables hold cross-page BFS state. Pool-derived prices are
 * discarded and rebuilt from scratch on every call — see the rails above.
 */
export function reprice(): { priced: number; tvlPools: number } {
  clearRepriceStage();

  // Seeds are copied set-wise, so hundreds of thousands of unpriced metadata
  // rows never cross the SQLite/V8 boundary.
  db.prepare(
    `INSERT INTO temp.reprice_prices (address, usd, depth, src, hops)
     SELECT address, price_usd, price_depth_usd, price_src, 0 FROM tokens
     WHERE price_src IS NOT NULL AND price_src <> 'pool'
       AND price_usd BETWEEN ? AND ?`,
  ).run(TUNE.minTokenUsd, TUNE.maxTokenUsd);
  db.prepare(
    `INSERT OR IGNORE INTO temp.reprice_prices (address, usd, depth, src, hops)
     VALUES (?, 1, 1, 'anchor', 0)`,
  ).run(ADDR.STABLE.toLowerCase());

  // Decode BigInt balances and v3 spot exactly once, one state page at a time.
  let cursor = '';
  for (;;) {
    const rows = rawStatePage(cursor);
    if (!rows.length) break;
    tx(() => {
      for (const s of rows) {
        const b0 = Number(formatUnits(BigInt(s.reserve0), s.dec0));
        const b1 = Number(formatUnits(BigInt(s.reserve1), s.dec1));
        insertRepriceStateQ.run(s.address, s.token0, s.token1, b0, b1, spotOf(s, b0, b1, s.dec0, s.dec1));
      }
    });
    cursor = rows[rows.length - 1].address;
  }

  // Hop 1 is priced directly against a seed, hop 2 against a hop-1 token, etc.
  // Quotes live on disk; only one state page or one token's top quotes is in JS.
  for (let hop = 1; hop <= TUNE.maxPriceHops; hop++) {
    db.exec('DELETE FROM temp.reprice_quotes');
    cursor = '';
    for (;;) {
      const rows = pricedStatePage(cursor);
      if (!rows.length) break;
      tx(() => {
        for (const s of rows) {
          const p1per0 = s.spot1_per_0;
          if (p1per0 === null) continue;

          if (s.p0_hops === hop - 1 && s.p1_usd === null && s.balance1 > 0) {
            const depth = s.p0_hops === 0 ? s.balance0 * s.p0_usd! : Math.min(s.balance0 * s.p0_usd!, s.p0_depth!);
            const usd = s.p0_usd! / p1per0;
            if (depth >= TUNE.minDepthUsd && plausibleUsd(usd)) insertQuoteQ.run(s.token1, usd, depth);
          }
          if (s.p1_hops === hop - 1 && s.p0_usd === null && s.balance0 > 0) {
            const depth = s.p1_hops === 0 ? s.balance1 * s.p1_usd! : Math.min(s.balance1 * s.p1_usd!, s.p1_depth!);
            const usd = s.p1_usd! * p1per0;
            if (depth >= TUNE.minDepthUsd && plausibleUsd(usd)) insertQuoteQ.run(s.token0, usd, depth);
          }
        }
      });
      cursor = rows[rows.length - 1].address;
    }

    let quoteTokens = 0;
    cursor = '';
    for (;;) {
      const tokens = quoteTokensPageQ.all(cursor, CATALOG_PAGE_SIZE) as {
        token: string;
      }[];
      if (!tokens.length) break;
      tx(() => {
        for (const { token } of tokens) {
          // Deterministically retain the deepest quotes. The old in-memory
          // implementation intended this cap but could temporarily retain 64.
          const qs = topQuotesQ.all(token, MAX_QUOTES) as {
            usd: number;
            depth: number;
          }[];
          insertRepricePriceQ.run(
            token,
            weightedMedian(qs),
            qs.reduce((max, q) => Math.max(max, q.depth), 0),
            hop,
          );
        }
      });
      quoteTokens += tokens.length;
      cursor = tokens[tokens.length - 1].token;
    }
    if (!quoteTokens) break;
  }

  let tvlPools = 0;
  cursor = '';
  for (;;) {
    const rows = pricedStatePage(cursor);
    if (!rows.length) break;
    tx(() => {
      for (const s of rows) {
        const p0 = stagedPrice(s.p0_usd, s.p0_depth, s.p0_src, s.p0_hops);
        const p1 = stagedPrice(s.p1_usd, s.p1_depth, s.p1_src, s.p1_hops);
        const u0 = p0 ? s.balance0 * p0.usd : null;
        const u1 = p1 ? s.balance1 * p1.usd : null;
        const { tvl, approx } = tvlOf(u0, credible(p0), u1, credible(p1), capOf(p0), capOf(p1));
        insertRepriceTvlQ.run(s.address, tvl, approx ? 1 : 0);
        if (tvl !== null) tvlPools++;
      }
    });
    cursor = rows[rows.length - 1].address;
  }

  // Publish the complete staged pass atomically, preserving the old API
  // visibility semantics while moving the expensive work outside this tx.
  tx(() => {
    clearDerivedPrices();
    db.prepare(
      `INSERT INTO tokens (address, price_usd, price_depth_usd, price_src, price_updated)
       SELECT address, usd, depth, src, ? FROM temp.reprice_prices WHERE src = 'pool'
       ON CONFLICT(address) DO UPDATE SET
         price_usd = excluded.price_usd,
         price_depth_usd = excluded.price_depth_usd,
         price_src = excluded.price_src,
         price_updated = excluded.price_updated`,
    ).run(now());
    db.exec(
      `UPDATE pool_state AS current SET
         tvl_usd = staged.tvl_usd,
         tvl_approx = staged.tvl_approx
       FROM temp.reprice_tvl AS staged
       WHERE current.address = staged.address
         AND (current.tvl_usd IS NOT staged.tvl_usd OR
              current.tvl_approx <> staged.tvl_approx)`,
    );
  });

  const priced = (
    db.prepare('SELECT COUNT(*) AS n FROM temp.reprice_prices').get() as {
      n: number;
    }
  ).n;
  return { priced, tvlPools };
}

type StoredTvlRow = {
  address: string;
  token0: string;
  token1: string;
  reserve0: string;
  reserve1: string;
  dec0: number;
  dec1: number;
  p0_usd: number | null;
  p0_depth: number | null;
  p0_src: string | null;
  p1_usd: number | null;
  p1_depth: number | null;
  p1_src: string | null;
};
const storedTvlRowQ = db.prepare(
  `SELECT p.address, p.token0, p.token1, s.reserve0, s.reserve1,
          COALESCE(t0.decimals, 18) AS dec0, COALESCE(t1.decimals, 18) AS dec1,
          t0.price_usd AS p0_usd, t0.price_depth_usd AS p0_depth, t0.price_src AS p0_src,
          t1.price_usd AS p1_usd, t1.price_depth_usd AS p1_depth, t1.price_src AS p1_src
   FROM pools p JOIN pool_state s ON s.address = p.address
   LEFT JOIN tokens t0 ON t0.address = p.token0
   LEFT JOIN tokens t1 ON t1.address = p.token1
   WHERE p.address = ?`,
);

/** Cheap TVL refresh for an explicit subset using already-stored prices. */
export function computeTvlFor(addrs: string[]): void {
  if (!addrs.length) return;
  tx(() => {
    for (const a of addrs) {
      const s = storedTvlRowQ.get(a.toLowerCase()) as StoredTvlRow | undefined;
      if (!s) continue;
      const p0 = stagedPrice(s.p0_usd, s.p0_depth, s.p0_src, s.p0_src === 'pool' ? 1 : 0);
      const p1 = stagedPrice(s.p1_usd, s.p1_depth, s.p1_src, s.p1_src === 'pool' ? 1 : 0);
      const u0 = p0 ? Number(formatUnits(BigInt(s.reserve0), s.dec0)) * p0.usd : null;
      const u1 = p1 ? Number(formatUnits(BigInt(s.reserve1), s.dec1)) * p1.usd : null;
      const { tvl, approx } = tvlOf(u0, credible(p0), u1, credible(p1), capOf(p0), capOf(p1));
      setTvl(s.address, tvl, approx);
    }
  });
}

/**
 * The same TVL rule, applied to v4's PoolId-keyed accounting.
 *
 * It runs here rather than in the browser because the server has to be able to
 * RANK by this number — a page can only sort what it was already sent, which is
 * how a stock chip came to show four markets out of a catalog's worth. The
 * browser is still handed the raw token quantities beside the answer, so it can
 * check the arithmetic rather than take it on trust.
 *
 * Quantities come from the Graph already decimal-adjusted, so unlike the
 * address-keyed pass there is no formatUnits step — the rest of the reasoning
 * (which side is credible, what a pool-priced side may claim) is `tvlOf`'s,
 * unchanged, because a v4 pool is not a different kind of thing to price.
 */
export function computeV4Tvl(): number {
  const rows = v4TvlInputs();
  if (!rows.length) return 0;
  let priced = 0;
  tx(() => {
    for (const row of rows) {
      const p0 = stagedPrice(row.p0_usd, row.p0_depth, row.p0_src, row.p0_src === 'pool' ? 1 : 0);
      const p1 = stagedPrice(row.p1_usd, row.p1_depth, row.p1_src, row.p1_src === 'pool' ? 1 : 0);
      const u0 = p0 && row.tvl0 !== null ? row.tvl0 * p0.usd : null;
      const u1 = p1 && row.tvl1 !== null ? row.tvl1 * p1.usd : null;
      const { tvl, approx } = tvlOf(u0, credible(p0), u1, credible(p1), capOf(p0), capOf(p1));
      setV4ChainTvl(row.pool_id, tvl, approx);
      if (tvl !== null) priced++;
    }
  });
  return priced;
}

export const sweepLog = (label: string, n: number, ms: number) =>
  log(`[sweep] ${label} ${n} pools in ${(ms / 1000).toFixed(1)}s`);
