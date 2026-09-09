import { useQuery } from '@tanstack/react-query'
import { CHAIN, ACTIVE_IS_BUILD } from '../config/chains'
import { indexerApiPath } from '../config/chains/routes'
import { ENV } from '../config/env'
import { FEATURES } from '../config/features'

/** Volume-trend classification served by the rank snapshot (PRD §5.1). */
export type TrendClass = 'rising' | 'new_hot' | 'stable' | 'fading' | 'collapsing' | 'unknown'

export type VolumeTrend = {
  class: TrendClass
  vsBaseline: number | null
  slope7dPct: number | null
  consecutiveRiseDays: number | null
  consecutiveFallDays: number | null
  /** new_hot only: days until the pool reaches the verified age */
  daysToVerified: number | null
  confidence: number
  /** 14 daily volumes, oldest→newest; null = missing day */
  dailyVol: (number | null)[]
  daysSampled: number
}

export type MigrationEvent = {
  type: 'migration'
  fromPool: string
  toPool: string
  pair: string
  venueFrom: string
  venueTo: string
  feeFromBps: number | null
  feeToBps: number | null
  fromShareStart: number
  fromShareEnd: number
  toShareStart: number
  toShareEnd: number
  windowDays: number
  magnitudeUsd: number
  nearEpochFlip: boolean
  detectedAt: number
}

export type PoolRankRow = {
  venue: 'up33-cl' | 'univ3'
  pool: string
  address: string
  feeBps: number
  tickSpacing: number | null
  tvlUsd: number
  volDayUsd: number
  feeApr: number
  netFeeApr: number
  sigmaDaily: number
  sigmaAnnual: number
  coverage: number
  stakedShare: number | null
  emitApr: number | null
  volumePersistence: number
  daysActive: number
  trend: VolumeTrend
}

/** Too young for the σ/coverage gates, real volume — trend badge only. */
export type EmergingRow = Pick<PoolRankRow, 'venue' | 'pool' | 'address' | 'feeBps' | 'tickSpacing' | 'tvlUsd' | 'volDayUsd' | 'trend'>

export type PoolRankApi = {
  enabled: boolean
  ready: boolean
  generatedAt: number | null
  ageSeconds: number | null
  nextRefreshSeconds: number | null
  rows: PoolRankRow[]
  emerging: EmergingRow[]
  dropped: { pool: string; reason: string }[]
  migrationEvents: MigrationEvent[]
  upPriceUsd: number | null
  windowDays: number
}

/**
 * The indexer's twice-daily pool ranking. A reference table, not a market
 * feed: the snapshot only moves when the indexer's cycle runs, so a long
 * staleTime is correct rather than lazy — refetching harder cannot make the
 * data fresher than its fixed cadence.
 */
export function usePoolRank() {
  const path = FEATURES.poolRank
    ? indexerApiPath('pool-rank', CHAIN.key, ENV.chainGateway, ACTIVE_IS_BUILD)
    : null
  return useQuery({
    queryKey: ['pool-rank', CHAIN.key],
    enabled: path !== null,
    retry: 2,
    staleTime: 10 * 60_000,
    refetchInterval: 30 * 60_000,
    queryFn: async (): Promise<PoolRankApi> => {
      const r = await fetch(path as string)
      if (!r.ok) throw new Error(`pool rank unavailable (${r.status})`)
      return (await r.json()) as PoolRankApi
    },
  })
}
