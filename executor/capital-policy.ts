import { parseUnits, type Address } from 'viem'
import type { StrategyConfig, StrategyPositionSnapshot } from '../shared/strategy/types'
import { planCapitalHarvest, type CapitalHarvestPlan } from '../shared/strategy/capital'
import { ADDR } from '../src/config/addresses'
import { quoteKyber } from './kyber'
import { quoteTurnover } from './risk'
import { replaceStrategyBaselineQuote, setStrategyBaselineIfAbsent, strategyBaseline } from './store'
import { quoteValueInUsdg } from './stable-valuation'

const low = (value: string) => value.toLowerCase()

export async function strategyCapitalHarvest(args: {
  config: StrategyConfig
  snapshot: StrategyPositionSnapshot
  sqrtPriceX96: bigint
  amount0: bigint
  amount1: bigint
}): Promise<CapitalHarvestPlan> {
  const activeValueQuote = quoteTurnover(args.amount0, args.snapshot.token0, args.config, args.snapshot, args.sqrtPriceX96)
    + quoteTurnover(args.amount1, args.snapshot.token1, args.config, args.snapshot, args.sqrtPriceX96)
  const thresholdUsdg = parseUnits(args.config.capitalProtection.profitThresholdUsdg, 6)
  if (!args.config.capitalProtection.enabled) {
    return planCapitalHarvest({
      amount0: args.amount0, amount1: args.amount1, activeValueQuote,
      capitalCapQuote: activeValueQuote, excessValueUsdg: 0n, thresholdUsdg,
    })
  }
  let baseline = strategyBaseline(args.config.id)
  // Legacy strategies may predate immutable start marks. Establish a
  // fail-closed cap from the first balanced replacement preview; the first
  // upgraded cycle cannot be mistaken for profit, while every later cycle is
  // bounded by this durable value.
  if (!baseline) {
    const valueUsdgRaw = await quoteValueInUsdg(activeValueQuote, args.config.quoteToken).then(String).catch(() => undefined)
    setStrategyBaselineIfAbsent({
      strategyId: args.config.id,
      valueQuoteRaw: activeValueQuote.toString(),
      valueUsdgRaw,
      quoteToken: args.config.quoteToken,
      observedAt: args.snapshot.observedAt,
      blockNumber: args.snapshot.blockNumber,
      tokenId: args.snapshot.tokenId,
      tick: args.snapshot.tick,
      source: 'baseline_backfill',
    })
    baseline = strategyBaseline(args.config.id)
  }
  if (baseline && low(baseline.quoteToken) !== low(args.config.quoteToken)) {
    const valueUsdgRaw = await quoteValueInUsdg(activeValueQuote, args.config.quoteToken).then(String).catch(() => undefined)
    replaceStrategyBaselineQuote({
      strategyId: args.config.id,
      valueQuoteRaw: activeValueQuote.toString(),
      valueUsdgRaw,
      quoteToken: args.config.quoteToken,
      observedAt: args.snapshot.observedAt,
      blockNumber: args.snapshot.blockNumber,
      tokenId: args.snapshot.tokenId,
      tick: args.snapshot.tick,
      source: 'baseline_backfill',
    })
    baseline = strategyBaseline(args.config.id)
  }
  if (!baseline || low(baseline.quoteToken) !== low(args.config.quoteToken)) throw new Error('E_CAPITAL_BASELINE')
  const capitalCapQuote = BigInt(baseline.valueQuoteRaw)
  const excessValueQuote = activeValueQuote > capitalCapQuote ? activeValueQuote - capitalCapQuote : 0n
  let excessValueUsdg = 0n
  if (excessValueQuote > 0n) {
    excessValueUsdg = low(args.config.quoteToken) === low(ADDR.USDG)
      ? excessValueQuote
      : BigInt((await quoteKyber(args.config.quoteToken as Address, ADDR.USDG, excessValueQuote)).routeSummary.amountOut)
  }
  return planCapitalHarvest({
    amount0: args.amount0,
    amount1: args.amount1,
    activeValueQuote,
    capitalCapQuote,
    excessValueUsdg,
    thresholdUsdg,
  })
}
