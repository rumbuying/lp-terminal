export type CapitalHarvestPlan = {
  triggered: boolean
  deploy0: bigint
  deploy1: bigint
  profit0: bigint
  profit1: bigint
  activeValueQuote: bigint
  capitalCapQuote: bigint
  excessValueQuote: bigint
  excessValueUsdg: bigint
}

/**
 * Peel a proportional slice from an already-balanced replacement portfolio.
 * Proportional scaling preserves the target CL token ratio without another
 * swap. Profit remains real wallet custody but is classified non-deployable.
 */
export function planCapitalHarvest(args: {
  amount0: bigint
  amount1: bigint
  activeValueQuote: bigint
  capitalCapQuote: bigint
  excessValueUsdg: bigint
  thresholdUsdg: bigint
}): CapitalHarvestPlan {
  const { amount0, amount1, activeValueQuote, capitalCapQuote, excessValueUsdg, thresholdUsdg } = args
  if ([amount0, amount1, activeValueQuote, capitalCapQuote, excessValueUsdg, thresholdUsdg].some((value) => value < 0n))
    throw new Error('E_CAPITAL_AMOUNT')
  const excessValueQuote = activeValueQuote > capitalCapQuote ? activeValueQuote - capitalCapQuote : 0n
  const triggered = activeValueQuote > 0n
    && capitalCapQuote > 0n
    && excessValueQuote > 0n
    && excessValueUsdg >= thresholdUsdg
  if (!triggered) {
    return { triggered: false, deploy0: amount0, deploy1: amount1, profit0: 0n, profit1: 0n, activeValueQuote, capitalCapQuote, excessValueQuote, excessValueUsdg }
  }
  const deploy0 = (amount0 * capitalCapQuote) / activeValueQuote
  const deploy1 = (amount1 * capitalCapQuote) / activeValueQuote
  // An in-range CL mint needs both legs. Dust rounding must postpone a harvest
  // instead of turning a healthy position into a zero-liquidity recovery.
  if (deploy0 === 0n || deploy1 === 0n) {
    return { triggered: false, deploy0: amount0, deploy1: amount1, profit0: 0n, profit1: 0n, activeValueQuote, capitalCapQuote, excessValueQuote, excessValueUsdg }
  }
  return {
    triggered: true,
    deploy0,
    deploy1,
    profit0: amount0 - deploy0,
    profit1: amount1 - deploy1,
    activeValueQuote,
    capitalCapQuote,
    excessValueQuote,
    excessValueUsdg,
  }
}
