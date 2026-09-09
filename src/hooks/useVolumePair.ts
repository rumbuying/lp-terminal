import { useQuery } from '@tanstack/react-query'
import { CHAIN, ACTIVE_IS_BUILD } from '../config/chains'
import { indexerApiPath } from '../config/chains/routes'
import { ENV } from '../config/env'
import { FEATURES } from '../config/features'
import type { TrendClass, VolumeTrend } from './usePoolRank'

export type PairDiagnosisKind = 'migration' | 'retreat' | 'expansion_shift' | 'both_rising' | 'unknown'

export type PairVolumeMember = {
  identity: string
  proto: 'up33-cl' | 'univ3' | 'univ4'
  feeBps: number | null
  tickSpacing: number | null
  tvlUsd: number | null
  gaugeAlive: boolean
  dailyVol: (number | null)[]
  share: (number | null)[]
  trend: VolumeTrend
  ageDaysLowerBound: number
  isNewcomer: boolean
  usdCoverage: number
}

export type PairVolumeEvent = {
  fromPool: string
  toPool: string
  fromShareStart: number
  fromShareEnd: number
  toShareStart: number
  toShareEnd: number
  windowDays: number
  magnitudeUsd: number
  nearEpochFlip: boolean
}

export type PairVolumePayload = {
  pairKey: string
  token0: string
  token1: string
  symbol0: string
  symbol1: string
  days: number[]
  pairTotal: (number | null)[]
  pools: PairVolumeMember[]
  diagnosis: { kind: PairDiagnosisKind; caveats: string[] }
  /** L3 token heat classes (PRD FR-CALC-5) */
  tokenHeat: { token0: TrendClass; token1: TrendClass }
  events: PairVolumeEvent[]
  newcomer: { pool: string; shareGainPpDay: number; ageDays: number; volLastDayUsd: number } | null
}

export type PairVolumeApi =
  | ({ ready: true } & PairVolumePayload)
  | { ready: false; reason: 'pool_not_grouped' | 'not_ready' }

/**
 * The pair-attribution payload for one pool identity — served verbatim from
 * the indexer's kv snapshot (12h cadence, same as the rank), so the same
 * long staleTime logic as usePoolRank applies. Only mounted when a rank row
 * expands, and the react-query cache means re-expanding is free.
 */
export function useVolumePair(identity: string | null) {
  const base = FEATURES.poolRank
    ? indexerApiPath('volume/pair', CHAIN.key, ENV.chainGateway, ACTIVE_IS_BUILD)
    : null
  return useQuery({
    queryKey: ['volume-pair', CHAIN.key, identity?.toLowerCase()],
    enabled: base !== null && identity !== null,
    retry: 1,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<PairVolumeApi> => {
      const url = `${base}?pool=${encodeURIComponent(identity as string)}`
      const r = await fetch(url)
      if (!r.ok) throw new Error(`volume pair unavailable (${r.status})`)
      return (await r.json()) as PairVolumeApi
    },
  })
}
