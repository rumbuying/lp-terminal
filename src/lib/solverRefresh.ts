export const SOLVER_QUOTE_REFRESH_MS = 15_000
export const SOLVER_AUTO_REFRESHES = 3

type SettledQuoteCounts = { dataUpdateCount: number; errorUpdateCount: number }

export class ManualRefreshGate {
  private readonly inFlight = new WeakMap<object, Promise<unknown>>()

  run<T>(query: object, refetch: () => Promise<T>): Promise<T> {
    const active = this.inFlight.get(query)
    if (active) return active as Promise<T>

    const guarded = refetch().finally(() => {
      if (this.inFlight.get(query) === guarded) this.inFlight.delete(query)
    })
    this.inFlight.set(query, guarded)
    return guarded
  }
}

export const solverQuoteAutoRefreshExhausted = (
  state: SettledQuoteCounts,
  manualRefreshes = 0,
): boolean =>
  state.dataUpdateCount + state.errorUpdateCount - manualRefreshes > SOLVER_AUTO_REFRESHES

export const solverQuoteCanAutoRefresh = (
  state: SettledQuoteCounts,
  manualRefreshes = 0,
): boolean => !solverQuoteAutoRefreshExhausted(state, manualRefreshes)

export const solverQuoteRefetchInterval = (
  state: SettledQuoteCounts,
  manualRefreshes = 0,
): number | false =>
  solverQuoteCanAutoRefresh(state, manualRefreshes) ? SOLVER_QUOTE_REFRESH_MS : false

export const quoteDataIsStale = (lastSuccessfulQuoteAt: number, now: number): boolean =>
  lastSuccessfulQuoteAt <= 0 || now - lastSuccessfulQuoteAt >= SOLVER_QUOTE_REFRESH_MS

export const solverQuoteNeedsManualRefresh = (
  autoRefreshExhausted: boolean,
  hasUsableQuote: boolean,
): boolean => autoRefreshExhausted && !hasUsableQuote

export const selectUsableQuoteData = <Solver, Direct>({
  solverData,
  directData,
  solverError,
  directError,
  solverDataUpdatedAt,
  directDataUpdatedAt,
  now,
}: {
  solverData: Solver | null | undefined
  directData: Direct | null | undefined
  solverError: boolean
  directError: boolean
  solverDataUpdatedAt: number
  directDataUpdatedAt: number
  now: number
}): { solver: Solver | null; direct: Direct | null; hasStaleData: boolean } => {
  const solverStale = solverData != null && quoteDataIsStale(solverDataUpdatedAt, now)
  const directStale = directData != null && quoteDataIsStale(directDataUpdatedAt, now)
  return {
    solver: solverError || solverStale ? null : (solverData ?? null),
    direct: directError || directStale ? null : (directData ?? null),
    hasStaleData: solverStale || directStale,
  }
}
