// Read-only HTTP API. Response shapes mirror the frontend's PoolsData /
// PoolStat structures so the POOLS tab maps rows 1:1 (bigints travel as
// strings). Served same-origin in production (nginx /api → this) and through
// the vite dev/preview proxy locally.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { PORT, TUNE, log } from './config'
import { ADDR } from '../src/config/addresses'
import { db, kvGet, notePoolsHit, poolCounts } from './store'

const JSONH = { 'content-type': 'application/json; charset=utf-8' }

type Params = URLSearchParams

const PROTOS = new Set(['univ2', 'univ3'])
const HEX40 = /^0x[0-9a-f]{40}$/

function poolsWhere(params: Params): { where: string; args: (string | number)[] } {
  const clauses: string[] = []
  const args: (string | number)[] = []

  const proto = (params.get('proto') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => PROTOS.has(s))
  if (proto.length) {
    clauses.push(`p.proto IN (${proto.map(() => '?').join(',')})`)
    args.push(...proto)
  } else {
    // UP33 CL lives in this database for recommendation analytics, while this
    // long-standing endpoint remains the Uniswap catalog consumed by uniIndex.
    clauses.push("p.proto IN ('univ2','univ3')")
  }

  const minTvl = Number(params.get('min_tvl'))
  if (Number.isFinite(minTvl) && minTvl > 0) {
    clauses.push('s.tvl_usd >= ?')
    args.push(minTvl)
  }

  const q = (params.get('q') ?? '').trim().toLowerCase()
  if (q) {
    if (HEX40.test(q)) {
      clauses.push('(p.address = ? OR p.token0 = ? OR p.token1 = ?)')
      args.push(q, q, q)
    } else if (q.includes('/')) {
      // pair search: "weth/usdg" — both sides must match (either orientation)
      const [a, b] = q.split('/', 2).map((s) => s.trim())
      const side = `SELECT address FROM tokens WHERE symbol LIKE ?`
      clauses.push(
        `((p.token0 IN (${side}) AND p.token1 IN (${side})) OR (p.token0 IN (${side}) AND p.token1 IN (${side})))`,
      )
      args.push(a + '%', b + '%', b + '%', a + '%')
    } else {
      const side = `SELECT address FROM tokens WHERE symbol LIKE ?`
      clauses.push(`(p.token0 IN (${side}) OR p.token1 IN (${side}))`)
      args.push(q + '%', q + '%')
    }
  }
  return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', args }
}

// TVL ranking sinks corrupt figures to the bottom instead of filtering them:
// this chain's whole TVL is ~8 orders under maxPoolTvlUsd, so anything above it
// is a pricing artefact, not a whale — but it must stay reachable by address or
// symbol search so it can still be diagnosed. (2026-07-22: without this guard
// 120 of the 120 rows the POOLS tab fetches were fabricated.)
const ORDER: Record<string, string> = {
  tvl: `ORDER BY (s.tvl_usd IS NULL OR s.tvl_usd >= ${TUNE.maxPoolTvlUsd}), s.tvl_usd DESC`,
  vol: 'ORDER BY (st.vol24h_usd IS NULL), st.vol24h_usd DESC',
  created: 'ORDER BY (p.created_block IS NULL), p.created_block DESC, p.pair_index DESC',
}

type PoolOut = Record<string, unknown>

function getPools(params: Params) {
  const { where, args } = poolsWhere(params)
  const order = ORDER[params.get('sort') ?? 'tvl'] ?? ORDER.tvl
  const limit = Math.min(Math.max(Number(params.get('limit')) || 100, 1), 500)
  const offset = Math.min(Math.max(Number(params.get('offset')) || 0, 0), 20_000)

  const base = `FROM pools p LEFT JOIN pool_state s ON s.address = p.address LEFT JOIN pool_stats st ON st.address = p.address ${where}`
  const count = (db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...args) as { n: number }).n
  const rows = db
    .prepare(
      `SELECT p.address, p.proto, p.token0, p.token1, p.fee_ppm, p.tick_spacing, p.created_block,
              s.sqrt_price, s.tick, s.liquidity, s.reserve0, s.reserve1, s.total_supply,
              s.tvl_usd, s.tvl_approx, s.updated AS state_updated,
              st.vol5m_usd, st.vol1h_usd, st.vol6h_usd, st.vol24h_usd,
              st.txns24h, st.liq_usd, st.source AS stats_source
       ${base} ${order} LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset) as Record<string, unknown>[]

  const tokenAddrs = new Set<string>()
  const pools: PoolOut[] = rows.map((r) => {
    tokenAddrs.add(r.token0 as string)
    tokenAddrs.add(r.token1 as string)
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
      stateUpdated: r.state_updated,
    }
  })

  const tokens: Record<string, unknown> = {}
  if (tokenAddrs.size) {
    const list = [...tokenAddrs]
    const trs = db
      .prepare(`SELECT address, symbol, decimals, price_usd FROM tokens WHERE address IN (${list.map(() => '?').join(',')})`)
      .all(...list) as { address: string; symbol: string; decimals: number; price_usd: number | null }[]
    for (const t of trs) tokens[t.address] = { address: t.address, symbol: t.symbol, decimals: t.decimals, priceUsd: t.price_usd }
  }

  const totals = Object.fromEntries(poolCounts().map((c) => [c.proto, c.n]))
  return { ready: kvGet('ready') === '1', asof: Number(kvGet('snapshot_asof')) || null, totals, count, pools, tokens }
}

function getTokens(params: Params) {
  const q = (params.get('q') ?? '').trim().toLowerCase()
  if (!q) return { tokens: [] }
  const rows = HEX40.test(q)
    ? db.prepare('SELECT address, symbol, decimals, price_usd FROM tokens WHERE address = ?').all(q)
    : db
        .prepare(
          `SELECT t.address, t.symbol, t.decimals, t.price_usd,
                  (SELECT COUNT(*) FROM pools p WHERE p.token0 = t.address OR p.token1 = t.address) AS pools
           FROM tokens t WHERE t.symbol LIKE ? ORDER BY pools DESC LIMIT 20`,
        )
        .all(q + '%')
  return { tokens: rows }
}

/**
 * Batch mark prices for wallet/position screens. The indexer has already done
 * the expensive, depth-bounded graph pricing pass; exposing those marks in one
 * request keeps the browser off third-party token endpoints and avoids one
 * request per held asset.
 */
function getPrices(params: Params) {
  const addresses = [
    ...new Set(
      (params.get('addresses') ?? '')
        .split(',')
        .map((address) => address.trim().toLowerCase())
        .filter((address) => HEX40.test(address)),
    ),
  ].slice(0, 200)
  if (!addresses.length) return { ready: kvGet('ready') === '1', prices: {} }

  const rows = db
    .prepare(
      `SELECT address, price_usd, price_depth_usd, price_src, price_updated
       FROM tokens WHERE address IN (${addresses.map(() => '?').join(',')})`,
    )
    .all(...addresses) as {
      address: string
      price_usd: number | null
      price_depth_usd: number
      price_src: string | null
      price_updated: number | null
    }[]
  const prices: Record<string, unknown> = {}
  for (const row of rows) {
    prices[row.address] = {
      priceUsd: row.price_usd,
      depthUsd: row.price_depth_usd,
      source: row.price_src,
      updatedAt: row.price_updated,
    }
  }
  return { ready: kvGet('ready') === '1', prices }
}

function getHealth() {
  const totals = Object.fromEntries(poolCounts().map((c) => [c.proto, c.n]))
  const tokens = (db.prepare('SELECT COUNT(*) AS n FROM tokens').get() as { n: number }).n
  const priced = (db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE price_usd > 0').get() as { n: number }).n
  const tvl = (db.prepare('SELECT COUNT(*) AS n FROM pool_state WHERE tvl_usd IS NOT NULL').get() as { n: number }).n
  // pricing-health canary: a healthy chain has zero of these
  const corrupt = (
    db.prepare('SELECT COUNT(*) AS n FROM pool_state WHERE tvl_usd >= ?').get(TUNE.maxPoolTvlUsd) as { n: number }
  ).n
  const stateFreshness = db.prepare('SELECT MIN(updated) AS oldest, MAX(updated) AS newest FROM pool_state').get()
  const statsFreshness = db.prepare('SELECT MAX(updated) AS newest FROM pool_stats').get()
  const analytics = db.prepare(`SELECT
    (SELECT COUNT(*) FROM pool_market_snapshots) AS marketSnapshots,
    (SELECT COUNT(*) FROM pool_tick_samples) AS tickSamples,
    (SELECT MIN(ts) FROM pool_tick_samples) AS firstTick,
    (SELECT MAX(ts) FROM pool_tick_samples) AS lastTick`).get()
  return {
    ready: kvGet('ready') === '1',
    asof: Number(kvGet('snapshot_asof')) || null,
    lastBootError: kvGet('boot_error') || null,
    pools: totals,
    tokens,
    pricedTokens: priced,
    tvlPools: tvl,
    corruptTvlPools: corrupt,
    stateFreshness,
    statsFreshness,
    analytics,
    v3Cursor: Number(kvGet('v3_cursor') ?? 0),
    v2Count: Number(kvGet('v2_count') ?? 0),
    rssMb: Math.round(process.memoryUsage.rss() / 1e6),
  }
}

function getRecommendationCandidates(params: Params) {
  const limit = Math.min(Math.max(Number(params.get('limit')) || 50, 1), 80)
  const minTvl = Math.max(Number(params.get('min_tvl')) || 10_000, 0)
  const minVolume = Math.max(Number(params.get('min_volume')) || 10_000, 0)
  const now = Math.floor(Date.now() / 1000)
  const marketSince = now - 30 * 86_400
  const tickSince = now - 7 * 86_400
  const candidateSelect = `SELECT p.address,p.proto,p.token0,p.token1,p.fee_ppm,p.unstaked_fee_ppm,p.tick_spacing,
    t0.symbol AS symbol0,t0.decimals AS decimals0,t0.price_usd AS token0_usd,
    t1.symbol AS symbol1,t1.decimals AS decimals1,t1.price_usd AS token1_usd,
    s.sqrt_price,s.tick,s.liquidity,s.staked_liquidity,s.reward_rate,s.period_finish,s.gauge_alive,s.updated AS state_updated,
    COALESCE(s.tvl_usd,st.liq_usd) AS tvl_usd,st.vol1h_usd,st.vol6h_usd,st.vol24h_usd,st.updated AS stats_updated
    FROM pools p JOIN pool_state s ON s.address=p.address JOIN pool_stats st ON st.address=p.address
    JOIN tokens t0 ON t0.address=p.token0 JOIN tokens t1 ON t1.address=p.token1
    WHERE p.proto IN ('univ3','up33cl') AND s.sqrt_price IS NOT NULL AND s.tick IS NOT NULL AND s.liquidity IS NOT NULL
      AND COALESCE(s.tvl_usd,st.liq_usd,0)>=? AND COALESCE(st.vol24h_usd,0)>=?`
  const feeRows = db.prepare(`${candidateSelect}
    ORDER BY (
      MIN(
        COALESCE(st.vol1h_usd,st.vol24h_usd/24.0),
        COALESCE(st.vol6h_usd/6.0,st.vol24h_usd/24.0),
        st.vol24h_usd/24.0
      ) * p.fee_ppm / MAX(COALESCE(s.tvl_usd,st.liq_usd),1)
    ) DESC LIMIT ?`).all(minTvl, minVolume, limit) as Record<string, any>[]
  // Emission opportunities are not necessarily the highest-volume fee pools.
  // Keep a bounded reward cohort so reward mode cannot silently miss its best
  // gauge before scoring even starts.
  const rewardRows = db.prepare(`${candidateSelect}
    AND p.proto='up33cl' AND s.gauge_alive=1 AND s.period_finish>? AND CAST(s.reward_rate AS REAL)>0
    ORDER BY CAST(s.reward_rate AS REAL) DESC LIMIT ?`)
    .all(minTvl, minVolume, now, Math.min(30, limit)) as Record<string, any>[]
  const rows = [...new Map([...feeRows, ...rewardRows].map((row) => [row.address, row])).values()]
  // Hourly history is sufficient for walk-forward volume validation. Returning
  // every five-minute rolling snapshot made this endpoint multi-megabyte and
  // blocked the indexer's event loop for several seconds.
  const marketQ = db.prepare(`SELECT CAST(ts/3600 AS INTEGER)*3600 AS ts,
      AVG(vol1h_usd) AS vol1hUsd,AVG(vol6h_usd) AS vol6hUsd,AVG(vol24h_usd) AS vol24hUsd
    FROM pool_market_snapshots WHERE pool=? AND ts>=?
    GROUP BY CAST(ts/3600 AS INTEGER) ORDER BY ts`)
  const recentTickQ = db.prepare('SELECT ts,tick FROM pool_tick_samples WHERE pool=? AND ts>=? ORDER BY ts')
  const historicTickQ = db.prepare(`SELECT sample.ts,sample.tick FROM pool_tick_samples sample
    JOIN (
      SELECT MAX(ts) AS ts FROM pool_tick_samples
      WHERE pool=? AND ts>=? AND ts<? GROUP BY CAST(ts/600 AS INTEGER)
    ) bucket ON bucket.ts=sample.ts
    WHERE sample.pool=? ORDER BY sample.ts`)
  const up = db.prepare('SELECT price_usd FROM tokens WHERE address=?').get('0x57c0e45cb534413d1c20a4240955d6bb250bb4f1') as { price_usd: number | null } | undefined
  const weth = ADDR.WETH.toLowerCase()
  const usdg = ADDR.USDG.toLowerCase()
  return {
    ready: kvGet('ready') === '1',
    asof: Math.floor(Date.now() / 1000),
    candidates: rows.map((row) => ({
      pool: row.address,
      protocol: row.proto === 'up33cl' ? 'up33' : 'univ3',
      token0: row.token0, token1: row.token1,
      symbol0: row.symbol0, symbol1: row.symbol1,
      decimals0: row.decimals0, decimals1: row.decimals1,
      token0Usd: row.token0_usd, token1Usd: row.token1_usd,
      token0IsRisk: row.token1 === usdg ? true : row.token0 === usdg ? false : row.token0 === weth ? false : true,
      hasStableQuote: row.token0 === usdg || row.token1 === usdg,
      feePpm: row.fee_ppm, unstakedFeePpm: row.unstaked_fee_ppm,
      tickSpacing: row.tick_spacing, tick: row.tick, sqrtPriceX96: row.sqrt_price,
      liquidity: row.liquidity, stakedLiquidity: row.staked_liquidity,
      tvlUsd: row.tvl_usd, vol1hUsd: row.vol1h_usd, vol6hUsd: row.vol6h_usd, vol24hUsd: row.vol24h_usd,
      statsUpdatedAt: row.stats_updated, stateUpdatedAt: row.state_updated,
      gaugeAlive: row.gauge_alive === 1, rewardRate: row.reward_rate, periodFinish: row.period_finish,
      upUsd: up?.price_usd ?? null,
      marketHistory: marketQ.all(row.address, marketSince),
      tickHistory: [
        ...historicTickQ.all(row.address, tickSince, now - 30 * 3_600, row.address),
        ...recentTickQ.all(row.address, now - 30 * 3_600),
      ],
    })),
  }
}

export function startApi(): void {
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now()
    try {
      const url = new URL(req.url ?? '/', 'http://indexer')
      if (req.method !== 'GET') {
        res.writeHead(405, JSONH)
        res.end('{"error":"GET only"}')
        return
      }
      let body: unknown
      let cache = 'public, max-age=10'
      if (url.pathname === '/api/pools') {
        notePoolsHit() // open the frontpage-sweep demand gate
        body = getPools(url.searchParams)
      }
      else if (url.pathname === '/api/tokens') body = getTokens(url.searchParams)
      else if (url.pathname === '/api/prices') {
        body = getPrices(url.searchParams)
        cache = 'public, max-age=15'
      }
      else if (url.pathname === '/api/recommendation-candidates') {
        body = getRecommendationCandidates(url.searchParams)
        cache = 'public, max-age=30'
      }
      else if (url.pathname === '/api/health') {
        body = getHealth()
        cache = 'no-store'
      } else {
        res.writeHead(404, JSONH)
        res.end('{"error":"not found"}')
        return
      }
      res.writeHead(200, { ...JSONH, 'cache-control': cache })
      res.end(JSON.stringify(body))
      if (Date.now() - started > 500) log(`[api] slow ${url.pathname} ${Date.now() - started}ms`)
    } catch (e) {
      res.writeHead(500, JSONH)
      res.end(JSON.stringify({ error: String(e) }))
    }
  })
  srv.listen(PORT, '127.0.0.1', () => log(`[api] listening on 127.0.0.1:${PORT}`))
}
