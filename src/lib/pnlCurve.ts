import { formatUnits } from 'viem'
import type { ExecutorPerformance, ExecutorPnlCurvePoint } from './executorClient'

export type PnlCurveUnit = 'quote' | 'stable'
export type PnlCurvePoint = { at: number; value: number }

export function strategyPnlCurvePoints(
  strategyId: string,
  rows: ExecutorPnlCurvePoint[],
  performance: ExecutorPerformance,
  unit: PnlCurveUnit,
): PnlCurvePoint[] {
  if (!performance.quote) return []
  const quoteAddress = performance.quote.address.toLowerCase()
  const decimals = unit === 'stable' ? performance.stable?.decimals ?? 6 : performance.quote.decimals
  const points = rows
    .filter((row) => row.strategyId === strategyId && (unit === 'stable' || row.quote.address.toLowerCase() === quoteAddress))
    .flatMap((row) => {
      const raw = unit === 'stable' ? row.pnlUsdgRaw : row.pnlRaw
      if (raw == null) return []
      const value = Number(formatUnits(BigInt(raw), decimals))
      return Number.isFinite(value) ? [{ at: row.observedAt, value }] : []
    })

  const liveRaw = unit === 'stable' ? performance.summary?.pnlUsdgRaw : performance.summary?.pnlQuoteRaw
  if (liveRaw != null) {
    const value = Number(formatUnits(BigInt(liveRaw), decimals))
    if (Number.isFinite(value)) points.push({ at: performance.calculatedAt ?? Math.floor(Date.now() / 1000), value })
  }
  const windowStart = (performance.calculatedAt ?? Math.floor(Date.now() / 1000)) - 30 * 24 * 60 * 60
  if (performance.baseline?.at && performance.baseline.at >= windowStart && (!points.length || performance.baseline.at < points[0].at)) {
    points.push({ at: performance.baseline.at, value: 0 })
  }

  points.sort((a, b) => a.at - b.at)
  return points.filter((point, index) => index === points.length - 1 || point.at !== points[index + 1].at)
}

export function mergePnlCurveSnapshots(
  current: ExecutorPnlCurvePoint[],
  incoming: ExecutorPnlCurvePoint[],
  cutoff: number,
): ExecutorPnlCurvePoint[] {
  const merged = new Map<string, ExecutorPnlCurvePoint>()
  for (const point of [...current, ...incoming]) {
    if (point.bucketAt < cutoff) continue
    const key = `${point.strategyId}:${point.bucketAt}`
    const existing = merged.get(key)
    if (!existing || point.observedAt >= existing.observedAt) merged.set(key, point)
  }
  return [...merged.values()].sort((a, b) => a.bucketAt - b.bucketAt || a.strategyId.localeCompare(b.strategyId))
}
