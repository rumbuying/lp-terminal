import type { RecommendationItem, RecommendationResponse } from '../../shared/recommendation/types'

export type RecommendationObservationReason =
  | 'low_confidence'
  | 'non_positive_net'
  | 'excessive_reopens'
  | 'insufficient_tick_history'
  | 'non_positive_risk_adjusted_net'
  | 'unanchored_quote_risk'
  | 'pool_below_lvr_floor'

export type RecommendationDisplayItem = {
  item: RecommendationItem
  status: 'recommended' | 'observed'
  observationReasons: RecommendationObservationReason[]
}

/**
 * Keep the strongest promoted recommendations first, then fill empty card
 * slots with clearly-labelled observations. The API's observed list contains
 * promoted pools too, so pool addresses are de-duplicated here.
 */
export function recommendationDisplayItems(
  data: Pick<RecommendationResponse, 'items' | 'observed'> | null,
  limit = 3,
): RecommendationDisplayItem[] {
  if (!data || limit <= 0) return []
  const out: RecommendationDisplayItem[] = []
  const used = new Set<string>()

  for (const item of data.items) {
    const pool = item.pool.toLowerCase()
    if (used.has(pool)) continue
    used.add(pool)
    out.push({ item, status: 'recommended', observationReasons: [] })
    if (out.length === limit) return out
  }

  for (const item of data.observed) {
    const pool = item.pool.toLowerCase()
    if (used.has(pool)) continue
    const observationReasons: RecommendationObservationReason[] = []
    if (item.confidence.level === 'low') observationReasons.push('low_confidence')
    if (item.projection24h.netUsd <= 0) observationReasons.push('non_positive_net')
    observationReasons.push(...item.gateReasons)
    used.add(pool)
    out.push({ item, status: 'observed', observationReasons })
    if (out.length === limit) break
  }

  return out
}
