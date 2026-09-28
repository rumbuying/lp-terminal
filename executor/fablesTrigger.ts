import { rangeSide } from '../shared/strategy/range'
import type { FablesStrategyConfig } from '../shared/strategy/types'
import type { FablesMonitorState } from './fablesStore'

export type FablesTriggerEvaluation = {
  state: 'monitoring' | 'confirming' | 'ready' | 'paused'
  monitor: FablesMonitorState
}

/** Only current tick and persistent elapsed time determine the boundary trigger. */
export function evaluateFablesTrigger(args: {
  config: FablesStrategyConfig
  prior?: FablesMonitorState
  tick: number
  blockNumber: bigint
  now: number
  claimPaused: boolean
}): FablesTriggerEvaluation {
  const { config, prior, tick, blockNumber, now } = args
  const side = rangeSide(tick, config.positionRef.tickLower, config.positionRef.tickUpper)
  const base: FablesMonitorState = {
    revision: config.revision, lastTick: tick, lastBlock: blockNumber.toString(),
    cooldownUntil: prior?.revision === config.revision ? prior.cooldownUntil : undefined,
  }
  if (args.claimPaused) return { state: 'paused', monitor: { ...base, error: 'E_FABLES_CLAIM_PAUSED' } }
  if (side === 'in') return { state: 'monitoring', monitor: base }
  const outSince = prior?.revision === config.revision && prior.outSide === side && prior.outSince !== undefined
    ? prior.outSince : now
  const monitor: FablesMonitorState = { ...base, outSide: side, outSince }
  if (now < (base.cooldownUntil ?? 0) || now - outSince < config.trigger.confirmationSeconds)
    return { state: 'confirming', monitor }
  return { state: 'ready', monitor }
}
