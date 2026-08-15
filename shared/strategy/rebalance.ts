import type { Address } from 'viem'
import { getAmountsForLiquidity, getSqrtRatioAtTick } from '../../src/lib/clmath'
import { STRATEGY_ERROR, StrategyError } from './errors'

const UNIT_LIQUIDITY = 1n << 120n

export type TargetUnits = { amount0: bigint; amount1: bigint }

/** Raw token amounts required per arbitrary liquidity unit at the new range. */
export function targetUnits(sqrtPriceX96: bigint, tickLower: number, tickUpper: number): TargetUnits {
  const units = getAmountsForLiquidity(
    sqrtPriceX96,
    getSqrtRatioAtTick(tickLower),
    getSqrtRatioAtTick(tickUpper),
    UNIT_LIQUIDITY,
  )
  if (units.amount0 <= 0n || units.amount1 <= 0n)
    throw new StrategyError(STRATEGY_ERROR.CONFIG, 'recenter target must contain current price')
  return units
}

export type SwapDirection = 'token0_to_token1' | 'token1_to_token0'

/**
 * Solve the exact input against a quoted effective rate. All terms stay in raw
 * integer units; quoteIn/quoteOut may come from any tentative route size.
 */
export function solveSwapInput(args: {
  balance0: bigint
  balance1: bigint
  unit0: bigint
  unit1: bigint
  quoteIn: bigint
  quoteOut: bigint
  direction: SwapDirection
}): bigint {
  const { balance0: a0, balance1: a1, unit0: u0, unit1: u1, quoteIn: qi, quoteOut: qo } = args
  if ([a0, a1, u0, u1, qi, qo].some((x) => x < 0n) || u0 === 0n || u1 === 0n || qi === 0n || qo === 0n)
    throw new StrategyError(STRATEGY_ERROR.CONFIG, 'invalid rebalance solve input')
  if (args.direction === 'token0_to_token1') {
    const excess = a0 * u1 - a1 * u0
    if (excess <= 0n) return 0n
    const result = (excess * qi) / (u1 * qi + qo * u0)
    return result > a0 ? a0 : result
  }
  const excess = a1 * u0 - a0 * u1
  if (excess <= 0n) return 0n
  const result = (excess * qi) / (u0 * qi + qo * u1)
  return result > a1 ? a1 : result
}

export function chooseSwapDirection(balance0: bigint, balance1: bigint, units: TargetUnits): SwapDirection | null {
  const left = balance1 * units.amount0
  const right = balance0 * units.amount1
  if (left === right) return null
  return left < right ? 'token0_to_token1' : 'token1_to_token0'
}

export type RebalanceQuote = {
  tokenIn: Address
  tokenOut: Address
  amountIn: bigint
  amountOut: bigint
  route: unknown
}

/** Two quotes normally converge; a third is allowed when price impact is sharp. */
export async function planBalanceSwap(args: {
  token0: Address
  token1: Address
  balance0: bigint
  balance1: bigint
  units: TargetUnits
  quote: (tokenIn: Address, tokenOut: Address, amountIn: bigint) => Promise<{ amountOut: bigint; route: unknown }>
}): Promise<RebalanceQuote | null> {
  const direction = chooseSwapDirection(args.balance0, args.balance1, args.units)
  if (!direction) return null
  const tokenIn = direction === 'token0_to_token1' ? args.token0 : args.token1
  const tokenOut = direction === 'token0_to_token1' ? args.token1 : args.token0
  const available = direction === 'token0_to_token1' ? args.balance0 : args.balance1
  // Spot seed: target half-value approximation. The first real quote replaces it.
  let amountIn = available / 2n
  if (amountIn === 0n) return null
  let latest: { amountOut: bigint; route: unknown } | undefined
  for (let i = 0; i < 3; i++) {
    latest = await args.quote(tokenIn, tokenOut, amountIn)
    if (latest.amountOut <= 0n) throw new StrategyError(STRATEGY_ERROR.SLIPPAGE, 'zero swap quote')
    const solved = solveSwapInput({
      balance0: args.balance0,
      balance1: args.balance1,
      unit0: args.units.amount0,
      unit1: args.units.amount1,
      quoteIn: amountIn,
      quoteOut: latest.amountOut,
      direction,
    })
    if (solved === 0n) return null
    const drift = solved > amountIn ? solved - amountIn : amountIn - solved
    amountIn = solved
    if (drift * 500n <= available) break // <=0.2% of available
  }
  latest = await args.quote(tokenIn, tokenOut, amountIn)
  return { tokenIn, tokenOut, amountIn, amountOut: latest.amountOut, route: latest.route }
}
