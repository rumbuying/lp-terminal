import { rangeSide } from './range'
import type { StrategyConfig, StrategyExecutionPlan, StrategyPositionSnapshot } from './types'

export type TriggerAverage = { tick: number; firstTs: number; lastTs: number; count: number }

/** Only for a job that has not changed funds yet. Recovery after an exit must
 * finish reconciling its receipts even when the original trigger has gone. */
export function assertEntryTrigger(args: {
  config: StrategyConfig
  plan: StrategyExecutionPlan
  snapshot: StrategyPositionSnapshot
  now: number
  average?: TriggerAverage
}) {
  const { config, plan, snapshot, now, average } = args
  if (plan.action === 'collect_fees' || plan.manualExecution || plan.triggerSide === 'manual') return
  if (!Number.isFinite(snapshot.observedAt) || snapshot.observedAt > now || now - snapshot.observedAt > config.safeguards.maxPlanAgeSeconds)
    throw new Error('E_TRIGGER_UNAVAILABLE')
  let tick = snapshot.tick
  if (plan.triggerSide !== 'adaptive_contraction' && config.trigger.source === 'sampled_twap') {
    const window = Math.max(60, config.trigger.confirmationSeconds, config.trigger.pollSeconds * 3)
    if (!average || average.count < 2 || !Number.isFinite(average.tick)
      || average.firstTs > now - window + config.trigger.pollSeconds * 2
      || average.lastTs < now - config.trigger.pollSeconds * 2 || average.lastTs > now)
      throw new Error('E_TRIGGER_UNAVAILABLE')
    tick = average.tick
  }
  if (!Number.isInteger(tick) || !Number.isInteger(snapshot.tickLower) || !Number.isInteger(snapshot.tickUpper)
    || snapshot.tickLower >= snapshot.tickUpper) throw new Error('E_TRIGGER_UNAVAILABLE')
  const expected = plan.triggerSide === 'adaptive_contraction' ? 'in' : plan.triggerSide
  if (rangeSide(tick, snapshot.tickLower, snapshot.tickUpper) !== expected) throw new Error('E_TRIGGER_CHANGED')
}
