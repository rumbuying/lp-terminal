export type DailyQuoteReturnRow = {
  pnlRaw: string | null
  openingAssetsRaw: string | null
  quoteAddress: string
}

export type DailyStableReturnRow = {
  pnlUsdgRaw: string | null
  /** Day-start assets recorded by the executor in USDG raw units (6 decimals). */
  openingAssetsUsdgRaw: string | null
}

export type DailyCycleInput = {
  completedAt: number | null
  grossFeesQuoteRaw: string
  incomeTaxQuoteRaw: string
}

export type ValuationAvailabilityRow = {
  performanceLoaded: boolean
  pnlRaw: string | null
}

/** Loaded-but-null is an unavailable valuation, not work still in flight. */
export function valuationAvailability(rows: ValuationAvailabilityRow[]) {
  let known = 0
  let pending = 0
  let unavailable = 0
  for (const row of rows) {
    if (!row.performanceLoaded) pending++
    else if (row.pnlRaw === null) unavailable++
    else known++
  }
  return { known, pending, unavailable }
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

/**
 * Daily portfolio return in the strategy quote unit: Σ day P/L / Σ opening
 * assets, both raw in the same quote token. Only meaningful when every
 * contributing strategy shares one quote token, so mixed-quote portfolios
 * return null (their quote-denominated P/L is likewise not displayed).
 * The result shares the sign of Σ pnlRaw — it cannot contradict the quote
 * "当日盈亏" total next to it.
 */
export function quoteDailyReturnPct(rows: DailyQuoteReturnRow[]): number | null {
  const contributing = rows.filter((row) => row.pnlRaw !== null && row.openingAssetsRaw !== null)
  if (contributing.length === 0) return null
  if (new Set(contributing.map((row) => row.quoteAddress.toLowerCase())).size !== 1) return null
  let pnl = 0n
  let opening = 0n
  for (const row of contributing) {
    const openingRaw = BigInt(row.openingAssetsRaw!)
    if (openingRaw <= 0n) continue
    pnl += BigInt(row.pnlRaw!)
    opening += openingRaw
  }
  if (opening === 0n) return null
  return Number((pnl * 1_000_000n) / opening) / 10_000
}

/**
 * Daily portfolio return in USDG: Σ day USDG P/L / Σ opening USDG assets.
 * Both terms are settlement-denominated, so the result shares the sign of the
 * USDG "当日盈亏" total — a positive USDG P/L can never show a negative rate.
 * Rows without an occurrence-time USDG P/L and day-open asset mark are skipped.
 * A current token price must never rewrite a historical daily denominator.
 */
export function stableDailyReturnPct(rows: DailyStableReturnRow[]): number | null {
  let pnlUsdg = 0n
  let openingUsdg = 0
  for (const row of rows) {
    if (row.pnlUsdgRaw === null) continue
    let opening: number | null = null
    if (row.openingAssetsUsdgRaw !== null) {
      const raw = Number(row.openingAssetsUsdgRaw)
      if (Number.isFinite(raw) && raw > 0) opening = raw / 1e6
    }
    if (opening === null) continue
    pnlUsdg += BigInt(row.pnlUsdgRaw)
    openingUsdg += opening
  }
  if (openingUsdg <= 0) return null
  return (Number(pnlUsdg) / 1e6 / openingUsdg) * 100
}
