import { ADDR } from '../config/addresses'
import { CHAIN } from '../config/chains'

export function strategyStableValue(quoteValue: number, quoteAddress: string, quoteUsd?: number): number | null {
  if (!Number.isFinite(quoteValue)) return null
  if (quoteAddress.toLowerCase() === ADDR.STABLE.toLowerCase()) return quoteValue
  return quoteUsd !== undefined && Number.isFinite(quoteUsd) && quoteUsd > 0 ? quoteValue * quoteUsd : null
}

/** A known quote amount must never render as empty merely because its USD mark is unavailable. */
export function strategyDisplayValue(quoteValue: number, quoteAddress: string, quoteUsd?: number) {
  const stable = strategyStableValue(quoteValue, quoteAddress, quoteUsd)
  return stable === null
    ? { value: quoteValue, unit: 'quote' as const }
    : { value: stable, unit: CHAIN.stable.symbol }
}
