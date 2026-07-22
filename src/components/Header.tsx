import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useTranslation } from 'react-i18next'
import { usePools } from '../hooks/usePools'
import { HistoryButton } from './HistoryButton'
import { LangControl } from './LangControl'
import { NewsButton } from './NewsButton'

export type TabId = 'pools' | 'positions' | 'swap' | 'bridge'
const TABS = [
  { id: 'pools', labelKey: 'hdr.pools', key: '1' },
  { id: 'positions', labelKey: 'hdr.positions', key: '2' },
  { id: 'swap', labelKey: 'hdr.swap', key: '3' },
  { id: 'bridge', labelKey: 'hdr.bridge', key: '5' },
] as const

export function Header(props: { tab: TabId; onTab: (t: TabId) => void }) {
  const { t } = useTranslation()
  const pools = usePools()
  const p = pools.data?.protocol

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
      {p && (
        <span className="hdr-meta">
          {t('hdr.blk')} <b>{p.blockNumber.toString()}</b>
        </span>
      )}
      <HistoryButton />
      <NewsButton />
      <LangControl />
      <ConnectButton.Custom>
        {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
          if (!mounted) return <button className="btn ghost">…</button>
          if (!account)
            return (
              <button className="btn" onClick={openConnectModal}>
                {t('hdr.connect')}
              </button>
            )
          if (chain?.unsupported)
            return (
              <button className="btn danger" onClick={openChainModal}>
                {t('hdr.wrongChain')}
              </button>
            )
          return (
            <button className="btn ghost" onClick={openAccountModal}>
              [{account.displayName}
              <span className="hide-m">{account.displayBalance ? ` · ${account.displayBalance}` : ''}</span>]
            </button>
          )
        }}
      </ConnectButton.Custom>
    </div>
  )
}
