import { isTransientRpcFailure } from './rpc-retry'

/** Errors that should keep retrying because external state can recover by itself. */
export function isTransientRecoveryFailure(error: unknown): boolean {
  const code = error instanceof Error ? error.message : String(error)
  return code === 'E_RECOVERY_PENDING'
    || code === 'E_KYBER_QUOTE'
    || code === 'E_KYBER_BUILD'
    || code === 'E_NATIVE_QUOTE'
    || code === 'E_SOLVER_QUOTE'
    || code === 'E_EXECUTOR_PAUSED'
    || isTransientRpcFailure(error)
}
