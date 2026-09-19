// tracked_inventory_reduced — the §5.2 inventory-release event (EMG-B01
// prerequisite). Per token: the tracked issuer-side actor set (genesis
// recipients + declared beneficiaries from the actor evidence) qualifies when
// its combined residual is ≤ 0.5% of the denominator continuously for 6h,
// with no single related source moving >0.1%/h out during the window.
//
// Honesty rules the PRD attaches to this event, all preserved here:
//  - it says "已标记主体减持完成", never "内幕供给消失" — unknown wallets are
//    invisible to it by construction;
//  - a re-cross above the threshold, or a large related-source outflow inside
//    the stable window, INVALIDATES the event; re-qualification starts a NEW
//    window (reductionStartedAt resets, reductionConfirmedAt moves);
//  - state lives in a kv snapshot per token (§5.2), transitions are pure and
//    unit-pinned.
import { EMERGING_THRESHOLDS as T } from './emergingPolicy'
import { kvGet, kvSet } from './store'

export type ReductionObservation = {
  ts: number
  /** Tracked-actor combined residual / denominator at ts. */
  residualShare: number
  /** Largest single related source's 1h outbound / denominator. */
  maxSourceHourOutflowShare: number
}

export type ReductionState = {
  startedAt: number | null
  confirmedAt: number | null
  invalidatedAt: number | null
  reason: string | null
}

export const emptyReduction = (): ReductionState => ({
  startedAt: null, confirmedAt: null, invalidatedAt: null, reason: null,
})

export const reductionKey = (token: string) => `emerging_reduction:${token.toLowerCase()}`
export const loadReduction = (token: string): ReductionState => {
  const raw = kvGet(reductionKey(token))
  if (!raw) return emptyReduction()
  try { return JSON.parse(raw) as ReductionState } catch { return emptyReduction() }
}
export const saveReduction = (token: string, state: ReductionState): void => {
  kvSet(reductionKey(token), JSON.stringify(state))
}

export type ReductionTransition = {
  state: ReductionState
  /** Events worth an audit line: 'started' | 'confirmed' | 'invalidated'. */
  event: 'started' | 'confirmed' | 'invalidated' | null
}

/**
 * One pure step. `qualified` = residual ≤ threshold AND outflow ≤ cap at ts.
 * The stable window must hold CONTINUOUSLY from startedAt: any disqualifying
 * observation before 6h elapses resets startedAt to null (a fresh start may
 * begin at this same ts if it qualifies again); after confirmation, the same
 * conditions INVALIDATE instead (§5.2: 余额重新抬升、未解释大额转出即失效).
 */
export function stepReduction(
  prev: ReductionState,
  obs: ReductionObservation,
): ReductionTransition {
  const qualified =
    obs.residualShare <= T.actorResidualMaxPct &&
    obs.maxSourceHourOutflowShare <= T.actorFlowMaxPctPerHour

  // Active window: started, not yet confirmed, not invalidated.
  if (prev.startedAt !== null && prev.confirmedAt === null) {
    if (obs.ts - prev.startedAt >= T.actorStableHours) {
      if (qualified) {
        return { state: { ...prev, confirmedAt: obs.ts }, event: 'confirmed' }
      }
      return {
        state: { startedAt: qualified ? obs.ts : null, confirmedAt: null, invalidatedAt: null, reason: 'window_broken_before_confirm' },
        event: null,
      }
    }
    if (!qualified)
      return { state: { startedAt: null, confirmedAt: null, invalidatedAt: null, reason: 'window_broken_before_confirm' }, event: null }
    return { state: prev, event: null }
  }

  // Confirmed state: qualify checks continue forever; a break invalidates.
  if (prev.confirmedAt !== null) {
    if (!qualified)
      return {
        state: { startedAt: null, confirmedAt: null, invalidatedAt: obs.ts, reason: 'residual_rerose_or_large_flow' },
        event: 'invalidated',
      }
    return { state: prev, event: null }
  }

  // No active window: qualify begins one.
  if (qualified)
    return { state: { startedAt: obs.ts, confirmedAt: null, invalidatedAt: prev.invalidatedAt, reason: null }, event: 'started' }
  return { state: prev, event: null }
}
