import { rangeSide } from '../shared/strategy/range'
import type { FablesStrategyConfig } from '../shared/strategy/types'
import { readFablesPosition } from '../src/lib/fables'
import { publicClient } from './chain'
import { EXECUTOR } from './config'
import { fablesMonitorState, listFablesStrategies, updateFablesMonitorState, type FablesMonitorState } from './fablesStore'
import { audit, executorPaused } from './store'
import { createFablesJob } from './fablesJobs'

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

let running = false
const nextAt = new Map<string, number>()

/** Read-only Fables monitor; live signing remains behind the separate execution gate. */
export async function monitorFablesOnce(options: { ignoreSchedule?: boolean } = {}): Promise<void> {
  if (running || EXECUTOR.chainId !== 4663 || executorPaused()) return
  running = true
  try {
    const nowMs = Date.now()
    for (const { config, state: previousState } of listFablesStrategies().filter(row =>
      row.config.enabled && ['monitoring','confirming','paused','read_error','awaiting_manual','dry_run_ready'].includes(row.state))) {
      if (!options.ignoreSchedule && nowMs < (nextAt.get(config.id) ?? 0)) continue
      nextAt.set(config.id, nowMs + Math.max(config.trigger.pollSeconds, EXECUTOR.monitorMinSeconds) * 1000)
      try {
        const position = await readFablesPosition(publicClient, {
          owner: config.owner, hook: config.positionRef.hook, rangeId: BigInt(config.positionRef.rangeId),
        })
        if (position.pool.id.toLowerCase() !== config.positionRef.poolId.toLowerCase()
          || position.tickLower !== config.positionRef.tickLower
          || position.tickUpper !== config.positionRef.tickUpper
          || position.shares === 0n || position.staked !== 0n)
          throw new Error('E_FABLES_POSITION_CHANGED')
        const decision = evaluateFablesTrigger({ config, prior: fablesMonitorState(config.id),
          tick: position.tick, blockNumber: position.observedBlock,
          now: Math.floor(nowMs / 1000), claimPaused: position.claimPaused })
        const strategyState = decision.state === 'ready'
          ? (config.execution.mode === 'notify_only' ? 'awaiting_manual' : 'dry_run_ready')
          : decision.state
        updateFablesMonitorState(config.id, decision.monitor, strategyState)
        if (decision.state === 'ready' && previousState !== strategyState) audit('fables_monitor', 'boundary_confirmed', 'strategy', config.id, {
          side: decision.monitor.outSide, tick: position.tick, blockNumber: position.observedBlock.toString(),
        })
        if (decision.state === 'ready' && config.execution.mode === 'executor_auto' && !config.execution.dryRun)
          createFablesJob(config)
      } catch (error) {
        const code = error instanceof Error ? error.message.slice(0, 160) : 'E_FABLES_READ'
        // A failed read breaks the consecutive confirmation interval.
        updateFablesMonitorState(config.id, { revision: config.revision, error: code }, 'read_error')
        audit('fables_monitor', 'read_error', 'strategy', config.id, { code })
      }
    }
  } finally {
    running = false
  }
}
