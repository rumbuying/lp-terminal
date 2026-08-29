export type DailyReturnInput = {
  pnlRaw: string | null
  openingAssetsRaw: string | null
  openingAssetsStable: number | null
}

export type DailyCycleInput = {
  completedAt: number | null
  grossFeesQuoteRaw: string
  incomeTaxQuoteRaw: string
}

export function dailyCycleTotals(cycles: DailyCycleInput[], dayOf: (timestamp: number) => number, day: number) {
  let grossFees = 0n
  let incomeTax = 0n
  for (const cycle of cycles) {
    if (cycle.completedAt === null || dayOf(cycle.completedAt) !== day) continue
    grossFees += BigInt(cycle.grossFeesQuoteRaw)
    incomeTax += BigInt(cycle.incomeTaxQuoteRaw)
  }
  return { grossFeesRaw: grossFees.toString(), incomeTaxRaw: incomeTax.toString() }
}

/** Value-weighted portfolio return using each strategy's own accounting unit. */
export function weightedDailyReturnPct(rows: DailyReturnInput[]): number | null {
  let weightedReturn = 0
  let totalOpeningAssets = 0
  for (const row of rows) {
    if (row.pnlRaw === null || row.openingAssetsRaw === null || row.openingAssetsStable === null) continue
    const openingRaw = Number(row.openingAssetsRaw)
    if (!Number.isFinite(openingRaw) || openingRaw <= 0 || !Number.isFinite(row.openingAssetsStable) || row.openingAssetsStable <= 0) continue
    const returnRatio = Number(row.pnlRaw) / openingRaw
    if (!Number.isFinite(returnRatio)) continue
    weightedReturn += returnRatio * row.openingAssetsStable
    totalOpeningAssets += row.openingAssetsStable
  }
  return totalOpeningAssets > 0 ? weightedReturn / totalOpeningAssets * 100 : null
}
