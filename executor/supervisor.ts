import { executeRecovery } from './recovery-runner'
import { audit, clearRecoverySchedule, executorPaused, jobsForRecovery, recoveryAttemptReady, scheduleRecoveryRetry } from './store'
import { clearStrategyRetry, deferStrategyRetry } from './retry-state'
import { isTransientRecoveryFailure } from './recovery-policy'

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
    // Recover different signing wallets concurrently, but never queue several
    // jobs behind one wallet lock. This bounds the blast radius of a slow RPC,
    // quote, or receipt check to the wallet that owns that transaction stream.
    const selected = new Map<string, ReturnType<typeof jobsForRecovery>[number]>()
    for (const job of jobsForRecovery()) {
      if (job.state !== 'recovery' || !job.wallet_id || !recoveryAttemptReady(job.id)) continue
      if (!selected.has(job.wallet_id)) selected.set(job.wallet_id, job)
    }
    await Promise.allSettled([...selected.values()].map(async (job) => {
      try {
        const result = await executeRecovery(job.id)
        clearRecoverySchedule(job.id)
        if (result.disposition === 'restart_safe') {
          const delayMs = deferStrategyRetry(job.strategy_id)
          audit('supervisor', 'strategy_retry_scheduled', 'strategy', job.strategy_id, { jobId: job.id, delayMs })
        } else {
          clearStrategyRetry(job.strategy_id)
          audit('supervisor', 'strategy_auto_recovered', 'strategy', job.strategy_id, { jobId: job.id, disposition: result.disposition })
        }
      } catch (error) {
        const code = error instanceof Error ? error.message.slice(0, 120) : 'E_RECOVERY'
        const retry = scheduleRecoveryRetry(job.id, code, !isTransientRecoveryFailure(error))
        audit('supervisor', retry.quarantined ? 'strategy_recovery_quarantined' : 'strategy_recovery_retry_scheduled', 'strategy', job.strategy_id, {
          jobId: job.id, code, delayMs: retry.delayMs, attempts: retry.attempts, streak: retry.streak,
        })
      }
    }))
  } finally {
    running = false
  }
}
