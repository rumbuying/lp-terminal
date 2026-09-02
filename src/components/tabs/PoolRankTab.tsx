import { useTranslation } from 'react-i18next'
import { usePoolRank, type PoolRankRow } from '../../hooks/usePoolRank'
import { Btn } from '../ui'

const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`
const usd = (x: number) =>
  new Intl.NumberFormat(undefined, { notation: x >= 100_000 ? 'compact' : 'standard', maximumFractionDigits: x >= 100_000 ? 1 : 0 }).format(Math.round(x))
const venueLabel = (venue: PoolRankRow['venue']): string => (venue === 'up33-cl' ? 'UP33 CL' : 'Uni v3')

function TrendMark({ value }: { value: number }) {
  if (value >= 1.5) return <span title={`×${value.toFixed(2)}`}>↗</span>
  if (value <= 0.5) return <span className="dim" title={`×${value.toFixed(2)}`}>↘</span>
  return <span className="dim" title={`×${value.toFixed(2)}`}>→</span>
}

export function PoolRankTab() {
  const { t } = useTranslation()
  const query = usePoolRank()
  const data = query.data
  const generated = data?.generatedAt ? new Date(data.generatedAt * 1000) : null
  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <div className="section-title">{t('poolRank.title')}</div>
          <div className="dim mono-sm">
            {generated
              ? t('poolRank.updated', {
                  time: generated.toLocaleString(),
                  hours: Math.floor((data?.ageSeconds ?? 0) / 3600),
                  minutes: Math.floor(((data?.ageSeconds ?? 0) % 3600) / 60),
                })
              : t('poolRank.waiting')}
          </div>
        </div>
        <Btn onClick={() => void query.refetch()} busy={query.isFetching}>{t('poolRank.refresh')}</Btn>
      </div>

      {!data?.ready ? (
        <div className="dim">{t('poolRank.empty')}</div>
      ) : (
        <>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('poolRank.pair')}</th>
                  <th className="num">{t('poolRank.fee')}</th>
                  <th className="num">{t('poolRank.tvl')}</th>
                  <th className="num hide-t">{t('poolRank.volDay')}</th>
                  <th className="num" title={t('poolRank.feeAprTip')}>{t('poolRank.feeApr')}</th>
                  <th className="num hide-m" title={t('poolRank.sigmaTip')}>{t('poolRank.sigma')}</th>
                  <th className="num" title={t('poolRank.coverageTip')}>{t('poolRank.coverage')}</th>
                  {data.rows.some((r) => r.emitApr !== null) && (
                    <th className="num hide-t" title={t('poolRank.emitAprTip')}>{t('poolRank.emitApr')}</th>
                  )}
                  <th className="hide-m" title={t('poolRank.trendTip')}>{t('poolRank.trend')}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, index) => (
                  <tr key={`${row.venue}-${row.address}`}>
                    <td className="dim mono-sm">{index + 1}</td>
                    <td>
                      <span className="mono-sm">{row.pool}</span>
                      <span className="dim mono-sm"> · {venueLabel(row.venue)}{row.tickSpacing !== null ? ` ts${row.tickSpacing}` : ''}</span>
                    </td>
                    <td className="num mono-sm">{row.feeBps < 1 ? row.feeBps.toFixed(2) : row.feeBps}bp</td>
                    <td className="num mono-sm">${usd(row.tvlUsd)}</td>
                    <td className="num mono-sm hide-t">${usd(row.volDayUsd)}</td>
                    <td className="num mono-sm" title={t('poolRank.feeAprValueTip', { gross: pct(row.feeApr) })}>{pct(row.netFeeApr)}</td>
                    <td className="num mono-sm hide-m">{pct(row.sigmaDaily, 2)}</td>
                    <td className={`num mono-sm ${row.coverage >= 1 ? 'green' : 'red'}`} title={t('poolRank.coverageValueTip', { value: row.coverage.toFixed(1) })}>
                      {row.coverage >= 100 ? Math.round(row.coverage) : row.coverage.toFixed(1)}
                    </td>
                    {data.rows.some((r) => r.emitApr !== null) && (
                      <td className="num mono-sm hide-t">
                        {row.emitApr !== null ? (
                          <span title={row.stakedShare !== null ? t('poolRank.stakedShareTip', { share: pct(row.stakedShare) }) : undefined}>
                            {pct(row.emitApr)}
                          </span>
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </td>
                    )}
                    <td className="hide-m"><TrendMark value={row.volumePersistence} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="dim mono-sm" style={{ marginTop: 8 }}>
            {t('poolRank.legend')} {data.upPriceUsd !== null ? `· ${t('poolRank.upPrice', { price: data.upPriceUsd.toFixed(4) })}` : ''}
          </div>
          {data.dropped.length > 0 && (
            <div className="dim mono-sm">
              {t('poolRank.dropped')}{' '}
              {data.dropped.slice(0, 6).map((d) => `${d.pool} (${d.reason})`).join(' · ')}
              {data.dropped.length > 6 ? ` +${data.dropped.length - 6}` : ''}
            </div>
          )}
          <div className="amber mono-sm">{t('poolRank.disclaimer')}</div>
        </>
      )}
    </div>
  )
}
