import { formatUnits, getAddress, type Address } from 'viem'
import { CHAINS } from '../config/chains'
import { chainExecutorPath } from '../config/chains/routes'
import type { StrategyLpProtocol } from '../config/networks'

export type PublicStrategyPerformance = {
  calculatedAt?: number
  quote?: { address: string; symbol: string; decimals: number }
  stable?: { address: string; symbol: string; decimals: number }
  summary?: {
    reopens: number
    currentValueQuoteRaw: string | null
    baselineValueQuoteRaw: string | null
    pnlQuoteRaw: string | null
    pnlPct: number | null
    currentValueStableRaw: string | null
    baselineValueStableRaw: string | null
    pnlStableRaw: string | null
    pnlStablePct: number | null
  }
  baselineAt?: number
  position?: { tokenId: string | null; tick: number | null; tickLower: number | null; tickUpper: number | null }
}

export type PublicStrategy = {
  id: string
  name: string
  protocol: StrategyLpProtocol
  state: string
  updatedAt: number
  pool: Address
  activeTokenId: string | null
  range: { mode: string; lowerPct: number; upperPct: number; tickLower?: number; tickUpper?: number }
  performance?: PublicStrategyPerformance
  error?: string
}

export type PublicStrategyCurvePoint = {
  strategyId: string
  bucketAt: number
  observedAt: number
  quote: { address: string; symbol: string; decimals: number }
  pnlQuoteRaw: string | null
  pnlStableRaw: string | null
}

export type PublicStrategyStatus = {
  chain: { id: 4663 | 56; key: string; name: string; stable: { address: Address; symbol: string; decimals: number } }
  address: Address
  generatedAt: number
  intervalSeconds: number
  strategies: PublicStrategy[]
  points: PublicStrategyCurvePoint[]
}

export type PublicStatusResult = {
  chainKey: string
  chainName: string
  data?: PublicStrategyStatus
  error?: string
}

export function statusAddressFromPath(pathname: string): Address | null {
  const match = /^\/status\/([^/]+)\/?$/.exec(pathname)
  if (!match) return null
  try { return getAddress(decodeURIComponent(match[1])) } catch { return null }
}

export function statusPath(address: string): string {
  return `/status/${getAddress(address.trim())}`
}

export async function fetchPublicStrategyStatus(chainKey: string, address: Address): Promise<PublicStrategyStatus> {
  const chain = CHAINS[chainKey]
  if (!chain) throw new Error(`unsupported chain ${chainKey}`)
  const endpoint = chainExecutorPath(chainKey, `/v1/public/status/${address}`)
  const response = await fetch(endpoint, { cache: 'no-store' })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  const servedChainId = Number(response.headers.get('x-lp-chain-id'))
  if (servedChainId !== chain.id)
    throw new Error(`strategy executor chain mismatch: expected ${chain.id}, received ${Number.isFinite(servedChainId) ? servedChainId : 'unknown'}`)
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `status request failed (${response.status})`)
  return body as PublicStrategyStatus
}

export async function fetchAllPublicStrategyStatuses(address: Address): Promise<PublicStatusResult[]> {
  return Promise.all(Object.values(CHAINS).map(async (chain) => {
    try {
      return { chainKey: chain.key, chainName: chain.name, data: await fetchPublicStrategyStatus(chain.key, address) }
    } catch (error) {
      return { chainKey: chain.key, chainName: chain.name, error: error instanceof Error ? error.message : 'status unavailable' }
    }
  }))
}

export function decimalValue(raw: string | null | undefined, decimals: number): number | null {
  if (raw == null) return null
  const value = Number(formatUnits(BigInt(raw), decimals))
  return Number.isFinite(value) ? value : null
}

export function publicStatusTotals(results: PublicStatusResult[]) {
  let strategies = 0
  let currentValue = 0
  let baselineValue = 0
  let pnl = 0
  let valuedStrategies = 0
  for (const result of results) {
    if (!result.data) continue
    const decimals = result.data.chain.stable.decimals
    for (const strategy of result.data.strategies) {
      strategies += 1
      const summary = strategy.performance?.summary
      const current = decimalValue(summary?.currentValueStableRaw, decimals)
      const baseline = decimalValue(summary?.baselineValueStableRaw, decimals)
      const strategyPnl = decimalValue(summary?.pnlStableRaw, decimals)
      if (current !== null) currentValue += current
      if (baseline !== null) baselineValue += baseline
      if (strategyPnl !== null) {
        pnl += strategyPnl
        valuedStrategies += 1
      }
    }
  }
  return {
    strategies,
    currentValue,
    pnl,
    pnlPct: baselineValue > 0 ? pnl / baselineValue * 100 : null,
    valuedStrategies,
  }
}

type CurveEvent = { at: number; key: string; value: number }

/** Merge sparse per-strategy snapshots without treating a missing bucket as zero. */
export function aggregatePublicPnlCurve(results: PublicStatusResult[]) {
  const events: CurveEvent[] = []
  for (const result of results) {
    if (!result.data) continue
    const decimals = result.data.chain.stable.decimals
    for (const strategy of result.data.strategies) {
      const key = `${result.data.chain.key}:${strategy.id}`
      const baselineAt = strategy.performance?.baselineAt
      if (baselineAt) events.push({ at: baselineAt, key, value: 0 })
      for (const point of result.data.points) {
        if (point.strategyId !== strategy.id) continue
        const value = decimalValue(point.pnlStableRaw, decimals)
        if (value !== null) events.push({ at: point.bucketAt, key, value })
      }
      const live = decimalValue(strategy.performance?.summary?.pnlStableRaw, decimals)
      if (live !== null) events.push({ at: strategy.performance?.calculatedAt ?? result.data.generatedAt, key, value: live })
    }
  }
  events.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key))
  const latest = new Map<string, number>()
  const points: { at: number; value: number }[] = []
  for (let index = 0; index < events.length;) {
    const at = events[index].at
    while (index < events.length && events[index].at === at) {
      latest.set(events[index].key, events[index].value)
      index += 1
    }
    points.push({ at, value: [...latest.values()].reduce((sum, value) => sum + value, 0) })
  }
  return points.filter((point, index) => index === points.length - 1 || point.at !== points[index + 1].at)
}

export function positionRangeState(position?: PublicStrategyPerformance['position']) {
  if (position?.tick == null || position.tickLower == null || position.tickUpper == null) return 'unknown' as const
  return position.tick >= position.tickLower && position.tick < position.tickUpper ? 'in' as const : 'out' as const
}
