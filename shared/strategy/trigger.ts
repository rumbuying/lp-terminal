import type { BoundaryPolicy, TriggerDecision } from './types'
import { rangeSide } from './range'
import { STRATEGY_ERROR } from './errors'

export function decideBoundaryTrigger(args: {
  tick: number
  tickLower: number
  tickUpper: number
  lower: BoundaryPolicy
  upper: BoundaryPolicy
  now: number
  outOfRangeSince?: number
  confirmationSeconds: number
  cooldownUntil?: number
  netAprPct?: number | null
  minNetAprPct?: number
}): TriggerDecision {
  const side = rangeSide(args.tick, args.tickLower, args.tickUpper)
  if (side === 'in') return { kind: 'none', reason: 'in_range' }
  if (args.cooldownUntil && args.now < args.cooldownUntil) return { kind: 'none', reason: 'cooldown' }
  const policy = side === 'lower' ? args.lower : args.upper
  if (policy.condition === 'manual_confirm') return { kind: 'pause', code: STRATEGY_ERROR.PLAN_STALE, detail: { reason: 'manual_confirm' } }
  if (args.confirmationSeconds > 0 && args.outOfRangeSince && args.now - args.outOfRangeSince < args.confirmationSeconds)
    return { kind: 'none', reason: 'confirming' }
  if (policy.condition === 'fee_break_even') {
    if (args.netAprPct === null || args.netAprPct === undefined)
      return { kind: 'pause', code: STRATEGY_ERROR.APR_UNAVAILABLE }
    if (args.minNetAprPct !== undefined && args.netAprPct < args.minNetAprPct)
      return { kind: 'none', reason: 'guard_not_met' }
  }
  if (policy.action === 'pause') return { kind: 'pause', code: STRATEGY_ERROR.PLAN_STALE, detail: { side } }
  return { kind: 'execute', side, action: policy.action, observedAt: args.now }
}
