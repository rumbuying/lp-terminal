import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { EXPLORER } from '../config/addresses'
import { copyText } from '../lib/clipboard'
import { clampWidth, shortAddr } from '../lib/format'
import { popoverTop } from '../lib/popover'
import type { StockIssuerId } from '../config/chains/stockIssuers'
import { TokenSymbol } from './TokenIdentity'

const POP_W = 320
const GAP = 8
const DROP = 6 // gap between the trigger and the card it opens
/**
 * Columns each side of the pair may occupy in the trigger.
 *
 * A symbol is the one field on a row that a stranger sets, and nothing stops
 * them from setting it to a paragraph. The pools table sizes its columns from
 * their content, so one such row stretched the pair column until the numbers to
 * its right — TVL, volume, APR, the reason the table exists — were pushed off
 * screen for EVERY row. Two sides plus the slash fit inside 30 columns here,
 * which real symbols (WBNB, USDT, BTCB, Cake-LP) never come close to.
 *
 * The popover this opens is deliberately NOT clamped: it is the surface for
 * "which token is this actually", and a name is part of the answer.
 */
export const SYMBOL_COLUMNS = 14

export type PairReferenceEntry = {
  k: string
  value: string
  explorer?: 'token' | 'address'
  /** set on the two TOKEN rows only, so the card can mark the proven issuer */
  issuer?: StockIssuerId | null
}

export function pairReferenceEntries(
  props: {
    sym0: string
    sym1: string
    token0: string
    token1: string
    pool: string
    poolId?: string
    hooks?: string
    issuer0?: StockIssuerId | null
    issuer1?: StockIssuerId | null
  },
  labels: { pool: string; poolId: string; hooks: string; manager: string },
): PairReferenceEntry[] {
  const entries: PairReferenceEntry[] = [
    { k: props.sym0, value: props.token0, explorer: 'token', issuer: props.issuer0 ?? null },
    { k: props.sym1, value: props.token1, explorer: 'token', issuer: props.issuer1 ?? null },
  ]
  if (props.poolId) {
    entries.push(
      { k: labels.poolId, value: props.poolId },
      ...(props.hooks ? [{ k: labels.hooks, value: props.hooks, explorer: 'address' as const }] : []),
      { k: labels.manager, value: props.pool, explorer: 'address' },
    )
  } else {
    entries.push({ k: labels.pool, value: props.pool, explorer: 'address' })
  }
  return entries
}

/** `from` is the trigger's box, kept so placement can flip the card above it */
type At = { top: number; left: number; from: { top: number; bottom: number }; placed: boolean }

/**
 * The pair label, as a button that opens the identifiers behind it. Ordinary
 * pools expose two tokens and their pool contract. A v4 pool instead exposes
 * its real PoolId and hooks separately from the shared PoolManager.
 *
 * Every value here exists to be pasted somewhere else — a block explorer, a
 * wallet's import-token box, a script — so the popover is a copy surface first
 * and a reference second, and each row copies the FULL value even though it only
 * has room to show a shortened one.
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
  /** v4 only: real pool identity; `pool` is then labelled PoolManager. */
  poolId?: string
  /** v4 only: hook contract, including the zero address for a hookless pool. */
  hooks?: string
  /** class for the trigger, so callers keep their own type scale (b, card-title, …) */
  className?: string
  /**
   * Proven tokenized-equity issuer per side, where there is one.
   *
   * Marked HERE rather than by the caller because this component owns both the
   * label and the popover that reveals each token's address — and the address
   * is exactly what an impersonator is counting on nobody checking. Naming the
   * issuer beside the address it belongs to is the point.
   */
  issuer0?: StockIssuerId | null
  issuer1?: StockIssuerId | null
}) {
  const { t } = useTranslation()
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

  const entries = pairReferenceEntries(props, {
    pool: t('pools.addrPool'),
    poolId: t('pools.addrPoolId'),
    hooks: t('pools.addrHooks'),
    manager: t('pools.addrManager'),
  })

  const status = (addr: string) =>
    copied === addr ? (
      <span className="addr-ok">{t('pools.addrCopied')}</span>
    ) : failed === addr ? (
      <span className="addr-bad">{t('pools.addrFailed')}</span>
    ) : (
      <span className="dim">⧉</span>
    )

  const shown0 = clampWidth(props.sym0, SYMBOL_COLUMNS)
  const shown1 = clampWidth(props.sym1, SYMBOL_COLUMNS)
  // A clipped name cannot be read until the card is open. The hover says it in
  // full first, because the card costs a click and the tooltip costs nothing.
  const clipped = shown0 !== props.sym0 || shown1 !== props.sym1
  const triggerTitle = clipped
    ? `${props.sym0}/${props.sym1}\n${t('pools.addrTip')}`
    : t('pools.addrTip')

  return (
    <>
      <button
        className={`pair-btn ${props.className ?? ''} ${at ? 'on' : ''}`}
        onClick={open}
        title={triggerTitle}
        aria-haspopup="dialog"
        aria-expanded={!!at}
      >
        <TokenSymbol
          symbol={props.sym0}
          address={props.token0}
          issuer={props.issuer0 ?? null}
          max={SYMBOL_COLUMNS}
        />
        {'/'}
        <TokenSymbol
          symbol={props.sym1}
          address={props.token1}
          issuer={props.issuer1 ?? null}
          max={SYMBOL_COLUMNS}
        />
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
                  <TokenSymbol symbol={props.sym0} address={props.token0} issuer={props.issuer0 ?? null} />/
                  <TokenSymbol symbol={props.sym1} address={props.token1} issuer={props.issuer1 ?? null} />
                </b>
                <span className="dim">{t('pools.addrHint')}</span>
              </div>
              {entries.map((e) => (
                <div className="addr-row" key={e.value + e.k}>
                  {/* the address is right there beside it — this is the row where
                      "which TSLA is this" is actually answerable */}
                  <span className="addr-k">
                    <TokenSymbol
                      symbol={e.k}
                      address={e.explorer === 'token' ? e.value : undefined}
                      issuer={e.issuer ?? null}
                    />
                  </span>
                  <button className="addr-copy" onClick={() => copy(e.value)} title={t('pools.addrCopyTip')}>
                    <span className="addr-v">{shortAddr(e.value)}</span>
                    {status(e.value)}
                  </button>
                  {e.explorer && (
                    <a
                      className="dim addr-ext"
                      href={`${EXPLORER}/${e.explorer}/${e.value}`}
                      target="_blank"
                      rel="noreferrer"
                      title={t('pools.addrExplorerTip')}
                    >
                      ↗
                    </a>
                  )}
                </div>
              ))}
            </div>
          </>,
          document.body,
        )}
    </>
  )
}
