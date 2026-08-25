import type { Address } from 'viem'
import { STRATEGY_ERROR, StrategyError } from './errors'
import type { LedgerEntry } from './types'

const amount = (v: string, name: string) => {
  try {
    const parsed = BigInt(v)
    if (parsed < 0n) throw new Error('negative')
    return parsed
  } catch {
    throw new StrategyError(STRATEGY_ERROR.CONFIG, `${name} must be an unsigned integer string`)
  }
}

/** Reconstruct gross fees from actual net receipts and a known withheld levy rate. */
export function estimateUnstakedLevy(netFee: bigint, levyPpm: number): { grossFee: bigint; levy: bigint } {
  if (!Number.isInteger(levyPpm) || levyPpm < 0 || levyPpm >= 1_000_000)
    throw new StrategyError(STRATEGY_ERROR.CONFIG, 'invalid levy ppm')
  if (netFee === 0n || levyPpm === 0) return { grossFee: netFee, levy: 0n }
  const denominator = 1_000_000n - BigInt(levyPpm)
  const grossFee = (netFee * 1_000_000n + denominator - 1n) / denominator
  return { grossFee, levy: grossFee - netFee }
}

/**
 * Value an executed swap against the best price fact we actually persisted.
 *
 * `spotOut` captures pool fee + size impact versus the source LP's pre-swap
 * mid. Aggregated routes can legitimately quote better than that one pool, so
 * `quotedOut` is also a real, executable baseline. Using only `spotOut` made a
 * quote-to-fill shortfall disappear whenever the router beat the source pool;
 * use the better baseline without adding the two shortfalls twice.
 */
export function executionShortfall(args: {
  spotOut: bigint
  quotedOut?: bigint
  actualOut: bigint
}): { amountOut: bigint; impactBps: number | null } {
  if (args.spotOut < 0n || args.actualOut < 0n || (args.quotedOut !== undefined && args.quotedOut < 0n))
    throw new StrategyError(STRATEGY_ERROR.CONFIG, 'swap accounting amounts must be unsigned')
  const quoted = args.quotedOut ?? 0n
  const baselineOut = quoted > args.spotOut ? quoted : args.spotOut
  if (baselineOut === 0n || args.actualOut >= baselineOut) return { amountOut: 0n, impactBps: null }
  const amountOut = baselineOut - args.actualOut
  // Return bps with 0.01-bp precision so small but real quote slippage is not
  // rounded to an indistinguishable integer zero.
  const impactBps = Number((amountOut * 1_000_000n) / baselineOut) / 100
  return { amountOut, impactBps }
}

/** Allocate a quoted total across native-cost rows without losing rounding dust. */
export function allocateProRata(total: bigint, weights: bigint[]): bigint[] {
  if (total < 0n || weights.some((weight) => weight < 0n))
    throw new StrategyError(STRATEGY_ERROR.CONFIG, 'pro-rata accounting amounts must be unsigned')
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0n)
  if (weightTotal === 0n) {
    if (total !== 0n) throw new StrategyError(STRATEGY_ERROR.CONFIG, 'non-zero total requires a pro-rata basis')
    return weights.map(() => 0n)
  }
  let remainingTotal = total
  let remainingWeight = weightTotal
  let weightedRows = weights.filter((weight) => weight > 0n).length
  return weights.map((weight) => {
    if (weight === 0n) return 0n
    weightedRows -= 1
    const allocated = weightedRows === 0 ? remainingTotal : (remainingTotal * weight) / remainingWeight
    remainingTotal -= allocated
    remainingWeight -= weight
    return allocated
  })
}

/** A distribution changes custody, not lifetime performance. */
export function distributionAdjustedPnl(args: {
  currentValue: bigint
  withdrawnValue: bigint
  baselineValue: bigint
  gasCost: bigint
}) {
  return args.currentValue + args.withdrawnValue - args.baselineValue - args.gasCost
}

/** Record USDG retained directly from collected income as an explicit tax fact. */
export function incomeTaxRetentionEntry(args: {
  id: string
  strategyId: string
  cycleId?: string
  jobId: string
  ts: number
  token: Address
  amount: bigint
  txHash?: string
  blockNumber?: string
}): LedgerEntry | undefined {
  if (args.amount < 0n) throw new StrategyError(STRATEGY_ERROR.CONFIG, 'income tax must be unsigned')
  if (args.amount === 0n) return undefined
  return {
    id: args.id,
    strategyId: args.strategyId,
    cycleId: args.cycleId,
    jobId: args.jobId,
    ts: args.ts,
    blockNumber: args.blockNumber,
    txHash: args.txHash,
    kind: 'income_tax',
    token: args.token,
    amount: args.amount.toString(),
    meta: { purpose: 'fee_tax', source: 'direct_retention' },
  }
}

/**
 * Split a collect receipt without guessing: principal is the decrease event;
 * any extra collected amount is fee. A negative difference is unsafe and is
 * treated as an unsupported token/receipt mismatch.
 */
export function attributeCollect(args: {
  strategyId: string
  cycleId?: string
  ts: number
  token0: Address
  token1: Address
  principal0: string
  principal1: string
  collected0: string
  collected1: string
  unstakedLevyPpm?: number
  txHash?: string
  blockNumber?: string
}): LedgerEntry[] {
  const p0 = amount(args.principal0, 'principal0')
  const p1 = amount(args.principal1, 'principal1')
  const c0 = amount(args.collected0, 'collected0')
  const c1 = amount(args.collected1, 'collected1')
  if (c0 < p0 || c1 < p1)
    throw new StrategyError(STRATEGY_ERROR.POSITION_CHANGED, 'collect receipt is less than principal decrease')
  const base = { strategyId: args.strategyId, cycleId: args.cycleId, ts: args.ts, txHash: args.txHash, blockNumber: args.blockNumber }
  const entries: LedgerEntry[] = []
  const add = (kind: LedgerEntry['kind'], token: Address, raw: bigint, estimated = false) => {
    if (raw > 0n) entries.push({ ...base, id: `${kind}-${token.toLowerCase()}-${entries.length}`, kind, token, amount: raw.toString(), estimated })
  }
  add('principal_exit', args.token0, p0)
  add('principal_exit', args.token1, p1)
  const levyPpm = args.unstakedLevyPpm ?? 0
  for (const [token, net] of [[args.token0, c0 - p0], [args.token1, c1 - p1]] as const) {
    const { grossFee, levy } = estimateUnstakedLevy(net, levyPpm)
    add('fee_gross', token, grossFee, levy > 0n)
    add('protocol_fee', token, levy, true)
  }
  return entries
}
