const TICK_LOG = Math.log(1.0001)

/** Absolute quote-price displacement between two ticks, rounded up in bps. */
export function tickDistanceBps(a: number, b: number): number {
  const distance = Math.abs(a - b)
  if (!Number.isFinite(distance)) return Number.POSITIVE_INFINITY
  return Math.ceil(Math.expm1(distance * TICK_LOG) * 10_000)
}

export type MarketQuality = {
  healthy: boolean
  reason?: 'market_volatility' | 'spot_twap_deviation'
  volatilityBps: number
  spotTwapDeviationBps: number
}

export function evaluateMarketQuality(args: {
  spotTick: number
  averageTick: number
  minTick: number
  maxTick: number
  maxVolatilityBps?: number
  maxSpotTwapDeviationBps?: number
}): MarketQuality {
  const volatilityBps = tickDistanceBps(args.minTick, args.maxTick)
  const spotTwapDeviationBps = tickDistanceBps(args.spotTick, args.averageTick)
  if (args.maxVolatilityBps !== undefined && volatilityBps > args.maxVolatilityBps)
    return { healthy: false, reason: 'market_volatility', volatilityBps, spotTwapDeviationBps }
  if (args.maxSpotTwapDeviationBps !== undefined && spotTwapDeviationBps > args.maxSpotTwapDeviationBps)
    return { healthy: false, reason: 'spot_twap_deviation', volatilityBps, spotTwapDeviationBps }
  return { healthy: true, volatilityBps, spotTwapDeviationBps }
}

/** Whether the current eligible trigger is the configured Nth burst trigger. */
export function shouldStartBurstWait(recentCompleted: number, triggerCount: number): boolean {
  return Number.isInteger(recentCompleted) && Number.isInteger(triggerCount)
    && recentCompleted >= 0 && triggerCount >= 2 && recentCompleted >= triggerCount - 1
}
