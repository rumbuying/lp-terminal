import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CHANGELOG } from '../content/changelog'
import { currentLang } from '../i18n'
import { freshCount, isFresh } from '../lib/news'

// WHAT'S NEW — same shell as the activity log next door: a header button with a
// popover. The red dot is purely time-based (lib/news.ts), so there is no read
// state to store and nothing to mark: an entry stops being new by ageing out.
export function NewsButton() {
  const { t, i18n } = useTranslation()
  void i18n.language // subscribe: entry text follows the language switch
  const [open, setOpen] = useState(false)
  const lang = currentLang()
  const now = Date.now() // re-read per render; the header re-renders on every block
  const fresh = freshCount(now)

  return (
    <div className="hist">
      <button
        className={`hist-btn ${open ? 'on' : ''}`}
        onClick={() => setOpen(!open)}
        title={t('news.tip')}
      >
        ★ <span className="hide-m">{t('news.label')}</span>
        {fresh > 0 && <span className="news-dot" title={t('news.freshTip', { n: fresh })} />}
      </button>
      {open && (
        <>
          <div className="tsel-backdrop" onClick={() => setOpen(false)} />
          <div className="hist-pop news-pop">
            <div className="news-hd">
              <span>{t('news.title')}</span>
              <button className="chip" onClick={() => setOpen(false)}>
                ×
              </button>
            </div>
            <div className="news-list">
              {CHANGELOG.length === 0 && <div className="news-item dim">{t('news.empty')}</div>}
              {CHANGELOG.map((e) => (
                <div className="news-e" key={e.id}>
                  <div className="news-e-hd">
                    <span className="news-date" title={e.date}>
                      {e.date.slice(5)}
                    </span>
                    <span className={`news-tag ${e.tag}`}>{e.tag}</span>
                    <span className="news-title">{e.title[lang]}</span>
                    {isFresh(e, now) && <span className="news-dot" />}
                  </div>
                  {e.items.map((it) => (
                    <div className="news-item" key={it.en}>
                      {it[lang]}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
