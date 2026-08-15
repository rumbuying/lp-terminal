import type { Address } from 'viem'
import type { StrategyConfig, StrategyPositionSnapshot } from '../shared/strategy/types'
import { planBalanceSwap, targetUnits } from '../shared/strategy/rebalance'
import type { KyberRouteSummary } from './kyber'

export type CycleFunds = { principal0: bigint; principal1: bigint; fee0: bigint; fee1: bigint }
export type SwapIntent = {
  purpose: 'strategy' | 'fee_tax'
  tokenIn: Address
  tokenOut: Address
  amountIn: bigint
  quotedOut: bigint
  routeSummary: KyberRouteSummary
  principalIn: bigint
  feeIn: bigint
}

type QuoteFn = (tokenIn: Address, tokenOut: Address, amountIn: bigint) => Promise<{ amountOut: bigint; routeSummary: KyberRouteSummary }>

/** Plans principal balancing and fee conversion, merging equal directions. */
export async function planCycleSwaps(args: {
  config: StrategyConfig
  snapshot: StrategyPositionSnapshot
  sqrtPriceX96: bigint
  tickLower: number
  tickUpper: number
  funds: CycleFunds
  quote: QuoteFn
}): Promise<{ lp0: bigint; lp1: bigint; held0: bigint; held1: bigint; swaps: SwapIntent[] }> {
  const { config, snapshot, funds } = args
  const reinvest = config.fees.handling === 'reinvest'
  const lp0 = funds.principal0 + (reinvest ? funds.fee0 : 0n)
  const lp1 = funds.principal1 + (reinvest ? funds.fee1 : 0n)
  const held0 = reinvest ? 0n : funds.fee0
  const held1 = reinvest ? 0n : funds.fee1
  const units = targetUnits(args.sqrtPriceX96, args.tickLower, args.tickUpper)
  const principal = await planBalanceSwap({
    token0: snapshot.token0,
    token1: snapshot.token1,
    balance0: lp0,
    balance1: lp1,
    units,
    quote: async (tokenIn, tokenOut, amountIn) => {
      const q = await args.quote(tokenIn, tokenOut, amountIn)
      return { amountOut: q.amountOut, route: q.routeSummary }
    },
  })
  const intents: Omit<SwapIntent, 'quotedOut' | 'routeSummary'>[] = []
  if (principal) intents.push({ purpose: 'strategy', tokenIn: principal.tokenIn, tokenOut: principal.tokenOut, amountIn: principal.amountIn, principalIn: principal.amountIn, feeIn: 0n })

  if (config.fees.handling === 'convert_to_quote') {
    const riskIs0 = config.riskToken.toLowerCase() === snapshot.token0.toLowerCase()
    const feeRisk = riskIs0 ? funds.fee0 : funds.fee1
    if (feeRisk > 0n) {
      const same = intents.find((x) => x.tokenIn.toLowerCase() === config.riskToken.toLowerCase() && x.tokenOut.toLowerCase() === config.quoteToken.toLowerCase())
      if (same) {
        same.amountIn += feeRisk
        same.feeIn += feeRisk
      } else {
        intents.push({ purpose: 'strategy', tokenIn: config.riskToken, tokenOut: config.quoteToken, amountIn: feeRisk, principalIn: 0n, feeIn: feeRisk })
      }
    }
  }

  const swaps: SwapIntent[] = []
  for (const intent of intents) {
    const q = await args.quote(intent.tokenIn, intent.tokenOut, intent.amountIn)
    swaps.push({ ...intent, quotedOut: q.amountOut, routeSummary: q.routeSummary })
  }
  return { lp0, lp1, held0, held1, swaps }
}

export function allocateSwapOutput(intent: SwapIntent, actualOut: bigint): { principalOut: bigint; feeOut: bigint } {
  if (intent.amountIn <= 0n || actualOut < 0n) throw new Error('E_SWAP_ACCOUNTING')
  const principalOut = (actualOut * intent.principalIn) / intent.amountIn
  return { principalOut, feeOut: actualOut - principalOut }
}

export type SwapExecutionAllocation = {
  spent: bigint
  gained: bigint
  principalSpent: bigint
  feeSpent: bigint
  principalOut: bigint
  feeOut: bigint
  unspentPrincipal: bigint
  unspentFee: bigint
}

/**
 * Validate a successful exact-input route from observed wallet deltas.
 *
 * Aggregators may legitimately return part of the approved input while still
 * satisfying `minOut`. Treat that return as unspent strategy funds instead of
 * requiring the wallet delta to equal the requested input exactly.
 */
export function allocateSwapExecution(intent: SwapIntent, spent: bigint, gained: bigint, minOut: bigint): SwapExecutionAllocation {
  if (
    intent.amountIn <= 0n
    || intent.principalIn < 0n
    || intent.feeIn < 0n
    || intent.principalIn + intent.feeIn !== intent.amountIn
    || spent <= 0n
    || spent > intent.amountIn
    || gained < minOut
  ) throw new Error('E_UNSUPPORTED_TOKEN')

  const principalSpent = (spent * intent.principalIn) / intent.amountIn
  const feeSpent = spent - principalSpent
  const principalOut = (gained * principalSpent) / spent
  const feeOut = gained - principalOut
  return {
    spent,
    gained,
    principalSpent,
    feeSpent,
    principalOut,
    feeOut,
    unspentPrincipal: intent.principalIn - principalSpent,
    unspentFee: intent.feeIn - feeSpent,
  }
}
