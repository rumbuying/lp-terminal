import { useTranslation } from 'react-i18next'
import { THEMES, applyTheme, useTheme, type ThemeId } from '../lib/theme'

/** footer theme switcher — instant, persisted, also restyles the wallet modal */
export function ThemeControl() {
  const { t } = useTranslation()
  const cur = useTheme()
  return (
    <span className="theme-ctl">
      <span className="dim">{t('theme.label')}</span>
      {(Object.keys(THEMES) as ThemeId[]).map((id) => (
        <button
          key={id}
          className={`chip ${cur === id ? 'on' : ''}`}
          onClick={() => applyTheme(id)}
          title={t('theme.switchTip', { name: id })}
        >
          {THEMES[id].label}
        </button>
      ))}
    </span>
  )
}

/** Compact phone control — the desktop footer is hidden below 720px, so light
 * mode still needs a reachable switch in the header. */
export function MobileThemeControl() {
  const { t } = useTranslation()
  const cur = useTheme()
  const light = THEMES[cur].scheme === 'light'
  const next: ThemeId = light ? 'mono' : 'light'
  return (
    <button
      className="chip mobile-theme"
      onClick={() => applyTheme(next)}
      title={t('theme.switchTip', { name: next })}
      aria-label={t('theme.switchTip', { name: next })}
    >
      {light ? '☾' : '☀'}
    </button>
  )
}
