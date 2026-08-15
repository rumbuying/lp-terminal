import type { Address } from 'viem'
import type { StrategyConfig, StrategyRange } from './types'

const trimNumber = (value: number) => Number.isInteger(value) ? String(value) : String(value).replace(/0+$/, '').replace(/\.$/, '')

export function strategyRangeName(range: StrategyRange): string {
  if (range.mode === 'fixed_ticks') return `ticks ${range.tickLower ?? '?'}…${range.tickUpper ?? '?'}`
  const lower = trimNumber(range.lowerPct)
  const upper = trimNumber(range.upperPct)
  return range.mode === 'symmetric' && range.lowerPct === range.upperPct ? `±${lower}%` : `−${lower}%/+${upper}%`
}

export function strategyProtocolName(protocol: StrategyConfig['protocol']): string {
  return protocol === 'univ3' ? 'UNIV3' : 'UP33'
}

const shortAddress = (address: Address) => `${address.slice(0, 6)}…${address.slice(-4)}`

/** Stable across rebalances: the current NFT id is shown separately in the UI. */
export function strategyName(
  config: Pick<StrategyConfig, 'protocol' | 'quoteToken' | 'riskToken' | 'range'>,
  symbolOf: (address: Address) => string | undefined,
): string {
  const quote = symbolOf(config.quoteToken)?.trim() || shortAddress(config.quoteToken)
  const risk = symbolOf(config.riskToken)?.trim() || shortAddress(config.riskToken)
  return `${quote}/${risk} · ${strategyProtocolName(config.protocol)} · ${strategyRangeName(config.range)}`
}
