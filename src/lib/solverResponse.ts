export function parseSolverPriceImpactBps(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error('invalid solver priceImpactBps')
  }
  return value
}

/** Fee-free executable-probe baseline; null means no valid counterfactual probe. */
export function parseSolverMidAmountOut(value: unknown): bigint | null {
  if (value === null) return null
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new Error('invalid solver midAmountOut')
  }
  return BigInt(value)
}
