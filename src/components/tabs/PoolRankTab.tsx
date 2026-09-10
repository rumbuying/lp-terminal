import { Fragment, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fmtCompact, fmtUsd } from '../../lib/format'
import { trendSortWeight } from '../../lib/trendBadge'
import { usePoolRank, type EmergingRow, type MigrationEvent, type PoolRankRow, type TrendClass } from '../../hooks/usePoolRank'
import { useRecStatusByPool, type RecStatusData } from '../../hooks/useRecStatusByPool'
import type { RecStatusEntry } from '../../lib/recStatus'
import { queueRecFocus } from '../../lib/recFocus'
import { queuePoolJump } from '../../lib/poolJump'
import { Btn } from '../ui'
import { PairAttributionPanel, TrendBadge, VolumeSparkline } from './PairAttributionPanel'

const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`
const venueLabel = (venue: PoolRankRow['venue']): string => (venue === 'up33-cl' ? 'UP33 CL' : 'Uni v3')

type SortKey = 'coverage' | 'trend' | 'feeApr' | 'tvl' | 'volDay' | 'sigma' | 'emitApr' | 'fee'

/** ascending comparators; the header toggle applies the direction */
const COMPARATORS: Record<SortKey, (a: PoolRankRow, b: PoolRankRow) => number> = {
  coverage: (a, b) => a.coverage - b.coverage,
  trend: (a, b) =>
    trendSortWeight[a.trend.class] - trendSortWeight[b.trend.class]
    || (a.trend.vsBaseline ?? 0) - (b.trend.vsBaseline ?? 0)
    || a.coverage - b.coverage,
  feeApr: (a, b) => a.netFeeApr - b.netFeeApr,
  tvl: (a, b) => a.tvlUsd - b.tvlUsd,
  volDay: (a, b) => a.volDayUsd - b.volDayUsd,
  sigma: (a, b) => a.sigmaDaily - b.sigmaDaily,
  emitApr: (a, b) => (a.emitApr ?? -1) - (b.emitApr ?? -1),
  fee: (a, b) => a.feeBps - b.feeBps,
}

const TREND_FILTERS: readonly TrendClass[] = ['rising', 'new_hot', 'stable', 'fading', 'collapsing']

/** sortable header cell: click cycles desc → asc; the active column shows its direction */
function SortTh(props: {
  k: SortKey
  label: string
  tip?: string
  className?: string
  sort: { key: SortKey; dir: 'desc' | 'asc' }
  onSort: (k: SortKey) => void
}) {
  const active = props.sort.key === props.k
  return (
    <th
      className={props.className}
      title={props.tip}
      aria-sort={active ? (props.sort.dir === 'desc' ? 'descending' : 'ascending') : undefined}
    >
      <button className={`pr-sort ${active ? 'on' : ''}`} onClick={() => props.onSort(props.k)}>
        {props.label}
        {active ? <span aria-hidden="true">{props.sort.dir === 'desc' ? ' ▼' : ' ▲'}</span> : null}
      </button>
    </th>
  )
}

/** venue · tick spacing · fee — the identity line under the symbols on phones,
 * inline after them on wider screens. */
function VenueTag({ venue, tickSpacing, feeBps }: { venue: PoolRankRow['venue']; tickSpacing: number | null; feeBps: number }) {
  const ts = tickSpacing !== null ? ` ts${tickSpacing}` : ''
  return (
    <>
      <span className="dim mono-sm hide-m"> · {venueLabel(venue)}{ts}</span>
      <span className="cell-sub show-m">{venueLabel(venue)}{ts} · {feeBps < 1 ? feeBps.toFixed(2) : feeBps}bp</span>
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
      onClick={(e) => {
        // the row itself toggles the attribution panel — a badge click must
        // not also collapse it
        e.stopPropagation()
        queueRecFocus(props.address)
        props.onOpen()
      }}
      title={title}
    >
      {props.entry.status === 'recommended'
        ? t('poolRank.recBadge', { net: fmtUsd(props.entry.net24h) })
        : props.entry.gateReasons.length > 0 ? t('poolRank.recGated') : t('poolRank.recWatch')}
    </button>
  )
}

function MigrationBanner({ events, onTrack }: { events: MigrationEvent[]; onTrack: (identity: string) => void }) {
  const { t } = useTranslation()
  if (!events.length) return null
  return (
    <div className="pr-banner">
      {events.slice(0, 3).map((e) => (
        <div key={`${e.fromPool}-${e.toPool}`} className="pr-banner-row amber mono-sm">
          <span>
            🚚 {t('poolRank.migrationBanner', {
              pair: e.pair,
              window: e.windowDays,
              venueFrom: e.venueFrom === 'up33-cl' ? 'UP33 CL' : e.venueFrom === 'univ3' ? 'Uni v3' : 'Uni v4',
              feeFrom: e.feeFromBps !== null ? `${e.feeFromBps < 1 ? e.feeFromBps.toFixed(2) : e.feeFromBps}bp` : '—',
              venueTo: e.venueTo === 'up33-cl' ? 'UP33 CL' : e.venueTo === 'univ3' ? 'Uni v3' : 'Uni v4',
              feeTo: e.feeToBps !== null ? `${e.feeToBps < 1 ? e.feeToBps.toFixed(2) : e.feeToBps}bp` : '—',
              fromPct: pct(e.fromShareStart),
              toPct: pct(e.fromShareEnd),
              magnitude: fmtCompact(e.magnitudeUsd),
            })}
            {e.nearEpochFlip ? ` · ${t('poolRank.epochNote')}` : ''}
          </span>
          <button className="pr-rec" onClick={() => onTrack(e.fromPool)}>{t('poolRank.track')}</button>
        </div>
      ))}
      {events.length > 3 && <div className="dim mono-sm">{t('poolRank.moreEvents', { n: events.length - 3 })}</div>}
    </div>
  )
}

/** Young pools below the σ gate — trend badge only, never entry semantics. */
function EmergingRowItem({ row, onOpen }: { row: EmergingRow; onOpen: (address: string) => void }) {
  const { t } = useTranslation()
  return (
    <div className="pr-emerging-row mono-sm">
      <button className="pr-open" onClick={() => onOpen(row.address)} title={t('poolRank.openTip')}>
        <span>{row.pool}</span>
        <span className="pr-arrow" aria-hidden="true">↗</span>
      </button>
      <span className="dim">{row.venue === 'up33-cl' ? 'UP33 CL' : 'Uni v3'}{row.tickSpacing !== null ? ` ts${row.tickSpacing}` : ''}</span>
      <span className="dim">${fmtCompact(row.volDayUsd)}/d</span>
      <TrendBadge trend={row.trend} />
      <span className="cell-sub show-m dim">{t('poolRank.emergingNote')}</span>
    </div>
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
  const [sort, setSort] = useState<{ key: SortKey; dir: 'desc' | 'asc' }>({ key: 'coverage', dir: 'desc' })
  const [trendFilter, setTrendFilter] = useState<TrendClass[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }))

  const rows = useMemo(() => {
    let list = [...(data?.rows ?? [])]
    if (trendFilter.length) list = list.filter((r) => trendFilter.includes(r.trend.class))
    const cmp = COMPARATORS[sort.key]
    list.sort((a, b) => (sort.dir === 'desc' ? cmp(b, a) : cmp(a, b)))
    return list
  }, [data, sort, trendFilter])

  const colSpan = 8 + (hasEmissions ? 1 : 0) + (hasRec ? 1 : 0)
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
          <MigrationBanner events={data.migrationEvents} onTrack={(identity) => setExpanded(identity)} />

          <div className="pr-toolbar">
            <span className="dim mono-sm">{t('poolRank.trendFilter')}</span>
            {TREND_FILTERS.map((klass) => (
              <button
                key={klass}
                className={`pr-chip ${trendFilter.includes(klass) ? 'on' : ''}`}
                onClick={() => setTrendFilter((f) => (f.includes(klass) ? f.filter((x) => x !== klass) : [...f, klass]))}
              >
                {t(`poolRank.trendClass.${klass}`)}
              </button>
            ))}
            {trendFilter.length > 0 && (
              <button className="pr-chip" onClick={() => setTrendFilter([])}>{t('poolRank.trendFilterAll')}</button>
            )}
          </div>

          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="hide-m">#</th>
                  <th>{t('poolRank.pair')}</th>
                  <SortTh k="fee" label={t('poolRank.fee')} className="num hide-m" sort={sort} onSort={toggleSort} />
                  <SortTh k="tvl" label={t('poolRank.tvl')} className="num" sort={sort} onSort={toggleSort} />
                  <SortTh k="volDay" label={t('poolRank.volDay')} className="num hide-m" sort={sort} onSort={toggleSort} />
                  <SortTh k="feeApr" label={t('poolRank.feeApr')} tip={t('poolRank.feeAprTip')} className="num" sort={sort} onSort={toggleSort} />
                  <SortTh k="sigma" label={t('poolRank.sigma')} tip={t('poolRank.sigmaTip')} className="num hide-m" sort={sort} onSort={toggleSort} />
                  <SortTh k="coverage" label={t('poolRank.coverage')} tip={t('poolRank.coverageTip')} className="num" sort={sort} onSort={toggleSort} />
                  {hasEmissions && (
                    <SortTh k="emitApr" label={t('poolRank.emitApr')} tip={t('poolRank.emitAprTip')} className="num hide-t" sort={sort} onSort={toggleSort} />
                  )}
                  <SortTh k="trend" label={t('poolRank.trend')} tip={t('poolRank.trendTip')} sort={sort} onSort={toggleSort} />
                  {hasRec && <th className="hide-m" title={t('poolRank.recColTip')}>{t('poolRank.recCol')}</th>}
                  <th aria-label={t('poolRank.panel.pool')} />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const key = row.address.toLowerCase()
                  const isOpen = expanded === key
                  const toggle = () => setExpanded(isOpen ? null : key)
                  return (
                    <Fragment key={key}>
                      {/* the WHOLE row toggles the attribution panel (user ask:
                          the corner triangle was too small a target); the two
                          embedded controls stop propagation so they keep
                          their own destinations */}
                      <tr
                        className={`pr-row ${isOpen ? 'pr-open-row' : ''}`}
                        onClick={toggle}
                      >
                        <td className="dim mono-sm hide-m">{index + 1}</td>
                        <td>
                          <button
                            className="pr-open"
                            onClick={(e) => { e.stopPropagation(); openInPools(row.address) }}
                            title={t('poolRank.openTip')}
                          >
                            <span className="mono-sm">{row.pool}</span>
                            <span className="pr-arrow" aria-hidden="true">↗</span>
                          </button>
                          <VenueTag venue={row.venue} tickSpacing={row.tickSpacing} feeBps={row.feeBps} />
                        </td>
                        <td className="num mono-sm hide-m">{row.feeBps < 1 ? row.feeBps.toFixed(2) : row.feeBps}bp</td>
                        <td className="num mono-sm">
                          <span className="hide-m">{fmtUsd(row.tvlUsd)}</span>
                          <span className="show-m">${fmtCompact(row.tvlUsd)}</span>
                          {/* phones lose the VOL/DAY + trend columns — the badge rides here */}
                          <span className="cell-sub show-m">
                            ${fmtCompact(row.volDayUsd)} <TrendBadge trend={row.trend} />
                          </span>
                        </td>
                        <td className="num mono-sm hide-m">
                          <VolumeSparkline values={row.trend.dailyVol} />
                          <span className="cell-sub dim">${fmtCompact(row.volDayUsd)}</span>
                        </td>
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
                        <td><TrendBadge trend={row.trend} /></td>
                        {hasRec && (
                          <td className="hide-m">
                            {(() => {
                              const entry = recByPool?.get(key)
                              return entry
                                ? <RecBadge address={row.address} entry={entry} inputs={recStatus.data?.inputs} onOpen={props.onOpenRecommendations} />
                                : <span className="dim">—</span>
                            })()}
                          </td>
                        )}
                        <td className="num">
                          {/* visual affordance only — the click bubbles to the
                              row's toggle; kept focusable so Enter still works */}
                          <span
                            className="pr-expand-btn"
                            role="button"
                            aria-expanded={isOpen}
                            aria-label={t('poolRank.expandTip')}
                            title={t('poolRank.expandTip')}
                          >
                            {isOpen ? '▼' : '▶'}
                          </span>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="pr-expand">
                          <td colSpan={colSpan}>
                            <PairAttributionPanel identity={row.address} rows={data.rows} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>

          {data.emerging.length > 0 && (
            <div className="pr-emerging">
              <div className="dim mono-sm">{t('poolRank.emergingTitle')}</div>
              {data.emerging.map((row) => (
                <EmergingRowItem key={row.address} row={row} onOpen={openInPools} />
              ))}
            </div>
          )}

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
