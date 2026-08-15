import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { EXPLORER } from '../config/addresses'
import { txlog, type LogLine } from '../lib/txlog'

function glyph(l: LogLine): string {
  switch (l.kind) {
    case 'ok':
      return '✓'
    case 'err':
      return '✗'
    case 'pending':
      return '⧗'
    default:
      return '>'
  }
}

export function TxLogPanel() {
  const { t } = useTranslation()
  const lines = useSyncExternalStore(txlog.subscribe, txlog.get)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  return (
    // The panel is the product's promise that every action narrates — wallet
    // prompt, pending, confirmed. Without a live region that narration is
    // silent to a screen reader, which is the one case where a flow really is
    // an unexplained wait. `additions` so a re-render of settled lines does
    // not re-read the whole log.
    <div
      className="logpanel"
      ref={ref}
      role="log"
      aria-live="polite"
      aria-relevant="additions"
    >
      {lines.length === 0 && <div className="logline dim">{t('log.ready')}</div>}
      {lines.length > 2 && (
        <div className="logline dim">
          <span className="t">--------</span>
          <span className="txt">{t('log.events', { n: lines.length })}</span>
          <button className="chip logaction" onClick={() => txlog.clear()}>
            {t('log.clear')}
          </button>
        </div>
      )}
      {lines.map((l) => (
        <div key={l.id} className={`logline ${l.kind}`}>
          <span className="t">{new Date(l.ts).toLocaleTimeString('en-GB')}</span>
          <span className="txt">
            {glyph(l)} {l.text}
          </span>
          {l.hash && (
            <a href={l.href ?? `${EXPLORER}/tx/${l.hash}`} target="_blank" rel="noreferrer">
              tx↗
            </a>
          )}
          {l.action && (
            <button className="chip logaction" onClick={l.action.onClick}>
              {l.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
