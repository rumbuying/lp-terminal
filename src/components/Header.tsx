import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import type { PublicClient } from 'viem'
import { CHAIN_ID } from '../config/addresses'
import { FEATURES } from '../config/features'
import { HEADER_BLOCK_QUERY_POLICY } from '../config/query'
import { useTranslation } from 'react-i18next'
import { ChainControl } from './ChainControl'
import { HistoryButton } from './HistoryButton'
import { LangControl } from './LangControl'
import { NewsButton } from './NewsButton'
import { MobileThemeControl } from './ThemeControl'

export type TabId = 'pools' | 'recommendations' | 'positions' | 'swap' | 'bridge' | 'strategy' | 'strategy-history' | 'pnl-calendar'
// Reading order is the order of the trade: find a market, take it, then watch
// what you are left holding. POOLS now carries the swap form beside the market
// list, so SWAP sits next to it as the same act at full width; POSITIONS is
// what comes after, and BRIDGE is how funds arrive. The digits follow the eye —
// [5] keeps its old binding because the bridge never moved.
const ALL_TABS = [
  { id: 'pools', labelKey: 'hdr.pools', key: '1' },
  { id: 'recommendations', labelKey: 'hdr.recommendations', key: '9' },
  { id: 'swap', labelKey: 'hdr.swap', key: '2' },
  { id: 'positions', labelKey: 'hdr.positions', key: '3' },
  { id: 'bridge', labelKey: 'hdr.bridge', key: '5' },
  { id: 'strategy', labelKey: 'hdr.strategy', key: '6' },
  { id: 'strategy-history', labelKey: 'hdr.strategyHistory', key: '7' },
  { id: 'pnl-calendar', labelKey: 'hdr.pnlCalendar', key: '8' },
] as const
// a chain with no bridge route model never shows the tab (FEATURES.bridge)
const TABS = ALL_TABS.filter((tb) => tb.id !== 'bridge' || FEATURES.bridge)

export function Header(props: { tab: TabId; onTab: (t: TabId) => void }) {
  const { t } = useTranslation()
  const pc = usePublicClient({ chainId: CHAIN_ID })
  const block = useQuery({
    queryKey: ['headerBlockNumber', CHAIN_ID],
    enabled: !!pc,
    ...HEADER_BLOCK_QUERY_POLICY,
    queryFn: () => (pc as PublicClient).getBlockNumber(),
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
      {block.data !== undefined && (
        <span className="hdr-meta">
          {t('hdr.blk')} <b>{block.data.toString()}</b>
        </span>
      )}
      <HistoryButton />
      <NewsButton />
      <MobileThemeControl />
      <LangControl />
      {/* immediately left of the wallet, where every DApp puts it — the two
          answer the same question from different sides */}
      <ChainControl />
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
