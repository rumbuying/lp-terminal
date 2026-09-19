// Emerging behavior/market metrics — pure half (docs/EMERGING-POOL-LP-PRD
// .zh-CN.md §5.4, §6.2, EMG-B02). No I/O, no clock: every function takes its
// series and reads its cut-offs from EMERGING_THRESHOLDS, so the
// classification a signal cites is exactly what the tests pinned (the
// volumeTrend.ts discipline).
//
// Wording contract (§5.4): the passing grade is `low_observed` — “未发现指
// 定异常” in every surface — never “真实量” or “安全”. A classification is
// an anomaly SCREEN, not a fraud verdict.
import { EMERGING_THRESHOLDS as T } from './emergingPolicy'

// --- §5.4 behavior risk ---

export type BehaviorTrade = {
  ts: number
  /** Quote-side volume, always positive (the trade's size in quote units). */
  volumeQuote: bigint
  /** Trade direction in the base token: buy = base acquired. */
  direction: 'buy' | 'sell'
  /** Resolved economic actor (lowercase), or null = unresolved/route-only. */
  actor: string | null
}

export type BehaviorRiskClass = 'low_observed' | 'suspect' | 'unknown'

export type BehaviorAssessment = {
  class: BehaviorRiskClass
  trades: number
  uniqueActors: number
  unknownVolumeShare: number
  maxActorVolumeShare: number
  maxSingleTradeShare: number
  roundTripShare: number
  reasons: string[]
}

/**
 * Round-trip pairing (§5.4): same actor, opposite direction, inside the
 * window, quote sizes within tolerance; first-come-first-paired, and a trade
 * pairs at most once. Returns the paired volume over the total.
 */
export function roundTripShare(
  trades: Array<{ ts: number; direction: 'buy' | 'sell'; volumeQuote: bigint; actor: string | null }>,
): number {
  const window = T.roundTripWindowSec * 1000
  const tol = T.roundTripSizeTolerance
  const byActor = new Map<string, Array<{ i: number; ts: number; direction: 'buy' | 'sell'; v: bigint }>>()
  trades.forEach((t, i) => {
    if (t.actor === null || t.volumeQuote <= 0n) return
    const list = byActor.get(t.actor) ?? []
    list.push({ i, ts: t.ts, direction: t.direction, v: t.volumeQuote })
    byActor.set(t.actor, list)
  })
  const paired = new Set<number>()
  let pairedVolume = 0n
  let totalVolume = 0n
  for (const t of trades) totalVolume += t.volumeQuote
  for (const [, list] of byActor) {
    for (let a = 0; a < list.length; a++) {
      const x = list[a]
      if (paired.has(x.i)) continue
      for (let b = a + 1; b < list.length; b++) {
        const y = list[b]
        if (paired.has(x.i) || paired.has(y.i)) continue
        if (y.direction === x.direction) continue
        if (y.ts - x.ts > window) continue
        const diff = x.v > y.v ? x.v - y.v : y.v - x.v
        if (Number(diff) / Number(x.v > y.v ? x.v : y.v) <= tol) {
          paired.add(x.i)
          paired.add(y.i)
          pairedVolume += x.v < y.v ? x.v : y.v
          break
        }
      }
    }
  }
  return totalVolume === 0n ? 0 : Number(pairedVolume) / Number(totalVolume)
}

/**
 * §5.4 behavior classification over one pool's quote-side trades. `trades`
        must cover COMPLETE hours of resolved-and-raw swap data; a data gap is
 * the caller's `hasDataGap` flag and forces `unknown` (§3.2: 未扫描 ≠ 零).
 */
export function assessBehavior(args: {
  trades: BehaviorTrade[]
  hasDataGap: boolean
}): BehaviorAssessment {
  const { trades } = args
  const reasons: string[] = []
  const total = trades.reduce((a, t) => a + t.volumeQuote, 0n)
  const unknownVolume = trades.reduce((a, t) => a + (t.actor === null ? t.volumeQuote : 0n), 0n)
  const unknownShare = total === 0n ? 0 : Number(unknownVolume) / Number(total)

  const byActor = new Map<string, bigint>()
  let maxSingle = 0n
  for (const t of trades) {
    if (t.actor !== null) byActor.set(t.actor, (byActor.get(t.actor) ?? 0n) + t.volumeQuote)
    if (t.volumeQuote > maxSingle) maxSingle = t.volumeQuote
  }
  const maxActorShare = total === 0n ? 0 : Number([...byActor.values()].reduce((a, b) => (a > b ? a : b), 0n)) / Number(total)
  const maxSingleShare = total === 0n ? 0 : Number(maxSingle) / Number(total)
  const rt = roundTripShare(trades.map((t) => ({
    ts: t.ts, direction: t.direction, volumeQuote: t.volumeQuote, actor: t.actor,
  })))

  const a: BehaviorAssessment = {
    class: 'low_observed',
    trades: trades.length,
    uniqueActors: byActor.size,
    unknownVolumeShare: unknownShare,
    maxActorVolumeShare: maxActorShare,
    maxSingleTradeShare: maxSingleShare,
    roundTripShare: rt,
    reasons,
  }
  if (args.hasDataGap) { a.class = 'unknown'; reasons.push('data_gap') }
  if (unknownShare > T.maxUnknownActorVolume) {
    a.class = 'unknown'
    reasons.push(`unknown_volume>${T.maxUnknownActorVolume}`)
  }
  if (maxActorShare > T.maxActorVolumeShare) {
    a.class = 'suspect'
    reasons.push(`actor_share>${T.maxActorVolumeShare}`)
  }
  if (maxSingleShare > T.maxSingleTradeShare) {
    a.class = 'suspect'
    reasons.push(`single_trade>${T.maxSingleTradeShare}`)
  }
  if (rt > T.maxRoundTripShare) {
    a.class = 'suspect'
    reasons.push(`round_trip>${T.maxRoundTripShare}`)
  }
  return a
}

// --- §6.2 retention: twelve complete hours ---

export type RetentionAssessment = {
  pass: boolean
  reasons: string[]
  aMean: number
  bMean: number
  latest: number
  mMean: number
}

/**
 * §6.2: over the 12 COMPLETE hours after reductionConfirmedAt — first-6h mean
 * A, last-6h mean B, latest full hour V, first-11h mean M. Pass needs
 * A>0 ∧ B/A ≥ 0.5 ∧ V/M ≥ 0.35 ∧ every hour ≥ the quiet floor. A zero/missing
 * hour in the denominator is unknown-shaped input — callers must not feed it;
 * a zero A fails outright.
 */
export function assessRetention(hourlyQuoteVolume: number[], quietFloor: number): RetentionAssessment {
  const reasons: string[] = []
  const need = T.persistenceHours
  if (hourlyQuoteVolume.length !== need)
    return { pass: false, reasons: [`need_${need}_complete_hours`], aMean: 0, bMean: 0, latest: 0, mMean: 0 }
  const A = hourlyQuoteVolume.slice(0, 6).reduce((a, b) => a + b, 0) / 6
  const B = hourlyQuoteVolume.slice(6).reduce((a, b) => a + b, 0) / 6
  const V = hourlyQuoteVolume[need - 1]
  const M = hourlyQuoteVolume.slice(0, need - 1).reduce((a, b) => a + b, 0) / (need - 1)
  const pass =
    A > 0 &&
    B / A >= T.retentionRatioMin &&
    V / M >= T.collapseRatio &&
    hourlyQuoteVolume.every((v) => v >= quietFloor)
  if (A <= 0) reasons.push('A<=0')
  if (A > 0 && B / A < T.retentionRatioMin) reasons.push('B/A<0.5')
  if (V / M < T.collapseRatio) reasons.push('V/M<0.35')
  if (hourlyQuoteVolume.some((v) => v < quietFloor)) reasons.push('quiet_floor')
  return { pass, reasons, aMean: A, bMean: B, latest: V, mMean: M }
}

// --- §6.2 stabilization: 5-minute closes, σ ratio and rebound ---

export type PriceBar = { close: number; hasVolume: boolean }

export type StabilizationAssessment = {
  pass: boolean
  reasons: string[]
  sigmaA: number
  sigmaB: number
  sigmaRatio: number
  rebound: number
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

/**
 * §6.2 stabilization over the LAST 6h of 5-minute closes: adjacent-close log
 * returns where both bars traded; σA = first 3h, σB = last 3h (n−1). Pass
 * needs ≥24 valid returns per window, σA > 0, σB/σA ≤ 0.8, and last close ≥
 * anchorLow × (1 + max(5%, 2σB)) — σB stays on the 5-minute scale, never
 * annualized (§6.2).
 */
export function assessStabilization(bars: PriceBar[], anchorLow: number): StabilizationAssessment {
  const reasons: string[] = []
  const barsPerWindow = (T.stabilizationHours * 3600) / (T.priceBarMinutes * 60)
  const returns: number[] = []
  for (let i = 1; i < bars.length; i++) {
    if (!bars[i].hasVolume || !bars[i - 1].hasVolume) continue
    if (bars[i].close <= 0 || bars[i - 1].close <= 0) continue
    returns.push(Math.log(bars[i].close / bars[i - 1].close))
  }
  // §6.2 splits the 6h window into FIRST-3h (σA) and LAST-3h (σB) halves.
  const half = Math.floor(barsPerWindow / 2)
  const winA = returns.slice(0, half)
  const winB = returns.length > half ? returns.slice(returns.length - half) : []
  const sigmaA = stdev(winA)
  const sigmaB = stdev(winB)
  const ratio = sigmaA > 0 ? sigmaB / sigmaA : Infinity
  const lastClose = bars.length ? bars[bars.length - 1].close : 0
  const rebound = anchorLow > 0 ? lastClose / anchorLow - 1 : -1
  const reboundNeed = Math.max(T.reboundMin, T.reboundSigmaMultiplier * (Number.isFinite(sigmaB) ? sigmaB : 0))

  const pass =
    winA.length >= T.minReturnSamplesPerWindow &&
    winB.length >= T.minReturnSamplesPerWindow &&
    sigmaA > 0 &&
    ratio <= T.sigmaRatioMax &&
    rebound >= reboundNeed
  if (winA.length < T.minReturnSamplesPerWindow || winB.length < T.minReturnSamplesPerWindow)
    reasons.push(`returns<${T.minReturnSamplesPerWindow}`)
  if (sigmaA <= 0) reasons.push('sigmaA<=0')
  if (ratio > T.sigmaRatioMax) reasons.push('sigmaB/sigmaA>0.8')
  if (rebound < reboundNeed) reasons.push(`rebound<${reboundNeed.toFixed(4)}`)
  return { pass, reasons, sigmaA, sigmaB, sigmaRatio: Number.isFinite(ratio) ? ratio : Infinity, rebound }
}
