import { zeroAddress, type Address } from 'viem'
import { erc20Abi } from '../src/abi'
import { sqrtPriceToPrice } from '../src/lib/clmath'
import { quoteFablesExit } from '../src/lib/fablesExitQuote'
import { quoteRangeToTicks } from '../shared/strategy/range'
import { targetUnits } from '../shared/strategy/rebalance'
import type { FablesStrategyConfig } from '../shared/strategy/types'
import { publicClient } from './chain'
import { fablesTargetValueBps } from './fablesCycle'

export const fablesTokenDecimals = (token: Address, blockNumber: bigint) => token.toLowerCase() === zeroAddress
  ? Promise.resolve(18)
  : publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'decimals', blockNumber }).then(Number)

export type FablesDryRunPlan = {
  strategyId: string
  observedBlock: string
  old: { poolId: string; hook: Address; rangeId: string; tickLower: number; tickUpper: number; shares: string }
  exit: {
    method: 'withdraw' | 'withdrawAndClaim'
    principal0: string; principal1: string
    amount0Min: string; amount1Min: string
    claimable0: string; claimable1: string
    claimFeeBps: number
  }
  indicativeRecenter: {
    currentTick: number; tickLower: number; tickUpper: number
    currency0: Address; currency1: Address
    unit0: string; unit1: string; targetValueBps0: number; targetValueBps1: number
  }
  constraints: {
    quoteToken: Address
    maxSlippageBps: number; maxSwapImpactBps: number; maxClaimFeeBps: number
    maxPlanAgeSeconds: number; minNativeGasReserveWei: string
    maxDailyTurnoverQuote?: string; maxGasPriceWei?: string
    allowLegacyUnboundedFeeExit: boolean
  }
  note: 'recalculate_after_exit_and_swap'
}

/** Read-only preview. The executor must reprice, requote and resize after receipts. */
export async function planFablesRebalance(config: FablesStrategyConfig): Promise<FablesDryRunPlan> {
  const quote = await quoteFablesExit(publicClient, {
    owner: config.owner, hook: config.positionRef.hook,
    rangeId: BigInt(config.positionRef.rangeId),
    slippageBps: config.safeguards.maxSlippageBps,
  })
  const position = quote.position
  if (position.pool.id.toLowerCase() !== config.positionRef.poolId.toLowerCase()
    || position.tickLower !== config.positionRef.tickLower
    || position.tickUpper !== config.positionRef.tickUpper)
    throw new Error('E_FABLES_POSITION_CHANGED')
  if (quote.maxFeeBpsToPass > config.safeguards.maxClaimFeeBps)
    throw new Error('E_FABLES_CLAIM_FEE_BOUND')
  if (quote.exitMethod === 'withdraw' && !config.safeguards.allowLegacyUnboundedFeeExit)
    throw new Error('E_FABLES_LEGACY_FEE_CONSENT')
  const key = position.pool.key
  const [dec0, dec1] = await Promise.all([
    fablesTokenDecimals(key.currency0, position.observedBlock), fablesTokenDecimals(key.currency1, position.observedBlock),
  ])
  const token0IsRisk = key.currency0.toLowerCase() === config.riskToken.toLowerCase()
  if (!(token0IsRisk || key.currency1.toLowerCase() === config.riskToken.toLowerCase()))
    throw new Error('E_FABLES_TOKENS')
  if ((token0IsRisk ? key.currency1 : key.currency0).toLowerCase() !== config.quoteToken.toLowerCase())
    throw new Error('E_FABLES_TOKENS')
  const token1PerToken0 = sqrtPriceToPrice(position.sqrtPriceX96, dec0, dec1)
  const quotePerRisk = token0IsRisk ? token1PerToken0 : 1 / token1PerToken0
  const range = quoteRangeToTicks({
    centerQuotePerRisk: quotePerRisk,
    lowerPct: config.range.lowerPct, upperPct: config.range.upperPct,
    currentTick: position.tick, tickSpacing: key.tickSpacing,
    token0IsRisk, token0Decimals: dec0, token1Decimals: dec1,
  })
  const units = targetUnits(position.sqrtPriceX96, range.tickLower, range.tickUpper)
  const split = fablesTargetValueBps(units, position.sqrtPriceX96)
  return {
    strategyId: config.id,
    observedBlock: position.observedBlock.toString(),
    old: {
      poolId: position.pool.id, hook: key.hooks, rangeId: position.rangeId.toString(),
      tickLower: position.tickLower, tickUpper: position.tickUpper, shares: position.shares.toString(),
    },
    exit: {
      method: quote.exitMethod,
      principal0: quote.principal0.toString(), principal1: quote.principal1.toString(),
      amount0Min: quote.amount0Min.toString(), amount1Min: quote.amount1Min.toString(),
      claimable0: quote.claimable0.toString(), claimable1: quote.claimable1.toString(),
      claimFeeBps: quote.maxFeeBpsToPass,
    },
    indicativeRecenter: {
      currentTick: position.tick, tickLower: range.tickLower, tickUpper: range.tickUpper,
      currency0: key.currency0, currency1: key.currency1,
      unit0: units.amount0.toString(), unit1: units.amount1.toString(),
      targetValueBps0: split.token0, targetValueBps1: split.token1,
    },
    constraints: {
      quoteToken: config.quoteToken,
      maxSlippageBps: config.safeguards.maxSlippageBps,
      maxSwapImpactBps: config.safeguards.maxSwapImpactBps,
      maxClaimFeeBps: config.safeguards.maxClaimFeeBps,
      maxPlanAgeSeconds: config.safeguards.maxPlanAgeSeconds,
      minNativeGasReserveWei: config.safeguards.minNativeGasReserveWei,
      maxDailyTurnoverQuote: config.execution.maxDailyTurnoverQuote,
      maxGasPriceWei: config.execution.maxGasPriceWei,
      allowLegacyUnboundedFeeExit: config.safeguards.allowLegacyUnboundedFeeExit,
    },
    note: 'recalculate_after_exit_and_swap',
  }
}
