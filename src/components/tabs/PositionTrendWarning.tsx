import { useTranslation } from 'react-i18next'
import { usePoolRank } from '../../hooks/usePoolRank'

/**
 * The holding-side volume warning (PRD FR-UI-6): when a position's pool shows
 * fading/cliffing volume or is the FROM side of a detected migration, say so
 * while it is happening — not weeks later in the P/L calendar. Read-only by
 * design; the links hand off to the rank tab's attribution panel and to the
 * strategy page. Served from the shared usePoolRank cache, so mounting this
 * on every position card costs no extra request.
 */
export function PositionTrendWarning({ identity }: { identity: string | null }) {
  const { t } = useTranslation()
  const query = usePoolRank()
  if (!identity) return null
  const id = identity.toLowerCase()
  const row = query.data?.rows.find((r) => r.address.toLowerCase() === id)
  const klass = row?.trend.class
  const event = query.data?.migrationEvents.find((e) => e.fromPool === id)
  if (!event && klass !== 'fading' && klass !== 'collapsing') return null
  return (
    <div className="pos-trend-warn amber mono-sm">
      {event
        ? t('pos.trendMigrated', {
            fromPct: Math.round(event.fromShareStart * 100),
            toPct: Math.round(event.fromShareEnd * 100),
          })
        : t('pos.trendFading', { klass: t(`poolRank.trendClass.${klass ?? 'unknown'}`) })}
      {' '}
      <a href="#pool-rank" className="dim">{t('pos.trendOpenRank')} ↗</a>
      {' · '}
      <a href="#strategy" className="dim">{t('pos.trendEvalStrategy')} ↗</a>
    </div>
  )
}
