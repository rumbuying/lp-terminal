import { executeRecovery } from './recovery-runner'
import { audit, executorPaused, jobsForRecovery } from './store'
import { clearStrategyRetry, deferStrategyRetry, strategyRetryReady } from './retry-state'

let running = false

/**
 * Recovery is an executor responsibility, not an operator workflow. Pending
 * or ambiguous transactions are never resent blindly: executeRecovery first
 * re-inspects their durable hash/nonce facts and only signs when its recovery
 * policy proves the next step safe.
 */
export async function superviseOnce() {
  if (running || executorPaused()) return
  running = true
  try {
    for (const job of jobsForRecovery()) {
      if (job.state !== 'recovery' || !strategyRetryReady(job.strategy_id)) continue
      try {
        const result = await executeRecovery(job.id)
        if (result.disposition === 'restart_safe') {
          const delayMs = deferStrategyRetry(job.strategy_id)
          audit('supervisor', 'strategy_retry_scheduled', 'strategy', job.strategy_id, { jobId: job.id, delayMs })
        } else {
          clearStrategyRetry(job.strategy_id)
          audit('supervisor', 'strategy_auto_recovered', 'strategy', job.strategy_id, { jobId: job.id, disposition: result.disposition })
        }
      } catch (error) {
        const code = error instanceof Error ? error.message.slice(0, 120) : 'E_RECOVERY'
        const delayMs = deferStrategyRetry(job.strategy_id)
        audit('supervisor', 'strategy_recovery_retry_scheduled', 'strategy', job.strategy_id, { jobId: job.id, code, delayMs })
      }
    }
  } finally {
    running = false
  }
}
