import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiquidityDistribution } from '../hooks/useLiquidityDistribution'
import { tickToPrice } from '../lib/clmath'
import { fmtNum } from '../lib/format'
import { buildLiquidityBins } from '../lib/liquidityDistribution'
import type { ClPool, TokenInfo } from '../types'

const WIDTH = 900
const HEIGHT = 174
const PLOT_TOP = 16
const PLOT_BOTTOM = 132
const COMPACT_WIDTH = 720
const COMPACT_HEIGHT = 82
const COMPACT_PLOT_TOP = 16
const COMPACT_PLOT_BOTTOM = 68

function pctWidth(lower: number, upper: number): number {
  return (Math.pow(1.0001, upper - lower) - 1) * 100
}

export function LiquidityDistributionChart(props: {
  pool: ClPool
  tickLower: number
  tickUpper: number
  token0: TokenInfo
  token1: TokenInfo
  /** Price orientation shared with its range bar. */
  flipped?: boolean
  /** Positions use the same live on-chain data in a deliberately terse card view. */
  compact?: boolean
}) {
  const { t } = useTranslation()
  const { pool, tickLower, tickUpper, token0, token1, compact = false, flipped = false } = props
  const { domain, query } = useLiquidityDistribution(pool, tickLower, tickUpper)
  const bins = useMemo(
    () => buildLiquidityBins(pool.tick, pool.liquidity, query.data ?? [], domain),
    [pool.tick, pool.liquidity, query.data, domain.tickLow, domain.tickHigh],
  )
  const maxLiquidity = Math.max(0, ...bins.map((bin) => bin.liquidity))
  const widthPct = pctWidth(tickLower, tickUpper)
  const efficiencyKey = widthPct >= 40 ? 'add.distWide' : widthPct <= 4 ? 'add.distTight' : 'add.distBalanced'
  const width = compact ? COMPACT_WIDTH : WIDTH
  const height = compact ? COMPACT_HEIGHT : HEIGHT
  const plotTop = compact ? COMPACT_PLOT_TOP : PLOT_TOP
  const plotBottom = compact ? COMPACT_PLOT_BOTTOM : PLOT_BOTTOM
  const xScale = (tick: number) => {
    const canonicalX = ((tick - domain.tickLow) / (domain.tickHigh - domain.tickLow)) * width
    return flipped ? width - canonicalX : canonicalX
  }
  const lowerX = Math.max(0, Math.min(width, xScale(tickLower)))
  const upperX = Math.max(0, Math.min(width, xScale(tickUpper)))
  const selectedX = Math.min(lowerX, upperX)
  const selectedWidth = Math.max(1, Math.abs(upperX - lowerX))
  const currentX = Math.max(0, Math.min(width, xScale(pool.tick)))
  const canonicalLowerPrice = tickToPrice(domain.tickLow, token0.decimals, token1.decimals)
  const canonicalSpotPrice = tickToPrice(pool.tick, token0.decimals, token1.decimals)
  const canonicalUpperPrice = tickToPrice(domain.tickHigh, token0.decimals, token1.decimals)
  const lowerPrice = flipped ? 1 / canonicalUpperPrice : canonicalLowerPrice
  const spotPrice = flipped ? 1 / canonicalSpotPrice : canonicalSpotPrice
  const upperPrice = flipped ? 1 / canonicalLowerPrice : canonicalUpperPrice
  const unit = flipped ? `${token0.symbol}/${token1.symbol}` : `${token1.symbol}/${token0.symbol}`

  return (
    <div className={`liq-dist${compact ? ' liq-dist-compact' : ''}`}>
      <div className="liq-dist-head">
        <span>{compact ? t('pos.liquidityDist') : t('add.distTitle')}</span>
        <span className="dim">
          {!compact && t('add.distWidth', { pct: widthPct > 999 ? '>999' : widthPct.toFixed(widthPct < 10 ? 1 : 0) })}
          {query.isFetching ? <span className="spin"> ▮</span> : ''}
        </span>
      </div>
      <svg className="liq-dist-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('add.distAria')}>
        <rect x={selectedX} y={plotTop} width={selectedWidth} height={plotBottom - plotTop} className="liq-dist-selection" />
        {bins.map((bin, index) => {
          const normalized = maxLiquidity > 0 ? Math.sqrt(bin.liquidity / maxLiquidity) : 0
          const barHeight = normalized * (plotBottom - plotTop - 8)
          const barWidth = width / bins.length
          return (
            <rect
              key={index}
              x={flipped ? width - (index + 1) * barWidth + 0.6 : index * barWidth + 0.6}
              y={plotBottom - barHeight}
              width={Math.max(0.5, barWidth - 1.2)}
              height={barHeight}
              className="liq-dist-bar"
            >
              <title>{t('add.distBarTip', { liquidity: bin.liquidity.toExponential(3) })}</title>
            </rect>
          )
        })}
        <line x1={currentX} x2={currentX} y1={8} y2={plotBottom + 5} className="liq-dist-current" />
        <text x={currentX} y={11} textAnchor={currentX > width * 0.82 ? 'end' : 'start'} className="liq-dist-now">
          {t('add.distNow')}
        </text>
        <line x1="0" x2={width} y1={plotBottom} y2={plotBottom} className="liq-dist-axis" />
        {!compact && <>
          <text x="0" y="158" textAnchor="start" className="liq-dist-label">{fmtNum(lowerPrice)}</text>
          <text x={currentX} y="158" textAnchor="middle" className="liq-dist-label liq-dist-spot">{fmtNum(spotPrice)}</text>
          <text x={WIDTH} y="158" textAnchor="end" className="liq-dist-label">{fmtNum(upperPrice)}</text>
          <text x={WIDTH} y="172" textAnchor="end" className="liq-dist-unit">{unit}</text>
        </>}
      </svg>
      {!compact && <div className={`liq-dist-note ${widthPct >= 40 ? 'amber' : widthPct <= 4 ? 'green' : 'dim'}`}>
        {t(efficiencyKey)}
        {domain.clipped ? ` · ${t('add.distClipped')}` : ''}
      </div>}
      {query.isError && <div className="liq-dist-note amber">{compact ? t('pos.liquidityDistUnavailable') : t('add.distUnavailable')}</div>}
    </div>
  )
}
