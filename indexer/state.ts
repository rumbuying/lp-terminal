// On-chain state sweeps + USD pricing.
//
// State per pool (multicall):
//   univ3: slot0 + liquidity + erc20 balanceOf(token0/1) — balances (not L)
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
import { erc20Abi, formatUnits } from 'viem'
import { clGaugeAbi, clPoolAbi, erc20Abi as appErc20Abi, uniV2PairAbi, uniV3PoolAbi, voterAbi } from '../src/abi'
import { ADDR, TUNE, log, now } from './config'
import { mc, ok, type Call } from './rpc'
import {
  allTokens,
  clearDerivedPrices,
  db,
  missingMetaTokens,
  setTokenPrice,
  setTvl,
  tx,
  upsertState,
  upsertTokenMeta,
  type PoolRow,
} from './store'

const printable = (s: unknown): string | null => {
  if (typeof s !== 'string') return null
  const t = s.replace(/[^\x20-\x7e]/g, '').trim()
  return t ? t.slice(0, 24) : null
}

/** fetch symbol/decimals for catalog tokens we haven't met yet (10k/slice) */
export async function ensureTokenMeta(): Promise<number> {
  const all = missingMetaTokens()
  for (let i = 0; i < all.length; i += 10_000) {
    const missing = all.slice(i, i + 10_000)
    const res = await mc(
      missing.flatMap((t) => [
        { abi: erc20Abi, address: t as `0x${string}`, functionName: 'symbol' },
        { abi: erc20Abi, address: t as `0x${string}`, functionName: 'decimals' },
      ]),
    )
    tx(() => {
      missing.forEach((t, j) => {
        const sym = printable(ok<string>(res[j * 2]))
        const dec = ok<number>(res[j * 2 + 1])
        upsertTokenMeta(t, sym ?? t.slice(0, 6) + '…', dec ?? 18, sym !== null && dec !== undefined)
      })
    })
  }
  return all.length
}

const poolRowsQ = (addrs: string[]): PoolRow[] => {
  const out: PoolRow[] = []
  const q = db.prepare('SELECT address, proto, token0, token1, fee_ppm, unstaked_fee_ppm, tick_spacing, gauge FROM pools WHERE address = ?')
  for (const a of addrs) {
    const r = q.get(a.toLowerCase()) as PoolRow | undefined
    if (r) out.push(r)
  }
  return out
}

/** refresh raw on-chain state for the given pools (memory-bounded slices) */
export async function sweepState(addrs: string[]): Promise<number> {
  let done = 0
  for (let i = 0; i < addrs.length; i += 5_000) {
    done += await sweepSlice(addrs.slice(i, i + 5_000))
  }
  if (done < addrs.length)
    log(`[sweep] ${done}/${addrs.length} pools updated; kept last-good state for ${addrs.length - done}`)
  return done
}

async function sweepSlice(addrs: string[]): Promise<number> {
  if (!addrs.length) return 0
  const rows = poolRowsQ(addrs)
  const calls: Call[] = []
  for (const p of rows) {
    const a = p.address as `0x${string}`
    if (p.proto === 'univ3')
      calls.push(
        { abi: uniV3PoolAbi, address: a, functionName: 'slot0' },
        { abi: uniV3PoolAbi, address: a, functionName: 'liquidity' },
        { abi: erc20Abi, address: p.token0 as `0x${string}`, functionName: 'balanceOf', args: [a] },
        { abi: erc20Abi, address: p.token1 as `0x${string}`, functionName: 'balanceOf', args: [a] },
      )
    else if (p.proto === 'up33cl')
      calls.push(
        { abi: clPoolAbi, address: a, functionName: 'slot0' },
        { abi: clPoolAbi, address: a, functionName: 'liquidity' },
        { abi: clPoolAbi, address: a, functionName: 'stakedLiquidity' },
        { abi: appErc20Abi, address: p.token0 as `0x${string}`, functionName: 'balanceOf', args: [a] },
        { abi: appErc20Abi, address: p.token1 as `0x${string}`, functionName: 'balanceOf', args: [a] },
        ...(p.gauge ? [
          { abi: clGaugeAbi, address: p.gauge as `0x${string}`, functionName: 'rewardRate' },
          { abi: clGaugeAbi, address: p.gauge as `0x${string}`, functionName: 'periodFinish' },
          { abi: voterAbi, address: ADDR.VOTER, functionName: 'isAlive', args: [p.gauge as `0x${string}`] },
        ] : []),
      )
    else
      calls.push(
        { abi: uniV2PairAbi, address: a, functionName: 'getReserves' },
        { abi: uniV2PairAbi, address: a, functionName: 'totalSupply' },
      )
  }
  const res = await mc(calls)
  let i = 0
  let done = 0
  tx(() => {
    for (const p of rows) {
      if (p.proto === 'univ3') {
        const s0 = ok<readonly [bigint, number, ...unknown[]]>(res[i++])
        const liq = ok<bigint>(res[i++])
        const b0 = ok<bigint>(res[i++])
        const b1 = ok<bigint>(res[i++])
        if (!s0 || liq === undefined || b0 === undefined || b1 === undefined) continue
        upsertState(p.address, {
          sqrtPrice: s0[0],
          tick: s0[1],
          liquidity: liq,
          reserve0: b0,
          reserve1: b1,
        })
        done++
      } else if (p.proto === 'up33cl') {
        const s0 = ok<readonly [bigint, number, ...unknown[]]>(res[i++])
        const liq = ok<bigint>(res[i++])
        const staked = ok<bigint>(res[i++])
        const b0 = ok<bigint>(res[i++])
        const b1 = ok<bigint>(res[i++])
        const rewardRate = p.gauge ? ok<bigint>(res[i++]) : 0n
        const periodFinish = p.gauge ? ok<bigint>(res[i++]) : 0n
        const gaugeAlive = p.gauge ? ok<boolean>(res[i++]) : false
        if (!s0 || liq === undefined || staked === undefined || b0 === undefined || b1 === undefined) continue
        upsertState(p.address, {
          sqrtPrice: s0[0], tick: s0[1], liquidity: liq, stakedLiquidity: staked,
          rewardRate: rewardRate ?? 0n, periodFinish: periodFinish ?? 0n, gaugeAlive: gaugeAlive ?? false,
          reserve0: b0, reserve1: b1,
        })
        done++
      } else {
        const rs = ok<readonly [bigint, bigint, number]>(res[i++])
        const ts = ok<bigint>(res[i++])
        if (!rs || ts === undefined) continue
        upsertState(p.address, { reserve0: rs[0], reserve1: rs[1], totalSupply: ts })
        done++
      }
    }
  })
  return done
}

/** `hops` = distance from a credible seed: 0 = GT/anchor, 1..n = propagated */
type PriceEntry = { usd: number; depth: number; src: string; hops: number }

/** a price outside this band is a broken pool, not a market */
export const plausibleUsd = (x: number | null | undefined): x is number =>
  x != null && Number.isFinite(x) && x >= TUNE.minTokenUsd && x <= TUNE.maxTokenUsd

/**
 * Seeds for a pricing pass: GT + anchor ONLY. Pool-derived prices are rebuilt
 * from scratch every time — inheriting one (with the depth it claimed) is what
 * made poisoning permanent, since nothing honest could ever outbid it again.
 */
const loadSeeds = (): Map<string, PriceEntry> => {
  const m = new Map<string, PriceEntry>()
  for (const t of allTokens())
    if (t.price_src && t.price_src !== 'pool' && plausibleUsd(t.price_usd))
      m.set(t.address, { usd: t.price_usd!, depth: t.price_depth_usd, src: t.price_src, hops: 0 })
  return m
}

type StateRow = {
  address: string
  proto: string
  token0: string
  token1: string
  reserve0: string
  reserve1: string
  sqrt_price: string | null
  liquidity: string | null
  tick: number | null
}
const statesQ = () =>
  db
    .prepare(
      `SELECT p.address, p.proto, p.token0, p.token1, s.reserve0, s.reserve1, s.sqrt_price, s.liquidity, s.tick
       FROM pools p JOIN pool_state s ON s.address = p.address`,
    )
    .all() as StateRow[]

const Q96 = 2 ** 96
/** univ3 spot from slot0: HUMAN token1 per token0 (null when absent/degenerate) */
export function v3Price1Per0(sqrtPrice: string | null, dec0: number, dec1: number): number | null {
  if (!sqrtPrice) return null
  const r = Number(sqrtPrice) / Q96
  const p = r * r * 10 ** (dec0 - dec1)
  return Number.isFinite(p) && p > 0 ? p : null
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
  if (tick === null || Math.abs(tick) > TUNE.maxAbsTick) return false
  try {
    return liquidity !== null && BigInt(liquidity) > 0n
  } catch {
    return false
  }
}

/** HUMAN token1-per-token0 spot, or null when this pool may not set a price */
const spotOf = (s: StateRow, b0: number, b1: number, decs: Map<string, number>): number | null => {
  if (s.proto !== 'univ3' && s.proto !== 'up33cl') return b0 > 0 && b1 > 0 ? b1 / b0 : null
  if (!v3SpotOk(s.liquidity, s.tick)) return null
  return v3Price1Per0(s.sqrt_price, decs.get(s.token0) ?? 18, decs.get(s.token1) ?? 18)
}

/**
 * Depth-weighted median of a token's candidate quotes. A single manipulated
 * pool now has to bring more than half the credible depth backing a token to
 * move its price — with "deepest wins" it only had to claim a bigger number.
 */
export function weightedMedian(quotes: readonly { usd: number; depth: number }[]): number {
  if (quotes.length === 1) return quotes[0].usd
  const sorted = [...quotes].sort((a, b) => a.usd - b.usd)
  const half = sorted.reduce((a, q) => a + q.depth, 0) / 2
  let acc = 0
  for (const q of sorted) {
    acc += q.depth
    if (acc >= half) return q.usd
  }
  return sorted[sorted.length - 1].usd
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
  let capped = false
  if (u0 != null && u0 > cap0) {
    u0 = cap0
    capped = true
  }
  if (u1 != null && u1 > cap1) {
    u1 = cap1
    capped = true
  }
  const bounded = (r: { tvl: number | null; approx: boolean }) => (capped ? { ...r, approx: true } : r)
  if (u0 == null && u1 == null) return { tvl: null, approx: false }
  if (u0 == null || u1 == null) return { tvl: (u0 ?? u1)! * 2, approx: true }
  if (cred0 !== cred1) {
    const cu = cred0 ? u0 : u1
    const ju = cred0 ? u1 : u0
    if (ju > cu * TUNE.maxUncredibleRatio) return { tvl: cu * 2, approx: true }
  } else if (!cred0 && !cred1) {
    const lo = Math.min(u0, u1)
    if (Math.max(u0, u1) > lo * TUNE.maxUncredibleRatio) return { tvl: lo * 2, approx: true }
  }
  return bounded({ tvl: u0 + u1, approx: false })
}

const credible = (e?: PriceEntry) => !!e && e.src !== 'pool'
/** ceiling on what a pool-priced side may claim; credible seeds are unbounded */
const capOf = (e?: PriceEntry) => (e && e.src === 'pool' ? e.depth * TUNE.maxSideOverDepth : Infinity)

/** at most this many quotes retained per token per hop (memory bound) */
const MAX_QUOTES = 32

/**
 * Full pricing pass: BFS USD prices out from the GT/anchor seeds, then
 * recompute every pool's TVL. Pure JS over in-memory rows (~230k pools), runs
 * after full sweeps and after each GT cycle. Pool-derived prices are discarded
 * and rebuilt from scratch on every call — see the rails in the file header.
 */
export function reprice(): { priced: number; tvlPools: number } {
  const decs = new Map(allTokens().map((t) => [t.address, t.decimals]))
  const prices = loadSeeds()
  // bootstrap anchor before the first GT cycle: USDG ≈ $1 (GT overwrites it)
  if (!prices.has(ADDR.USDG.toLowerCase()))
    prices.set(ADDR.USDG.toLowerCase(), { usd: 1, depth: 1, src: 'anchor', hops: 0 })

  // Balances and spot are decoded ONCE — every pool is walked maxPriceHops
  // times plus once more for TVL, and formatUnits+BigInt per visit was the
  // pass's whole GC bill (the container's heap cap is 448MB).
  const human = (raw: string, addr: string) => Number(formatUnits(BigInt(raw), decs.get(addr) ?? 18))
  const states = statesQ().map((s) => {
    const b0 = human(s.reserve0, s.token0)
    const b1 = human(s.reserve1, s.token1)
    return { s, b0, b1, spot: spotOf(s, b0, b1, decs) }
  })

  // hop 1 = priced directly against a seed, hop 2 = against a hop-1 token, ...
  // A token settles at the FIRST hop that can price it and is never revisited,
  // so a long chain of junk pools can never displace a nearer honest quote.
  const derived = new Map<string, PriceEntry>()
  for (let hop = 1; hop <= TUNE.maxPriceHops; hop++) {
    const quotes = new Map<string, { usd: number; depth: number }[]>()
    for (const { s, b0, b1, spot: p1per0 } of states) {
      if (p1per0 === null) continue
      for (const [known, other, kb, ob, knownIs0] of [
        [s.token0, s.token1, b0, b1, true],
        [s.token1, s.token0, b1, b0, false],
      ] as const) {
        const kp = prices.get(known)
        if (!kp || kp.hops !== hop - 1 || ob <= 0 || prices.has(other)) continue
        // credible dollars only: past the seeds a quote is worth no more than
        // the depth backing the side it came from, so an inflated price can no
        // longer inflate its own authority
        const depth = kp.hops === 0 ? kb * kp.usd : Math.min(kb * kp.usd, kp.depth)
        if (!Number.isFinite(depth) || !(depth >= TUNE.minDepthUsd)) continue
        const usd = knownIs0 ? kp.usd / p1per0 : kp.usd * p1per0
        if (!plausibleUsd(usd)) continue
        const list = quotes.get(other)
        if (!list) quotes.set(other, [{ usd, depth }])
        else if (list.push({ usd, depth }) > MAX_QUOTES * 2) {
          list.sort((a, b) => b.depth - a.depth)
          list.length = MAX_QUOTES
        }
      }
    }
    if (!quotes.size) break
    for (const [addr, qs] of quotes) {
      const e: PriceEntry = {
        usd: weightedMedian(qs),
        depth: qs.reduce((m, q) => Math.max(m, q.depth), 0),
        src: 'pool',
        hops: hop,
      }
      if (plausibleUsd(e.usd) && Number.isFinite(e.depth)) {
        prices.set(addr, e)
        derived.set(addr, e)
      }
    }
  }

  let tvlPools = 0
  tx(() => {
    clearDerivedPrices() // no pool-derived price outlives the pass that made it
    for (const [addr, e] of derived) setTokenPrice(addr, e.usd, e.depth, e.src)
    for (const { s, b0, b1 } of states) {
      const p0 = prices.get(s.token0)
      const p1 = prices.get(s.token1)
      const u0 = p0 ? b0 * p0.usd : null
      const u1 = p1 ? b1 * p1.usd : null
      const { tvl, approx } = tvlOf(u0, credible(p0), u1, credible(p1), capOf(p0), capOf(p1))
      setTvl(s.address, tvl, approx)
      if (tvl != null) tvlPools++
    }
  })
  return { priced: prices.size, tvlPools }
}

/** cheap TVL refresh for a few pools using already-stored prices (no propagation) */
export function computeTvlFor(addrs: string[]): void {
  if (!addrs.length) return
  const q = db.prepare(
    `SELECT p.address, p.proto, p.token0, p.token1, s.reserve0, s.reserve1, s.sqrt_price, s.liquidity, s.tick
     FROM pools p JOIN pool_state s ON s.address = p.address WHERE p.address = ?`,
  )
  for (let offset = 0; offset < addrs.length; offset += 1_000) {
    const rows = addrs.slice(offset, offset + 1_000)
      .map((address) => q.get(address.toLowerCase()) as StateRow | undefined)
      .filter((row): row is StateRow => Boolean(row))
    const tokenAddrs = [...new Set(rows.flatMap((row) => [row.token0, row.token1]))]
    const tokenRows: { address: string; decimals: number; price_usd: number | null; price_depth_usd: number; price_src: string | null }[] = []
    for (let tokenOffset = 0; tokenOffset < tokenAddrs.length; tokenOffset += 500) {
      const chunk = tokenAddrs.slice(tokenOffset, tokenOffset + 500)
      tokenRows.push(...db.prepare(`SELECT address,decimals,price_usd,price_depth_usd,price_src FROM tokens
        WHERE address IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as typeof tokenRows)
    }
    const decs = new Map(tokenRows.map((token) => [token.address, token.decimals]))
    const prices = new Map<string, PriceEntry>()
    for (const token of tokenRows) if (plausibleUsd(token.price_usd)) prices.set(token.address, {
      usd: token.price_usd, depth: token.price_depth_usd, src: token.price_src ?? '?', hops: token.price_src === 'pool' ? 1 : 0,
    })
    tx(() => { for (const s of rows) {
      const human = (raw: string, addr: string) => Number(formatUnits(BigInt(raw), decs.get(addr) ?? 18))
      const p0 = prices.get(s.token0)
      const p1 = prices.get(s.token1)
      const u0 = p0 ? human(s.reserve0, s.token0) * p0.usd : null
      const u1 = p1 ? human(s.reserve1, s.token1) * p1.usd : null
      const { tvl, approx } = tvlOf(u0, credible(p0), u1, credible(p1), capOf(p0), capOf(p1))
      setTvl(s.address, tvl, approx)
    } })
  }
}

export const sweepLog = (label: string, n: number, ms: number) =>
  log(`[sweep] ${label} ${n} pools in ${(ms / 1000).toFixed(1)}s`)
