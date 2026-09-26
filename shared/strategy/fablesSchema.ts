import { getAddress, isAddress, isHex, size, type Address, type Hex } from 'viem'
import { STRATEGY_ERROR, StrategyError } from './errors'
import type { FablesStrategyConfig } from './types'
import { robinhoodConfig } from '../../src/config/chains/robinhood'
import { FABLES_AUTO_POOL_IDS, FABLES_KNOWN_POOL_IDS, fablesHook } from '../../src/config/fables'
import { fablesRangeId } from '../../src/lib/fables'

const fail = (message: string): never => { throw new StrategyError(STRATEGY_ERROR.CONFIG, message) }
const record = (value: unknown, name: string): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : fail(`${name} must be an object`)
const addr = (value: unknown, name: string): Address =>
  typeof value === 'string' && isAddress(value) ? getAddress(value) : fail(`${name} must be an address`)
const int = (value: unknown, name: string, min: number, max: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value : fail(`${name} must be an integer from ${min} to ${max}`)
const pct = (value: unknown, name: string): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0.001 && value <= 500
    ? value : fail(`${name} must be between 0.001 and 500`)
const uint = (value: unknown, name: string, optional = false): string | undefined => {
  if (optional && (value === undefined || value === null)) return undefined
  if (typeof value !== 'string' || !/^\d+$/.test(value)) fail(`${name} must be a nonnegative integer string`)
  return BigInt(value as string).toString()
}

/** Separate v2 parser so a Fables share position never enters the v1 NFT runner. */
export function parseFablesStrategyConfig(value: unknown, options: { requireAutoApproval?: boolean } = {}): FablesStrategyConfig {
  const x = record(value, 'strategy')
  if (x.version !== 2 || x.protocol !== 'fables' || x.chainId !== 4663)
    fail('Fables requires version 2 on Robinhood Chain')
  if ('activeTokenId' in x || 'positionManager' in x || 'staking' in x)
    fail('Fables share strategies cannot contain NFT or staking fields')
  if (typeof x.id !== 'string' || !x.id.trim()) fail('strategy id missing')
  if (typeof x.name !== 'string' || !x.name.trim()) fail('strategy name missing')
  if (typeof x.enabled !== 'boolean') fail('enabled must be boolean')
  const positionRef = record(x.positionRef, 'positionRef')
  if (positionRef.kind !== 'fables_range') fail('Fables requires a share-range positionRef')
  if (typeof positionRef.poolId !== 'string' || !isHex(positionRef.poolId) || size(positionRef.poolId) !== 32)
    fail('poolId must be bytes32')
  const poolId = positionRef.poolId.toLowerCase() as Hex
  if (!FABLES_KNOWN_POOL_IDS.has(poolId)) fail('poolId is not in the reviewed Fables registry')
  const hook = addr(positionRef.hook, 'hook')
  if (!fablesHook(hook)) fail('hook has not been reviewed')
  const tickLower = int(positionRef.tickLower, 'tickLower', -887272, 887272)
  const tickUpper = int(positionRef.tickUpper, 'tickUpper', -887272, 887272)
  if (tickLower >= tickUpper) fail('tickLower must be less than tickUpper')
  const rangeId = uint(positionRef.rangeId, 'rangeId')!
  if (BigInt(rangeId) !== fablesRangeId(poolId, tickLower, tickUpper)) fail('rangeId does not match pool and ticks')
  const poolManager = addr(x.poolManager, 'poolManager')
  if (poolManager.toLowerCase() !== robinhoodConfig.uniV4!.POOL_MANAGER.toLowerCase())
    fail('poolManager does not match Robinhood deployment')
  const owner = addr(x.owner, 'owner')
  const riskToken = addr(x.riskToken, 'riskToken')
  const quoteToken = addr(x.quoteToken, 'quoteToken')
  if (riskToken.toLowerCase() === quoteToken.toLowerCase()) fail('riskToken and quoteToken must differ')
  const range = record(x.range, 'range')
  const lowerPct = pct(range.lowerPct, 'range.lowerPct')
  if (lowerPct >= 100) fail('range.lowerPct must be below 100')
  const trigger = record(x.trigger, 'trigger')
  const fees = record(x.fees, 'fees')
  if (fees.handling !== 'reinvest') fail('only fee reinvestment is supported by this Fables config version')
  if ('timing' in fees || 'thresholdQuote' in fees || 'intervalMinutes' in fees)
    fail('Fables fee timing and fee thresholds are unsupported')
  const safeguards = record(x.safeguards, 'safeguards')
  const execution = record(x.execution, 'execution')
  if (!['notify_only', 'executor_auto'].includes(execution.mode)) fail('invalid execution mode')
  if (typeof execution.dryRun !== 'boolean') fail('dryRun must be boolean')
  if (typeof safeguards.allowLegacyUnboundedFeeExit !== 'boolean') fail('legacy exit consent must be explicit')
  if (options.requireAutoApproval !== false && x.enabled && execution.mode === 'executor_auto' && !FABLES_AUTO_POOL_IDS.has(poolId))
    fail('pool is not approved for Fables automatic signing')
  const signerAddress = execution.signerAddress === undefined ? undefined : addr(execution.signerAddress, 'signerAddress')
  if (x.enabled && execution.mode === 'executor_auto'
    && (!execution.walletId || signerAddress?.toLowerCase() !== owner.toLowerCase()))
    fail('automatic execution requires an owner-matched signer wallet')
  return {
    version: 2, protocol: 'fables', chainId: 4663,
    id: x.id.trim(), name: x.name.trim(), enabled: x.enabled,
    owner, poolManager,
    positionRef: { kind: 'fables_range', poolId, hook, rangeId, tickLower, tickUpper },
    riskToken, quoteToken,
    range: { lowerPct, upperPct: pct(range.upperPct, 'range.upperPct') },
    trigger: {
      pollSeconds: int(trigger.pollSeconds, 'trigger.pollSeconds', 1, 60),
      confirmationSeconds: int(trigger.confirmationSeconds, 'trigger.confirmationSeconds', 0, 3600),
      cooldownMinutes: int(trigger.cooldownMinutes, 'trigger.cooldownMinutes', 0, 1440),
    },
    fees: { handling: 'reinvest' },
    safeguards: {
      maxSlippageBps: int(safeguards.maxSlippageBps, 'safeguards.maxSlippageBps', 0, 10_000),
      maxSwapImpactBps: int(safeguards.maxSwapImpactBps, 'safeguards.maxSwapImpactBps', 0, 10_000),
      maxRebalancesPerDay: int(safeguards.maxRebalancesPerDay, 'safeguards.maxRebalancesPerDay', 1, 100),
      maxPlanAgeSeconds: int(safeguards.maxPlanAgeSeconds, 'safeguards.maxPlanAgeSeconds', 30, 600),
      maxClaimFeeBps: int(safeguards.maxClaimFeeBps, 'safeguards.maxClaimFeeBps', 0, 10_000),
      allowLegacyUnboundedFeeExit: safeguards.allowLegacyUnboundedFeeExit,
      minNativeGasReserveWei: uint(safeguards.minNativeGasReserveWei, 'safeguards.minNativeGasReserveWei')!,
    },
    execution: {
      mode: execution.mode, walletId: execution.walletId,
      signerAddress, dryRun: execution.dryRun,
      maxGasPriceWei: uint(execution.maxGasPriceWei, 'execution.maxGasPriceWei', true),
      maxDailyTurnoverQuote: uint(execution.maxDailyTurnoverQuote, 'execution.maxDailyTurnoverQuote', true),
    },
    revision: int(x.revision, 'revision', 1, Number.MAX_SAFE_INTEGER),
    createdAt: int(x.createdAt, 'createdAt', 1, Number.MAX_SAFE_INTEGER),
    updatedAt: int(x.updatedAt, 'updatedAt', 1, Number.MAX_SAFE_INTEGER),
  }
}
