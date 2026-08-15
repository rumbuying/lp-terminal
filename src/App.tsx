import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WagmiProvider } from 'wagmi'
import { QueryClientProvider } from '@tanstack/react-query'
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit'
import { activeChain } from './config/chain'
import { CHAIN } from './config/chains'
import { FEATURES } from './config/features'
import { wagmiConfig } from './config/wagmi'
import { queryClient } from './config/query'
import { CHAIN_ID, EXPLORER } from './config/addresses'
import { currentLang } from './i18n'
import { Header, type TabId } from './components/Header'
import { NetworkPrompt } from './components/NetworkPrompt'
import { RpcControl } from './components/RpcControl'
import { ThemeControl } from './components/ThemeControl'
import { THEMES, useTheme } from './lib/theme'
import { BridgeTab } from './components/tabs/BridgeTab'
import { LabTab } from './components/tabs/LabTab'
import { PoolsTab } from './components/tabs/PoolsTab'
import { PositionsTab } from './components/tabs/PositionsTab'
import { SwapTab } from './components/tabs/SwapTab'
import { Btn } from './components/ui'

export default function App() {
  const theme = useTheme() // wallet modal accent follows the terminal theme
  const { i18n } = useTranslation() // wallet modal language follows too
  void i18n.language
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({
            accentColor: THEMES[theme].acc,
            accentColorForeground: THEMES[theme].accFg,
            borderRadius: 'none',
            overlayBlur: 'small',
          })}
          locale={currentLang() === 'zh' ? 'zh-CN' : 'en-US'}
          initialChain={activeChain}
          modalSize="compact"
          // same name the wallet approval screen shows (see config/wagmi.ts) —
          // this one names the app inside rainbowkit's own account modal
          appInfo={{ appName: 'LP Terminal' }}
        >
          <Shell />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}

const KEYS: Record<string, TabId> = {
  '1': 'pools',
  '2': 'swap',
  '3': 'positions',
  ...(FEATURES.bridge ? { '5': 'bridge' as TabId } : {}),
}

const validTab = (h: string): TabId | null => {
  if (h === 'limit') return 'swap' // LIMIT mode is a sub-view of the swap tab
  if (h === 'lab') return 'pools' // hidden component lab rides the pools slot
  if (h === 'bridge' && !FEATURES.bridge) return null
  return (['pools', 'positions', 'swap', 'bridge'] as const).includes(h as TabId) ? (h as TabId) : null
}

function Shell() {
  const { t } = useTranslation()
  const [tab, setTabState] = useState<TabId>(() => validTab(location.hash.slice(1)) ?? 'pools')
  const setTab = (t: TabId) => {
    setTabState(t)
    history.replaceState(null, '', '#' + t)
    // Choosing POSITIONS is the manual refresh: mark the scan stale so it
    // refetches in the background — the warm snapshot stays on screen the
    // whole time, which is what makes the click feel instant. Root-key match:
    // every chain/user variant of the scan is covered.
    if (t === 'positions')
      void queryClient.invalidateQueries({ queryKey: ['positions'] })
  }
  useEffect(() => {
    const onHash = () => {
      const t = validTab(location.hash.slice(1))
      if (t) setTab(t)
    }
    window.addEventListener('hashchange', onHash)
    const h = (e: KeyboardEvent) => {
      // a dialog owns the keyboard while it is up — Modal sets this class, and
      // [1] changing the tab behind an open dialog is a page the user never
      // asked for, waiting for them when they answer
      if (document.body.classList.contains('modal-open')) return
      // Esc returns focus to the page — on a phone that is also how the tab
      // bar comes back without hunting for dead space to tap. Before the
      // input guard: the fields are exactly who this key serves.
      if (e.key === 'Escape') {
        ;(document.activeElement as HTMLElement | null)?.blur?.()
        return
      }
      const el = e.target as HTMLElement
      if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      // "/" is the universal search key; the box only exists on the pools tab.
      // An open overlay owns the moment: arrow-keying a token picker and then
      // hitting "/" must not move focus to a box hidden underneath it.
      if (e.key === '/') {
        if (document.querySelector('.tsel-pop, .chain-pop, .hist-pop')) return
        const box = document.getElementById('pool-search')
        if (box) {
          e.preventDefault() // don't type the slash into it
          box.focus()
        }
        return
      }
      const t = KEYS[e.key]
      if (t) setTab(t)
    }
    window.addEventListener('keydown', h)
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('keydown', h)
    }
  }, [])

  return (
    <div className="app">
      <Header tab={tab} onTab={setTab} />
      <div className="main">
        <NetworkPrompt enabled={tab !== 'bridge'} />
        {tab === 'pools' && (location.hash === '#lab' ? <LabTab /> : <PoolsTab />)}
        {tab === 'positions' && <PositionsTab />}
        {tab === 'swap' && <SwapTab />}
        {tab === 'bridge' && FEATURES.bridge && <BridgeTab />}
      </div>
      <div className="footer">
        <span className="hide-m">{t('app.tagline')}</span>
        {/* [5] is a key that does nothing on a chain with no bridge tab, and
            the switcher puts both chains one click apart on the same page */}
        <span className="hide-m">{t(FEATURES.bridge ? 'app.keys' : 'app.keysNoBridge')}</span>
        <RpcControl />
        <ThemeControl />
        <a href={EXPLORER} target="_blank" rel="noreferrer">
          {t('app.blockscout')}
        </a>
      </div>
    </div>
  )
}
