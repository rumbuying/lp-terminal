// Where each pool currently stands in the recommender's output, keyed for the
// POOL RANK table. Pure mapping so the rank tab never needs to understand
// RecommendationResponse internals: one entry per pool, recommended beating
// observed, the better net kept when a pool shows up in both modes.

import type { RecommendationItem, RecommendationMode, RecommendationResponse } from '../../shared/recommendation/types'

export type RecStatusEntry = {
  status: 'recommended' | 'observed'
  /** which return modes currently surface this pool */
  modes: RecommendationMode[]
  /** best projected 24h net across the modes that surface it */
  net24h: number
  rangePct: number
  gateReasons: RecommendationItem['gateReasons']
}

export type RecStatusResponses = {
  fees: RecommendationResponse | null
  rewards: RecommendationResponse | null
}

export function recStatusByPool(responses: RecStatusResponses): Map<string, RecStatusEntry> {
  const out = new Map<string, RecStatusEntry>()
  const put = (item: RecommendationItem, status: RecStatusEntry['status']) => {
    const keys = [...new Set([item.pool.toLowerCase(), ...(item.poolId ? [item.poolId.toLowerCase()] : [])])]
    const existing = out.get(keys[0])
    if (existing) {
      // a recommended card outranks a watchlist row; equal ranks keep the best net
      if (existing.status === 'recommended' && status === 'observed') return
      if (!existing.modes.includes(item.mode)) existing.modes.push(item.mode)
      if (status === 'recommended' && (existing.status === 'observed' || item.projection24h.netUsd > existing.net24h)) {
        existing.status = 'recommended'
        existing.net24h = item.projection24h.netUsd
        existing.rangePct = item.range.lowerPct
        existing.gateReasons = item.gateReasons
      }
      return
    }
    const entry: RecStatusEntry = {
      status,
      modes: [item.mode],
      net24h: item.projection24h.netUsd,
      rangePct: item.range.lowerPct,
      gateReasons: item.gateReasons,
    }
    for (const key of keys) out.set(key, entry)
  }
  for (const response of [responses.fees, responses.rewards]) {
    if (!response) continue
    for (const item of response.items) put(item, 'recommended')
    for (const item of response.observed) put(item, 'observed')
  }
  return out
}
