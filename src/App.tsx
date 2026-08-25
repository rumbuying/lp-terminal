import { lazy, Suspense, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WagmiProvider, useAccount, useSwitchChain } from 'wagmi'
import { QueryClientProvider } from '@tanstack/react-query'
import { wagmiConfig } from './config/wagmi'
import { queryClient } from './config/query'
import { CHAIN_ID, EXPLORER } from './config/addresses'
import { Header, type TabId } from './components/Header'
import { RpcControl } from './components/RpcControl'
import { ThemeControl } from './components/ThemeControl'
import { PoolsTab } from './components/tabs/PoolsTab'
import { Btn } from './components/ui'

const BridgeTab = lazy(() => import('./components/tabs/BridgeTab').then(({ BridgeTab }) => ({ default: BridgeTab })))
const LabTab = lazy(() => import('./components/tabs/LabTab').then(({ LabTab }) => ({ default: LabTab })))
const PositionsTab = lazy(() => import('./components/tabs/PositionsTab').then(({ PositionsTab }) => ({ default: PositionsTab })))
const RecommendationsTab = lazy(() => import('./components/tabs/RecommendationsTab').then(({ RecommendationsTab }) => ({ default: RecommendationsTab })))
const SwapTab = lazy(() => import('./components/tabs/SwapTab').then(({ SwapTab }) => ({ default: SwapTab })))
const StrategyTab = lazy(() => import('./components/tabs/StrategyTab').then(({ StrategyTab }) => ({ default: StrategyTab })))
const StrategyHistoryTab = lazy(() => import('./components/tabs/StrategyHistoryTab').then(({ StrategyHistoryTab }) => ({ default: StrategyHistoryTab })))
const PnlCalendarTab = lazy(() => import('./components/tabs/PnlCalendarTab').then(({ PnlCalendarTab }) => ({ default: PnlCalendarTab })))

export default function App() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <Shell />
      </QueryClientProvider>
    </WagmiProvider>
  )
}

const KEYS: Record<string, TabId> = {
  '1': 'pools',
  '9': 'recommendations',
  '2': 'positions',
  '3': 'swap',
  '5': 'bridge',
  '6': 'strategy',
  '7': 'strategy-history',
  '8': 'pnl-calendar',
}

const validTab = (h: string): TabId | null => {
  if (h === 'limit') return 'swap' // LIMIT mode is a sub-view of the swap tab
  if (h === 'lab') return 'pools' // hidden component lab rides the pools slot
  return (['pools', 'recommendations', 'positions', 'swap', 'bridge', 'strategy', 'strategy-history', 'pnl-calendar'] as const).includes(h as TabId) ? (h as TabId) : null
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
        <Suspense fallback={<div className="panel dim mono-sm">{t('app.loadingTab')}</div>}>
          {tab === 'pools' && (location.hash === '#lab' ? <LabTab /> : <PoolsTab />)}
          {tab === 'recommendations' && <RecommendationsTab onOpenPool={() => setTab('pools')} />}
          {tab === 'positions' && <PositionsTab />}
          {tab === 'swap' && <SwapTab />}
          {tab === 'bridge' && <BridgeTab />}
          {tab === 'strategy' && <StrategyTab />}
          {tab === 'strategy-history' && <StrategyHistoryTab />}
          {tab === 'pnl-calendar' && <PnlCalendarTab />}
        </Suspense>
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
