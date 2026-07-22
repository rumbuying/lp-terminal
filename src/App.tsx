import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WagmiProvider, useAccount, useSwitchChain } from 'wagmi'
import { QueryClientProvider } from '@tanstack/react-query'
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit'
import { robinhood } from './config/chain'
import { wagmiConfig } from './config/wagmi'
import { queryClient } from './config/query'
import { CHAIN_ID, EXPLORER } from './config/addresses'
import { currentLang } from './i18n'
import { Header, type TabId } from './components/Header'
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
          initialChain={robinhood}
          modalSize="compact"
        >
          <Shell />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}

const KEYS: Record<string, TabId> = { '1': 'pools', '2': 'positions', '3': 'swap', '5': 'bridge' }

const validTab = (h: string): TabId | null => {
  if (h === 'limit') return 'swap' // LIMIT mode is a sub-view of the swap tab
  if (h === 'lab') return 'pools' // hidden component lab rides the pools slot
  return (['pools', 'positions', 'swap', 'bridge'] as const).includes(h as TabId) ? (h as TabId) : null
}

function Shell() {
  const { t } = useTranslation()
  const [tab, setTabState] = useState<TabId>(() => validTab(location.hash.slice(1)) ?? 'pools')
  const setTab = (t: TabId) => {
    setTabState(t)
    history.replaceState(null, '', '#' + t)
  }
  const { isConnected, chainId } = useAccount()
  const { switchChain } = useSwitchChain()

  useEffect(() => {
    const onHash = () => {
      const t = validTab(location.hash.slice(1))
      if (t) setTabState(t)
    }
    window.addEventListener('hashchange', onHash)
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '4') {
        // LIMIT is a sub-view of swap; location.hash fires hashchange so the
        // mounted SwapTab syncs its mode too
        setTabState('swap')
        location.hash = 'limit'
        return
      }
      const t = KEYS[e.key]
      if (t) {
        setTabState(t)
        history.replaceState(null, '', '#' + t)
      }
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
        {isConnected && chainId !== CHAIN_ID && tab !== 'bridge' && (
          <div className="banner">
            {t('app.wrongNetwork')}
            <Btn onClick={() => switchChain({ chainId: CHAIN_ID })}>{t('app.switch')}</Btn>
          </div>
        )}
        {tab === 'pools' && (location.hash === '#lab' ? <LabTab /> : <PoolsTab />)}
        {tab === 'positions' && <PositionsTab />}
        {tab === 'swap' && <SwapTab />}
        {tab === 'bridge' && <BridgeTab />}
      </div>
      <div className="footer">
        <span className="hide-m">{t('app.tagline')}</span>
        <span className="hide-m">{t('app.keys')}</span>
        <RpcControl />
        <ThemeControl />
        <a href={EXPLORER} target="_blank" rel="noreferrer">
          {t('app.blockscout')}
        </a>
      </div>
    </div>
  )
}
