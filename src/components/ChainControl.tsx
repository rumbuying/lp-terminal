import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BUILD_CHAIN, CHAIN, CHAIN_GATEWAY, CHAINS } from '../config/chains'
import { CANONICAL_ORIGIN, chainServedHere } from '../config/chains/routes'
import { chainHref, chainHrefOn } from '../lib/chainPref'
import { ActiveChainMark, ChainMark } from './ChainMark'

// Which chain the terminal is showing. Same shell as the activity log and
// WHAT'S NEW next door: a header button with a popover.
//
// Every entry is a real LINK, not a click handler. A link is what makes
// middle-click open the other chain in a second tab — two chains side by side
// is the thing a switcher is actually for — and the browser's own Back button
// then returns to the chain you came from. It also carries the whole mechanism
// for free: the href names the chain, and config/chains reads that name on the
// next load while main.tsx remembers it. Nothing here has to persist anything.
export function ChainControl() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  // read at render, not at module load: the tab lives in the hash and moves
  // under us via replaceState, and a switch should land on the tab being read
  const here = typeof window !== 'undefined' ? window.location.href : '/'
  return (
    <div className="hist chain-ctl">
      <button
        className={`hist-btn ${open ? 'on' : ''}`}
        onClick={() => setOpen(!open)}
        title={t('chain.tip', { chain: CHAIN.name })}
      >
        <ActiveChainMark />
        {CHAIN.shortName} ▾
      </button>
      {open && (
        <>
          <div className="tsel-backdrop" onClick={() => setOpen(false)} />
          <div className="hist-pop chain-pop">
            <div className="news-hd">
              <span>{t('chain.title')}</span>
              <button className="chip" onClick={() => setOpen(false)}>
                ×
              </button>
            </div>
            {Object.values(CHAINS).map((c) => {
              const body = (
                <>
                  <ChainMark chain={c.key} />
                  <span className="chain-nm">{c.name}</span>
                  <span className="chain-id">#{c.id}</span>
                </>
              )
              // the chain already on screen is a row, not a link: its href is
              // this very page, and browsers reload on a click to the URL they
              // are already at — a whole page load to arrive where you are
              // A chain this deployment has no indexer for is still offered —
              // it just has to be offered somewhere it works. Same origin when
              // we can serve it; the canonical gateway when we cannot, marked
              // so the reader knows the host changes under them.
              const offsite = !chainServedHere(c.key, CHAIN_GATEWAY, BUILD_CHAIN.key)
              return c.key === CHAIN.key ? (
                <div className="chain-opt on" key={c.key}>
                  {body}
                </div>
              ) : (
                <a
                  className="chain-opt"
                  key={c.key}
                  href={
                    offsite ? chainHrefOn(CANONICAL_ORIGIN, c.key, here) : chainHref(c.key, here)
                  }
                  title={
                    offsite
                      ? t('chain.offsiteTip', { host: new URL(CANONICAL_ORIGIN).host })
                      : undefined
                  }
                >
                  {body}
                  {offsite && <span className="chain-offsite">↗</span>}
                </a>
              )
            })}
            <div className="chain-foot">{t('chain.reloads')}</div>
          </div>
        </>
      )}
    </div>
  )
}
