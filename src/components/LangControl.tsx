import { useTranslation } from 'react-i18next'
import { currentLang, setLang, type Lang } from '../i18n'

const LABELS: Record<Lang, string> = { en: 'EN', zh: '中文' }
const OTHER: Record<Lang, Lang> = { en: 'zh', zh: 'en' }

/** header language switcher — instant, persisted, wallet modal follows */
export function LangControl() {
  const { t, i18n } = useTranslation()
  void i18n.language // subscribe: re-render on language change
  const cur = currentLang()
  const other = OTHER[cur]
  return (
    <span className="theme-ctl">
      <span className="dim">{t('lang.label')}</span>
      {/* Two chips with the current one lit: the desktop header has the width,
          and seeing both says what the choice is without opening anything. */}
      <span className="lang-pair">
        {(Object.keys(LABELS) as Lang[]).map((l) => (
          <button key={l} className={`chip ${cur === l ? 'on' : ''}`} onClick={() => setLang(l)}>
            {LABELS[l]}
          </button>
        ))}
      </span>
      {/* On a phone the same control is ONE chip naming the language it would
          switch to. Two chips cost about ninety pixels of a 360px header, and
          that width is what decides whether the utility cluster and CONNECT
          share a row or the header grows to two. Showing the destination rather
          than the current state is also the honest label for a button: the page
          around it is already in the current language. */}
      <button
        className="chip lang-solo"
        onClick={() => setLang(other)}
        title={t('lang.switchTip', { lang: LABELS[other] })}
      >
        {LABELS[other]}
      </button>
    </span>
  )
}
