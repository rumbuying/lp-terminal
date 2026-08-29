// APR math — pool-level columns AND per-position add-LP simulation.
//
// ve(3,3) ground rules (see docs/up33-contract-map.md):
//   fees  -> UNSTAKED LPs only (CL pays a 10% default levy); staked LPs' fees go to voters
//   UP    -> STAKED LPs only, pro-rata ACTIVE (in-range) staked liquidity, post-cap rewardRate
// A position earns one or the other, never both.
import { zeroAddress } from 'viem'
import { ADDR, GOV } from '../config/addresses'
import { sqrtPriceToPrice } from './clmath'
import { nowSec } from './format'
import { effectiveClFeePpm } from './poolIdentity'
import type { PoolStat } from './poolstats'
import type { ClPool, Pool, V2Pool } from '../types'

const YEAR = 31_536_000

export type VolumeWindow = 'm5' | 'h1' | 'h6' | 'h24'

export function volumeWindowLabel(window: VolumeWindow): string {
  return window === 'm5' ? '5M' : `${window.slice(1)}H`
}

const VOLUME_FIELD: Record<VolumeWindow, keyof Pick<PoolStat, 'vol5mUsd' | 'vol1hUsd' | 'vol6hUsd' | 'vol24hUsd'>> = {
  m5: 'vol5mUsd',
  h1: 'vol1hUsd',
  h6: 'vol6hUsd',
  h24: 'vol24hUsd',
}

const WINDOW_SECONDS: Record<VolumeWindow, number> = {
  m5: 5 * 60,
  h1: 60 * 60,
  h6: 6 * 60 * 60,
  h24: 24 * 60 * 60,
}

export function volumeOf(stat: PoolStat | undefined, window: VolumeWindow): number | null {
  return stat?.[VOLUME_FIELD[window]] ?? null
}

export function feesOf(p: Pool, stat: PoolStat | undefined, window: VolumeWindow): number | null {
  const volume = volumeOf(stat, window)
  if (volume == null) return null
  const feePct = p.kind === 'v2' ? p.feeBps / 100 : effectiveClFeePpm(p) / 10_000
  return (volume * feePct) / 100
}

export function fees24Of(p: Pool, stat?: PoolStat): number | null {
  return feesOf(p, stat, 'h24')
}

/** pool-average fee APR for an UNSTAKED LP (net of the CL unstaked levy) */
export function feeAprOf(p: Pool, stat?: PoolStat, window: VolumeWindow = 'h24'): number | null {
  if (stat?.liqUsd == null || stat.liqUsd <= 0) return null
  const grossFees = feesOf(p, stat, window)
  if (grossFees == null) return null
  const keep = p.kind === 'cl' ? 1 - p.unstakedFeePpm / 1e6 : 1
  return ((grossFees * keep * (YEAR / WINDOW_SECONDS[window])) / stat.liqUsd) * 100
}

export function stakedShareOf(p: Pool): number {
  if (p.kind === 'v2') return p.totalSupply > 0n ? Number(p.gaugeTotalSupply) / Number(p.totalSupply) : 0
  return p.liquidity > 0n ? Number(p.stakedLiquidity) / Number(p.liquidity) : 0
}

function isEmitting(p: Pool): boolean {
  return p.rewardRate > 0n && p.periodFinish > BigInt(nowSec())
}

function upPerYearUsd(p: Pool, upUsd: number): number {
  return (Number(p.rewardRate) / 1e18) * YEAR * upUsd
}

/** pool-average emissions APR for a STAKED LP (Infinity = ~zero staked TVL) */
export function emitAprOf(p: Pool, stat: PoolStat | undefined, upUsd: number | undefined): number | null {
  if (!upUsd || stat?.liqUsd == null || stat.liqUsd <= 0) return null
  if (!isEmitting(p)) return null
  const stakedTvl = stat.liqUsd * stakedShareOf(p)
  if (stakedTvl < 0.01) return Infinity
  return (upPerYearUsd(p, upUsd) / stakedTvl) * 100
}

export function fmtApr(x: number): string {
  if (Number.isNaN(x)) return '—'
  if (!Number.isFinite(x)) return '∞'
  // dust-TVL pools produce absurd APRs — cap the string so table columns
  // never get stretched by a meaningless number
  if (x >= 10_000) return '>9,999%'
  if (x >= 1000) return Math.round(x).toLocaleString('en-US') + '%'
  if (x >= 10) return x.toFixed(0) + '%'
  return x.toFixed(2) + '%'
}

export type ClTokenUsd = {
  p0: number
  p1: number
  /** the side that carried a price in from outside; the other came from the pool */
  anchor: 0 | 1
  /** the anchor is the $1 stable, so the pool's own price IS the dollar price */
  exact: boolean
}

export type TokenUsdMap = Record<string, number | undefined>

const validUsd = (price: number | null | undefined): price is number =>
  price !== null && price !== undefined && Number.isFinite(price) && price > 0

/**
 * USD prices of a CL pool's two tokens via USDG($1) / WETH / UP anchors.
 *
 * One side has to arrive from outside; the pool supplies the other, because the
 * pool's price is the exchange rate between them. Which side that is decides how
 * much the answer can drift: against the $1 stable the pool price is the dollar
 * price outright, while against WETH it rides on a WETH/USD read from
 * dexscreener and moves whenever ETH does.
 *
 * So when both tokens can anchor — every WETH/stable pool — the stable wins. It
 * costs nothing and it takes the drift out of the pair people quote most.
 */
export function clTokenUsd(
  pool: ClPool,
  dec0: number,
  dec1: number,
  upUsd?: number,
  wethUsd?: number | null,
  tokenUsd?: TokenUsdMap,
): ClTokenUsd | null {
  const token0 = pool.token0.toLowerCase()
  const token1 = pool.token1.toLowerCase()
  const direct0 = tokenUsd?.[token0]
  const direct1 = tokenUsd?.[token1]
  if (validUsd(direct0) && validUsd(direct1))
    return { p0: direct0, p1: direct1, anchor: 0, exact: false }

  const anchors: Record<string, number | undefined> = {
    [ADDR.STABLE.toLowerCase()]: 1,
    [ADDR.WNATIVE.toLowerCase()]: wethUsd ?? undefined,
    ...(pool.protocol === 'univ4' ? { [zeroAddress]: wethUsd ?? undefined } : {}),
    ...(GOV ? { [GOV.UP.toLowerCase()]: upUsd } : {}),
  }
  const P = sqrtPriceToPrice(pool.sqrtPriceX96, dec0, dec1) // token1 per 1 token0
  if (!Number.isFinite(P) || P <= 0) return null
  const stable = ADDR.STABLE.toLowerCase()
  const t0 = token0
  const t1 = token1
  if (validUsd(direct0)) return { p0: direct0, p1: direct0 / P, anchor: 0, exact: false }
  if (validUsd(direct1)) return { p0: P * direct1, p1: direct1, anchor: 1, exact: false }
  const a0 = anchors[t0]
  const a1 = anchors[t1]
  const from0: ClTokenUsd | null =
    a0 !== undefined && a0 > 0 ? { p0: a0, p1: a0 / P, anchor: 0, exact: t0 === stable } : null
  const from1: ClTokenUsd | null =
    a1 !== undefined && a1 > 0 ? { p0: P * a1, p1: a1, anchor: 1, exact: t1 === stable } : null
  if (from1?.exact) return from1
  return from0 ?? from1
}

export type AddSim = {
  depositUsd: number
  feeApr: number // NaN when volume unknown — YOUR unstaked net fee APR while in range
  emitApr: number // NaN when UP price unknown / not emitting — YOUR staked APR while in range
  sharePct: number // your share of active liquidity (fee basis)
  inRange: boolean
}

/**
 * Simulate YOUR APRs for a prospective CL position. Unlike the pool columns
 * this is position-specific: your liquidity L (from amounts × range width)
 * captures concentration — a narrow range packs more L per dollar — and your L
 * is added to the denominators, capturing dilution.
 *   fee share  = L / (activeLiquidity + L)         (× vol × fee × (1−levy))
 *   emit share = L / (stakedLiquidity + L)         (× rewardRate × UP price)
 * Both hold only while price stays inside your range.
 */
export function simulateClAdd(args: {
  pool: ClPool
  tickLower: number
  tickUpper: number
  liquidity: bigint
  amount0h: number // human units
  amount1h: number
  dec0: number
  dec1: number
  stat?: PoolStat
  upUsd?: number
  wethUsd?: number | null
  volumeWindow?: VolumeWindow
}): AddSim | null {
  const { pool, liquidity } = args
  if (liquidity <= 0n) return null
  const px = clTokenUsd(pool, args.dec0, args.dec1, args.upUsd, args.wethUsd)
  if (!px) return null
  const depositUsd = args.amount0h * px.p0 + args.amount1h * px.p1
  if (!(depositUsd > 0)) return null
  const inRange = pool.tick >= args.tickLower && pool.tick < args.tickUpper
  if (!inRange) return { depositUsd, feeApr: 0, emitApr: 0, sharePct: 0, inRange: false }
  const L = Number(liquidity)
  const feeShare = L / (Number(pool.liquidity) + L)
  const emitShare = L / (Number(pool.stakedLiquidity) + L)
  const keep = 1 - pool.unstakedFeePpm / 1e6
  const volumeWindow = args.volumeWindow ?? 'h24'
  const windowFees = feesOf(pool, args.stat, volumeWindow)
  const feeApr =
    windowFees == null
      ? NaN
      : ((windowFees * (YEAR / WINDOW_SECONDS[volumeWindow]) * keep * feeShare) / depositUsd) * 100
  const emitApr =
    !args.upUsd || !isEmitting(pool)
      ? NaN
      : ((upPerYearUsd(pool, args.upUsd) * emitShare) / depositUsd) * 100
  return { depositUsd, feeApr, emitApr, sharePct: feeShare * 100, inRange: true }
}

/** Simulate YOUR APRs for a v2 add: pool APRs diluted by your deposit. */
export function simulateV2Add(args: {
  pool: V2Pool
  amount0h: number
  amount1h: number
  dec0: number
  dec1: number
  stat?: PoolStat
  upUsd?: number
  volumeWindow?: VolumeWindow
}): AddSim | null {
  const { pool, stat } = args
  if (stat?.liqUsd == null || stat.liqUsd <= 0) return null
  const r0h = Number(pool.reserve0) / 10 ** args.dec0
  const r1h = Number(pool.reserve1) / 10 ** args.dec1
  if (!(r0h > 0) || !(r1h > 0)) return null
  // v2 pools sit ~50/50 by value — price each token off its half of TVL
  const p0 = stat.liqUsd / 2 / r0h
  const p1 = stat.liqUsd / 2 / r1h
  const depositUsd = args.amount0h * p0 + args.amount1h * p1
  if (!(depositUsd > 0)) return null
  const volumeWindow = args.volumeWindow ?? 'h24'
  const windowFees = feesOf(pool, stat, volumeWindow)
  const feeApr =
    windowFees == null
      ? NaN
      : ((windowFees * (YEAR / WINDOW_SECONDS[volumeWindow])) / (stat.liqUsd + depositUsd)) * 100
  const stakedTvl = stat.liqUsd * stakedShareOf(pool)
  const emitApr =
    !args.upUsd || !isEmitting(pool)
      ? NaN
      : (upPerYearUsd(pool, args.upUsd) / (stakedTvl + depositUsd)) * 100
  return {
    depositUsd,
    feeApr,
    emitApr,
    sharePct: (depositUsd / (stat.liqUsd + depositUsd)) * 100,
    inRange: true,
  }
}
