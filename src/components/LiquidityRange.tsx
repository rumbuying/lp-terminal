import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { binsForWidth, useElementWidth } from '../hooks/useElementWidth'
import { usePriceUnit } from '../hooks/usePriceUnit'
import { useTickLiquidity } from '../hooks/useTickLiquidity'
import { MAX_TICK, MIN_TICK, alignTick, priceToTick, sqrtPriceToPrice, tickToPrice } from '../lib/clmath'
import { fmtNum, sanitizeAmountInput } from '../lib/format'
import { concentration, valueMix } from '../lib/rangeFacts'
import { binLiquidity, buildSegments } from '../lib/tickLiq'
import type { ClPool } from '../types'
import { UnitToggle } from './UnitToggle'

/**
 * Column pitch, in pixels — the count follows from the measured width.
 *
 * 16px leaves a 15px column beside its 1px divider, which is the smallest that
 * still reads as a column rather than as a stripe. Held at a fixed count
 * instead, a 940px expander and a 360px phone would draw the same 56 buckets,
 * and on the phone each one would be five pixels wide with a divider taking a
 * fifth of it.
 */
const BIN_PITCH = 16
const BIN_MIN = 14
const BIN_MAX = 64
/** how close a bound has to come, in pixels, before a magnet takes it */
const MAGNET_PX = 9
const UNBOUNDED_MARGIN = 1000
const INF = '∞'

/** which end of the plot a handle is on — screen sides, which flipping swaps */
type Side = 'left' | 'right'

/**
 * A price seeded into an editable bound, in plain digits.
 *
 * Nine figures, not the five or seven the readout rounds to. This number goes
 * back through `priceToTick` the moment the reader presses Enter, and a tick is
 * one part in ten thousand: at five figures a sub-$1 price quantizes to about
 * half a tick, so opening the field and committing it UNCHANGED could shift the
 * bound by one — visibly, since the bound is what the chart draws. Nine figures
 * puts the error four orders below a tick, and `priceToTick` rounds the rest
 * away.
 */
function plainPrice(x: number): string {
  if (!Number.isFinite(x) || x <= 0) return ''
  const s = x.toPrecision(9)
  return s.includes('.') && !s.includes('e')
    ? s.replace(/0+$/, '').replace(/\.$/, '')
    : s
}

/**
 * The range you are buying, drawn over the liquidity already there.
 *
 * Two facts share one picture because they are only meaningful together: a band
 * is not wide or narrow in the abstract, it is wide or narrow against where the
 * other positions sit. A range placed on the peak earns fees fastest and is the
 * first to be run over; a range out on the shelf is quiet and keeps its shape.
 * Printing "0.42% of active liquidity" states the outcome; the histogram shows
 * the reason, and reads before a number does.
 *
 * The columns are the pool's depth reconstructed from the chain (see tickLiq),
 * dimmed outside the selected band and lit inside it — the same density
 * distinction the zap flow uses, for the same reason: green, red and amber
 * already mean in-range, out-of-range and warning here, and MONO has no hue to
 * spend at all.
 *
 * Both bounds are draggable. Every result is aligned to the pool's tick spacing
 * because the contract will not accept anything else, so the alignment is not a
 * magnet but the floor. On top of it two soft magnets pull within a few pixels:
 * the current price, and the ticks where the depth actually steps — the edges of
 * other people's positions. Those are the places a bound means something, and
 * they are exactly the places that are hard to hit by eye.
 *
 * Dragging commits on release, not on every pointer move. Downstream of this is
 * a deposit preview and a zap re-plan; firing those sixty times a second would
 * quote a route for a range the pointer has already left.
 *
 * Flipping mirrors the PLOT, not just the numbers. Showing the inverse quote
 * while the picture stayed put would leave the smaller number on the right, and
 * a handle that moves the bound on the opposite side from the one it touches.
 * So screen sides and tick bounds are kept apart everywhere below: `Side` is
 * where a thing sits, `lower`/`upper` is what it edits, and flipping swaps the
 * mapping between them once.
 */
export function LiquidityRange(props: {
  pool: ClPool
  tickLower: number
  tickUpper: number
  dec0: number
  dec1: number
  sym0: string
  sym1: string
  /**
   * Where the price is right now, when a fresher feed than the pool snapshot is
   * available. Display only — the WALK keeps anchoring on `pool.tick` with
   * `pool.liquidity`, because those two are one measurement: pairing a newer
   * tick with an older active liquidity misreports the anchor by exactly the
   * boundaries the price crossed in between.
   */
  tick?: number
  sqrtPriceX96?: bigint
  /** anchors for the dollar reading — the pool supplies whichever side these don't */
  upUsd?: number
  wethUsd?: number | null
  /** absent for a band that cannot move — an existing position draws no handles */
  onChange?: (lower: number, upper: number) => void
}) {
  const { t } = useTranslation()
  const { pool, tickLower, tickUpper, dec0, dec1, sym0, sym1, onChange } = props
  const spacing = pool.tickSpacing
  const curTick = props.tick ?? pool.tick
  const curSqrtP = props.sqrtPriceX96 ?? pool.sqrtPriceX96

  const trackRef = useRef<HTMLDivElement>(null)
  const plotWidth = useElementWidth(trackRef)
  const binCount = binsForWidth(plotWidth, BIN_PITCH, BIN_MIN, BIN_MAX, 40)

  const unit = usePriceUnit({ pool, dec0, dec1, upUsd: props.upUsd, wethUsd: props.wethUsd })
  const { usd, flipped, money } = unit
  // which bound the keyboard owns, and the text in it — 'lo'/'hi' are SCREEN
  // ends, like Side, because that is what the reader is pointing at
  const [edit, setEdit] = useState<{ side: 'lo' | 'hi'; text: string } | null>(null)
  // which handle the pointer owns, and the un-committed band it is dragging
  const [drag, setDrag] = useState<Side | null>(null)
  const [live, setLive] = useState<{ lower: number; upper: number } | null>(null)
  const lower = live?.lower ?? tickLower
  const upper = live?.upper ?? tickUpper

  /** the tick bound a screen-side handle edits; flipping swaps the two */
  const boundOf = useCallback(
    (side: Side): 'lower' | 'upper' => ((side === 'left') === flipped ? 'upper' : 'lower'),
    [flipped],
  )

  // The window is derived from the COMMITTED band and frozen while dragging: a
  // window that rescaled under the pointer would move the very edge being aimed
  // at. 60% padding each side leaves room to widen the band by dragging before
  // a handle reaches the edge, and the current tick is always inside it.
  const frozen = useRef<{ lo: number; hi: number } | null>(null)
  const win = useMemo(() => {
    if (drag && frozen.current) return frozen.current
    const lo0 = Math.min(tickLower, curTick)
    const hi0 = Math.max(tickUpper, curTick)
    const pad = Math.max(Math.round((hi0 - lo0) * 0.6), spacing * 4)
    const w = {
      lo: alignTick(lo0 - pad, spacing, 'floor'),
      hi: alignTick(hi0 + pad, spacing, 'ceil'),
    }
    frozen.current = w
    return w
  }, [drag, tickLower, tickUpper, curTick, spacing])

  const liq = useTickLiquidity(pool, win.lo, win.hi)
  // The walk lives here, not in the hook: it re-anchors on the pool's tick and
  // active liquidity, both of which arrive together on the pool refresh, while
  // the two reads behind `liq` stay cached across it.
  const segs = useMemo(
    () =>
      liq.data
        ? buildSegments(liq.data.nets, pool.tick, pool.liquidity, liq.data.loTick, liq.data.hiTick)
        : null,
    [liq.data, pool.tick, pool.liquidity],
  )
  const bins = useMemo(
    () => (segs ? binLiquidity(segs, win.lo, win.hi, binCount) : null),
    [segs, win.lo, win.hi, binCount],
  )
  const peak = useMemo(() => (bins ? bins.reduce((m, b) => (b > m ? b : m), 0n) : 0n), [bins])

  // the ticks where depth steps — other positions' edges, and the only places
  // besides the current price where landing a bound exactly means something
  const magnets = useMemo(() => {
    const m = [curTick]
    if (segs) for (const s of segs) m.push(s.lower)
    return m.map((x) => Math.round(x / spacing) * spacing)
  }, [segs, curTick, spacing])

  const span = win.hi - win.lo
  /** tick → where it sits on screen, which is where flipping is applied */
  const pctOf = (tick: number) => {
    const p = ((tick - win.lo) / span) * 100
    return flipped ? 100 - p : p
  }

  const snap = useCallback(
    (raw: number, widthPx: number) => {
      const pxPerTick = widthPx / span
      let best: number | null = null
      let bestPx = MAGNET_PX
      for (const m of magnets) {
        const d = Math.abs(raw - m) * pxPerTick
        if (d < bestPx) {
          bestPx = d
          best = m
        }
      }
      const out = best ?? Math.round(raw / spacing) * spacing
      return Math.min(Math.max(out, alignTick(MIN_TICK, spacing, 'ceil')), alignTick(MAX_TICK, spacing, 'floor'))
    },
    [magnets, span, spacing],
  )

  const move = useCallback(
    (side: Side, clientX: number) => {
      const el = trackRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      let frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
      if (flipped) frac = 1 - frac
      const next = snap(win.lo + frac * span, r.width)
      const bound = boundOf(side)
      setLive((cur) => {
        const base = cur ?? { lower: tickLower, upper: tickUpper }
        return bound === 'lower'
          ? { lower: Math.min(next, base.upper - spacing), upper: base.upper }
          : { lower: base.lower, upper: Math.max(next, base.lower + spacing) }
      })
    },
    [snap, win.lo, span, spacing, tickLower, tickUpper, flipped, boundOf],
  )

  const onDown = (side: Side) => (e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    setDrag(side)
    setLive({ lower: tickLower, upper: tickUpper })
    move(side, e.clientX)
  }
  const onMove = (e: React.PointerEvent) => {
    if (drag) move(drag, e.clientX)
  }
  const onUp = () => {
    if (!drag) return
    setDrag(null)
    // one commit, on release — everything downstream re-plans off this
    if (onChange && live && (live.lower !== tickLower || live.upper !== tickUpper)) {
      onChange(live.lower, live.upper)
    }
    setLive(null)
  }

  // Arrows nudge by a spacing, shift by ten — the bound is reachable exactly
  // without a pointer, and on a phone it is the way to correct a fat-finger
  // drag. The key names a screen direction, so flipping reverses what it means
  // in ticks, exactly as it reverses which bound the handle holds.
  const onKey = (side: Side) => (e: React.KeyboardEvent) => {
    const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
    if (!dir) return
    e.preventDefault()
    const step = dir * (flipped ? -1 : 1) * spacing * (e.shiftKey ? 10 : 1)
    const next =
      boundOf(side) === 'lower'
        ? { lower: Math.min(lower + step, upper - spacing), upper }
        : { lower, upper: Math.max(upper + step, lower + spacing) }
    onChange?.(next.lower, next.upper)
  }

  const pLo = tickToPrice(lower, dec0, dec1)
  const pHi = tickToPrice(upper, dec0, dec1)
  const pCur = sqrtPriceToPrice(curSqrtP, dec0, dec1)
  const loUnbounded = lower <= MIN_TICK + UNBOUNDED_MARGIN
  const hiUnbounded = upper >= MAX_TICK - UNBOUNDED_MARGIN
  const inRange = curTick >= lower && curTick < upper

  // display orientation: flipping inverts every price and swaps which bound is
  // the small number, so the pair still reads low-to-high left-to-right
  const dLo = flipped ? 1 / pHi : pLo
  const dHi = flipped ? 1 / pLo : pHi
  const dCur = flipped ? 1 / pCur : pCur
  const dLoUnbounded = flipped ? hiUnbounded : loUnbounded
  const dHiUnbounded = flipped ? loUnbounded : hiUnbounded
  const base = flipped ? sym1 : sym0
  const quote = flipped ? sym0 : sym1

  /**
   * Type a bound instead of dragging to it.
   *
   * These two numbers were being printed here and edited somewhere else — a
   * PRICE mode behind MORE held its own pair of inputs for the same pair of
   * bounds, so the band you could read was never the band you could type, and
   * the form carried two sources of truth for one range. Reading and writing
   * are the same control now.
   *
   * A screen end is not a tick bound: flipping swaps which is which, exactly as
   * it does for the handles. And the number on screen may be dollars, which is
   * `money`'s scale applied — so a typed figure divides it back out before it
   * means a ratio. Against WETH that scale is a live quote, which is what the ≈
   * beside these numbers has always been saying.
   */
  // Escape unmounts the input, and an unmounted input may still deliver the
  // blur that would otherwise commit it. One flag settles which of the two the
  // reader asked for.
  const cancelled = useRef(false)
  const startEdit = (side: 'lo' | 'hi') => () => {
    const unbounded = side === 'lo' ? dLoUnbounded : dHiUnbounded
    const shown = side === 'lo' ? dLo : dHi
    // an Escape whose blur never arrived would otherwise leave the flag armed
    // and swallow the NEXT edit's commit
    cancelled.current = false
    setEdit({ side, text: unbounded ? '' : plainPrice(shown * (usd ? unit.scale : 1)) })
  }
  const commitEdit = () => {
    const typed = edit ? Number(edit.text) : NaN
    setEdit(null)
    if (cancelled.current) {
      cancelled.current = false
      return
    }
    if (!onChange || !edit || !(typed > 0)) return
    const ratio = usd ? typed / unit.scale : typed
    const raw = priceToTick(flipped ? 1 / ratio : ratio, dec0, dec1)
    const floor = alignTick(MIN_TICK, spacing, 'ceil')
    const ceil = alignTick(MAX_TICK, spacing, 'floor')
    // the left number is the LOW tick only while unflipped; the handles map the
    // same way, and for the same reason
    const next = { lower, upper }
    if ((edit.side === 'lo') !== flipped) {
      next.lower = Math.min(Math.max(alignTick(raw, spacing, 'floor'), floor), upper - spacing)
    } else {
      next.upper = Math.max(Math.min(alignTick(raw, spacing, 'ceil'), ceil), lower + spacing)
    }
    if (next.lower !== tickLower || next.upper !== tickUpper) onChange(next.lower, next.upper)
  }

  /** one bound: the number, or the field it becomes when you tap it */
  const bound = (side: 'lo' | 'hi', text: string) => {
    if (edit?.side === side)
      return (
        <span className="lr-edit">
          {usd && <span className="dim">$</span>}
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus -- it exists because it was tapped
            autoFocus
            className="input"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            aria-label={t(
              (side === 'lo') !== flipped ? 'lrange.lowBound' : 'lrange.highBound',
            )}
            value={edit.text}
            /* the same gate every other number field in the app uses. Raw, this
               field took any text at all and then quietly declined to commit
               it: a price typed with a Chinese IME active arrives as "0。05",
               which `Number` reads as NaN, so Enter did nothing and said
               nothing. The sanitizer maps the fullwidth forms instead. */
            onChange={(e) => {
              const v = sanitizeAmountInput(e.target.value, 18)
              if (v !== null) setEdit({ side, text: v })
            }}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEdit()
              if (e.key === 'Escape') {
                // Escape belongs to the innermost thing that can be dismissed,
                // and on a phone this field is inside a sheet whose own Escape
                // listener sits on `window`. Unstopped, backing out of a typo
                // took the entire trade panel with it.
                e.stopPropagation()
                cancelled.current = true
                setEdit(null)
              }
            }}
          />
        </span>
      )
    if (!onChange) return <span className="lr-b">{text}</span>
    return (
      <button className="lr-b" onClick={startEdit(side)} title={t('lrange.editTip')}>
        {text}
      </button>
    )
  }

  // What the band DOES, as against where it sits. Both read off the pool's own
  // orientation, so token0 stays token0 here and the display swaps at the end.
  const conc = concentration(pLo, pCur, pHi)
  const mix = valueMix(pLo, pCur, pHi)
  const baseShare = mix && Math.round((flipped ? mix.v1 : mix.v0) * 100)

  // how far price has to travel to reach each bound. An unbounded side never
  // gets there, and a band the price already left reports one of these negative
  // — which is the honest reading of "how far back in".
  const signed = (x: number) => `${x >= 0 ? '+' : ''}${fmtNum(x, 3)}%`
  const moveLo = dLoUnbounded ? `−${INF}` : signed((dLo / dCur - 1) * 100)
  const moveHi = dHiUnbounded ? `+${INF}` : signed((dHi / dCur - 1) * 100)

  const leftPct = pctOf(flipped ? upper : lower)
  const rightPct = pctOf(flipped ? lower : upper)
  const curPct = Math.min(100, Math.max(0, pctOf(curTick)))

  const dispBins = useMemo(() => {
    const b = bins ?? new Array<bigint>(binCount).fill(0n)
    return flipped ? [...b].reverse() : b
  }, [bins, flipped, binCount])

  return (
    <div
      className={`lrange${drag ? ' dragging' : ''}${inRange ? '' : ' out'}${onChange ? '' : ' fixed'}`}
    >
      <div
        className="lr-plot"
        ref={trackRef}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <div className="lr-bins" aria-hidden>
          {dispBins.map((b, i) => {
            const frac = (i + 0.5) / binCount
            const mid = win.lo + Math.round(span * (flipped ? 1 - frac : frac))
            const on = mid >= lower && mid < upper
            // a bin with depth never draws as nothing — 2% floor keeps the
            // shelf visible as a shelf rather than reading as missing data
            const h = peak > 0n ? Math.max(2, Number((b * 100n) / peak)) : 0
            return (
              <div key={i} className={`lr-bin${on ? ' on' : ''}`} style={{ height: `${h}%` }} />
            )
          })}
        </div>
        {/* the band, drawn over the columns it selects */}
        <div
          className={`lr-win${inRange ? '' : ' out'}`}
          style={{ left: `${leftPct}%`, width: `${Math.max(0, rightPct - leftPct)}%` }}
        />
        {/* current price: a crosshair, the one mark that is not draggable */}
        <div className={`lr-cur${inRange ? '' : ' out'}`} style={{ left: `${curPct}%` }} />
        {/* An existing position's range is fixed by the NFT, so it gets no
            handles — a control that cannot move should not be reachable by tab
            or advertise a grab cursor. The band still shows, in its posts. */}
        {onChange && (
          <>
            <div
              className="lr-grip lo"
              style={{ left: `${leftPct}%` }}
              onPointerDown={onDown('left')}
              onKeyDown={onKey('left')}
              role="slider"
              tabIndex={0}
              aria-label={t(boundOf('left') === 'lower' ? 'lrange.lowBound' : 'lrange.highBound')}
              aria-valuenow={boundOf('left') === 'lower' ? lower : upper}
              aria-valuetext={dLoUnbounded ? '0' : money(dLo)}
            />
            <div
              className="lr-grip hi"
              style={{ left: `${rightPct}%` }}
              onPointerDown={onDown('right')}
              onKeyDown={onKey('right')}
              role="slider"
              tabIndex={0}
              aria-label={t(boundOf('right') === 'lower' ? 'lrange.lowBound' : 'lrange.highBound')}
              aria-valuenow={boundOf('right') === 'lower' ? lower : upper}
              aria-valuetext={dHiUnbounded ? INF : money(dHi)}
            />
          </>
        )}
      </div>
      {/* The two bounds read as a PAIR, not as edge labels. Pinned to the ends
          of the plot they claimed to annotate the window edges, which is where
          they sat and not what they meant — the band posts are wherever the
          band is. Beside them, what it costs to reach each bound: after a drag
          the chips no longer describe the band, and this is the only place its
          width is stated at all. */}
      <div className="lr-axis mono-sm">
        <span className="lr-band">
          {/* A dollar band converted through WETH moves whenever ETH does while
              the bounds themselves sit still. The tilde is where that is said,
              since the two numbers beside it are the ones that will drift. */}
          {usd && !usd.exact && (
            <span className="dim" title={t('lrange.usdDerived', { sym: quote })}>
              ≈
            </span>
          )}
          {bound('lo', dLoUnbounded ? '0' : money(dLo))}
          <span className="dim">─</span>
          {bound('hi', dHiUnbounded ? INF : money(dHi))}
          <span className="lr-mv dim" title={t('lrange.moveTip')}>
            {moveLo} / {moveHi}
          </span>
        </span>
        <span className="lr-mid dim" title={t('lrange.dragTip')}>
          {liq.data?.truncated && <span className="lr-trunc" title={t('lrange.truncated')}>◀▶ </span>}
          {t('lrange.px')} <span className={inRange ? 'green' : 'red'}>{money(dCur)}</span>{' '}
          {usd ? t('lrange.per', { sym: base }) : `${quote}/${base}`}
          <UnitToggle unit={unit} />
        </span>
      </div>
      {/* Where a band sits is the picture above; what it DOES is these two
          lines, and both read the moment a chip is clicked — neither one waits
          on an amount the way a fee APR does. */}
      {(conc !== null || mix !== null) && (
        <div className="lr-facts mono-sm">
          {conc !== null && (
            <>
              <span className="k">{t('lrange.fees')}</span>
              <span className="v">
                {fmtNum(conc, 3)}× <span className="dim">{t('lrange.feesOf')}</span>
              </span>
            </>
          )}
          {baseShare !== null && (
            <>
              <span className="k">{t('lrange.hold')}</span>
              <span className="v" title={t('lrange.holdTip')}>
                <span className="dim">{t('lrange.allOf', { sym: base })} ◀</span> {baseShare}% /{' '}
                {100 - baseShare}% <span className="dim">▶ {t('lrange.allOf', { sym: quote })}</span>
              </span>
            </>
          )}
        </div>
      )}
    </div>
  )
}
