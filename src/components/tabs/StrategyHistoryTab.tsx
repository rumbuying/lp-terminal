import { useEffect, useRef, useState } from 'react'
import { formatUnits } from 'viem'
import { useTranslation } from 'react-i18next'
import { useAccount } from 'wagmi'
import { executorHistory, type ExecutorHistoryStrategy, type ExecutorPerformance } from '../../lib/executorClient'
import { strategyName } from '../../../shared/strategy/name'
import { Badge, Btn } from '../ui'
import { useExecutorWalletAuth } from '../../hooks/useExecutorWalletAuth'

const amount = (raw: string | null | undefined, performance: ExecutorPerformance, signed = false) => {
  if (raw == null || !performance.quote) return '—'
  const value = Number(formatUnits(BigInt(raw), performance.quote.decimals))
  const abs = Math.abs(value)
  const text = new Intl.NumberFormat(undefined, { maximumFractionDigits: abs >= 1 ? 4 : 6 }).format(abs)
  return `${value < 0 ? '−' : signed && value > 0 ? '+' : ''}${text} ${performance.quote.symbol}`
}

export function StrategyHistoryTab() {
  const { t } = useTranslation()
  const { address: user } = useAccount()
  const ownerRef = useRef(user?.toLowerCase())
  ownerRef.current = user?.toLowerCase()
  const auth = useExecutorWalletAuth(user)
  const [items, setItems] = useState<ExecutorHistoryStrategy[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const load = async () => {
    const requestedOwner = ownerRef.current
    setLoading(true); setError(null)
    try {
      const result = await executorHistory(auth.token)
      if (ownerRef.current !== requestedOwner) return
      setItems(requestedOwner ? result.strategies.filter((item) => item.config.owner.toLowerCase() === requestedOwner) : [])
    } catch (cause) {
      if (ownerRef.current === requestedOwner) setError(cause instanceof Error ? cause.message : 'history unavailable')
    }
    finally { if (ownerRef.current === requestedOwner) setLoading(false) }
  }
  useEffect(() => {
    setItems([])
    if (auth.token && user) void load()
  }, [user, auth.token])
  return <div className="panel">
    <div className="panel-head"><div><div className="section-title">{t('strategyHistory.title')}</div><div className="dim mono-sm">{t('strategyHistory.subtitle')}</div></div></div>
    {!user ? <div className="dim">{t('strategyHistory.connectWallet')}</div> : null}
    {user && !auth.token ? <div className="card"><div className="dim mono-sm">{auth.status === 'signing' ? t('strategy.walletAuthSigning') : auth.status === 'verifying' ? t('strategy.walletAuthVerifying') : t('strategy.walletAuthPrompt')}</div>{auth.status === 'error' ? <Btn onClick={auth.retry}>{t('strategy.walletAuthRetry')}</Btn> : null}{auth.error && <div className="amber mono-sm">{auth.error}</div>}</div> : null}
    {error ? <div className="amber mono-sm">{error}</div> : null}
    {user && auth.token && <div className="card-actions"><Btn onClick={() => void load()} busy={loading}>{t('strategyHistory.refresh')}</Btn></div>}
    {user && !loading && items.length === 0 && !error ? <div className="dim">{t('strategyHistory.empty')}</div> : items.map((item) => {
      const p = item.performance, s = p.summary
      const pnlKnown = s?.pnlQuoteRaw != null
      const name = strategyName(item.config, (address) => address.toLowerCase() === item.config.quoteToken.toLowerCase() ? p.quote?.symbol : p.risk?.symbol)
      return <div className="card" key={item.config.id}>
        <div className="card-head"><span className="card-title">{name}</span><Badge tone="dim">{t('strategyHistory.archived')}</Badge></div>
        <div className="kv mono-sm"><span>{new Date(item.config.createdAt * 1000).toLocaleString()} → {new Date(item.archivedAt * 1000).toLocaleString()}</span><span>{t('strategyHistory.lastPosition', { tokenId: item.config.activeTokenId ?? '—' })}</span></div>
        {s && p.quote ? <>
          <div className="performance-grid">
            <div className="performance-metric"><span>{t('strategy.perfPnl')}</span><strong className={pnlKnown && BigInt(s.pnlQuoteRaw!) >= 0n ? 'green' : pnlKnown ? 'red' : ''}>{amount(s.pnlQuoteRaw, p, true)}</strong><small>{s.pnlPct == null ? t('strategyHistory.notTracked') : `${s.pnlPct >= 0 ? '+' : ''}${s.pnlPct.toFixed(2)}%`}</small></div>
            <div className="performance-metric"><span>{t('strategy.perfFees')}</span><strong className="green">{amount(s.netFeesQuoteRaw, p)}</strong><small>{t('strategy.perfNetFees')}</small></div>
            <div className="performance-metric"><span>{t('strategy.perfGas')}</span><strong className="red">{amount(s.gasCostQuoteRaw, p)}</strong><small>{t('strategy.perfReopens')} {s.reopens}</small></div>
            <div className="performance-metric"><span>{t('strategyHistory.finalAssets')}</span><strong>{amount(s.currentValueQuoteRaw, p)}</strong><small>{t('strategyHistory.frozen')}</small></div>
          </div>
          {p.cycles?.length ? <details className="performance-history"><summary>{t('strategy.perfHistory', { n: p.cycles.length })}</summary>{p.cycles.map((cycle) => <div className="performance-cycle mono-sm" key={cycle.id}><span>{cycle.completedAt ? new Date(cycle.completedAt * 1000).toLocaleString() : '—'}</span><span>#{cycle.oldTokenId ?? '—'} → #{cycle.newTokenId ?? '—'}</span><span className="green">+{amount(cycle.netFeesQuoteRaw, p)}</span><span className="red">Gas {amount(cycle.gasCostQuoteRaw, p)}</span></div>)}</details> : null}
        </> : <div className="dim">{t('strategyHistory.notTracked')}</div>}
      </div>
    })}
  </div>
}
