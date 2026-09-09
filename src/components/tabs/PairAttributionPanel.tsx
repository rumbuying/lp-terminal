import { useTranslation } from 'react-i18next'
import { fmtCompact, fmtUsd } from '../../lib/format'
import { sparklineBars, trendBadgeColor, trendGlyph, trendSubline } from '../../lib/trendBadge'
import type { PoolRankRow } from '../../hooks/usePoolRank'
import { useVolumePair, type PairVolumeMember, type PairVolumePayload } from '../../hooks/useVolumePair'
import { queuePoolJump } from '../../lib/poolJump'

const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`

/** The five-class trend badge (PRD FR-UI-1): glyph, color, number sub-line. */
export function TrendBadge({ trend }: { trend: PoolRankRow['trend'] }) {
  const { t } = useTranslation()
  if (trend.class === 'unknown') return <span className="dim" title={t('poolRank.trendUnknownTip')}>—</span>
  const color = trendBadgeColor[trend.class]
  const sub = trendSubline(trend)
  const hot = trend.class === 'new_hot' && trend.daysToVerified !== null
  return (
    <span
      className="pr-trend"
      title={t('poolRank.trendValueTip', {
        klass: t(`poolRank.trendClass.${trend.class}`),
        sub,
        days: trend.daysSampled,
        rises: trend.consecutiveRiseDays ?? '—',
      })}
    >
      <span className={`badge ${color}`}>{trendGlyph[trend.class]} {t(`poolRank.trendClass.${trend.class}`)}</span>
      {sub && <span className="dim mono-sm">{sub}</span>}
      {hot && <span className="dim mono-sm">· {t('poolRank.newHotLeft', { days: trend.daysToVerified })}</span>}
    </span>
  )
}

/** 14-day daily-volume sparkline — a missing day is a gap, never a zero. */
export function VolumeSparkline({ values }: { values: readonly (number | null)[] }) {
  const bars = sparklineBars(values, 42, 14)
  if (!bars.length) return null
  return (
    <svg className="pr-spark" viewBox="0 0 42 14" width="42" height="14" role="img" aria-hidden="true">
      {bars.map((b, i) => (
        <rect key={i} x={b.x.toFixed(2)} y={b.y.toFixed(2)} width={b.w.toFixed(2)} height={b.h.toFixed(2)} fill="currentColor" opacity="0.55" />
      ))}
    </svg>
  )
}

const VENUE_LABEL: Record<PairVolumeMember['proto'], string> = {
  'up33-cl': 'UP33 CL',
  univ3: 'Uni v3',
  univ4: 'Uni v4',
}

const CHART_COLORS = ['var(--acc)', 'var(--cyan)', 'var(--amber)', 'var(--green)', 'var(--red)', 'var(--dim)']

/**
 * Stacked share polygons over contiguous fully-priced day runs, over the pair
 * total bars — the two charts the attribution panel opens with (PRD FR-UI-4).
 * A day any member lacks a price for is excluded from the stack; the member
 * usdCoverage line below the table explains why.
 */
function PairCharts({ payload, focusIdentity }: { payload: PairVolumePayload; focusIdentity: string }) {
  const { t } = useTranslation()
  const width = 680
  const height = 84
  const n = payload.days.length
  const members = payload.pools
  const maxTotal = Math.max(0, ...payload.pairTotal.filter((v): v is number => v !== null))
  const x = (i: number) => (i / Math.max(1, n - 1)) * width
  const y = (share: number) => height - Math.min(1, Math.max(0, share)) * (height - 4) - 2

  const runs: Array<{ start: number; end: number }> = []
  let runStart = -1
  for (let i = 0; i < n; i++) {
    const complete = members.every((m) => m.share[i] !== null)
    if (complete && runStart < 0) runStart = i
    if (runStart >= 0 && (!complete || i === n - 1)) {
      runs.push({ start: runStart, end: complete ? i : i - 1 })
      runStart = -1
    }
  }

  return (
    <div className="pr-charts">
      <div className="dim mono-sm">{t('poolRank.panel.pairTotal')}</div>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none" role="img" aria-label={t('poolRank.panel.pairTotal')}>
        {payload.pairTotal.map((v, i) => {
          if (v === null || !(maxTotal > 0)) return null
          const h = (v / maxTotal) * (height - 2)
          return <rect key={i} x={(x(i) - 3).toFixed(2)} y={(height - h).toFixed(2)} width="6" height={h.toFixed(2)} fill="var(--line)" />
        })}
      </svg>
      <div className="dim mono-sm">{t('poolRank.panel.shareStack')}</div>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none" role="img" aria-label={t('poolRank.panel.shareStack')}>
        {runs.flatMap(({ start, end }) => {
          const len = end - start + 1
          const cum = new Array(len).fill(0)
          return members.map((m, mi) => {
            const lower = [...cum]
            const upper = cum.map((c, k) => c + (m.share[start + k] ?? 0))
            for (let k = 0; k < len; k++) cum[k] = upper[k]
            const top = upper.map((s, k) => `${x(start + k).toFixed(2)},${y(s).toFixed(2)}`)
            const bottom = lower.map((s, k) => `${x(end - k).toFixed(2)},${y(s).toFixed(2)}`)
            const isFocus = m.identity === focusIdentity
            return (
              <polygon
                key={`${start}-${mi}`}
                points={[...top, ...bottom.reverse()].join(' ')}
                fill={CHART_COLORS[mi % CHART_COLORS.length]}
                fillOpacity={isFocus ? 0.55 : 0.3}
                stroke={CHART_COLORS[mi % CHART_COLORS.length]}
                strokeWidth={isFocus ? 1.5 : 0.75}
              />
            )
          })
        })}
      </svg>
      <div className="pr-legend dim mono-sm">
        {members.map((m, i) => (
          <span key={m.identity}>
            <span style={{ color: CHART_COLORS[i % CHART_COLORS.length] }}>■</span>{' '}
            {VENUE_LABEL[m.proto]}
            {m.feeBps !== null ? ` ${m.feeBps < 1 ? m.feeBps.toFixed(2) : m.feeBps}bp` : ''}
          </span>
        ))}
      </div>
    </div>
  )
}

/** The row-expansion panel: where did this pair's volume go? (PRD FR-UI-4) */
export function PairAttributionPanel({ identity, rows }: { identity: string; rows: PoolRankRow[] }) {
  const { t } = useTranslation()
  const query = useVolumePair(identity)
  const feeAprByPool = new Map(rows.map((r) => [r.address.toLowerCase(), r.netFeeApr]))
  const key = identity.toLowerCase()
  const body = (() => {
    if (query.isLoading || (!query.data && !query.isError)) return <div className="dim mono-sm">{t('poolRank.panel.loading')}</div>
    if (query.isError || !query.data) return <div className="amber mono-sm">{t('poolRank.panel.error')}</div>
    const data = query.data
    if (!data.ready) {
      return <div className="dim mono-sm">{data.reason === 'not_ready' ? t('poolRank.panel.notReady') : t('poolRank.panel.notGrouped')}</div>
    }
    const shareChange = (m: PairVolumeMember): string => {
      const len = m.share.length
      const now = m.share[len - 1]
      const before = m.share[Math.max(0, len - 7)]
      if (now === null || before === null) return '—'
      const pp = (now - before) * 100
      return `${pp >= 0 ? '+' : ''}${pp.toFixed(0)}pp`
    }
    const focusUsdCoverage = data.pools.find((m) => m.identity === key)?.usdCoverage ?? 1
    return (
      <>
        <div className={`mono-sm ${data.diagnosis.kind === 'migration' || data.diagnosis.kind === 'both_rising' ? 'green' : data.diagnosis.kind === 'retreat' ? 'amber' : 'dim'}`}>
          {t(`poolRank.diag.${data.diagnosis.kind}`)}
        </div>
        {data.diagnosis.kind === 'retreat' && data.tokenHeat && (
          <div className="dim mono-sm">
            {t('poolRank.diagTokenHeat', {
              sym0: data.symbol0,
              heat0: t(`poolRank.trendClass.${data.tokenHeat.token0}`),
              sym1: data.symbol1,
              heat1: t(`poolRank.trendClass.${data.tokenHeat.token1}`),
            })}
          </div>
        )}
        {data.diagnosis.caveats.includes('v2_not_monitored') && (
          <div className="amber mono-sm">{t('poolRank.caveat.v2')}</div>
        )}
        <PairCharts payload={data} focusIdentity={key} />
        {data.newcomer && (
          <div className="mono-sm cyan">
            🌱 {t('poolRank.panel.newcomer', { days: data.newcomer.ageDays, gain: data.newcomer.shareGainPpDay.toFixed(0) })}
          </div>
        )}
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('poolRank.panel.pool')}</th>
                <th className="num">{t('poolRank.panel.tvl')}</th>
                <th className="num">{t('poolRank.panel.shareChange')}</th>
                <th className="num hide-m">{t('poolRank.panel.feeApr')}</th>
                <th className="hide-m">{t('poolRank.panel.gauge')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.pools.map((m) => {
                const isFocus = m.identity === key
                const jumpable = m.identity.length === 42 && !isFocus
                const feeApr = feeAprByPool.get(m.identity)
                return (
                  <tr key={m.identity} className={isFocus ? 'pr-focus' : undefined}>
                    <td>
                      <span className="mono-sm">{isFocus ? '●' : '○'} {VENUE_LABEL[m.proto]}</span>
                      <span className="cell-sub mono-sm">
                        {m.feeBps !== null ? `${m.feeBps < 1 ? m.feeBps.toFixed(2) : m.feeBps}bp` : '—'}
                        {m.tickSpacing !== null ? ` · ts${m.tickSpacing}` : ''}
                        {m.isNewcomer ? ` · 🌱 ${t('poolRank.trendClass.new_hot')}` : ''}
                      </span>
                    </td>
                    <td className="num mono-sm">{m.tvlUsd !== null ? `$${fmtCompact(m.tvlUsd)}` : '—'}</td>
                    <td className="num mono-sm">{shareChange(m)}</td>
                    <td className="num mono-sm hide-m">{feeApr !== undefined ? pct(feeApr) : '—'}</td>
                    <td className="hide-m">{m.gaugeAlive ? <span className="green mono-sm">{t('poolRank.panel.gaugeAlive')}</span> : <span className="dim mono-sm">—</span>}</td>
                    <td className="num">
                      {jumpable && (
                        <button className="pr-rec" onClick={() => queuePoolJump(m.identity)} title={t('poolRank.openTip')}>
                          {t('poolRank.panel.open')} ↗
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {data.events.map((e) => (
          <div key={`${e.fromPool}-${e.toPool}`} className="dim mono-sm">
            🚚 {t('poolRank.migrationShort', {
              window: e.windowDays,
              fromPct: pct(e.fromShareStart),
              toPct: pct(e.fromShareEnd),
              magnitude: fmtUsd(e.magnitudeUsd),
            })}
            {e.nearEpochFlip ? ` · ${t('poolRank.epochNote')}` : ''}
          </div>
        ))}
        {focusUsdCoverage < 1 && (
          <div className="dim mono-sm">{t('poolRank.panel.coverage', { coverage: pct(focusUsdCoverage) })}</div>
        )}
      </>
    )
  })()
  return <div className="pr-panel">{body}</div>
}
