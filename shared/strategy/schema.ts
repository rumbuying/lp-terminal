import { getAddress, isAddress, isHex, size, zeroAddress, type Address, type Hex } from 'viem'
import { STRATEGY_ERROR, StrategyError } from './errors'
import type { StrategyConfig, StrategyPreset } from './types'
import { CHAIN_ID } from '../../src/config/addresses'
import { isStrategyChainId, positionManagerFor, strategyChain, type StrategyChainId, type StrategyLpProtocol } from '../../src/config/networks'

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
  chainId?: StrategyChainId
  owner: Address
  protocol: StrategyLpProtocol
  pool: Address
  poolId?: Hex
  hooks?: Address
  positionManager: Address
  riskToken: Address
  quoteToken: Address
  activeTokenId?: string | null
  name?: string
  staking?: { enabled: boolean; gauge?: Address }
}): StrategyConfig {
  const ts = now()
  const chainId = args.chainId ?? CHAIN_ID
  const chain = strategyChain(chainId)
  return {
    version: 1,
    id: id(),
    name: args.name ?? 'Original ±5%',
    preset: 'original',
    sourcePreset: 'original',
    enabled: false,
    chainId,
    owner: getAddress(args.owner),
    protocol: args.protocol,
    pool: getAddress(args.pool),
    poolId: args.poolId,
    hooks: args.protocol === 'univ4' ? getAddress(args.hooks ?? zeroAddress) : undefined,
    positionManager: getAddress(args.positionManager),
    activeTokenId: args.activeTokenId ?? null,
    riskToken: getAddress(args.riskToken),
    quoteToken: getAddress(args.quoteToken),
    staking: chain.gov && args.staking?.enabled ? {
      enabled: true,
      gauge: args.staking.gauge ? getAddress(args.staking.gauge) : undefined,
      rewardToken: chain.gov.UP,
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

/**
 * Band-scaled recommended safety limits for the quick ORIGINAL flow.
 *
 * Derived from the 2026-09 Robinhood Chain post-mortem: narrow bands with a
 * zero-confirmation spot trigger churned 20-44 recenters in 48h while gas
 * doubled, and gas alone ate 17-24% of net fees. These defaults close that
 * failure mode: the crossing floor filters wicks, the volatility/burst guards
 * pause churn instead of chasing it, the daily cap bounds gas spend, and the
 * risk-asset share keeps a hard meme ceiling above the ~50/50 recenter target.
 *
 * `minNetAprPct` is deliberately omitted: the monitor does not compute a net
 * APR yet, so the value would be inert (and a `fee_break_even` boundary would
 * pause with APR_UNAVAILABLE instead of gating).
 */
export function recommendedSafeguards(bandPct: number): StrategyConfig['safeguards'] {
  const band = Math.min(Math.max(Number.isFinite(bandPct) ? bandPct : 5, 0.001), 99)
  const bandBps = Math.round(band * 100)
  return {
    enabled: true,
    // A boundary crossing must persist before any recenter is planned.
    minCrossingMinutes: 5,
    // Hard daily recenter ceiling; narrower bands get the stricter cap.
    maxRebalancesPerDay: Math.min(12, Math.max(4, Math.round(band * 1.6))),
    // Stop catching a falling knife after repeated lower breaks.
    maxConsecutiveLowerBreaks: 4,
    // A symmetric recenter targets ~50/50; 60 keeps a hard risk-share ceiling.
    maxRiskAssetPct: 60,
    maxSwapImpactBps: 150,
    // Market-quality guard: pause once the sampled window swings more than
    // ~2x the band, or spot dislocates from the window average by ~0.6x.
    volatilityWindowSeconds: 300,
    maxVolatilityBps: Math.min(10_000, Math.max(1, Math.round(bandBps * 2))),
    maxSpotTwapDeviationBps: Math.min(10_000, Math.max(100, Math.round(bandBps * 0.6))),
    stableMarketSeconds: 600,
    // Rapid-trigger circuit breaker: the third trigger inside an hour forces
    // an hour-long cool-down instead of another gas-paying chase.
    burstWindowMinutes: 60,
    burstTriggerCount: 3,
    burstCooldownMinutes: 60,
    maxSlippageBps: 100,
    maxPlanAgeSeconds: 30,
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
  if (!isStrategyChainId(x.chainId)) throw new StrategyError(STRATEGY_ERROR.CHAIN, 'unsupported strategy chain')
  const configChain = strategyChain(x.chainId)
  if (!['up33', 'univ3', 'pancakeswap-v3', 'univ4'].includes(x.protocol)) throw new StrategyError(STRATEGY_ERROR.CONFIG, 'invalid protocol')
  if (configChain.key !== 'bsc' && x.protocol === 'pancakeswap-v3') throw new StrategyError(STRATEGY_ERROR.CONFIG, 'PancakeSwap v3 is only available on BSC')
  if (configChain.key !== 'robinhood' && x.protocol === 'up33') throw new StrategyError(STRATEGY_ERROR.CONFIG, 'UP33 is only available on Robinhood Chain')
  if (x.protocol === 'univ4' && !configChain.uniV4) throw new StrategyError(STRATEGY_ERROR.CONFIG, 'Uniswap v4 is not configured on this chain')
  if (x.protocol === 'univ4' && (typeof x.poolId !== 'string' || !isHex(x.poolId) || size(x.poolId) !== 32))
    throw new StrategyError(STRATEGY_ERROR.CONFIG, 'Uniswap v4 strategy requires a bytes32 poolId')
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
    chainId: x.chainId,
    owner: address(x.owner, 'owner'),
    protocol: x.protocol,
    pool: address(x.pool, 'pool'),
    poolId: x.protocol === 'univ4' ? x.poolId as Hex : undefined,
    hooks: x.protocol === 'univ4' ? address(x.hooks ?? zeroAddress, 'hooks') : undefined,
    positionManager: address(x.positionManager, 'positionManager'),
    activeTokenId: x.activeTokenId === null || x.activeTokenId === undefined ? null : String(x.activeTokenId),
    riskToken: address(x.riskToken, 'riskToken'),
    quoteToken: address(x.quoteToken, 'quoteToken'),
    staking: x.staking?.enabled ? {
      enabled: true,
      gauge: address(x.staking.gauge, 'staking.gauge'),
      rewardToken: x.staking.rewardToken === undefined
        ? (() => {
            if (!configChain.gov) throw new StrategyError(STRATEGY_ERROR.CONFIG, 'staking is unavailable on this chain')
            return configChain.gov.UP
          })()
        : address(x.staking.rewardToken, 'staking.rewardToken'),
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
      minCycleFeeCoverage: optionalFinite(x.safeguards.minCycleFeeCoverage, 'minCycleFeeCoverage', 0, 100),
      economicsHoldMinutes: optionalFinite(x.safeguards.economicsHoldMinutes, 'economicsHoldMinutes', 1, 1440),
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
  const expectedManager = positionManagerFor(config.chainId, config.protocol)
  if (config.positionManager.toLowerCase() !== expectedManager.toLowerCase())
    throw new StrategyError(STRATEGY_ERROR.POOL_IDENTITY, 'position manager is not the canonical deployment')
  if (config.execution.mode === 'executor_auto' && (!config.execution.walletId || !config.execution.signerAddress))
    throw new StrategyError(STRATEGY_ERROR.CONFIG, 'executor_auto requires walletId and signerAddress')
  if (config.execution.mode === 'executor_auto' && config.execution.signerAddress?.toLowerCase() !== config.owner.toLowerCase())
    throw new StrategyError(STRATEGY_ERROR.OWNER, 'executor signer must own the position')
  if (config.staking?.enabled) {
    if (!configChain.gov) throw new StrategyError(STRATEGY_ERROR.CONFIG, 'staking is unavailable on this chain')
    if (config.protocol !== 'up33' || !config.staking.gauge)
      throw new StrategyError(STRATEGY_ERROR.CONFIG, 'automatic staking requires an UP33 gauge')
    if (config.staking.rewardToken?.toLowerCase() !== configChain.gov.UP.toLowerCase() || config.staking.rewardQuoteToken?.toLowerCase() !== config.quoteToken.toLowerCase() || config.staking.rewardHandling !== 'convert_to_quote_hold')
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
