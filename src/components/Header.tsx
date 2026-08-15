import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useAccount, useConnect, useDisconnect, usePublicClient, useSwitchChain } from 'wagmi'
import { CHAIN_ID } from '../config/addresses'
import { WALLET_PICKER_EVENT } from '../lib/walletConnect'
import { HistoryButton } from './HistoryButton'
import { LangControl } from './LangControl'
import { NewsButton } from './NewsButton'
import { MobileThemeControl } from './ThemeControl'

export type TabId = 'pools' | 'positions' | 'swap' | 'bridge' | 'strategy' | 'strategy-history' | 'pnl-calendar'
const TABS = [
  { id: 'pools', labelKey: 'hdr.pools', key: '1' },
  { id: 'positions', labelKey: 'hdr.positions', key: '2' },
  { id: 'swap', labelKey: 'hdr.swap', key: '3' },
  { id: 'bridge', labelKey: 'hdr.bridge', key: '5' },
  { id: 'strategy', labelKey: 'hdr.strategy', key: '6' },
  { id: 'strategy-history', labelKey: 'hdr.strategyHistory', key: '7' },
  { id: 'pnl-calendar', labelKey: 'hdr.pnlCalendar', key: '8' },
] as const

export function Header(props: { tab: TabId; onTab: (t: TabId) => void }) {
  const { t } = useTranslation()
  const publicClient = usePublicClient({ chainId: CHAIN_ID })
  const head = useQuery({
    queryKey: ['chain-head'],
    enabled: !!publicClient,
    refetchInterval: 30_000,
    queryFn: () => publicClient!.getBlockNumber(),
  })

  return (
    <div className="hdr">
      {/* the wordmark contracts to "LP▮" on a phone — at full length the utility
          cluster no longer fits one row, and CONNECT wraps to a second */}
      <span className="brand">
        LP<span className="cursor">▮</span>
        <span className="hide-m">TERMINAL</span>
      </span>
      <div className="tabs">
        {TABS.map((tb) => (
          <button
            key={tb.id}
            className={`tab ${props.tab === tb.id ? 'active' : ''}`}
            onClick={() => props.onTab(tb.id)}
          >
            <span className="key">[{tb.key}]</span>
            {t(tb.labelKey)}
          </button>
        ))}
      </div>
      {head.data !== undefined && (
        <span className="hdr-meta">
          {t('hdr.blk')} <b>{head.data.toString()}</b>
        </span>
      )}
      <HistoryButton />
      <NewsButton />
      <MobileThemeControl />
      <LangControl />
      <WalletControl />
    </div>
  )
}

function WalletControl() {
  const { t } = useTranslation()
  const { address, chainId, isConnected } = useAccount()
  const { connectors, connect, error, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener(WALLET_PICKER_EVENT, show)
    return () => window.removeEventListener(WALLET_PICKER_EVENT, show)
  }, [])
  if (isConnected && chainId !== CHAIN_ID) {
    return <button className="btn danger" onClick={() => switchChain({ chainId: CHAIN_ID })}>{t('hdr.wrongChain')}</button>
  }
  const label = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : t('hdr.connect')
  return <div className="wallet-ctl">
    <button className={`btn ${address ? 'ghost' : ''}`} onClick={() => setOpen((value) => !value)}>{address ? `[${label}]` : label}</button>
    {open && <div className="wallet-menu card">
      <div className="lbl">{t('hdr.wallet')}</div>
      {connectors.map((connector) => <button className="btn" disabled={isPending} key={connector.uid} onClick={() => {
        connect({ connector })
        setOpen(false)
      }}>{connector.name}</button>)}
      {address && <button className="btn danger" onClick={() => { disconnect(); setOpen(false) }}>{t('hdr.disconnect')}</button>}
      {error && <div className="red mono-sm">{error.message}</div>}
    </div>}
  </div>
}
