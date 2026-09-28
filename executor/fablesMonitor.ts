import { readFablesPosition } from '../src/lib/fables'
import { publicClient } from './chain'
import { EXECUTOR } from './config'
import { fablesMonitorState, listFablesStrategies, updateFablesMonitorState, type FablesMonitorState } from './fablesStore'
import { audit, executorPaused } from './store'
import { createFablesJob } from './fablesJobs'
import { evaluateFablesTrigger } from './fablesTrigger'

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
        if (decision.state === 'ready' && config.execution.mode === 'executor_auto' && !config.execution.dryRun) {
          try { createFablesJob(config) }
          catch (error) {
            if (error instanceof Error && error.message === 'E_FABLES_WALLET_BUSY') {
              updateFablesMonitorState(config.id, {
                ...decision.monitor, error: 'E_FABLES_WALLET_BUSY',
              }, 'dry_run_ready')
              continue
            }
            throw error
          }
        }
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
