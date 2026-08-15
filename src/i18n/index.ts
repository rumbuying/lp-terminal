// i18n runtime: en/zh, persisted per browser, ?lang= view-only override
// (screenshots/sharing — mirrors ?theme=). The i18next singleton `t` is safe
// to import from non-React modules (tx step labels, zap planner); components
// use useTranslation() so language switches re-render live.
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { CHAIN } from '../config/chains'
import { en } from './en'
import { zh } from './zh'

export type Lang = 'en' | 'zh'
const KEY = 'up33.lang.v1'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation'
    resources: { translation: typeof en }
  }
}

function detectLang(): Lang {
  try {
    const q = new URLSearchParams(location.search).get('lang')
    if (q === 'en' || q === 'zh') return q // view-only — not persisted
    const s = localStorage.getItem(KEY)
    if (s === 'en' || s === 'zh') return s
  } catch {
    /* storage blocked */
  }
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, zh: { translation: zh } },
  lng: detectLang(),
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false, // React escapes; keep symbols like → intact
    /**
     * What the chain calls things, available to every string without a call
     * site passing it.
     *
     * These three used to be spelled ETH, WETH and UP33 in the copy, which is
     * the chain this terminal was written for reading its own name out on a
     * chain where none of it is true — a BSC user was told their BNB would be
     * "wrapped to WETH". A default variable cannot drift the way ~20 call sites
     * passing the same constant would.
     */
    defaultVariables: {
      native: CHAIN.nativeCurrency.symbol, // ETH here, BNB there
      wrapped: CHAIN.wrappedSymbol, // WETH / WBNB
      home: CHAIN.labels.home, // UP33 / PancakeSwap
    },
  },
  returnEmptyString: false,
})
document.documentElement.lang = i18n.language === 'zh' ? 'zh-CN' : 'en'

export function setLang(l: Lang): void {
  void i18n.changeLanguage(l)
  try {
    localStorage.setItem(KEY, l)
  } catch {
    /* storage blocked — applies for this tab */
  }
  document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en'
}

export function currentLang(): Lang {
  return i18n.language?.startsWith('zh') ? 'zh' : 'en'
}

/** singleton translate for non-React modules (txlog/step labels, planners) */
export const t = i18n.t.bind(i18n)
export default i18n
