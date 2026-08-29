import { useEffect, useMemo, useRef, useState } from 'react'
import { formatUnits } from 'viem'
import { useTranslation } from 'react-i18next'
import { useAccount } from 'wagmi'
import { executorPnlCalendar, type ExecutorCalendarRow } from '../../lib/executorClient'
import { shanghaiDay } from '../../../shared/strategy/calendar'
import { Btn } from '../ui'
import { useExecutorWalletAuth } from '../../hooks/useExecutorWalletAuth'
import { usePnlUnit } from '../../hooks/usePnlUnit'
import { PnlUnitToggle } from '../PnlUnitToggle'

const pad = (value: number) => String(value).padStart(2, '0')
const monthKey = (date: Date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`
const monthStart = (key: string) => new Date(`${key}-01T00:00:00Z`)
const shiftMonth = (key: string, delta: number) => { const d = monthStart(key); d.setUTCMonth(d.getUTCMonth() + delta); return monthKey(d) }
const dateDay = (date: string) => shanghaiDay(Date.parse(`${date}T00:00:00+08:00`) / 1000)

const signedAmount = (raw: bigint, symbol: string, decimals: number) => {
  const value = Number(formatUnits(raw, decimals)), abs = Math.abs(value)
  const text = new Intl.NumberFormat(undefined, { maximumFractionDigits: abs >= 1 ? 4 : 6 }).format(abs)
  return `${value < 0 ? '−' : value > 0 ? '+' : ''}${text} ${symbol}`
}

type Total = { raw: bigint; fees: bigint; gas: bigint; decimals: number; symbol: string }
const totals = (rows: ExecutorCalendarRow[]) => {
  const out = new Map<string, Total>()
  for (const row of rows) {
    const key = row.quote.address.toLowerCase(), item = out.get(key) ?? { raw: 0n, fees: 0n, gas: 0n, decimals: row.quote.decimals, symbol: row.quote.symbol }
    if (row.pnlRaw !== null) item.raw += BigInt(row.pnlRaw)
    item.fees += BigInt(row.feesRaw); item.gas += BigInt(row.gasRaw); out.set(key, item)
  }
  return [...out.values()]
}

export function PnlCalendarTab() {
  const { t } = useTranslation()
  const [pnlUnit] = usePnlUnit()
  const { address: user } = useAccount()
  const ownerRef = useRef(user?.toLowerCase())
  ownerRef.current = user?.toLowerCase()
  const shanghaiNow = new Date(Date.now() + 8 * 60 * 60_000)
  const [month, setMonth] = useState(monthKey(shanghaiNow))
  const [selected, setSelected] = useState(`${shanghaiNow.getUTCFullYear()}-${pad(shanghaiNow.getUTCMonth() + 1)}-${pad(shanghaiNow.getUTCDate())}`)
  const auth = useExecutorWalletAuth(user, true, false)
  const [rows, setRows] = useState<ExecutorCalendarRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = async (key = month) => {
    const requestedOwner = ownerRef.current
    setLoading(true); setError(null)
    try {
      const first = `${key}-01`, start = monthStart(key), end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0)
      const result = await executorPnlCalendar(auth.token, dateDay(first), dateDay(`${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}`))
      if (ownerRef.current !== requestedOwner) return
      setRows(requestedOwner ? result.rows : [])
    } catch (cause) {
      if (ownerRef.current === requestedOwner) {
        if (cause instanceof Error && cause.message === 'authentication required') auth.invalidate()
        else setError(cause instanceof Error ? cause.message : 'calendar unavailable')
      }
    }
    finally { if (ownerRef.current === requestedOwner) setLoading(false) }
  }
  useEffect(() => {
    setRows([])
    if (auth.token && user) void load(month)
  }, [month, user, auth.token])
  const byDate = useMemo(() => {
    const grouped = new Map<string, ExecutorCalendarRow[]>()
    for (const row of rows) grouped.set(row.date, [...(grouped.get(row.date) ?? []), row])
    return grouped
  }, [rows])
  const start = monthStart(month), days = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate()
  const leading = start.getUTCDay()
  const cells = Array.from({ length: leading + days }, (_, index) => index < leading ? null : `${month}-${pad(index - leading + 1)}`)
  while (cells.length % 7) cells.push(null)
  const selectedRows = byDate.get(selected) ?? []
  return <div className="panel">
    <div className="panel-head"><div><div className="section-title">{t('pnlCalendar.title')}</div><div className="dim mono-sm">{t('pnlCalendar.subtitle')}</div></div><PnlUnitToggle /></div>
    {!user ? <div className="dim">{t('pnlCalendar.connectWallet')}</div> : null}
    {user && !auth.token ? <div className="card"><div className="dim mono-sm">{auth.status === 'signing' ? t('strategy.walletAuthSigning') : auth.status === 'verifying' ? t('strategy.walletAuthVerifying') : t('strategy.walletAuthPrompt')}</div>{auth.status !== 'signing' && auth.status !== 'verifying' && auth.status !== 'requesting' ? <Btn onClick={auth.retry}>{auth.status === 'error' ? t('strategy.walletAuthRetry') : t('strategy.walletAuthRequest')}</Btn> : null}{auth.error && <div className="amber mono-sm">{auth.error}</div>}</div> : null}
    {error ? <div className="amber mono-sm">{error}</div> : null}
    {user && auth.token && <div className="calendar-toolbar"><Btn onClick={() => setMonth(shiftMonth(month, -1))}>‹</Btn><strong>{month}</strong><Btn onClick={() => setMonth(shiftMonth(month, 1))}>›</Btn><Btn onClick={() => void load()} busy={loading}>{t('pnlCalendar.refresh')}</Btn></div>}
    {user && auth.token && <>
    <div className="pnl-calendar">
      {(['sun','mon','tue','wed','thu','fri','sat'] as const).map((day) => <div className="calendar-weekday" key={day}>{t(`pnlCalendar.${day}`)}</div>)}
      {cells.map((date, index) => {
        if (!date) return <div className="calendar-day empty" key={`empty-${index}`} />
        const dayRows = byDate.get(date) ?? [], dayTotals = totals(dayRows)
        const stableRaw = dayRows.reduce<bigint | null>((sum, row) => row.pnlUsdgRaw === null ? sum : (sum ?? 0n) + BigInt(row.pnlUsdgRaw), null)
        const net = pnlUnit === 'stable'
          ? stableRaw === null ? 0 : stableRaw > 0n ? 1 : stableRaw < 0n ? -1 : 0
          : dayTotals.reduce((sum, item) => sum + (item.raw > 0n ? 1 : item.raw < 0n ? -1 : 0), 0)
        return <button className={`calendar-day ${date === selected ? 'selected' : ''} ${net > 0 ? 'profit' : net < 0 ? 'loss' : ''}`} key={date} onClick={() => setSelected(date)}>
          <span className="calendar-date">{Number(date.slice(-2))}</span>
          {pnlUnit === 'stable'
            ? stableRaw === null ? null : <strong>{signedAmount(stableRaw, 'USDG', 6)}</strong>
            : dayTotals.map((item) => <strong key={item.symbol}>{signedAmount(item.raw, item.symbol, item.decimals)}</strong>)}
          {dayRows.length ? <small>{t('pnlCalendar.dayMeta', { fees: dayTotals.map((item) => signedAmount(item.fees, item.symbol, item.decimals)).join(' · '), reopens: dayRows.reduce((sum, row) => sum + row.reopens, 0) })}</small> : null}
        </button>
      })}
    </div>
    <div className="section-title">{selected} · {t('pnlCalendar.details')}</div>
    {!selectedRows.length ? <div className="dim">{t('pnlCalendar.noData')}</div> : selectedRows.map((row) => <div className="card" key={row.strategyId}>
      <div className="card-head"><span className="card-title">{row.name}</span><strong className={(pnlUnit === 'stable' ? row.pnlUsdgRaw : row.pnlRaw) !== null && BigInt((pnlUnit === 'stable' ? row.pnlUsdgRaw : row.pnlRaw)!) >= 0n ? 'green' : 'red'}>{pnlUnit === 'stable' ? row.pnlUsdgRaw === null ? '—' : signedAmount(BigInt(row.pnlUsdgRaw), 'USDG', 6) : row.pnlRaw === null ? '—' : signedAmount(BigInt(row.pnlRaw), row.quote.symbol, row.quote.decimals)}</strong></div>
      <div className="kv mono-sm"><span>{t('pnlCalendar.fees')} {signedAmount(BigInt(row.feesRaw), row.quote.symbol, row.quote.decimals)}</span><span>{t('pnlCalendar.gas')} {signedAmount(-BigInt(row.gasRaw), row.quote.symbol, row.quote.decimals)}</span><span>{t('pnlCalendar.reopens')} {row.reopens}</span><span>{new Date(row.firstObservedAt * 1000).toLocaleTimeString()} → {new Date(row.lastObservedAt * 1000).toLocaleTimeString()}</span></div>
    </div>)}
    </>}
  </div>
}
