import { keccak256, stringToHex } from 'viem'
import { getSqrtRatioAtTick, minAmountsForLiquidity, tickToPrice } from '../../src/lib/clmath'
import { STRATEGY_ERROR, StrategyError } from './errors'
import { fixedTickRange, quoteRangeToTicks, rangeSide } from './range'
import { scaledRangePcts } from './adaptive-range'
import type { StrategyConfig, StrategyExecutionPlan, StrategyPlanStep, StrategyPositionSnapshot, TriggerSide } from './types'
import { ADDR } from '../../src/config/addresses'

const stable = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stable(obj[key])}`).join(',')}}`
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const bigint = (v: string, field: string) => {
  try {
    const x = BigInt(v)
    if (x < 0n) throw new Error('negative')
    return x
  } catch {
    throw new StrategyError(STRATEGY_ERROR.CONFIG, `invalid snapshot ${field}`)
  }
}

function assertSnapshot(config: StrategyConfig, snapshot: StrategyPositionSnapshot) {
  if (snapshot.chainId !== config.chainId) throw new StrategyError(STRATEGY_ERROR.CHAIN, 'snapshot chain mismatch')
  if (!same(snapshot.owner, config.owner)) throw new StrategyError(STRATEGY_ERROR.OWNER, 'position owner changed')
  if (config.staking?.enabled) {
    if (!snapshot.staked || !snapshot.gauge || !config.staking.gauge || !same(snapshot.gauge, config.staking.gauge) || !snapshot.nftOwner || !same(snapshot.nftOwner, config.staking.gauge))
      throw new StrategyError(STRATEGY_ERROR.OWNER, 'staked position custody changed')
  } else if (snapshot.staked) throw new StrategyError(STRATEGY_ERROR.OWNER, 'strategy does not permit gauge custody')
  if (snapshot.protocol !== config.protocol || !same(snapshot.pool, config.pool) || !same(snapshot.positionManager, config.positionManager))
    throw new StrategyError(STRATEGY_ERROR.POOL_IDENTITY, 'position no longer matches strategy')
  if (!config.activeTokenId || snapshot.tokenId !== config.activeTokenId)
    throw new StrategyError(STRATEGY_ERROR.POSITION_CHANGED, 'active token id changed')
  if (bigint(snapshot.liquidity, 'liquidity') === 0n) throw new StrategyError(STRATEGY_ERROR.POSITION_CHANGED, 'position has no liquidity')
  const hasRiskQuote =
    (same(snapshot.token0, config.riskToken) && same(snapshot.token1, config.quoteToken)) ||
    (same(snapshot.token1, config.riskToken) && same(snapshot.token0, config.quoteToken))
  if (!hasRiskQuote) throw new StrategyError(STRATEGY_ERROR.POOL_IDENTITY, 'pool tokens changed')
}

/**
 * A deterministic, JSON-safe plan. It carries intents only: every transaction
 * sender must re-read state and build calldata immediately before the step.
 */
export function makeRebalancePlan(args: {
  config: StrategyConfig
  snapshot: StrategyPositionSnapshot
  now?: number
  triggerSide?: TriggerSide
  rangeScale?: number
}): StrategyExecutionPlan {
  const now = args.now ?? Math.floor(Date.now() / 1000)
  const { config, snapshot } = args
  assertSnapshot(config, snapshot)
  if (now - snapshot.observedAt > config.safeguards.maxPlanAgeSeconds)
    throw new StrategyError(STRATEGY_ERROR.PLAN_STALE, 'snapshot is older than maximum plan age')

  const side = args.triggerSide ?? rangeSide(snapshot.tick, snapshot.tickLower, snapshot.tickUpper)
  const scheduledContraction = side === 'adaptive_contraction'
  if (side === 'in') throw new StrategyError(STRATEGY_ERROR.CONFIG, 'cannot rebalance an in-range position')
  if (scheduledContraction && rangeSide(snapshot.tick, snapshot.tickLower, snapshot.tickUpper) !== 'in')
    throw new StrategyError(STRATEGY_ERROR.CONFIG, 'adaptive contraction requires an in-range position')
  const policy = side === 'lower'
    ? config.boundary.lower
    : side === 'upper'
      ? config.boundary.upper
      : scheduledContraction
        ? { condition: 'always' as const, action: 'recenter' as const }
        : config.boundary.upper
  if (policy.action === 'pause')
    throw new StrategyError(STRATEGY_ERROR.CONFIG, `boundary action ${policy.action} has no rebuild plan`)
  if (policy.condition === 'manual_confirm' && !args.triggerSide)
    throw new StrategyError(STRATEGY_ERROR.CONFIG, 'boundary requires an explicit manual trigger')

  const rangeScale = config.range.mode === 'fixed_ticks' ? 1 : Math.max(1, args.rangeScale ?? 1)
  const baseLowerPct = policy.action === 'skew_recenter' ? config.range.defensiveLowerPct ?? config.range.lowerPct : config.range.lowerPct
  const baseUpperPct = policy.action === 'skew_recenter' ? config.range.defensiveUpperPct ?? config.range.upperPct : config.range.upperPct
  const { lowerPct, upperPct } = scaledRangePcts(baseLowerPct, baseUpperPct, rangeScale)

  const nextRange = config.range.mode === 'fixed_ticks'
    ? fixedTickRange(config.range.tickLower, config.range.tickUpper, snapshot.tickSpacing)
    : quoteRangeToTicks({
    centerQuotePerRisk: same(snapshot.token0, config.riskToken)
      ? tickToPrice(snapshot.tick, snapshot.token0Decimals, snapshot.token1Decimals)
      : 1 / tickToPrice(snapshot.tick, snapshot.token0Decimals, snapshot.token1Decimals),
    currentTick: snapshot.tick,
    tickSpacing: snapshot.tickSpacing,
    token0IsRisk: same(snapshot.token0, config.riskToken),
    token0Decimals: snapshot.token0Decimals,
    token1Decimals: snapshot.token1Decimals,
    lowerPct,
    upperPct,
    })
  const liquidity = bigint(snapshot.liquidity, 'liquidity')
  const mins = config.safeguards.enabled
    ? minAmountsForLiquidity(
      bigint(snapshot.sqrtPriceX96, 'sqrtPriceX96'),
      getSqrtRatioAtTick(snapshot.tickLower),
      getSqrtRatioAtTick(snapshot.tickUpper),
      liquidity,
      config.safeguards.maxSlippageBps,
    )
    : { amount0Min: 0n, amount1Min: 0n }
  const steps: StrategyPlanStep[] = [
    { index: 0, kind: 'precheck', intent: { owner: config.owner, tokenId: snapshot.tokenId, pool: config.pool, blockNumber: snapshot.blockNumber } },
    { index: 1, kind: 'decrease', intent: { tokenId: snapshot.tokenId, liquidity: snapshot.liquidity, amount0Min: mins.amount0Min.toString(), amount1Min: mins.amount1Min.toString(), bundledCollect: config.execution.lowTransactionMode } },
    { index: 2, kind: 'collect', intent: { tokenId: snapshot.tokenId, recipient: config.owner, includePrincipal: true, bundledWithDecrease: config.execution.lowTransactionMode } },
    { index: 3, kind: 'burn', intent: { tokenId: snapshot.tokenId, onlyIfEmpty: true, skippedInLowTransactionMode: config.execution.lowTransactionMode } },
    { index: 4, kind: 'approve_swap', intent: { spender: 'kyber_router', exactAllowance: !config.execution.lowTransactionMode, persistentAllowance: config.execution.lowTransactionMode } },
    { index: 5, kind: 'swap', intent: { repriceImmediatelyBeforeSend: true, feeHandling: config.fees.handling, maxSlippageBps: config.safeguards.maxSlippageBps } },
    { index: 6, kind: 'approve0', intent: { token: snapshot.token0, spender: config.positionManager, exactAllowance: !config.execution.lowTransactionMode, persistentAllowance: config.execution.lowTransactionMode } },
    { index: 7, kind: 'approve1', intent: { token: snapshot.token1, spender: config.positionManager, exactAllowance: !config.execution.lowTransactionMode, persistentAllowance: config.execution.lowTransactionMode } },
    { index: 8, kind: 'mint', intent: { pool: config.pool, tickLower: nextRange.tickLower, tickUpper: nextRange.tickUpper, recipient: config.owner, useActualBalances: true } },
    { index: 9, kind: 'revoke0', intent: { token: snapshot.token0, spender: config.positionManager, allowance: 0, skippedInLowTransactionMode: config.execution.lowTransactionMode } },
    { index: 10, kind: 'revoke1', intent: { token: snapshot.token1, spender: config.positionManager, allowance: 0, skippedInLowTransactionMode: config.execution.lowTransactionMode } },
    { index: 11, kind: 'commit', intent: { replaceTokenId: true, appendCycleAndLedger: true } },
  ]
  if (config.staking?.enabled) steps.push(
    { index: 12, kind: 'unstake', intent: { gauge: config.staking.gauge!, tokenId: snapshot.tokenId, autoClaimReward: true } },
    { index: 13, kind: 'approve_reward', intent: { token: config.staking.rewardToken!, exactAllowance: !config.execution.lowTransactionMode, persistentAllowance: config.execution.lowTransactionMode } },
    { index: 14, kind: 'swap_reward', intent: { tokenIn: config.staking.rewardToken!, intermediateToken: ADDR.WETH, tokenOut: config.quoteToken, holdAsIncome: true } },
  )
  if (config.staking?.enabled && policy.action !== 'hold_quote') steps.push(
    { index: 15, kind: 'approve_nft', intent: { spender: config.staking.gauge!, mintedTokenId: !config.execution.lowTransactionMode, approvalForAll: config.execution.lowTransactionMode } },
    { index: 16, kind: 'stake', intent: { gauge: config.staking.gauge!, mintedTokenId: true } },
  )
  const payload = { strategyId: config.id, strategyRevision: config.revision, createdAt: now, action: policy.action, snapshot, nextRange, rangeScale, steps }
  const hash = keccak256(stringToHex(stable(payload)))
  return {
    version: 1,
    id: `plan-${hash.slice(2, 18)}`,
    hash,
    strategyId: config.id,
    strategyRevision: config.revision,
    createdAt: now,
    expiresAt: now + config.safeguards.maxPlanAgeSeconds,
    triggerSide: side,
    action: policy.action,
    snapshot,
    nextRange,
    rangeScale,
    steps,
    safeguards: {
      maxSlippageBps: config.safeguards.maxSlippageBps,
      maxPlanAgeSeconds: config.safeguards.maxPlanAgeSeconds,
      dryRun: config.execution.dryRun,
    },
  }
}

export const serialisePlan = (plan: StrategyExecutionPlan) => stable(plan)

export function makeFeeCollectionPlan(args: { config: StrategyConfig; snapshot: StrategyPositionSnapshot; now?: number }): StrategyExecutionPlan {
  if (args.config.staking?.enabled) throw new StrategyError(STRATEGY_ERROR.CONFIG, 'staked reward harvesting occurs on rebalance')
  const now = args.now ?? Math.floor(Date.now() / 1000)
  assertSnapshot(args.config, args.snapshot)
  if (now - args.snapshot.observedAt > args.config.safeguards.maxPlanAgeSeconds)
    throw new StrategyError(STRATEGY_ERROR.PLAN_STALE, 'snapshot is older than maximum plan age')
  const steps: StrategyPlanStep[] = [
    { index: 0, kind: 'precheck', intent: { owner: args.config.owner, tokenId: args.snapshot.tokenId, pool: args.config.pool, blockNumber: args.snapshot.blockNumber } },
    { index: 1, kind: 'decrease', intent: { skipped: true, reason: 'fee_collection' } },
    { index: 2, kind: 'collect', intent: { tokenId: args.snapshot.tokenId, recipient: args.config.owner, feesOnly: true } },
    { index: 3, kind: 'burn', intent: { skipped: true, reason: 'fee_collection' } },
    { index: 4, kind: 'approve_swap', intent: { spender: 'kyber_router', exactAllowance: true, onlyIfConvertToQuote: true } },
    { index: 5, kind: 'swap', intent: { feesOnly: true, handling: args.config.fees.handling } },
    { index: 6, kind: 'approve0', intent: { skipped: true, reason: 'fee_collection' } },
    { index: 7, kind: 'approve1', intent: { skipped: true, reason: 'fee_collection' } },
    { index: 8, kind: 'mint', intent: { skipped: true, reason: 'fee_collection' } },
    { index: 9, kind: 'revoke0', intent: { skipped: true, reason: 'fee_collection' } },
    { index: 10, kind: 'revoke1', intent: { skipped: true, reason: 'fee_collection' } },
    { index: 11, kind: 'commit', intent: { appendLedger: true, preserveTokenId: true } },
  ]
  const nextRange = { tickLower: args.snapshot.tickLower, tickUpper: args.snapshot.tickUpper }
  const rangeScale = 1
  const payload = { strategyId: args.config.id, strategyRevision: args.config.revision, createdAt: now, action: 'collect_fees', snapshot: args.snapshot, nextRange, rangeScale, steps }
  const hash = keccak256(stringToHex(stable(payload)))
  return {
    version: 1,
    id: `plan-${hash.slice(2, 18)}`,
    hash,
    strategyId: args.config.id,
    strategyRevision: args.config.revision,
    createdAt: now,
    expiresAt: now + args.config.safeguards.maxPlanAgeSeconds,
    triggerSide: 'manual',
    action: 'collect_fees',
    snapshot: args.snapshot,
    nextRange,
    rangeScale,
    steps,
    safeguards: { maxSlippageBps: args.config.safeguards.maxSlippageBps, maxPlanAgeSeconds: args.config.safeguards.maxPlanAgeSeconds, dryRun: args.config.execution.dryRun },
  }
}
