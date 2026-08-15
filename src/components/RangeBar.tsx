import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { binsForWidth, useElementWidth } from '../hooks/useElementWidth'
import { useOnScreen } from '../hooks/useOnScreen'
import { usePriceUnit } from '../hooks/usePriceUnit'
import { useTickLiquidity } from '../hooks/useTickLiquidity'
import { MAX_TICK, MIN_TICK, sqrtPriceToPrice, tickToPrice } from '../lib/clmath'
import { fmtNum } from '../lib/format'
import { binLiquidity, buildSegments } from '../lib/tickLiq'
import type { ClPool } from '../types'
import { Flash } from './Flash'
import { UnitToggle } from './UnitToggle'

// a bound within this many ticks of the tick-space extreme is a FULL-RANGE
// edge — its price is astronomical/zero, so render ∞/0 instead of the number.
// The widest tick spacing in use is ~200, so 1000 clears every aligned extreme
// without ever catching a real band (real bands sit near the current tick).
const UNBOUNDED_MARGIN = 1000
const INF = '∞'
/**
 * Depth columns behind the track — pitch, not count, because this track shares
 * its row with a price at each end and so is narrower than the add chart at
 * every screen size, phone most of all. 12px is tighter than the add chart's 16
 * since these columns are a backdrop, and a backdrop can afford to be finer.
 */
const BIN_PITCH = 12
const BIN_MIN = 10
// high enough that a full-width card still resolves at the stated pitch — at 48
// a 990px track stretched to 20.7px columns, which is the ceiling deciding the
// look rather than the rule
const BIN_MAX = 72

/**
 * The LP range bar:
 *   [lower price] ▕░░▓▓▓▓▓┃▓▓░░▏ [upper price]
 * - both ends are the position's price bounds
 * - the marker is the CURRENT pool price
 * - shows drift: % move to each bound, % position inside the range, and when
 *   out of range, the move needed to re-enter.
 * Marker position is linear in tick space; a padding zone on both sides makes
 * out-of-range drift visible instead of clamping at the border.
 *
 * Given a `pool`, the track also carries the liquidity ALREADY there, drawn as
 * columns behind everything else. For a position that exists, the band cannot
 * move, so the useful question is no longer where to put it — it is whether the
 * rest of the pool has crowded in around it since. That answer is a backdrop,
 * not a subject: it sits at a third of the weight the add chart gives it,
 * underneath the window, marker and trail that this bar is actually about.
 *
 * The reads are gated on the bar having been scrolled to. A wallet with
 * positions in a dozen pools would otherwise pay two multicalls per card at
 * first paint for cards nobody has looked at; react-query then shares one fetch
 * between every position sitting in the same pool and window.
 */
export function RangeBar(props: {
  tickLower: number
  tickUpper: number
  tick: number
  sqrtPriceX96: bigint
  dec0: number
  dec1: number
  sym0: string
  sym1: string
  /** order mode: this position is a range order — out-of-range is the intended
   *  resting state, so relabel the status instead of alarming in red */
  order?: { fillFrac: number; sellSym: string; buySym: string }
  /** draw the pool's depth behind the track; omitted, the track stays bare */
  pool?: ClPool
  /** anchors for the dollar reading — the pool supplies whichever side these don't */
  upUsd?: number
  wethUsd?: number | null
}) {
  const { t } = useTranslation()
  const { tickLower, tickUpper, tick, sqrtPriceX96, dec0, dec1, sym0, sym1, order, pool } = props
  // An order bar starts in the sell token's direction, which is what makes
  // "fills as it rises" true, so it opts out of the dollar default rather than
  // having its orientation decided for it. The toggle still overrides.
  const unit = usePriceUnit({
    pool: pool ?? null,
    dec0,
    dec1,
    upUsd: props.upUsd,
    wethUsd: props.wethUsd,
    defaultUsd: !order,
    defaultFlipped: order ? order.sellSym === sym1 : false,
  })
  const { usd, flipped, money } = unit
  const wrapRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const onScreen = useOnScreen(wrapRef)
  const binCount = binsForWidth(useElementWidth(trackRef), BIN_PITCH, BIN_MIN, BIN_MAX, 24)

  // prices in token1-per-token0 orientation
  const pLower = tickToPrice(tickLower, dec0, dec1)
  const pUpper = tickToPrice(tickUpper, dec0, dec1)
  const pCur = sqrtPriceToPrice(sqrtPriceX96, dec0, dec1)

  // displayed orientation
  const dLower = flipped ? 1 / pUpper : pLower
  const dUpper = flipped ? 1 / pLower : pUpper
  const dCur = flipped ? 1 / pCur : pCur
  const base = flipped ? sym1 : sym0
  const quote = flipped ? sym0 : sym1

  // A dollar reading converted through WETH moves whenever ETH does while the
  // bounds sit still, so it says so; against the $1 stable there is nothing to
  // qualify, because the pool's own price IS the dollar price.
  const derived = !!usd && !usd.exact
  let unitLabel = `${quote}/${base}`
  if (usd) unitLabel = t('lrange.per', { sym: base })
  if (derived) unitLabel = `≈ ${unitLabel}`

  // Marker fraction, linear in ticks, padded each side. 15% is enough to show
  // drift off a bound, which is all the bare bar has to do. With depth drawn it
  // is not enough to show anything ABOUT the depth: a band's own neighbourhood
  // is frequently one liquidity segment, and a window that narrow renders it as
  // a flat line with nothing to compare against. 60% reaches far enough to
  // catch the boundaries the band sits between.
  const width = tickUpper - tickLower
  const pad = Math.max(1, Math.round(width * (pool ? 0.6 : 0.15)))
  const lo = tickLower - pad
  const hi = tickUpper + pad
  let frac = (tick - lo) / (hi - lo)
  if (flipped) frac = 1 - frac
  const fracPct = Math.min(99.5, Math.max(0.5, frac * 100))
  const winLeft = (pad / (hi - lo)) * 100
  const winWidth = (width / (hi - lo)) * 100

  // Depth across exactly the window the marker moves in, so a column sits under
  // the price it belongs to. The anchor is the pool's own tick and liquidity,
  // one measurement — `tick` here may be a fresher feed, and pairing it with a
  // stale active liquidity would shift the whole curve by the boundaries the
  // price crossed in between.
  const liq = useTickLiquidity(pool ?? null, lo, hi, onScreen)
  const bins = useMemo(() => {
    if (!pool || !liq.data) return null
    const segs = buildSegments(liq.data.nets, pool.tick, pool.liquidity, liq.data.loTick, liq.data.hiTick)
    return binLiquidity(segs, lo, hi, binCount)
  }, [pool, liq.data, lo, hi, binCount])
  const peak = useMemo(() => bins?.reduce((m, b) => (b > m ? b : m), 0n) ?? 0n, [bins])
  const dispBins = useMemo(() => (bins && flipped ? [...bins].reverse() : bins), [bins, flipped])

  const inRange = tick >= tickLower && tick < tickUpper
  const posPct = ((tick - tickLower) / width) * 100
  const nearEdge = inRange && (posPct < 12 || posPct > 88)
  const tone = order ? '' : !inRange ? 'red' : nearEdge ? 'amber' : ''

  // full-range edges: detect in tick space, map to display space (dLower → 0,
  // dUpper → ∞; the two swap when flipped). A full-range side has no finite
  // bound and no single-token "out here" state, so its number/label is dropped.
  const upperUnbounded = tickUpper >= MAX_TICK - UNBOUNDED_MARGIN
  const lowerUnbounded = tickLower <= MIN_TICK + UNBOUNDED_MARGIN
  const leftUnbounded = flipped ? upperUnbounded : lowerUnbounded
  const rightUnbounded = flipped ? lowerUnbounded : upperUnbounded
  // which single token you hold once price leaves the band (display space):
  // the low side (left) is 100% base, the high side (right) is 100% quote
  const heldLow = !order && !inRange && dCur < dLower
  const heldHigh = !order && !inRange && dCur > dUpper

  // phosphor trail: on a real price move, smear a decaying gradient over the
  // path the marker just glided across (oscilloscope persistence). Suppressed
  // on flip (display-space jump, price didn't move) and on sub-pixel jitter.
  const prevRef = useRef<{ pct: number; tick: number; flipped: boolean } | null>(null)
  const [trail, setTrail] = useState<{ left: number; width: number; rev: boolean; n: number } | null>(null)
  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = { pct: fracPct, tick, flipped }
    if (!prev || prev.flipped !== flipped || prev.tick === tick) return
    const d = fracPct - prev.pct
    if (Math.abs(d) < 0.4) return
    setTrail((tr) => ({ left: Math.min(prev.pct, fracPct), width: Math.abs(d), rev: d < 0, n: (tr?.n ?? 0) + 1 }))
  }, [fracPct, tick, flipped])

  // out of range: a dashed excursion line from the window edge to the marker
  // makes "how far out" visible (glides with the marker). Not in order mode —
  // resting outside the band is the intended state there.
  const winRight = winLeft + winWidth
  const exc =
    !order && !inRange
      ? fracPct < winLeft
        ? { left: fracPct, width: winLeft - fracPct }
        : { left: winRight, width: Math.max(0, fracPct - winRight) }
      : null
  // near-edge: mark the threatened bound post amber (display-space side)
  const warnSide = !order && nearEdge ? ((posPct < 12) !== flipped ? ' warn-lo' : ' warn-hi') : ''

  // % price move (in displayed units) to each bound
  const toLeft = (dLower / dCur - 1) * 100
  const toRight = (dUpper / dCur - 1) * 100
  // band half-width, geometric: ±x% around mid
  const bandPct = (Math.sqrt(dUpper / dLower) - 1) * 100
  // ∞ on an unbounded (full-range) side rather than an astronomical number
  const leftMove = leftUnbounded ? INF : `${toLeft >= 0 ? '+' : ''}${fmtNum(toLeft, 3)}%`
  const rightMove = rightUnbounded ? INF : `${toRight >= 0 ? '+' : ''}${fmtNum(toRight, 3)}%`
  const bandStr = leftUnbounded || rightUnbounded ? INF : fmtNum(bandPct, 3)

  let statusText: string
  let statusTone: string
  if (order) {
    if (order.fillFrac >= 0.999) {
      statusText = t('rbar.orderFilled', { sym: order.buySym })
      statusTone = 'green'
    } else if (inRange || order.fillFrac > 0.001) {
      statusText = t('rbar.orderFilling', { pct: (order.fillFrac * 100).toFixed(1), sym: order.sellSym })
      statusTone = 'amber'
    } else {
      const need = fmtNum(dCur < dLower ? toLeft : Math.abs(toRight), 3)
      statusText = dCur < dLower ? t('rbar.orderWaitRise', { pct: need }) : t('rbar.orderWaitFall', { pct: need })
      statusTone = 'cyan'
    }
  } else if (inRange) {
    statusText = t('rbar.inRange')
    statusTone = nearEdge ? 'amber' : 'green'
  } else if (dCur < dLower) {
    statusText = t('rbar.outRise', { pct: fmtNum(toLeft, 3) })
    statusTone = 'red'
  } else {
    statusText = t('rbar.outFall', { pct: fmtNum(Math.abs(toRight), 3) })
    statusTone = 'red'
  }

  return (
    <div className="rbar-wrap" ref={wrapRef}>
      {!order && (!leftUnbounded || !rightUnbounded) && (
        <div className="rbar-holds mono-sm">
          {leftUnbounded ? (
            <span />
          ) : (
            <span className={heldLow ? 'red' : 'dim'}>↓ {t('rbar.allOf', { sym: base })}</span>
          )}
          {rightUnbounded ? (
            <span />
          ) : (
            <span className={heldHigh ? 'red' : 'dim'}>{t('rbar.allOf', { sym: quote })} ↑</span>
          )}
        </div>
      )}
      <div className="rbar">
        <span className="rbar-price">{leftUnbounded ? '0' : money(dLower)}</span>
        <div
          ref={trackRef}
          className={`rbar-track${dispBins ? ' deep' : ''}`}
          title={t('rbar.ticksTip', { lo: tickLower, hi: tickUpper, tick })}
        >
          {dispBins && (
            <div className="rbar-depth" aria-hidden>
              {dispBins.map((b, i) => {
                const f = (i + 0.5) / binCount
                const mid = lo + Math.round((hi - lo) * (flipped ? 1 - f : f))
                const on = mid >= tickLower && mid < tickUpper
                const h = peak > 0n ? Math.max(2, Number((b * 100n) / peak)) : 0
                return <div key={i} className={`rbar-bin${on ? ' on' : ''}`} style={{ height: `${h}%` }} />
              })}
            </div>
          )}
          <div
            className={`rbar-window${!order && !inRange ? ' out' : ''}${warnSide}`}
            style={{ left: `${winLeft}%`, width: `${winWidth}%` }}
          />
          {trail && (
            <div
              key={trail.n}
              className={`rbar-trail${trail.rev ? ' rev' : ''} ${tone}`}
              style={{ left: `${trail.left}%`, width: `${trail.width}%` }}
            />
          )}
          {exc && exc.width > 0.2 && (
            <div className="rbar-exc" style={{ left: `${exc.left}%`, width: `${exc.width}%` }} />
          )}
          <div className={`rbar-marker ${tone}`} style={{ left: `${fracPct}%` }} />
        </div>
        <span className="rbar-price">{rightUnbounded ? INF : money(dUpper)}</span>
      </div>
      <div className="rbar-sub">
        <span className={heldLow ? 'red' : 'dim'}>
          {leftMove} {t('rbar.toLow')}
        </span>
        <span>
          px{' '}
          <Flash v={dCur} arrow>
            <span className={tone || 'green'}>{money(dCur)}</span>
          </Flash>{' '}
          <span className="dim" title={derived ? t('lrange.usdDerived', { sym: quote }) : undefined}>
            {unitLabel}
          </span>
          <UnitToggle unit={unit} />
        </span>
        <span className={heldHigh ? 'red' : 'dim'}>
          {t('rbar.fromHigh')} {rightMove}
        </span>
      </div>
      <div className="rbar-sub">
        <Flash v={order ? order.fillFrac : undefined} arrow>
          <span
            className={statusTone}
            title={
              !order && inRange ? t('rbar.inRangeTip', { pct: posPct.toFixed(1), band: bandStr }) : undefined
            }
          >
            {statusText}
          </span>
        </Flash>
      </div>
    </div>
  )
}
