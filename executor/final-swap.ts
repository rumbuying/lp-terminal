import { getAddress, zeroAddress, type Address } from 'viem'
import { NATIVE } from '../src/config/addresses'
import { applySlippage } from '../src/lib/clmath'
import type { StrategyConfig, StrategyPositionSnapshot } from '../shared/strategy/types'
import { readPoolState } from './chain'
import { gatedKyberTx, quoteKyber, type KyberRoute } from './kyber'
import { convertPoolAmount } from './risk'

const rawCurrency = (token: Address): Address => token.toLowerCase() === NATIVE.toLowerCase() ? zeroAddress : token
const routeCurrency = (token: Address): Address => token.toLowerCase() === zeroAddress ? NATIVE : token

/** Impact and slippage have separate limits. A recovery retry may widen its
 * quoted slippage only within the original combined execution-loss budget;
 * retries must not silently turn a 1% impact + 1% slippage policy into 11%. */
export function assertFinalSwapBounds(args: {
  amountOut: bigint
  minOut: bigint
  slippageBps: number
  baseSlippageBps: number
  maxImpactBps?: number
  referenceOut?: bigint
}) {
  if (!Number.isInteger(args.slippageBps) || args.slippageBps < 0 || args.slippageBps > 1000
    || !Number.isInteger(args.baseSlippageBps) || args.baseSlippageBps < 0 || args.baseSlippageBps > 1000)
    throw new Error('E_SWAP_SLIPPAGE')
  if (args.amountOut <= 0n || args.minOut <= 0n || args.minOut > args.amountOut
    || args.minOut < applySlippage(args.amountOut, args.slippageBps)) throw new Error('E_SWAP_MIN_OUT')
  if (args.maxImpactBps === undefined || args.referenceOut === undefined) return
  if (!(args.referenceOut > 0n) || !Number.isFinite(args.maxImpactBps) || args.maxImpactBps < 0 || args.maxImpactBps > 10_000)
    throw new Error('E_SWAP_IMPACT')
  const impact = BigInt(Math.floor(args.maxImpactBps))
  // Ceiling arithmetic: accepting a fractional raw-unit deficit would exceed
  // the configured limit, especially for small fee/recovery swaps.
  const quoteFloor = (args.referenceOut * (10_000n - impact) + 9_999n) / 10_000n
  const executionFloor = (args.referenceOut * (10_000n - impact) * BigInt(10_000 - args.baseSlippageBps) + 99_999_999n) / 100_000_000n
  if (args.amountOut < quoteFloor || args.minOut < executionFloor) throw new Error('E_SWAP_IMPACT')
}

/** Called after allowance transactions, using a new quote and fresh pool
 * state. It returns one quote/calldata pair for both execution and the journal.
 * A cross-token tax swap has no reference in this position's pool: do not
 * fabricate its impact from an unrelated pool or an aggregator's USD mark. */
export async function prepareFinalSwap(args: {
  config: StrategyConfig
  snapshot: StrategyPositionSnapshot
  tokenIn: Address
  tokenOut: Address
  amountIn: bigint
  slippageBps: number
  approvedTarget: Address
  fallback?: Parameters<typeof quoteKyber>[3]
  quoteFn?: (tokenIn: Address, tokenOut: Address, amountIn: bigint) => Promise<KyberRoute>
}) {
  const startedAt = Date.now()
  const tokenIn = routeCurrency(args.tokenIn), tokenOut = routeCurrency(args.tokenOut)
  const quote = await (args.quoteFn
    ? args.quoteFn(tokenIn, tokenOut, args.amountIn)
    : quoteKyber(tokenIn, tokenOut, args.amountIn, args.fallback))
  if (getAddress(quote.routeSummary.tokenIn) !== getAddress(tokenIn)
    || getAddress(quote.routeSummary.tokenOut) !== getAddress(tokenOut)
    || BigInt(quote.routeSummary.amountIn) !== args.amountIn) throw new Error('E_KYBER_IDENTITY')
  const tx = await gatedKyberTx({ routeSummary: quote.routeSummary, tokenIn, tokenOut,
    sender: args.config.owner, recipient: args.config.owner, amountIn: args.amountIn,
    slippageBps: args.slippageBps, nativeIn: tokenIn.toLowerCase() === NATIVE.toLowerCase() })
  if (getAddress(tx.approvalTarget) !== getAddress(args.approvedTarget)) throw new Error('E_SWAP_SPENDER_CHANGED')
  const input = rawCurrency(tokenIn), output = rawCurrency(tokenOut)
  let referenceOut: bigint | undefined
  if (args.config.safeguards.maxSwapImpactBps !== undefined) {
    const pair = new Set([args.snapshot.token0.toLowerCase(), args.snapshot.token1.toLowerCase()])
    if (pair.has(input.toLowerCase()) && pair.has(output.toLowerCase()) && input.toLowerCase() !== output.toLowerCase()) {
      const pool = await readPoolState(args.config)
      referenceOut = convertPoolAmount(args.amountIn, input, output, args.snapshot, pool.sqrtPriceX96)
    }
  }
  assertFinalSwapBounds({ amountOut: BigInt(quote.routeSummary.amountOut), minOut: tx.minOut,
    slippageBps: args.slippageBps, baseSlippageBps: args.config.safeguards.maxSlippageBps,
    maxImpactBps: args.config.safeguards.maxSwapImpactBps, referenceOut })
  if (Date.now() - startedAt > args.config.safeguards.maxPlanAgeSeconds * 1000) throw new Error('E_PLAN_STALE')
  return { quote, tx }
}
