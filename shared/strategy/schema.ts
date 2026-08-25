import { getAddress, isAddress, type Address } from 'viem'
import { STRATEGY_ERROR, StrategyError } from './errors'
import type { StrategyConfig, StrategyPreset } from './types'
import { ADDR, UNI } from '../../src/config/addresses'

const now = () => Math.floor(Date.now() / 1000)
const id = () => `strategy-${crypto.randomUUID()}`

const address = (v: unknown, name: string): Address => {
  if (typeof v !== 'string' || !isAddress(v)) throw new StrategyError(STRATEGY_ERROR.CONFIG, `${name} is not an address`)
  return getAddress(v)
}

const finite = (v: unknown, name: string, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
    throw new StrategyError(STRATEGY_ERROR.CONFIG, `${name} must be between ${min} and ${max}`)
  return v
}

const optionalFinite = (v: unknown, name: string, min: number, max: number): number | undefined =>
  v === undefined || v === null ? undefined : finite(v, name, min, max)

const optionalDecimal = (v: unknown, name: string, integerOnly = false): string | undefined => {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || !(integerOnly ? /^\d+$/ : /^\d+(?:\.\d+)?$/).test(v) || !/[1-9]/.test(v))
    throw new StrategyError(STRATEGY_ERROR.CONFIG, `${name} must be a positive decimal string`)
  return v
}

const presetValues: readonly StrategyPreset[] = ['original', 'fee_guarded', 'defensive', 'custom']

export function originalStrategyDraft(args: {
  owner: Address
  protocol: 'up33' | 'univ3'
  pool: Address
  positionManager: Address
  riskToken: Address
  quoteToken: Address
  activeTokenId?: string | null
  name?: string
  staking?: { enabled: boolean; gauge?: Address }
}): StrategyConfig {
  const ts = now()
  return {
    version: 1,
    id: id(),
    name: args.name ?? 'Original ±5%',
    preset: 'original',
    sourcePreset: 'original',
    enabled: false,
    chainId: 4663,
    owner: getAddress(args.owner),
    protocol: args.protocol,
    pool: getAddress(args.pool),
    positionManager: getAddress(args.positionManager),
    activeTokenId: args.activeTokenId ?? null,
    riskToken: getAddress(args.riskToken),
    quoteToken: getAddress(args.quoteToken),
    staking: args.staking?.enabled ? {
      enabled: true,
      gauge: args.staking.gauge ? getAddress(args.staking.gauge) : undefined,
      rewardToken: ADDR.UP,
      rewardQuoteToken: getAddress(args.quoteToken),
      rewardHandling: 'convert_to_quote_hold',
    } : { enabled: false },
    range: { mode: 'symmetric', lowerPct: 5, upperPct: 5 },
    trigger: { source: 'spot', pollSeconds: 4, confirmationSeconds: 0, cooldownMinutes: 0 },
    boundary: {
      lower: { condition: 'always', action: 'recenter' },
      upper: { condition: 'always', action: 'recenter' },
    },
    fees: { handling: 'convert_to_quote', timing: 'on_rebalance' },
    capitalProtection: { enabled: true, profitThresholdUsdg: '10' },
    adaptiveRange: { enabled: true, targetMinutes: 120, maxMultiplier: 4, recoveryDecay: 0.5, contractionReviewMinutes: 360, contractionStabilityMinutes: 120, contractionMaxVolatilityBps: 250, contractionFeeCoverage: 1.25 },
    safeguards: { enabled: false, maxSlippageBps: 100, maxPlanAgeSeconds: 30 },
    execution: { mode: 'notify_only', dryRun: false, gasReserveMultiplier: 1.5, lowTransactionMode: false },
    revision: 1,
    createdAt: ts,
    updatedAt: ts,
  }
}

/** Runtime validation for local storage and executor API payloads. */
export function parseStrategyConfig(v: unknown): StrategyConfig {
  if (!v || typeof v !== 'object') throw new StrategyError(STRATEGY_ERROR.CONFIG, 'strategy must be an object')
  const x = v as Record<string, any>
  if (x.version !== 1) throw new StrategyError(STRATEGY_ERROR.CONFIG, 'unsupported strategy version')
  if (typeof x.id !== 'string' || !x.id) throw new StrategyError(STRATEGY_ERROR.CONFIG, 'strategy id missing')
  if (typeof x.name !== 'string' || !x.name.trim()) throw new StrategyError(STRATEGY_ERROR.CONFIG, 'strategy name missing')
  if (!presetValues.includes(x.preset) || !presetValues.includes(x.sourcePreset))
    throw new StrategyError(STRATEGY_ERROR.CONFIG, 'invalid preset')
  if (x.chainId !== 4663) throw new StrategyError(STRATEGY_ERROR.CHAIN, 'strategy chain must be 4663')
  if (!['up33', 'univ3'].includes(x.protocol)) throw new StrategyError(STRATEGY_ERROR.CONFIG, 'invalid protocol')
  if (typeof x.enabled !== 'boolean') throw new StrategyError(STRATEGY_ERROR.CONFIG, 'enabled must be boolean')
  if (!x.range || !['symmetric', 'asymmetric', 'fixed_ticks'].includes(x.range.mode))
    throw new StrategyError(STRATEGY_ERROR.CONFIG, 'invalid range')
  const lowerPct = finite(x.range.lowerPct, 'lowerPct', 0.001, 99)
  const upperPct = finite(x.range.upperPct, 'upperPct', 0.001, 500)
  if (x.range.mode === 'fixed_ticks' && (!Number.isInteger(x.range.tickLower) || !Number.isInteger(x.range.tickUpper)))
    throw new StrategyError(STRATEGY_ERROR.CONFIG, 'fixed tick range requires ticks')
  if (x.range.tickLower !== undefined && x.range.tickUpper !== undefined && x.range.tickLower >= x.range.tickUpper)
    throw new StrategyError(STRATEGY_ERROR.CONFIG, 'tickLower must be below tickUpper')
  if (!x.trigger || !['spot', 'sampled_twap'].includes(x.trigger.source))
    throw new StrategyError(STRATEGY_ERROR.CONFIG, 'invalid trigger')
  if (!x.boundary || !x.boundary.lower || !x.boundary.upper) throw new StrategyError(STRATEGY_ERROR.CONFIG, 'boundary missing')
  const policy = (p: any, side: string) => {
    if (!['always', 'fee_break_even', 'manual_confirm'].includes(p.condition))
      throw new StrategyError(STRATEGY_ERROR.CONFIG, `invalid ${side} boundary condition`)
    if (!['recenter', 'skew_recenter', 'hold_quote', 'pause'].includes(p.action))
      throw new StrategyError(STRATEGY_ERROR.CONFIG, `invalid ${side} boundary action`)
    return { condition: p.condition, action: p.action }
  }
  if (!x.fees || !['convert_to_quote', 'reinvest', 'hold_tokens'].includes(x.fees.handling))
    throw new StrategyError(STRATEGY_ERROR.CONFIG, 'invalid fee handling')
  if (!['on_rebalance', 'threshold', 'interval'].includes(x.fees.timing))
    throw new StrategyError(STRATEGY_ERROR.CONFIG, 'invalid fee timing')
  if (!x.safeguards || typeof x.safeguards.enabled !== 'boolean')
    throw new StrategyError(STRATEGY_ERROR.CONFIG, 'invalid safeguards')
  if (!x.execution || !['notify_only', 'wallet_confirm', 'executor_auto'].includes(x.execution.mode))
    throw new StrategyError(STRATEGY_ERROR.CONFIG, 'invalid execution')

  const config: StrategyConfig = {
    version: 1,
    id: x.id,
    name: x.name.trim(),
    preset: x.preset,
    sourcePreset: x.sourcePreset,
    enabled: x.enabled,
    chainId: 4663,
    owner: address(x.owner, 'owner'),
    protocol: x.protocol,
    pool: address(x.pool, 'pool'),
    positionManager: address(x.positionManager, 'positionManager'),
    activeTokenId: x.activeTokenId === null || x.activeTokenId === undefined ? null : String(x.activeTokenId),
    riskToken: address(x.riskToken, 'riskToken'),
    quoteToken: address(x.quoteToken, 'quoteToken'),
    staking: x.staking?.enabled ? {
      enabled: true,
      gauge: address(x.staking.gauge, 'staking.gauge'),
      rewardToken: x.staking.rewardToken === undefined ? ADDR.UP : address(x.staking.rewardToken, 'staking.rewardToken'),
      rewardQuoteToken: x.staking.rewardQuoteToken === undefined ? address(x.quoteToken, 'quoteToken') : address(x.staking.rewardQuoteToken, 'staking.rewardQuoteToken'),
      rewardHandling: x.staking.rewardHandling === undefined ? 'convert_to_quote_hold' : x.staking.rewardHandling,
    } : { enabled: false },
    range: {
      mode: x.range.mode,
      lowerPct,
      upperPct,
      tickLower: x.range.tickLower,
      tickUpper: x.range.tickUpper,
      defensiveLowerPct: optionalFinite(x.range.defensiveLowerPct, 'defensiveLowerPct', 0.001, 99),
      defensiveUpperPct: optionalFinite(x.range.defensiveUpperPct, 'defensiveUpperPct', 0.001, 500),
    },
    trigger: {
      source: x.trigger.source,
      pollSeconds: finite(x.trigger.pollSeconds, 'pollSeconds', 1, 60),
      confirmationSeconds: finite(x.trigger.confirmationSeconds, 'confirmationSeconds', 0, 3600),
      cooldownMinutes: finite(x.trigger.cooldownMinutes, 'cooldownMinutes', 0, 1440),
    },
    boundary: { lower: policy(x.boundary.lower, 'lower'), upper: policy(x.boundary.upper, 'upper') },
    fees: {
      handling: x.fees.handling,
      timing: x.fees.timing,
      thresholdQuote: optionalDecimal(x.fees.thresholdQuote, 'thresholdQuote'),
      intervalMinutes: optionalFinite(x.fees.intervalMinutes, 'intervalMinutes', 1, 10080),
    },
    capitalProtection: {
      enabled: x.capitalProtection?.enabled !== false,
      profitThresholdUsdg: optionalDecimal(x.capitalProtection?.profitThresholdUsdg, 'profitThresholdUsdg') ?? '10',
    },
    adaptiveRange: {
      enabled: x.adaptiveRange?.enabled !== false,
      targetMinutes: optionalFinite(x.adaptiveRange?.targetMinutes, 'adaptiveRange.targetMinutes', 1, 10080) ?? 120,
      maxMultiplier: optionalFinite(x.adaptiveRange?.maxMultiplier, 'adaptiveRange.maxMultiplier', 1, 20) ?? 4,
      recoveryDecay: optionalFinite(x.adaptiveRange?.recoveryDecay, 'adaptiveRange.recoveryDecay', 0, 1) ?? 0.5,
      contractionReviewMinutes: optionalFinite(x.adaptiveRange?.contractionReviewMinutes, 'adaptiveRange.contractionReviewMinutes', 1, 10080) ?? 360,
      contractionStabilityMinutes: optionalFinite(x.adaptiveRange?.contractionStabilityMinutes, 'adaptiveRange.contractionStabilityMinutes', 1, 1440) ?? 120,
      contractionMaxVolatilityBps: optionalFinite(x.adaptiveRange?.contractionMaxVolatilityBps, 'adaptiveRange.contractionMaxVolatilityBps', 1, 10_000) ?? 250,
      contractionFeeCoverage: optionalFinite(x.adaptiveRange?.contractionFeeCoverage, 'adaptiveRange.contractionFeeCoverage', 1, 10) ?? 1.25,
    },
    safeguards: {
      enabled: x.safeguards.enabled,
      minCrossingMinutes: optionalFinite(x.safeguards.minCrossingMinutes, 'minCrossingMinutes', 0, 10080),
      minNetAprPct: optionalFinite(x.safeguards.minNetAprPct, 'minNetAprPct', 0, 1_000_000),
      maxRebalancesPerDay: optionalFinite(x.safeguards.maxRebalancesPerDay, 'maxRebalancesPerDay', 1, 1000),
      maxConsecutiveLowerBreaks: optionalFinite(x.safeguards.maxConsecutiveLowerBreaks, 'maxConsecutiveLowerBreaks', 1, 1000),
      maxRiskAssetPct: optionalFinite(x.safeguards.maxRiskAssetPct, 'maxRiskAssetPct', 0, 100),
      maxSwapImpactBps: optionalFinite(x.safeguards.maxSwapImpactBps, 'maxSwapImpactBps', 0, 10_000),
      volatilityWindowSeconds: optionalFinite(x.safeguards.volatilityWindowSeconds, 'volatilityWindowSeconds', 10, 3600),
      maxVolatilityBps: optionalFinite(x.safeguards.maxVolatilityBps, 'maxVolatilityBps', 1, 10_000),
      maxSpotTwapDeviationBps: optionalFinite(x.safeguards.maxSpotTwapDeviationBps, 'maxSpotTwapDeviationBps', 1, 10_000),
      stableMarketSeconds: optionalFinite(x.safeguards.stableMarketSeconds, 'stableMarketSeconds', 0, 3600),
      burstWindowMinutes: optionalFinite(x.safeguards.burstWindowMinutes, 'burstWindowMinutes', 1, 1440),
      burstTriggerCount: optionalFinite(x.safeguards.burstTriggerCount, 'burstTriggerCount', 2, 1000),
      burstCooldownMinutes: optionalFinite(x.safeguards.burstCooldownMinutes, 'burstCooldownMinutes', 1, 1440),
      maxSlippageBps: finite(x.safeguards.maxSlippageBps, 'maxSlippageBps', 0, 1000),
      maxPlanAgeSeconds: finite(x.safeguards.maxPlanAgeSeconds, 'maxPlanAgeSeconds', 1, 300),
    },
    execution: {
      mode: x.execution.mode,
      executorId: x.execution.executorId === undefined ? undefined : String(x.execution.executorId),
      walletId: x.execution.walletId === undefined ? undefined : String(x.execution.walletId),
      signerAddress: x.execution.signerAddress === undefined ? undefined : address(x.execution.signerAddress, 'signerAddress'),
      dryRun:
        typeof x.execution.dryRun === 'boolean'
          ? x.execution.dryRun
          : (() => {
              throw new StrategyError(STRATEGY_ERROR.CONFIG, 'dryRun must be boolean')
            })(),
      maxGasPriceWei: optionalDecimal(x.execution.maxGasPriceWei, 'maxGasPriceWei', true),
      maxGasQuotePerTx: optionalDecimal(x.execution.maxGasQuotePerTx, 'maxGasQuotePerTx'),
      maxDailyTurnoverQuote: optionalDecimal(x.execution.maxDailyTurnoverQuote, 'maxDailyTurnoverQuote'),
      gasReserveMultiplier: finite(x.execution.gasReserveMultiplier, 'gasReserveMultiplier', 1, 10),
      lowTransactionMode: x.execution.lowTransactionMode === true,
    },
    revision: finite(x.revision, 'revision', 1, Number.MAX_SAFE_INTEGER),
    createdAt: finite(x.createdAt, 'createdAt', 0, Number.MAX_SAFE_INTEGER),
    updatedAt: finite(x.updatedAt, 'updatedAt', 0, Number.MAX_SAFE_INTEGER),
  }
  if (config.riskToken.toLowerCase() === config.quoteToken.toLowerCase())
    throw new StrategyError(STRATEGY_ERROR.CONFIG, 'riskToken and quoteToken must differ')
  const expectedManager = config.protocol === 'up33' ? ADDR.CL_PM : UNI.V3_NPM
  if (config.positionManager.toLowerCase() !== expectedManager.toLowerCase())
    throw new StrategyError(STRATEGY_ERROR.POOL_IDENTITY, 'position manager is not the canonical deployment')
  if (config.execution.mode === 'executor_auto' && (!config.execution.walletId || !config.execution.signerAddress))
    throw new StrategyError(STRATEGY_ERROR.CONFIG, 'executor_auto requires walletId and signerAddress')
  if (config.execution.mode === 'executor_auto' && config.execution.signerAddress?.toLowerCase() !== config.owner.toLowerCase())
    throw new StrategyError(STRATEGY_ERROR.OWNER, 'executor signer must own the position')
  if (config.staking?.enabled) {
    if (config.protocol !== 'up33' || !config.staking.gauge)
      throw new StrategyError(STRATEGY_ERROR.CONFIG, 'automatic staking requires an UP33 gauge')
    if (config.staking.rewardToken?.toLowerCase() !== ADDR.UP.toLowerCase() || config.staking.rewardQuoteToken?.toLowerCase() !== config.quoteToken.toLowerCase() || config.staking.rewardHandling !== 'convert_to_quote_hold')
      throw new StrategyError(STRATEGY_ERROR.CONFIG, 'automatic staking rewards must convert UP via WETH to the held quote token')
    if (config.fees.timing !== 'on_rebalance')
      throw new StrategyError(STRATEGY_ERROR.CONFIG, 'staked strategies currently harvest rewards on rebalance')
  }
  if (config.fees.timing === 'threshold' && !config.fees.thresholdQuote)
    throw new StrategyError(STRATEGY_ERROR.CONFIG, 'threshold fee timing requires thresholdQuote')
  if (config.fees.timing === 'interval' && config.fees.intervalMinutes === undefined)
    throw new StrategyError(STRATEGY_ERROR.CONFIG, 'interval fee timing requires intervalMinutes')
  if (config.enabled && config.execution.mode === 'executor_auto' && !config.execution.dryRun) {
    if (!config.execution.maxDailyTurnoverQuote)
      throw new StrategyError(STRATEGY_ERROR.CONFIG, 'live automation requires maxDailyTurnoverQuote')
    if (!config.execution.maxGasPriceWei && !config.execution.maxGasQuotePerTx)
      throw new StrategyError(STRATEGY_ERROR.CONFIG, 'live automation requires a gas price or per-transaction gas cap')
  }
  return config
}
