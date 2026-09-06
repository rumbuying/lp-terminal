/**
 * Recovery swap escalation. A freshly re-quoted swap can still revert on chain
 * when the aggregator's quote is systematically optimistic for the routed pools
 * (thin meme pools, dynamic-fee hook pools): every retry re-quotes, every send
 * or pre-send gas estimate still misses `minOut`, and the job can either burn
 * gas forever or quarantine without trying a wider bound. Each consecutive
 * execution revert of the same swap therefore doubles the tolerated slippage,
 * bounded so a toxic token cannot drag an unbounded trade through. The
 * executor's plan-time impact guard (`maxSwapImpactBps` vs pool spot) still
 * applies independently.
 */
export const SWAP_RECOVERY_MAX_SLIPPAGE_BPS = 1_000

export function escalatedSlippageBps(baseBps: number, revertCount: number): number {
  const widened = baseBps * 2 ** Math.min(Math.max(revertCount, 0), 8)
  return Math.min(Math.max(baseBps, SWAP_RECOVERY_MAX_SLIPPAGE_BPS), widened)
}

/** True once further reverts can no longer widen the tolerance — the point
 * where reverting stops being an escalation ladder and becomes a stuck job
 * that should count toward quarantine. */
export function atSlippageCap(baseBps: number, revertCount: number): boolean {
  return escalatedSlippageBps(baseBps, revertCount) >= SWAP_RECOVERY_MAX_SLIPPAGE_BPS
}

/** A swap's estimateGas executes the same calldata without broadcasting it.
 * Treat a proven contract revert there exactly like a reverted receipt for the
 * bounded recovery ladder, while leaving transport/provider errors alone. */
export function isRecoverySwapRevert(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.message === 'E_TX_REVERTED') return true
  return /execution reverted|return amount is not enough/i.test(error.message)
}
