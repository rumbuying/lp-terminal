import type { StrategyConfig } from './types'
import { tickDistanceBps } from './market-guard'

/**
 * A concrete, user-facing evaluation of every automated safety condition.
 * The monitor (`executor/monitor.ts`) decides states; this module mirrors the
 * same rules read-only so the UI can explain exactly which condition is being
 * waited on, which are satisfied, and which are violated right now.
 */

export type GuardConditionId =
  | 'sample_history'
  | 'market_volatility'
  | 'spot_twap_deviation'
  | 'guard_recovery_stability'
  | 'burst_throttle'
  | 'trigger_cooldown'
  | 'boundary_confirmation'
  | 'boundary_pause'
  | 'apr_available'
  | 'manual_confirm'
  | 'monitor_recheck'
  | 'cycle_economics'

export type GuardConditionStatus = 'pass' | 'fail' | 'wait'

export type GuardCondition = {
  id: GuardConditionId
  status: GuardConditionStatus
  /** Current measured value (bps for market metrics, count for triggers). */
  measured?: number
  /** Configured limit in the same unit as `measured`. */
  threshold?: number
  /** Rolling-window sample count backing a market metric. */
  sampleCount?: number
  /** Absolute epoch second at which a pending wait ends; enables live countdowns. */
  waitUntil?: number
  remainingSeconds?: number
  totalSeconds?: number
  side?: 'lower' | 'upper'
  /** Epoch second of the event behind the condition (e.g. the pause). */
  at?: number
}

export type GuardReport = {
  /** The strategy is parked in a guard/pause state right now. */
  waiting: boolean
  /** True when an explicit user action is required; false means auto-resume. */
  needsManualResume: boolean
  /** Ids of the conditions currently preventing execution. */
  blocking: GuardConditionId[]
  conditions: GuardCondition[]
  checkedAt: number
}

export type GuardMarketStats = {
  count: number
  firstTs: number
  lastTs: number
  tick: number
  minTick: number
  maxTick: number
}

export type GuardPauseInfo = {
  code?: string
  reason?: string
  side?: string
  at: number
}

const WAITING_STATES = new Set(['guard_wait', 'paused_guard', 'awaiting_manual'])

export function buildGuardReport(args: {
  state: string
  now: number
  safeguards: StrategyConfig['safeguards']
  pollSeconds: number
  confirmationSeconds: number
  guardReason?: 'market_volatility' | 'spot_twap_deviation'
  guardStableSince?: number
  burstWaitUntil?: number
  cooldownUntil?: number
  outSide?: 'lower' | 'upper'
  outSince?: number
  spotTick?: number
  marketStats?: GuardMarketStats
  recentCompletedCycles?: number
  pause?: GuardPauseInfo
  /** Present when the per-cycle economics gate is configured for the strategy. */
  economics?: {
    /** Epoch second at which a pending gate wait ends; 0 when not waiting. */
    waitUntil: number
    /** Collectable fees at the last gate check, human quote units. */
    feesQuote?: number
    /** Last cycle's realized cost, human quote units. */
    costQuote?: number
    coverage: number
  }
}): GuardReport {
  const waiting = WAITING_STATES.has(args.state)
  const needsManualResume = args.state === 'paused_guard' || args.state === 'awaiting_manual'
  const conditions: GuardCondition[] = []
  const blocking = new Set<GuardConditionId>()

  const windowSeconds = args.safeguards.enabled ? args.safeguards.volatilityWindowSeconds : undefined
  const marketGuardActive = windowSeconds !== undefined
    && (args.safeguards.maxVolatilityBps !== undefined || args.safeguards.maxSpotTwapDeviationBps !== undefined)

  let marketHealthy: boolean | undefined
  if (marketGuardActive && windowSeconds) {
    const readyDeadline = (stats: GuardMarketStats | undefined) =>
      stats?.firstTs ? stats.firstTs + windowSeconds - args.pollSeconds * 2 : undefined
    const stats = args.marketStats
    const ready = !!stats && stats.count >= 2 && stats.firstTs <= args.now - windowSeconds + args.pollSeconds * 2

    if (!ready) {
      blocking.add('sample_history')
      conditions.push({
        id: 'sample_history',
        status: 'wait',
        sampleCount: stats?.count ?? 0,
        threshold: 2,
        totalSeconds: windowSeconds,
        waitUntil: readyDeadline(stats),
        remainingSeconds: Math.max(0, (readyDeadline(stats) ?? args.now) - args.now),
      })
    }

    const maxVolatilityBps = args.safeguards.maxVolatilityBps
    if (maxVolatilityBps !== undefined) {
      const measured = ready && stats ? tickDistanceBps(stats.minTick, stats.maxTick) : undefined
      const failed = measured !== undefined && measured > maxVolatilityBps
      if (failed) blocking.add('market_volatility')
      conditions.push({ id: 'market_volatility', status: failed ? 'fail' : ready ? 'pass' : 'wait', measured, threshold: maxVolatilityBps, sampleCount: stats?.count })
      if (failed) marketHealthy = false
    }

    const maxSpotTwapDeviationBps = args.safeguards.maxSpotTwapDeviationBps
    if (maxSpotTwapDeviationBps !== undefined) {
      const measured = ready && stats ? tickDistanceBps(args.spotTick ?? stats.tick, stats.tick) : undefined
      const failed = measured !== undefined && measured > maxSpotTwapDeviationBps
      if (failed) blocking.add('spot_twap_deviation')
      conditions.push({ id: 'spot_twap_deviation', status: failed ? 'fail' : ready ? 'pass' : 'wait', measured, threshold: maxSpotTwapDeviationBps, sampleCount: stats?.count })
      if (failed) marketHealthy = false
    }

    if (args.guardReason) {
      const stableSeconds = args.safeguards.stableMarketSeconds ?? 0
      const stableSince = args.guardStableSince ?? args.now
      const remaining = Math.max(0, stableSince + stableSeconds - args.now)
      const healthy = marketHealthy !== false && ready
      if (!healthy) {
        // A metric above already carries the fail for this market problem.
        // Report the hold as pending, not as a second failure: the summary
        // must count root causes, not echoes of the same cause.
        conditions.push({ id: 'guard_recovery_stability', status: 'wait', totalSeconds: stableSeconds })
      } else if (remaining > 0) {
        blocking.add('guard_recovery_stability')
        conditions.push({ id: 'guard_recovery_stability', status: 'wait', waitUntil: stableSince + stableSeconds, remainingSeconds: remaining, totalSeconds: stableSeconds })
      } else {
        conditions.push({ id: 'guard_recovery_stability', status: 'pass', totalSeconds: stableSeconds, remainingSeconds: 0 })
      }
    }
  }

  const burstWindowMinutes = args.safeguards.enabled ? args.safeguards.burstWindowMinutes : undefined
  const burstTriggerCount = args.safeguards.enabled ? args.safeguards.burstTriggerCount : undefined
  const burstCooldownMinutes = args.safeguards.enabled ? args.safeguards.burstCooldownMinutes : undefined
  if (burstWindowMinutes !== undefined && burstTriggerCount !== undefined && burstCooldownMinutes !== undefined) {
    const recent = args.recentCompletedCycles
    const totalSeconds = burstCooldownMinutes * 60
    if ((args.burstWaitUntil ?? 0) > args.now) {
      blocking.add('burst_throttle')
      conditions.push({
        id: 'burst_throttle',
        status: 'wait',
        measured: recent,
        threshold: burstTriggerCount,
        waitUntil: args.burstWaitUntil,
        remainingSeconds: args.burstWaitUntil! - args.now,
        totalSeconds,
      })
    } else if (recent !== undefined && recent >= burstTriggerCount - 1) {
      conditions.push({ id: 'burst_throttle', status: 'wait', measured: recent, threshold: burstTriggerCount })
    } else {
      conditions.push({ id: 'burst_throttle', status: 'pass', measured: recent, threshold: burstTriggerCount })
    }
  }

  if (args.cooldownUntil && args.cooldownUntil > args.now) {
    conditions.push({
      id: 'trigger_cooldown',
      status: 'wait',
      waitUntil: args.cooldownUntil,
      remainingSeconds: args.cooldownUntil - args.now,
    })
  }

  if (args.economics && args.economics.coverage > 0) {
    const waiting = args.economics.waitUntil > args.now
    const required = args.economics.costQuote !== undefined
      ? args.economics.costQuote * args.economics.coverage
      : undefined
    if (waiting) {
      blocking.add('cycle_economics')
      conditions.push({
        id: 'cycle_economics',
        status: 'wait',
        measured: args.economics.feesQuote,
        threshold: required !== undefined ? Math.round(required * 100) / 100 : undefined,
        waitUntil: args.economics.waitUntil,
        remainingSeconds: args.economics.waitUntil - args.now,
      })
    } else {
      conditions.push({ id: 'cycle_economics', status: 'pass', measured: args.economics.feesQuote, threshold: required !== undefined ? Math.round(required * 100) / 100 : undefined })
    }
  }

  if (args.outSide && args.outSince && args.confirmationSeconds > 0) {
    const elapsed = args.now - args.outSince
    if (elapsed < args.confirmationSeconds) {
      conditions.push({
        id: 'boundary_confirmation',
        status: 'wait',
        side: args.outSide,
        waitUntil: args.outSince + args.confirmationSeconds,
        remainingSeconds: args.confirmationSeconds - elapsed,
        totalSeconds: args.confirmationSeconds,
      })
    } else {
      conditions.push({ id: 'boundary_confirmation', status: 'pass', side: args.outSide, totalSeconds: args.confirmationSeconds })
    }
  }

  if (args.state === 'paused_guard' || args.state === 'awaiting_manual') {
    if (args.pause?.side) {
      blocking.add('boundary_pause')
      conditions.push({
        id: 'boundary_pause',
        status: 'fail',
        side: args.pause.side === 'upper' ? 'upper' : 'lower',
        at: args.pause.at,
      })
    }
    if (args.pause?.code === 'E_APR_UNAVAILABLE') {
      blocking.add('apr_available')
      conditions.push({ id: 'apr_available', status: 'fail', at: args.pause.at })
    }
    if (args.state === 'awaiting_manual') {
      blocking.add('manual_confirm')
      conditions.push({ id: 'manual_confirm', status: 'wait' })
    }
  }

  if (waiting && blocking.size === 0) {
    // The monitor will re-evaluate on its next pass (e.g. right after a swap
    // impact trip). Surface that loop instead of an unexplained wait.
    blocking.add('monitor_recheck')
    conditions.push({ id: 'monitor_recheck', status: 'wait', remainingSeconds: Math.max(args.pollSeconds, 1) })
  }

  return {
    waiting,
    needsManualResume,
    blocking: [...blocking],
    conditions,
    checkedAt: args.now,
  }
}
