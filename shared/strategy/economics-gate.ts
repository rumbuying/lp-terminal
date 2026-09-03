/**
 * Per-cycle economics gate for boundary rebalances.
 *
 * A recenter that pays gas plus swap impact roughly equal to the fees being
 * rolled over is churn, not income. Before the monitor plans a recenter it
 * compares the collectable fees against the last completed cycle's realized
 * cost (gas + execution shortfall) and defers when the edge is too thin. Two
 * rules keep it from ever fighting position safety:
 *
 *  - it fails open: no cost history (first cycle) or an unavailable valuation
 *    always executes, because protection dominates economics;
 *  - it has an escape: once the position has stayed out of range for the
 *    configured hold, the gate executes regardless — an out-of-range position
 *    earns nothing and bears directional risk, so waiting must be bounded.
 *
 * The gate only ever defers the recenter; it never changes the plan itself.
 */
export type CycleEconomicsDecision =
  | { kind: 'execute' }
  | {
      kind: 'wait'
      /** Epoch second at which the escape fires and the recenter proceeds. */
      waitUntil: number
      feesQuoteRaw: bigint
      costQuoteRaw: bigint
    }

export function decideCycleEconomics(args: {
  now: number
  /** Wall-clock epoch second when the current out-of-range stretch began. */
  outSince?: number
  /** Collectable (uncollected) fees, already valued in the quote token. */
  collectableFeesQuoteRaw: bigint
  /** Realized cost of the last completed cycle: gas + execution shortfall, in quote units. */
  lastCycleCostQuoteRaw?: bigint | null
  /** Required coverage as a multiple of cost (e.g. 1 = fees must >= cost). 0/undefined disables the gate. */
  minCycleFeeCoverage?: number
  /** Seconds an out-of-range position may sit gated before the escape executes anyway. */
  economicsHoldSeconds: number
}): CycleEconomicsDecision {
  const coverage = args.minCycleFeeCoverage
  if (!coverage || coverage <= 0) return { kind: 'execute' }
  const cost = args.lastCycleCostQuoteRaw
  if (cost === null || cost === undefined || cost <= 0n) return { kind: 'execute' }
  if (args.collectableFeesQuoteRaw < 0n) return { kind: 'execute' }
  // Ceil first so fractional coverage never rounds the requirement down.
  const required = (cost * BigInt(Math.ceil(coverage * 1_000_000))) / 1_000_000n
  if (args.collectableFeesQuoteRaw >= required) return { kind: 'execute' }
  const waitUntil = (args.outSince ?? args.now) + Math.max(0, Math.floor(args.economicsHoldSeconds))
  if (waitUntil <= args.now) return { kind: 'execute' }
  return { kind: 'wait', waitUntil, feesQuoteRaw: args.collectableFeesQuoteRaw, costQuoteRaw: cost }
}
