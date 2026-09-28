import { parseUnits } from 'viem'

/** Reject limits that the quote token cannot represent before a live job starts. */
export function validateFablesDailyTurnover(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36)
    throw new Error('E_FABLES_QUOTE_DECIMALS')
  const amount = parseUnits(value, decimals)
  if (amount <= 0n) throw new Error('E_FABLES_DAILY_LIMIT')
  return amount
}

/**
 * Approvals carry a small pad above the planned amount. The swap amount is
 * re-planned on every retry while the market moves, and a raised amount used
 * to cost two more approvals (zero-reset plus the covering approve) each
 * time. With the pad, moves under 5% reuse the existing allowance.
 */
export const FABLES_APPROVAL_PAD_BPS = 500n

/**
 * Bound on confirmed approvals per job stage, counted before sending another
 * one so a stuck token or a routing loop cannot broadcast forever. The budget
 * has to cover the legitimate cases: a re-plan that raises the amount beyond
 * the pad (zero-reset plus approve) and a flip between the two reviewed
 * routers, each of which needs its own spender allowance. Three wedged a live
 * cycle in recovery after the position had already been exited
 * (production 2026-09-28), so eight now bounds the same failure mode with
 * headroom while keeping the loop finite.
 */
export const FABLES_APPROVAL_LIMIT = 8

/** Amount to approve for a planned spend: the exact need plus a 5% pad. */
export function fablesApprovalAmount(amount: bigint): bigint {
  if (amount <= 0n) throw new Error('E_FABLES_APPROVAL_AMOUNT')
  return amount + (amount * FABLES_APPROVAL_PAD_BPS + 9_999n) / 10_000n
}
