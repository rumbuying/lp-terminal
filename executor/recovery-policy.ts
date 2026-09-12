import { isTransientRpcFailure } from './rpc-retry'

/**
 * Errors that should keep retrying because external state can recover by itself.
 *
 * `E_SWAP_IMPACT` belongs here: every throw site (recovery planning at
 * recovery-runner's hold-quote/from-wallet/fee-collection swap plans,
 * prepareFinalSwap's quote bounds) fires BEFORE any transaction of that swap is
 * broadcast, so a retry costs two read-only quote calls and no gas. The guard
 * compares the aggregator's quote with this pool's own spot price, which is a
 * market condition that can normalize between attempts — the live CASHCAT
 * recovery of 2026-09-11 quarantined exactly this way: two on-chain reverts
 * climbed the slippage ladder, then the re-quoted plan crossed the impact
 * guard and the third strike shut the strategy while its funds sat safely in
 * the wallet. The normal runner already treats the same code as `guard_wait`
 * (runner.ts) instead of a failure that pages an operator.
 */
export function isTransientRecoveryFailure(error: unknown): boolean {
  const code = error instanceof Error ? error.message : String(error)
  return code === 'E_RECOVERY_PENDING'
    || code === 'E_KYBER_QUOTE'
    || code === 'E_KYBER_BUILD'
    || code === 'E_NATIVE_QUOTE'
    || code === 'E_SOLVER_QUOTE'
    || code === 'E_EXECUTOR_PAUSED'
    || code === 'E_SWAP_IMPACT'
    || isTransientRpcFailure(error)
}
