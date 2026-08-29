import type { StrategyConfig } from '../shared/strategy/types'

const max = (a: bigint, b: bigint) => a > b ? a : b

/** Finite quick-strategy guard that gives narrower bands more recenter room. */
export function automaticDailyTurnoverLimit(config: StrategyConfig, positionValue: bigint, projectedTurnover: bigint): bigint {
  const narrowBandPct = Math.min(config.range.lowerPct, config.range.upperPct)
  const positionMultiples = BigInt(Math.max(20, Math.ceil(100 / Math.max(narrowBandPct, 0.1))))
  return max(max(positionValue * positionMultiples, projectedTurnover * 2n), 1n)
}
