/**
 * Executor-side sampling cadence for `strategy_pnl_snapshots`.
 *
 * Kept in a dependency-free module so the bucketing rules can be tested
 * without opening the executor database.
 */
export const PNL_SNAPSHOT_INTERVAL_SECONDS = 5 * 60

export type PnlCurveRow = {
  strategyId: string
  bucketAt: number
  observedAt: number
  quote: { address: string; symbol: string; decimals: number }
  pnlRaw: string | null
  pnlUsdgRaw: string | null
}

/**
 * Collapse a stored curve onto coarser buckets, keeping the last observation
 * inside each bucket.
 *
 * A month at the raw 5-minute cadence is thousands of points per strategy,
 * which a chart a few hundred pixels wide cannot show and a slow link pays for
 * in megabytes. Keeping the newest sample per bucket preserves the shape and
 * still ends the curve on the latest value.
 */
export function bucketPnlCurveRows(rows: PnlCurveRow[], bucketSeconds: number): PnlCurveRow[] {
  if (bucketSeconds <= PNL_SNAPSHOT_INTERVAL_SECONDS) return rows
  const bucketed = new Map<string, PnlCurveRow>()
  for (const row of rows) {
    const bucketAt = Math.floor(row.bucketAt / bucketSeconds) * bucketSeconds
    const key = `${row.strategyId}:${bucketAt}`
    const existing = bucketed.get(key)
    if (!existing || row.observedAt >= existing.observedAt) bucketed.set(key, { ...row, bucketAt })
  }
  return [...bucketed.values()].sort((a, b) => a.bucketAt - b.bucketAt || a.strategyId.localeCompare(b.strategyId))
}
