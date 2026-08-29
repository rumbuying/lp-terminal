const attempts = new Map<string, number>()
const retryAt = new Map<string, number>()

/**
 * Keep unattended strategies alive without hammering RPC/quote services or
 * repeatedly constructing transactions during an outage. State is purposely
 * process-local: a restart is itself a reasonable opportunity for one fresh
 * attempt, while all nonce/transaction facts remain durable in SQLite.
 */
export function deferStrategyRetry(strategyId: string): number {
  const nextAttempt = (attempts.get(strategyId) ?? 0) + 1
  attempts.set(strategyId, nextAttempt)
  const delayMs = Math.min(5 * 60_000, 5_000 * (2 ** Math.min(nextAttempt - 1, 6)))
  retryAt.set(strategyId, Date.now() + delayMs)
  return delayMs
}

export function strategyRetryReady(strategyId: string): boolean {
  return Date.now() >= (retryAt.get(strategyId) ?? 0)
}

export function clearStrategyRetry(strategyId: string) {
  attempts.delete(strategyId)
  retryAt.delete(strategyId)
}
