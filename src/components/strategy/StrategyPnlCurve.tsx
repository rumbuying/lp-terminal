import { useId } from 'react'
import type { ExecutorPerformance, ExecutorPnlCurvePoint } from '../../lib/executorClient'
import { strategyPnlCurvePoints, type PnlCurvePoint, type PnlCurveUnit } from '../../lib/pnlCurve'

const WIDTH = 720
const HEIGHT = 132
const PAD_X = 8
const PAD_Y = 12

const amount = (value: number, symbol: string) => {
  const abs = Math.abs(value)
  const text = new Intl.NumberFormat(undefined, { maximumFractionDigits: abs >= 100 ? 1 : abs >= 1 ? 2 : 4 }).format(abs)
  return `${value < 0 ? '−' : value > 0 ? '+' : ''}${text} ${symbol}`
}

export function StrategyPnlCurve({
  strategyId, rows, performance, unit, title, empty, compact = false,
}: {
  strategyId: string
  rows: ExecutorPnlCurvePoint[]
  performance: ExecutorPerformance
  unit: PnlCurveUnit
  title: string
  empty: string
  compact?: boolean
}) {
  const points = strategyPnlCurvePoints(strategyId, rows, performance, unit)
  const symbol = unit === 'stable' ? performance.stable?.symbol ?? 'USD' : performance.quote?.symbol ?? ''
  return <PnlValueCurve points={points} symbol={symbol} title={title} empty={empty} compact={compact}/>
}

export function PnlValueCurve({ points, symbol, title, empty, compact = false }: {
  points: PnlCurvePoint[]
  symbol: string
  title: string
  empty: string
  compact?: boolean
}) {
  const gradientId = `pnl-fill-${useId().replace(/:/g, '')}`
  if (!points.length) return <div className={`strategy-pnl-curve ${compact ? 'compact' : ''}`}><div className="strategy-pnl-curve-head"><span>{title}</span></div><div className="strategy-pnl-curve-empty">{empty}</div></div>

  const minAt = points[0].at
  const maxAt = points[points.length - 1].at
  const values = points.map((point) => point.value)
  const minValue = Math.min(0, ...values)
  const maxValue = Math.max(0, ...values)
  const span = Math.max(maxValue - minValue, Math.max(Math.abs(maxValue), Math.abs(minValue), 1) * 0.08)
  const x = (at: number) => PAD_X + ((at - minAt) / Math.max(1, maxAt - minAt)) * (WIDTH - PAD_X * 2)
  const y = (value: number) => PAD_Y + ((maxValue - value) / span) * (HEIGHT - PAD_Y * 2)
  const coords = points.map((point) => [x(point.at), y(point.value)] as const)
  const line = coords.map(([px, py], index) => `${index ? 'L' : 'M'}${px.toFixed(2)},${py.toFixed(2)}`).join(' ')
  const area = `${line} L${coords[coords.length - 1][0].toFixed(2)},${HEIGHT - PAD_Y} L${coords[0][0].toFixed(2)},${HEIGHT - PAD_Y} Z`
  const latest = points[points.length - 1]
  const positive = latest.value >= 0
  const zeroY = y(0)

  return <figure className={`strategy-pnl-curve ${positive ? 'profit' : 'loss'} ${compact ? 'compact' : ''}`}>
    <figcaption className="strategy-pnl-curve-head"><span>{title}</span><strong>{amount(latest.value, symbol)}</strong></figcaption>
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${title}: ${amount(latest.value, symbol)}`} preserveAspectRatio="none">
      <defs><linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".28"/><stop offset="1" stopColor="currentColor" stopOpacity="0"/></linearGradient></defs>
      <line className="strategy-pnl-zero" x1={PAD_X} x2={WIDTH - PAD_X} y1={zeroY} y2={zeroY}/>
      <path className="strategy-pnl-area" d={area} fill={`url(#${gradientId})`}/>
      <path className="strategy-pnl-line" d={line}/>
      <circle className="strategy-pnl-dot" cx={coords[coords.length - 1][0]} cy={coords[coords.length - 1][1]} r="3.5"/>
    </svg>
    {!compact && <div className="strategy-pnl-curve-axis mono-sm"><span>{new Date(minAt * 1000).toLocaleString()}</span><span>{new Date(maxAt * 1000).toLocaleString()}</span></div>}
  </figure>
}
