import { useTranslation } from 'react-i18next'
import { fmtCompact, fmtUsd } from '../../lib/format'
import { usePoolRank, type PoolRankRow } from '../../hooks/usePoolRank'
import { useRecStatusByPool, type RecStatusData } from '../../hooks/useRecStatusByPool'
import type { RecStatusEntry } from '../../lib/recStatus'
import { queueRecFocus } from '../../lib/recFocus'
import { queuePoolJump } from '../../lib/poolJump'
import { Btn } from '../ui'

const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`
const venueLabel = (venue: PoolRankRow['venue']): string => (venue === 'up33-cl' ? 'UP33 CL' : 'Uni v3')

function TrendMark({ value }: { value: number }) {
  if (value >= 1.5) return <span title={`×${value.toFixed(2)}`}>↗</span>
  if (value <= 0.5) return <span className="dim" title={`×${value.toFixed(2)}`}>↘</span>
  return <span className="dim" title={`×${value.toFixed(2)}`}>→</span>
}

/** venue · tick spacing · fee — the identity line under the symbols on phones,
 * inline after them on wider screens. */
function VenueTag({ row }: { row: PoolRankRow }) {
  const ts = row.tickSpacing !== null ? ` ts${row.tickSpacing}` : ''
  return (
    <>
      <span className="dim mono-sm hide-m"> · {venueLabel(row.venue)}{ts}</span>
      <span className="cell-sub show-m">{venueLabel(row.venue)}{ts} · {row.feeBps < 1 ? row.feeBps.toFixed(2) : row.feeBps}bp</span>
    </>
  )
}

/** Where this pool stands in the recommender's current output — the rank says
 * the pool pays its volatility, this says whether the model would fund it
 * today. Clicking hands off to the recommender page with the card focused. */
function RecBadge(props: { address: string; entry: RecStatusEntry; inputs: RecStatusData['inputs'] | undefined; onOpen: () => void }) {
  const { t } = useTranslation()
  const title = props.inputs
    ? t('poolRank.recBadgeTip', { capital: props.inputs.capitalUsd, risk: props.inputs.risk })
    : t('poolRank.recColTip')
  return (
    <button
      className={`pr-rec ${props.entry.status}`}
      onClick={() => { queueRecFocus(props.address); props.onOpen() }}
      title={title}
    >
      {props.entry.status === 'recommended'
        ? t('poolRank.recBadge', { net: fmtUsd(props.entry.net24h) })
        : props.entry.gateReasons.length > 0 ? t('poolRank.recGated') : t('poolRank.recWatch')}
    </button>
  )
}

export function PoolRankTab(props: { onOpenPool: () => void; onOpenRecommendations: () => void }) {
  const { t } = useTranslation()
  const query = usePoolRank()
  const data = query.data
  const recStatus = useRecStatusByPool()
  const recByPool = recStatus.data?.byPool
  const hasRec = (recByPool?.size ?? 0) > 0
  const generated = data?.generatedAt ? new Date(data.generatedAt * 1000) : null
  const hasEmissions = data?.rows.some((r) => r.emitApr !== null) ?? false
  const openInPools = (address: string) => {
    queuePoolJump(address)
    props.onOpenPool()
  }
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
                  <th className="hide-m">#</th>
                  <th>{t('poolRank.pair')}</th>
                  <th className="num hide-m">{t('poolRank.fee')}</th>
                  <th className="num">{t('poolRank.tvl')}</th>
                  <th className="num hide-m">{t('poolRank.volDay')}</th>
                  <th className="num" title={t('poolRank.feeAprTip')}>{t('poolRank.feeApr')}</th>
                  <th className="num hide-m" title={t('poolRank.sigmaTip')}>{t('poolRank.sigma')}</th>
                  <th className="num" title={t('poolRank.coverageTip')}>{t('poolRank.coverage')}</th>
                  {hasEmissions && (
                    <th className="num hide-t" title={t('poolRank.emitAprTip')}>{t('poolRank.emitApr')}</th>
                  )}
                  <th className="hide-m" title={t('poolRank.trendTip')}>{t('poolRank.trend')}</th>
                  {hasRec && <th className="hide-m" title={t('poolRank.recColTip')}>{t('poolRank.recCol')}</th>}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, index) => (
                  <tr key={`${row.venue}-${row.address}`}>
                    <td className="dim mono-sm hide-m">{index + 1}</td>
                    <td>
                      <button
                        className="pr-open"
                        onClick={() => openInPools(row.address)}
                        title={t('poolRank.openTip')}
                      >
                        <span className="mono-sm">{row.pool}</span>
                        <span className="pr-arrow" aria-hidden="true">↗</span>
                      </button>
                      <VenueTag row={row} />
                    </td>
                    <td className="num mono-sm hide-m">{row.feeBps < 1 ? row.feeBps.toFixed(2) : row.feeBps}bp</td>
                    <td className="num mono-sm">
                      <span className="hide-m">{fmtUsd(row.tvlUsd)}</span>
                      <span className="show-m">${fmtCompact(row.tvlUsd)}</span>
                      {/* phones lose the VOL/DAY + trend columns — they ride here */}
                      <span className="cell-sub show-m">
                        ${fmtCompact(row.volDayUsd)} <TrendMark value={row.volumePersistence} />
                      </span>
                    </td>
                    <td className="num mono-sm hide-m">{fmtUsd(row.volDayUsd)}</td>
                    <td className="num mono-sm" title={t('poolRank.feeAprValueTip', { gross: pct(row.feeApr) })}>
                      {pct(row.netFeeApr)}
                      {/* phones lose the STAKE APR column — the alternative yield rides here */}
                      {row.emitApr !== null && <span className="cell-sub show-m">{t('poolRank.stakeSub', { apr: pct(row.emitApr) })}</span>}
                    </td>
                    <td className="num mono-sm hide-m">{pct(row.sigmaDaily, 2)}</td>
                    <td className={`num mono-sm ${row.coverage >= 1 ? 'green' : 'red'}`} title={t('poolRank.coverageValueTip', { value: row.coverage.toFixed(1) })}>
                      {row.coverage >= 100 ? Math.round(row.coverage) : row.coverage.toFixed(1)}
                      {/* phones lose the σ/DAY column — the risk number rides here */}
                      <span className="cell-sub show-m">σ {pct(row.sigmaDaily, 2)}</span>
                    </td>
                    {hasEmissions && (
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
                    {hasRec && (
                      <td className="hide-m">
                        {(() => {
                          const entry = recByPool?.get(row.address.toLowerCase())
                          return entry
                            ? <RecBadge address={row.address} entry={entry} inputs={recStatus.data?.inputs} onOpen={props.onOpenRecommendations} />
                            : <span className="dim">—</span>
                        })()}
                      </td>
                    )}
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
