import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { getAddress } from 'viem'
import { LangControl } from './LangControl'
import { ThemeControl } from './ThemeControl'
import { Badge, Btn } from './ui'
import { PnlValueCurve } from './strategy/StrategyPnlCurve'
import {
  aggregatePublicPnlCurve,
  decimalValue,
  fetchAllPublicStrategyStatuses,
  positionRangeState,
  publicStatusTotals,
  statusAddressFromPath,
  statusPath,
  type PublicStrategy,
  type PublicStrategyStatus,
} from '../lib/publicStrategyStatus'

const money = (value: number | null, signed = false) => {
  if (value === null) return '—'
  const absolute = Math.abs(value)
  const digits = absolute >= 100 ? 0 : absolute >= 1 ? 2 : 4
  const prefix = value < 0 ? '−' : signed && value > 0 ? '+' : ''
  return `${prefix}$${new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(absolute)}`
}

const percentage = (value: number | null | undefined) => value == null
  ? '—'
  : `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(2)}%`

const compactAddress = (address: string) => `${address.slice(0, 8)}…${address.slice(-6)}`

function stateTone(state: string): 'green' | 'amber' | 'red' | 'dim' {
  if (state === 'monitoring') return 'green'
  if (['planned', 'executing', 'recovery'].includes(state)) return 'amber'
  if (state.includes('quarantined') || state.includes('paused')) return 'red'
  return 'dim'
}

function StrategyCard({ strategy, status }: { strategy: PublicStrategy; status: PublicStrategyStatus }) {
  const { t } = useTranslation()
  const performance = strategy.performance
  const summary = performance?.summary
  const stableDecimals = status.chain.stable.decimals
  const stablePnl = decimalValue(summary?.pnlStableRaw, stableDecimals)
  const stableValue = decimalValue(summary?.currentValueStableRaw, stableDecimals)
  const quotePnl = decimalValue(summary?.pnlQuoteRaw, performance?.quote?.decimals ?? 18)
  const quoteValue = decimalValue(summary?.currentValueQuoteRaw, performance?.quote?.decimals ?? 18)
  const range = positionRangeState(performance?.position)
  const pnlClass = (stablePnl ?? quotePnl ?? 0) >= 0 ? 'green' : 'red'
  return <article className="public-strategy-card">
    <div className="public-strategy-card-head">
      <div><span className="public-chain-tag">{status.chain.key === 'bsc' ? 'BSC' : 'ROBINHOOD'}</span><h3>{strategy.name}</h3></div>
      <Badge tone={stateTone(strategy.state)}>{strategy.state.toUpperCase()}</Badge>
    </div>
    <div className="public-strategy-metrics">
      <div><span>{t('publicStatus.pnl')}</span><strong className={pnlClass}>{stablePnl !== null ? money(stablePnl, true) : `${quotePnl == null ? '—' : quotePnl.toLocaleString()} ${performance?.quote?.symbol ?? ''}`}</strong><small>{percentage(summary?.pnlStablePct ?? summary?.pnlPct)}</small></div>
      <div><span>{t('publicStatus.value')}</span><strong>{stableValue !== null ? money(stableValue) : `${quoteValue == null ? '—' : quoteValue.toLocaleString()} ${performance?.quote?.symbol ?? ''}`}</strong><small>{t('publicStatus.rebalances', { n: summary?.reopens ?? 0 })}</small></div>
      <div><span>{t('publicStatus.position')}</span><strong>{strategy.activeTokenId ? `#${strategy.activeTokenId}` : '—'}</strong><small className={range === 'in' ? 'green' : range === 'out' ? 'red' : 'dim'}>{t(`publicStatus.range_${range}`)}</small></div>
    </div>
    {strategy.error && <div className="amber mono-sm">{t('publicStatus.valuationUnavailable')}</div>}
    <div className="public-strategy-meta mono-sm"><span>{strategy.protocol}</span><span>{compactAddress(strategy.pool)}</span><span>{t('publicStatus.updated', { time: new Date((performance?.calculatedAt ?? strategy.updatedAt) * 1000).toLocaleString() })}</span></div>
  </article>
}

export function PublicStatusPage() {
  const { t } = useTranslation()
  const pathHasAddress = /^\/status\/.+/.test(location.pathname)
  const address = statusAddressFromPath(location.pathname)
  const [input, setInput] = useState(address ?? '')
  const [inputError, setInputError] = useState(pathHasAddress && !address)

  useEffect(() => {
    if (!address) return
    const canonical = statusPath(address)
    if (location.pathname !== canonical) history.replaceState(null, '', `${canonical}${location.search}${location.hash}`)
    document.title = `${t('publicStatus.title')} · ${compactAddress(address)}`
  }, [address, t])

  const query = useQuery({
    queryKey: ['public-strategy-status', address],
    enabled: !!address,
    queryFn: () => fetchAllPublicStrategyStatuses(address!),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    staleTime: 25_000,
    retry: false,
  })
  const results = query.data ?? []
  const totals = useMemo(() => publicStatusTotals(results), [results])
  const curve = useMemo(() => aggregatePublicPnlCurve(results), [results])
  const available = results.filter((result) => result.data)
  const unavailable = results.filter((result) => result.error)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    try {
      const next = getAddress(input.trim())
      location.assign(`${statusPath(next)}${location.search}`)
    } catch { setInputError(true) }
  }

  return <div className="public-status-page">
    <header className="public-status-header">
      <a className="brand" href="/">LP<span className="cursor">▮</span><span>STATUS</span></a>
      <div className="public-status-controls"><LangControl/><a className="btn ghost" href="/">{t('publicStatus.terminal')}</a></div>
    </header>
    <main className="public-status-main">
      <section className="public-status-hero">
        <span className="public-status-kicker">{t('publicStatus.kicker')}</span>
        <h1>{t('publicStatus.title')}</h1>
        <p>{t('publicStatus.subtitle')}</p>
        <form className="public-status-search" onSubmit={submit}>
          <input className={`input ${inputError ? 'bad' : ''}`} value={input} onChange={(event) => { setInput(event.target.value); setInputError(false) }} placeholder="0x…" aria-label={t('publicStatus.address')}/>
          <Btn big>{t('publicStatus.view')}</Btn>
        </form>
        {inputError && <div className="red mono-sm">{t('publicStatus.invalidAddress')}</div>}
      </section>

      {address && <>
        <div className="public-status-wallet mono-sm"><span>{t('publicStatus.wallet')}</span><b>{address}</b><Btn tone="ghost" onClick={() => void navigator.clipboard?.writeText(location.href)}>{t('publicStatus.copy')}</Btn><Btn tone="ghost" busy={query.isFetching} onClick={() => void query.refetch()}>{t('publicStatus.refresh')}</Btn></div>
        {query.isLoading && <div className="panel dim">{t('publicStatus.loading')}</div>}
        {unavailable.map((result) => <div className="banner" key={result.chainKey}>{t('publicStatus.chainUnavailable', { chain: result.chainName })}</div>)}
        {available.length > 0 && <>
          <section className="public-status-summary" aria-label={t('publicStatus.summary')}>
            <div><span>{t('publicStatus.running')}</span><strong>{totals.strategies}</strong><small>{t('publicStatus.chains', { n: available.length })}</small></div>
            <div><span>{t('publicStatus.totalValue')}</span><strong>{money(totals.currentValue)}</strong><small>{t('publicStatus.usdApprox')}</small></div>
            <div><span>{t('publicStatus.totalPnl')}</span><strong className={totals.pnl >= 0 ? 'green' : 'red'}>{totals.valuedStrategies ? money(totals.pnl, true) : '—'}</strong><small>{percentage(totals.pnlPct)}</small></div>
            <div><span>{t('publicStatus.lastRefresh')}</span><strong>{new Date(Math.max(...available.map((result) => result.data!.generatedAt)) * 1000).toLocaleTimeString()}</strong><small>{t('publicStatus.autoRefresh')}</small></div>
          </section>
          <section className="public-status-curve panel"><PnlValueCurve points={curve} symbol="USD" title={t('publicStatus.curve')} empty={t('publicStatus.curveEmpty')}/></section>
          <section className="public-strategy-grid">
            {available.flatMap((result) => result.data!.strategies.map((strategy) => <StrategyCard key={`${result.chainKey}:${strategy.id}`} strategy={strategy} status={result.data!}/>))}
          </section>
          {!query.isLoading && totals.strategies === 0 && <div className="public-status-empty panel">{t('publicStatus.empty')}</div>}
        </>}
        {!query.isLoading && available.length === 0 && <div className="public-status-empty panel red">{t('publicStatus.allUnavailable')}</div>}
      </>}
    </main>
    <footer className="public-status-footer"><span>{t('publicStatus.readOnly')}</span><ThemeControl/></footer>
  </div>
}
