import type { RecommendationItem } from '../../shared/recommendation/types'

export type RecommendationPrefill = {
  pool: string
  poolId?: string
  hooks?: string
  protocol: RecommendationItem['protocol']
  status: 'recommended' | 'observed'
  pct: number
  capitalUsd: number
  tickLower: number
  tickUpper: number
}

let pendingRecommendation: RecommendationPrefill | null = null

export function queueRecommendationPrefill(item: RecommendationItem, capitalUsd: number, status: RecommendationPrefill['status']): void {
  pendingRecommendation = {
    pool: item.pool.toLowerCase(),
    poolId: item.poolId?.toLowerCase(),
    hooks: item.hooks?.toLowerCase(),
    protocol: item.protocol,
    status,
    pct: item.range.lowerPct,
    capitalUsd,
    tickLower: item.range.tickLower,
    tickUpper: item.range.tickUpper,
  }
}

export function takeRecommendationPrefill(): RecommendationPrefill | null {
  const value = pendingRecommendation
  pendingRecommendation = null
  return value
}
