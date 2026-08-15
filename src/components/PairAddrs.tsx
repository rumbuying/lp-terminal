import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { EXPLORER } from '../config/addresses'
import { copyText } from '../lib/clipboard'
import { shortAddr } from '../lib/format'
import { popoverTop } from '../lib/popover'

const POP_W = 320
const GAP = 8
const DROP = 6 // gap between the trigger and the card it opens

type Entry = { k: string; addr: string; token: boolean }

/** `from` is the trigger's box, kept so placement can flip the card above it */
type At = { top: number; left: number; from: { top: number; bottom: number }; placed: boolean }

/**
 * The pair label, as a button that opens the three addresses behind it: both
 * tokens and the pool itself.
 *
 * Every address here exists to be pasted somewhere else — a block explorer, a
 * wallet's import-token box, a script — so the popover is a copy surface first
 * and a reference second, and each row copies the FULL address even though it
 * only has room to show a shortened one.
 *
 * Drop-in anywhere a pair is named: the trigger stops its own click, so the
 * clickable rows and card headers it sits inside don't also fire.
 */
export function PairAddrs(props: {
  sym0: string
  sym1: string
  token0: string
  token1: string
  pool: string
  /** class for the trigger, so callers keep their own type scale (b, card-title, …) */
  className?: string
}) {
  const { t } = useTranslation()
  const pairLabel = `${props.sym0}/${props.sym1}`
  const [at, setAt] = useState<At | null>(null)
  // both hold the address they apply to, not a flag: three rows share this
  // state, and a bare boolean made one row's failure light up all three
  const [copied, setCopied] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const pop = useRef<HTMLDivElement>(null)

  useEffect(() => () => clearTimeout(timer.current), [])

  // The card is fixed-positioned and ANY scroll closes it, so one that opens
  // past the fold cannot be reached — scrolling toward it dismisses it. Its
  // height depends on its content (localized labels, however many rows), so
  // measure the real box once it is up and place from that. useLayoutEffect,
  // not useEffect: the correction lands before the browser paints. `placed`
  // makes this run exactly once per opening, so it cannot oscillate.
  useLayoutEffect(() => {
    if (!at || at.placed) return
    const h = pop.current?.offsetHeight ?? 0
    setAt({ ...at, top: popoverTop(at.from, h, window.innerHeight, GAP, DROP), placed: true })
  }, [at])

  // A row-anchored popover has nothing to hold onto once the row moves, and the
  // pools table scrolls inside its own box — so any scroll closes it rather than
  // leaving a card floating over an unrelated row. Escape closes it too.
  useEffect(() => {
    if (!at) return
    const close = () => setAt(null)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [at])

  const open = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation() // the row/card behind this is its own toggle
    if (at) {
      setAt(null)
      return
    }
    const r = e.currentTarget.getBoundingClientRect()
    // clamp into the viewport: this is position:fixed, and a card hanging off
    // the right edge would put the horizontal scrollbar back on a phone
    const w = Math.min(POP_W, window.innerWidth - 2 * GAP)
    // `top` here is provisional — the layout effect above replaces it with a
    // measured one before this ever paints
    setAt({
      top: r.bottom + DROP,
      left: Math.max(GAP, Math.min(r.left, window.innerWidth - w - GAP)),
      from: { top: r.top, bottom: r.bottom },
      placed: false,
    })
  }

  const copy = async (addr: string) => {
    const ok = await copyText(addr)
    clearTimeout(timer.current)
    setCopied(ok ? addr : null)
    setFailed(ok ? null : addr)
    timer.current = setTimeout(() => {
      setCopied(null)
      setFailed(null)
    }, 1400)
  }

  const entries: Entry[] = [
    { k: props.sym0, addr: props.token0, token: true },
    { k: props.sym1, addr: props.token1, token: true },
    { k: t('pools.addrPool'), addr: props.pool, token: false },
  ]

  const status = (addr: string) =>
    copied === addr ? (
      <span className="addr-ok">{t('pools.addrCopied')}</span>
    ) : failed === addr ? (
      <span className="addr-bad">{t('pools.addrFailed')}</span>
    ) : (
      <span className="dim">⧉</span>
    )

  return (
    <>
      <button
        className={`pair-btn ${props.className ?? ''} ${at ? 'on' : ''}`}
        onClick={open}
        title={`${pairLabel} · ${t('pools.addrTip')}`}
        aria-haspopup="dialog"
        aria-expanded={!!at}
      >
        {pairLabel}
      </button>
      {/* Portaled to <body>: the trigger sits inside a table cell that mobile
          gives `overflow: hidden` and `white-space: nowrap`. The portal escapes
          both the clip and the inherited typography — React still bubbles events
          through the COMPONENT tree though, so the stopPropagation below stays
          load-bearing for the row/card toggles behind this. */}
      {at &&
        createPortal(
          <>
            <div
              className="tsel-backdrop"
              onClick={(e) => {
                e.stopPropagation()
                setAt(null)
              }}
            />
            <div
              ref={pop}
              className="addr-pop"
              style={{ top: at.top, left: at.left }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="addr-pop-head">
                <b>
                  {props.sym0}/{props.sym1}
                </b>
                <span className="dim">{t('pools.addrHint')}</span>
              </div>
              {entries.map((e) => (
                <div className="addr-row" key={e.addr + e.k}>
                  <span className="addr-k">{e.k}</span>
                  <button className="addr-copy" onClick={() => copy(e.addr)} title={t('pools.addrCopyTip')}>
                    <span className="addr-v">{shortAddr(e.addr)}</span>
                    {status(e.addr)}
                  </button>
                  <a
                    className="dim addr-ext"
                    href={`${EXPLORER}/${e.token ? 'token' : 'address'}/${e.addr}`}
                    target="_blank"
                    rel="noreferrer"
                    title={t('pools.addrExplorerTip')}
                  >
                    ↗
                  </a>
                </div>
              ))}
            </div>
          </>,
          document.body,
        )}
    </>
  )
}
