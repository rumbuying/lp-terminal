import type { Address } from 'viem'
import { ADDR, requireGov } from '../src/config/addresses'
import { quoteWithNativeFallback, type KyberRoute } from './kyber'

/** Quote only the canonical UP reward into WETH, with a native UP33 CL fallback. */
export async function quoteRewardToWeth(amountIn: bigint): Promise<KyberRoute> {
  if (amountIn <= 0n) throw new Error('E_REWARD_AMOUNT')
  try {
    return await quoteWithNativeFallback(requireGov().UP, ADDR.WNATIVE, amountIn)
  } catch {
    throw new Error('E_REWARD_ROUTE')
  }
}

export type RewardSettlementQuote = {
  weth: KyberRoute
  quote?: KyberRoute
  wethAmountOut: bigint
  amountOut: bigint
}

/** Quote the fixed UP -> WETH reward exit and, when needed, WETH -> strategy quote. */
export async function quoteRewardToQuote(amountIn: bigint, quoteToken: Address): Promise<RewardSettlementQuote> {
  const weth = await quoteRewardToWeth(amountIn)
  const wethAmountOut = BigInt(weth.routeSummary.amountOut)
  if (quoteToken.toLowerCase() === ADDR.WNATIVE.toLowerCase())
    return { weth, wethAmountOut, amountOut: wethAmountOut }
  const quote = await quoteWithNativeFallback(ADDR.WNATIVE, quoteToken, wethAmountOut)
  return { weth, quote, wethAmountOut, amountOut: BigInt(quote.routeSummary.amountOut) }
}
