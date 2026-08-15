import type { Address } from 'viem'
import { ADDR } from '../src/config/addresses'
import type { KyberRouteSummary } from './kyber'
import type { SwapIntent } from './rebalance'

export const FEE_TAX_THRESHOLD_USDG = 1_000_000n
export const FEE_TAX_BPS = 1_000n
/** Bump when the deterministic income-tax funding policy changes. */
export const FEE_TAX_SELECTION_VERSION = 2

type QuoteFn = (tokenIn: Address, tokenOut: Address, amountIn: bigint) => Promise<{ amountOut: bigint; routeSummary: KyberRouteSummary }>

export type FeeTaxPlan = {
  applied: boolean
  /** Combined LP-fee and staking-reward value at the executable USDG quote. */
  totalIncomeUsdg: bigint
  /** Backward-compatible alias retained in durable job contexts and API results. */
  totalFeeUsdg: bigint
  tax0: bigint
  tax1: bigint
  rewardTax: bigint
  fee0AfterTax: bigint
  fee1AfterTax: bigint
  rewardAfterTax: bigint
  retainedUsdg: bigint
  swaps: SwapIntent[]
}

const low = (value: string) => value.toLowerCase()

/**
 * Tax actual strategy income: net LP fees plus the final quote token received
 * from settling a claimed UP reward through WETH. Income worth exactly 1 USDG is not taxed; once the
 * combined executable value is greater than 1 USDG, 10% is withheld. The
 * largest income leg funds the tax so dust legs cannot create extra swaps.
 */
export async function planFeeTax(args: {
  token0: Address
  token1: Address
  fee0: bigint
  fee1: bigint
  rewardToken?: Address
  rewardAmount?: bigint
  quote: QuoteFn
}): Promise<FeeTaxPlan> {
  const rewardToken = args.rewardToken ?? ADDR.WETH
  const rewardAmount = args.rewardAmount ?? 0n
  if (args.fee0 < 0n || args.fee1 < 0n || rewardAmount < 0n) throw new Error('E_FEE_TAX_AMOUNT')
  const valueInUsdg = async (token: Address, amount: bigint) => {
    if (amount === 0n) return 0n
    if (low(token) === low(ADDR.USDG)) return amount
    return (await args.quote(token, ADDR.USDG, amount)).amountOut
  }
  const [value0, value1, rewardValue] = await Promise.all([
    valueInUsdg(args.token0, args.fee0),
    valueInUsdg(args.token1, args.fee1),
    valueInUsdg(rewardToken, rewardAmount),
  ])
  const totalIncomeUsdg = value0 + value1 + rewardValue
  if (totalIncomeUsdg <= FEE_TAX_THRESHOLD_USDG) {
    return { applied: false, totalIncomeUsdg, totalFeeUsdg: totalIncomeUsdg, tax0: 0n, tax1: 0n, rewardTax: 0n, fee0AfterTax: args.fee0, fee1AfterTax: args.fee1, rewardAfterTax: rewardAmount, retainedUsdg: 0n, swaps: [] }
  }

  const targetUsdg = (totalIncomeUsdg * FEE_TAX_BPS) / 10_000n
  const sources = [
    { kind: 'fee0' as const, token: args.token0, amount: args.fee0, value: value0 },
    { kind: 'fee1' as const, token: args.token1, amount: args.fee1, value: value1 },
    { kind: 'reward' as const, token: rewardToken, amount: rewardAmount, value: rewardValue },
  ]
  // Prefer already-stable income, then canonical WETH income, when that leg
  // alone can fund the tax. Meme-token -> USDG aggregator routes are often
  // multi-hop and can quote successfully but fail execution because a
  // fee-on-transfer/intermediate pool returns less than the opaque route's
  // internal minimum. Funding the same exact tax from USDG/WETH avoids making
  // an otherwise healthy LP recenter depend on that fragile dust route.
  // Falling back to the largest leg remains deterministic and is always able
  // to fund a 10% tax across at most three income legs.
  const largest = sources.reduce((best, item) => item.value > best.value ? item : best)
  const sufficient = sources.filter((item) => item.value >= targetUsdg && item.amount > 0n)
  const preferred = (token: Address) => sufficient
    .filter((item) => low(item.token) === low(token))
    .reduce<(typeof sources)[number] | undefined>((best, item) => !best || item.value > best.value ? item : best, undefined)
  const source = preferred(ADDR.USDG) ?? preferred(ADDR.WETH) ?? largest
  const sourceValue = source.value
  const sourceAmount = source.amount
  if (sourceValue <= 0n || sourceAmount <= 0n || targetUsdg <= 0n) throw new Error('E_FEE_TAX_AMOUNT')
  const sourceToken = source.token
  const rawTax = low(sourceToken) === low(ADDR.USDG)
    ? targetUsdg
    : (sourceAmount * targetUsdg + sourceValue - 1n) / sourceValue
  const tax0 = source.kind === 'fee0' ? rawTax : 0n
  const tax1 = source.kind === 'fee1' ? rawTax : 0n
  const rewardTax = source.kind === 'reward' ? rawTax : 0n
  let retainedUsdg = 0n
  const swaps: SwapIntent[] = []
  for (const [token, amount] of [[args.token0, tax0], [args.token1, tax1], [rewardToken, rewardTax]] as const) {
    if (amount === 0n) continue
    if (low(token) === low(ADDR.USDG)) {
      retainedUsdg += amount
      continue
    }
    const quoted = await args.quote(token, ADDR.USDG, amount)
    swaps.push({
      purpose: 'fee_tax',
      tokenIn: token,
      tokenOut: ADDR.USDG,
      amountIn: amount,
      quotedOut: quoted.amountOut,
      routeSummary: quoted.routeSummary,
      principalIn: 0n,
      feeIn: amount,
    })
  }
  return {
    applied: true,
    totalIncomeUsdg,
    totalFeeUsdg: totalIncomeUsdg,
    tax0,
    tax1,
    rewardTax,
    fee0AfterTax: args.fee0 - tax0,
    fee1AfterTax: args.fee1 - tax1,
    rewardAfterTax: rewardAmount - rewardTax,
    retainedUsdg,
    swaps,
  }
}
