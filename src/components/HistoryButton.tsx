import { useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { txlog } from '../lib/txlog'
import { TxLogPanel } from './TxLogPanel'

// The terminal activity log lives here now — a header button, not a footer
// panel. Collapsed by default; the button still surfaces live tx state (count +
// a pulse while something is pending) so feedback isn't lost when it's closed.
export function HistoryButton() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const lines = useSyncExternalStore(txlog.subscribe, txlog.get)
  const pending = lines.some((l) => l.kind === 'pending')
  // surface the latest failure even while collapsed — the always-on panel that
  // used to show reverts inline is gone, so the button has to carry that signal
  const failed = !pending && lines[lines.length - 1]?.kind === 'err'

  return (
    <div className="hist">
      <button
        className={`hist-btn ${open ? 'on' : ''} ${pending ? 'pending' : ''} ${failed ? 'failed' : ''}`}
        onClick={() => setOpen(!open)}
        title={t('hdr.historyTip')}
      >
        {pending ? '⧗' : failed ? '✗' : '≡'} <span className="hide-m">{t('hdr.history')}</span>
        {lines.length > 0 && <span className="hist-n">{lines.length}</span>}
      </button>
      {open && (
        <>
          <div className="tsel-backdrop" onClick={() => setOpen(false)} />
          <div className="hist-pop">
            <TxLogPanel />
          </div>
        </>
      )}
    </div>
  )
}
