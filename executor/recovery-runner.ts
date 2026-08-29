import { formatUnits, parseUnits, zeroAddress, type Address, type TransactionReceipt } from 'viem'
import { attributeCollect, incomeTaxRetentionEntry } from '../shared/strategy/accounting'
import type { LedgerEntry, StrategyPositionSnapshot } from '../shared/strategy/types'
import { clPmAbi } from '../src/abi'
import { ADDR, NATIVE, UNI, requireGov } from '../src/config/addresses'
import { strategyPerformance } from './performance'
import { recordPerformanceDay } from './calendar'
import { applySlippage } from '../src/lib/clmath'
import { grantStrategyAllowance, revokeStrategyAllowance } from './allowance'
import { publicClient, readPoolState, readStrategySnapshot, readTokenBalances } from './chain'
import { EXECUTOR } from './config'
import { gatedKyberTx, quoteKyber, routeAudit } from './kyber'
import { automaticDailyTurnoverLimit } from './limits'
import { preflightStrategy } from './preflight'
import { allocateSwapExecution, allocateSwapOutput, planCycleSwaps, type CycleFunds, type SwapIntent } from './rebalance'
import { FEE_TAX_SELECTION_VERSION, planFeeTax, type FeeTaxPlan } from './fee-tax'
import { inspectRecovery } from './recovery'
import { receiptLiquidityFlows, receiptTokenDelta } from './receipts'
import { freshRange, quoteTurnover, riskAssetPct, swapImpactBps } from './risk'
import { sendTracked } from './signer'
import { burnCall, collectCall, decreaseCall, decreaseCollectCall, mintCall, v4CollectCall } from './steps'
import {
  activeJobForStrategy,
  abandonRecoveryJob,
  archiveStrategy,
  assertWalletAllocationUpdate,
  audit,
  commitHoldQuote,
  commitFeeCollection,
  commitRebalance,
  getJobContext,
  jobSteps,
  jobTransactions,
  dailyTurnoverUsed,
  nextTransactionIndex,
  markStep,
  recoveryJobById,
  replaceRecoveryStrategyConfig,
  reserveDailyTurnover,
  setJobContext,
  setJobState,
  setStrategyState,
  strategyById,
  strategyAllocations,
  walletAllocationTokens,
  type RunnableJob,
} from './store'
import { unlockPrivateKey } from './vault'
import { withWalletLock } from './wallet-lock'
import { recoverRetainedProfit } from './profit-withdrawal'
import { ensureRestaked, ensureUnstakedAndRewardConverted, type StakingRewardContext } from './staking'
import { strategyCapitalHarvest } from './capital-policy'

const low = (value: string) => value.toLowerCase()
const SETTLEMENT = EXECUTOR.network.settlementToken
const WRAPPED_NATIVE = EXECUTOR.network.wrappedNative
const isNativeCurrency = (token: Address) => token.toLowerCase() === zeroAddress
const routeCurrency = (token: Address) => isNativeCurrency(token) ? NATIVE : token
const receiptGas = (receipt: TransactionReceipt) => receipt.gasUsed * receipt.effectiveGasPrice
const receivedByWallet = (before: bigint, after: bigint, receipt: TransactionReceipt, token: Address) =>
  after - before + (isNativeCurrency(token) ? receiptGas(receipt) : 0n)
const spentByWallet = (before: bigint, after: bigint, receipt: TransactionReceipt, token: Address) =>
  before - after - (isNativeCurrency(token) ? receiptGas(receipt) : 0n)
type PrecheckContext = {
  baseline: Record<string, string>
  prior: Record<string, string>
  priorPrincipal?: Record<string, string>
  priorHeld?: Record<string, string>
  priorProfit?: Record<string, string>
  trackedTokens: Address[]
}
type SwapPlanRecord = { txIndex: number; purpose?: 'strategy' | 'fee_tax'; tokenIn: Address; tokenOut: Address; amountIn: string; quotedOut: string; minOut?: string; principalIn: string; feeIn: string; route?: unknown }
type SwapPlanContext = { swaps: SwapPlanRecord[]; tick?: number; sqrtPriceX96?: string; tickLower?: number; tickUpper?: number }
type ExecutedSwap = { intent: SwapIntent; spent: bigint; gained: bigint; receipt: TransactionReceipt }
type ExecutedSwapAudit = { txHash?: string; tokenIn: Address; tokenOut: Address; purpose?: 'strategy' | 'fee_tax'; amountIn: string; quotedOut: string; principalIn: string; feeIn: string; spent: string; gained: string; route?: { amountOut?: string; minOut?: string } }
type FeeTaxContext = { selectionVersion?: number; applied: boolean; totalFeeUsdg: string; totalIncomeUsdg?: string; tax0: string; tax1: string; rewardTax?: string; retainedUsdg: string }
type CapitalAllocationContext = {
  triggered: boolean
  deploy0: string; deploy1: string; profit0: string; profit1: string
  activeValueQuote: string; capitalCapQuote: string; excessValueQuote: string; excessValueUsdg: string
}

function priorComponents(context: PrecheckContext) {
  const total = Object.fromEntries(Object.entries(context.prior).map(([token, amount]) => [low(token), BigInt(amount)]))
  const principal = Object.fromEntries(Object.entries(context.priorPrincipal ?? {}).map(([token, amount]) => [low(token), BigInt(amount)]))
  const held = Object.fromEntries(Object.entries(context.priorHeld ?? {}).map(([token, amount]) => [low(token), BigInt(amount)]))
  const profit = Object.fromEntries(Object.entries(context.priorProfit ?? {}).map(([token, amount]) => [low(token), BigInt(amount)]))
  // Old jobs did not record component provenance. Treat their idle balances as
  // held so recovery cannot unexpectedly spend them.
  for (const [token, amount] of Object.entries(total)) if (!(token in principal) && !(token in held) && !(token in profit)) held[token] = amount
  return { total, principal, held, profit }
}

function stakingReward(job: RunnableJob) {
  const value = getJobContext<Partial<StakingRewardContext>>(job.id, 'staking_reward')
  const rewardWeth = BigInt(value?.rewardWeth ?? '0')
  const quotedWeth = BigInt(value?.quotedWeth ?? '0')
  const settlesInWeth = low(job.config.quoteToken) === low(WRAPPED_NATIVE)
  return {
    rewardUp: BigInt(value?.rewardUp ?? '0'),
    rewardWeth,
    rewardQuote: BigInt(value?.rewardQuote ?? (settlesInWeth ? rewardWeth : 0n)),
    quotedWeth,
    quotedQuote: BigInt(value?.quotedQuote ?? (settlesInWeth ? quotedWeth : 0n)),
    withdrawTxHash: value?.withdrawTxHash,
    swapTxHash: value?.swapTxHash,
    quoteSwapTxHash: value?.quoteSwapTxHash,
  }
}

function stakingRewardAfterTax(job: RunnableJob): bigint {
  const reward = stakingReward(job).rewardQuote
  const tax = getJobContext<FeeTaxContext>(job.id, 'fee_tax')
  const rewardTax = BigInt(tax?.rewardTax ?? '0')
  if (rewardTax < 0n || rewardTax > reward) throw new Error('E_RECOVERY_CONTEXT')
  return reward - rewardTax
}

const walletCustodyConfig = (job: RunnableJob) => job.config.staking?.enabled ? { ...job.config, staking: { enabled: false } as const } : job.config

function stakingRewardLedger(job: RunnableJob, now: number): LedgerEntry[] {
  if (!job.config.staking?.enabled) return []
  const reward = stakingReward(job)
  const common = { strategyId: job.config.id, cycleId: `cycle-${job.id}`, jobId: job.id, ts: now }
  const hasQuoteHop = low(job.config.quoteToken) !== low(WRAPPED_NATIVE)
  const entries: LedgerEntry[] = [{ ...common, id: `${job.id}-staking-reward`, kind: 'staking_reward', token: requireGov().UP, amount: reward.rewardUp.toString(), txHash: reward.withdrawTxHash as `0x${string}` | undefined, meta: { convertedToWeth: reward.rewardWeth.toString(), convertedToQuote: reward.rewardQuote.toString(), quoteToken: job.config.quoteToken } }]
  if (reward.rewardUp > 0n) entries.push(
    { ...common, id: `${job.id}-reward-swap-in`, kind: 'swap_in', token: requireGov().UP, amount: reward.rewardUp.toString(), txHash: reward.swapTxHash as `0x${string}` | undefined, meta: { source: 'staking_reward' } },
    { ...common, id: `${job.id}-reward-swap-out`, kind: 'swap_out', token: WRAPPED_NATIVE, amount: reward.rewardWeth.toString(), txHash: reward.swapTxHash as `0x${string}` | undefined, meta: { source: 'staking_reward', rewardFinal: !hasQuoteHop, quotedOut: reward.quotedWeth.toString() } },
  )
  if (hasQuoteHop && reward.rewardWeth > 0n) entries.push(
    { ...common, id: `${job.id}-reward-quote-swap-in`, kind: 'swap_in', token: WRAPPED_NATIVE, amount: reward.rewardWeth.toString(), txHash: reward.quoteSwapTxHash as `0x${string}` | undefined, meta: { source: 'staking_reward' } },
    { ...common, id: `${job.id}-reward-quote-swap-out`, kind: 'swap_out', token: job.config.quoteToken, amount: reward.rewardQuote.toString(), txHash: reward.quoteSwapTxHash as `0x${string}` | undefined, meta: { source: 'staking_reward', rewardFinal: true, quotedOut: reward.quotedQuote.toString() } },
  )
  return entries
}

const stakingRewardTurnover = (job: RunnableJob) => {
  const reward = stakingReward(job).rewardQuote
  return reward * (low(job.config.quoteToken) === low(WRAPPED_NATIVE) ? 1n : 2n)
}

function latestSwapRecord(records: readonly SwapPlanRecord[] | undefined, txIndex: number): SwapPlanRecord | undefined {
  if (!records) return undefined
  for (let index = records.length - 1; index >= 0; index -= 1)
    if (records[index].txIndex === txIndex) return records[index]
  return undefined
}

function upsertSwapRecords(existing: readonly SwapPlanRecord[], replacements: readonly SwapPlanRecord[]): SwapPlanRecord[] {
  const byIndex = new Map(existing.map((record) => [record.txIndex, record]))
  for (const record of replacements) byIndex.set(record.txIndex, record)
  return [...byIndex.values()].sort((a, b) => a.txIndex - b.txIndex)
}

function applyStoredFeeTax(jobId: string, funds: CycleFunds): CycleFunds {
  const tax = getJobContext<FeeTaxContext>(jobId, 'fee_tax')
  if (!tax) return funds
  const tax0 = BigInt(tax.tax0)
  const tax1 = BigInt(tax.tax1)
  if (tax0 < 0n || tax1 < 0n || tax0 > funds.fee0 || tax1 > funds.fee1) throw new Error('E_RECOVERY_CONTEXT')
  return { ...funds, fee0: funds.fee0 - tax0, fee1: funds.fee1 - tax1 }
}

async function ensureFeeTaxPlan(job: RunnableJob, funds: CycleFunds): Promise<FeeTaxPlan> {
  const snapshot = job.plan.snapshot
  const reward = stakingReward(job)
  const stored = getJobContext<FeeTaxContext>(job.id, 'fee_tax')
  const confirmedSwapExists = jobTransactions(job.id).some((row) => Number(row.step_index) === 5 && row.state === 'confirmed')
  if (!stored || (stored.selectionVersion !== FEE_TAX_SELECTION_VERSION && !confirmedSwapExists)) {
    const planned = await planFeeTax({
      token0: snapshot.token0,
      token1: snapshot.token1,
      fee0: funds.fee0,
      fee1: funds.fee1,
      rewardToken: job.config.quoteToken,
      rewardAmount: reward.rewardQuote,
      quote: async (tokenIn, tokenOut, amountIn) => {
        const route = await quoteKyber(tokenIn, tokenOut, amountIn)
        return { amountOut: BigInt(route.routeSummary.amountOut), routeSummary: route.routeSummary }
      },
    })
    setJobContext(job.id, 'fee_tax', {
      selectionVersion: FEE_TAX_SELECTION_VERSION,
      applied: planned.applied,
      totalFeeUsdg: planned.totalFeeUsdg.toString(),
      totalIncomeUsdg: planned.totalIncomeUsdg.toString(),
      tax0: planned.tax0.toString(),
      tax1: planned.tax1.toString(),
      rewardTax: planned.rewardTax.toString(),
      retainedUsdg: planned.retainedUsdg.toString(),
    })
    if (stored) audit('recovery', 'fee_tax_source_replanned', 'job', job.id, {
      previousTax0: stored.tax0,
      previousTax1: stored.tax1,
      previousRewardTax: stored.rewardTax ?? '0',
      nextTax0: planned.tax0.toString(),
      nextTax1: planned.tax1.toString(),
      nextRewardTax: planned.rewardTax.toString(),
      selectionVersion: FEE_TAX_SELECTION_VERSION,
    })
    return planned
  }

  const tax0 = BigInt(stored.tax0)
  const tax1 = BigInt(stored.tax1)
  const rewardTax = BigInt(stored.rewardTax ?? '0')
  if (tax0 > funds.fee0 || tax1 > funds.fee1 || rewardTax > reward.rewardQuote) throw new Error('E_RECOVERY_CONTEXT')
  const swaps: SwapIntent[] = []
  for (const [token, amount] of [[snapshot.token0, tax0], [snapshot.token1, tax1], [job.config.quoteToken, rewardTax]] as const) {
    if (amount === 0n || low(token) === low(SETTLEMENT)) continue
    const quote = await quoteKyber(token, SETTLEMENT, amount)
    swaps.push({ purpose: 'fee_tax', tokenIn: token, tokenOut: SETTLEMENT, amountIn: amount, quotedOut: BigInt(quote.routeSummary.amountOut), routeSummary: quote.routeSummary, principalIn: 0n, feeIn: amount })
  }
  return {
    applied: stored.applied,
    totalIncomeUsdg: BigInt(stored.totalIncomeUsdg ?? stored.totalFeeUsdg),
    totalFeeUsdg: BigInt(stored.totalFeeUsdg),
    tax0,
    tax1,
    rewardTax,
    fee0AfterTax: funds.fee0 - tax0,
    fee1AfterTax: funds.fee1 - tax1,
    rewardAfterTax: reward.rewardQuote - rewardTax,
    retainedUsdg: BigInt(stored.retainedUsdg),
    swaps,
  }
}

async function normalizeWethQuoteBeforeRecovery(job: RunnableJob, disposition: string): Promise<RunnableJob> {
  if (disposition !== 'resume_from_wallet' || job.plan.action !== 'recenter' || low(job.config.quoteToken) === low(WRAPPED_NATIVE)) return job
  const tokens = [job.plan.snapshot.token0, job.plan.snapshot.token1]
  if (!tokens.some((token) => low(token) === low(WRAPPED_NATIVE))) return job
  if (jobTransactions(job.id).some((row) => Number(row.step_index) >= 4 && row.state === 'confirmed')) throw new Error('E_RECOVERY_CONTEXT')

  const records = await confirmedReceipts(job.id)
  const funds = contextFunds(job.id, records, job.plan.snapshot)
  const riskToken = tokens.find((token) => low(token) !== low(WRAPPED_NATIVE))!
  const now = Math.floor(Date.now() / 1000)
  const corrected = {
    ...job.config,
    riskToken,
    quoteToken: WRAPPED_NATIVE,
    revision: job.config.revision + 1,
    updatedAt: now,
  }
  const pool = await readPoolState(corrected)
  const snapshot = job.plan.snapshot
  const positionValue =
    quoteTurnover(funds.principal0 + funds.fee0, snapshot.token0, corrected, snapshot, pool.sqrtPriceX96) +
    quoteTurnover(funds.principal1 + funds.fee1, snapshot.token1, corrected, snapshot, pool.sqrtPriceX96)
  const used = dailyTurnoverUsed(job.walletId, WRAPPED_NATIVE, now, job.config.id)
  corrected.execution = {
    ...corrected.execution,
    maxDailyTurnoverQuote: formatUnits(used + (positionValue > 0n ? positionValue * 5n : 1n), 18),
  }
  replaceRecoveryStrategyConfig(job.id, corrected)
  const repaired = recoveryJobById(job.id)
  if (!repaired) throw new Error('E_RECOVERY_JOB')
  return repaired
}

async function refreshAutomaticDailyLimit(job: RunnableJob): Promise<RunnableJob> {
  const hitDailyLimit = jobSteps(job.id).some((step) => step.error_code === 'E_DAILY_LIMIT')
  if (!hitDailyLimit || job.config.sourcePreset !== 'original') return job
  // Inspect the current position with a read-only ceiling that cannot itself
  // reproduce the legacy limit failure we are trying to migrate.
  const checked = await preflightStrategy({
    ...job.config,
    execution: { ...job.config.execution, maxDailyTurnoverQuote: '1000000000000000000000000000000000000' },
  })
  const limit = automaticDailyTurnoverLimit(
    job.config,
    BigInt(checked.expected.positionValueQuoteRaw),
    BigInt(checked.expected.projectedTurnoverWithHeadroomQuoteRaw),
  )
  const current = parseUnits(job.config.execution.maxDailyTurnoverQuote!, checked.expected.quoteDecimals)
  if (limit <= current) return job
  const now = Math.floor(Date.now() / 1000)
  const corrected = {
    ...job.config,
    execution: { ...job.config.execution, maxDailyTurnoverQuote: formatUnits(limit, checked.expected.quoteDecimals) },
    revision: job.config.revision + 1,
    updatedAt: now,
  }
  replaceRecoveryStrategyConfig(job.id, corrected)
  audit('recovery', 'automatic_daily_limit_refreshed', 'job', job.id, {
    previous: job.config.execution.maxDailyTurnoverQuote,
    next: corrected.execution.maxDailyTurnoverQuote,
  })
  const repaired = recoveryJobById(job.id)
  if (!repaired) throw new Error('E_RECOVERY_JOB')
  return repaired
}

async function confirmedReceipts(jobId: string): Promise<{ stepIndex: number; txIndex: number; receipt: TransactionReceipt }[]> {
  const rows = jobTransactions(jobId)
    .filter((row) => row.state === 'confirmed' && typeof row.tx_hash === 'string')
    .sort((a, b) => Number(a.step_index) - Number(b.step_index) || Number(a.tx_index) - Number(b.tx_index))
  const result = []
  for (const row of rows) {
    const receipt = await publicClient.getTransactionReceipt({ hash: row.tx_hash as `0x${string}` })
    if (receipt.status !== 'success') throw new Error('E_TX_REVERTED')
    result.push({ stepIndex: Number(row.step_index), txIndex: Number(row.tx_index), receipt })
  }
  return result
}

function contextFunds(jobId: string, receipts: { stepIndex: number; receipt: TransactionReceipt }[], snapshot: StrategyPositionSnapshot): CycleFunds {
  const stored = getJobContext<Record<keyof CycleFunds, string>>(jobId, 'funds')
  if (stored) return { principal0: BigInt(stored.principal0), principal1: BigInt(stored.principal1), fee0: BigInt(stored.fee0), fee1: BigInt(stored.fee1) }
  const decrease = receipts.find((row) => row.stepIndex === 1)?.receipt
  const collect = receipts.find((row) => row.stepIndex === 2)?.receipt ?? decrease
  if (!decrease || !collect) throw new Error('E_RECOVERY_CONTEXT')
  const decreased = receiptLiquidityFlows(decrease, snapshot.positionManager, BigInt(snapshot.tokenId))
  const collected = receiptLiquidityFlows(collect, snapshot.positionManager, BigInt(snapshot.tokenId))
  if (collected.collected0 < decreased.principal0 || collected.collected1 < decreased.principal1) throw new Error('E_UNSUPPORTED_TOKEN')
  const funds = {
    principal0: decreased.principal0,
    principal1: decreased.principal1,
    fee0: collected.collected0 - decreased.principal0,
    fee1: collected.collected1 - decreased.principal1,
  }
  setJobContext(jobId, 'funds', Object.fromEntries(Object.entries(funds).map(([key, value]) => [key, value.toString()])))
  return funds
}

function plannedIntent(record: SwapPlanRecord): SwapIntent {
  return {
    purpose: record.purpose ?? 'strategy',
    tokenIn: record.tokenIn,
    tokenOut: record.tokenOut,
    amountIn: BigInt(record.amountIn),
    quotedOut: BigInt(record.quotedOut),
    principalIn: BigInt(record.principalIn),
    feeIn: BigInt(record.feeIn),
    routeSummary: { tokenIn: record.tokenIn, tokenOut: record.tokenOut, amountIn: record.amountIn, amountOut: record.quotedOut, route: [] },
  }
}

function applyExecutedSwaps(args: { job: RunnableJob; funds: CycleFunds; receipts: { stepIndex: number; txIndex: number; receipt: TransactionReceipt }[] }) {
  const { job, funds } = args
  const snapshot = job.plan.snapshot
  const reinvest = job.config.fees.handling === 'reinvest'
  let lp0 = funds.principal0 + (reinvest ? funds.fee0 : 0n)
  let lp1 = funds.principal1 + (reinvest ? funds.fee1 : 0n)
  let held0 = reinvest ? 0n : funds.fee0
  let held1 = reinvest ? 0n : funds.fee1
  const plan = getJobContext<SwapPlanContext>(job.id, 'swap_plan')
  const records = plan?.swaps ?? []
  const executionAudit = getJobContext<ExecutedSwapAudit[]>(job.id, 'executed_swaps') ?? []
  const executed: ExecutedSwap[] = []
  for (const row of args.receipts.filter((item) => item.stepIndex === 5)) {
    const record = latestSwapRecord(records, row.txIndex)
    if (!record) throw new Error('E_RECOVERY_CONTEXT')
    const audited = executionAudit.find((item) => item.txHash?.toLowerCase() === row.receipt.transactionHash.toLowerCase())
    const intent = plannedIntent(audited ? {
      ...record,
      purpose: audited.purpose ?? record.purpose,
      tokenIn: audited.tokenIn,
      tokenOut: audited.tokenOut,
      amountIn: audited.amountIn,
      // Older jobs stored the refreshed executable quote only inside route.
      quotedOut: audited.route?.amountOut ?? audited.quotedOut,
      principalIn: audited.principalIn,
      feeIn: audited.feeIn,
    } : record)
    const inDelta = receiptTokenDelta(row.receipt, intent.tokenIn, job.config.owner)
    const outDelta = receiptTokenDelta(row.receipt, intent.tokenOut, job.config.owner)
    const spent = -inDelta
    const gained = outDelta
    const storedMinOut = record.minOut ?? audited?.route?.minOut
    const execution = allocateSwapExecution(intent, spent, gained, storedMinOut === undefined
      ? applySlippage(intent.quotedOut, job.config.safeguards.maxSlippageBps)
      : BigInt(storedMinOut))
    if (intent.purpose === 'fee_tax') {
      const refundToLp = job.config.fees.handling === 'reinvest'
      if (low(intent.tokenIn) === low(snapshot.token0)) {
        if (refundToLp) lp0 += execution.unspentFee
        else held0 += execution.unspentFee
      } else {
        if (refundToLp) lp1 += execution.unspentFee
        else held1 += execution.unspentFee
      }
      executed.push({ intent, spent, gained, receipt: row.receipt })
      continue
    }
    if (low(intent.tokenIn) === low(snapshot.token0)) {
      lp0 -= execution.principalSpent
      held0 -= execution.feeSpent
      lp1 += execution.principalOut
      held1 += execution.feeOut
    } else {
      lp1 -= execution.principalSpent
      held1 -= execution.feeSpent
      lp0 += execution.principalOut
      held0 += execution.feeOut
    }
    if ([lp0, lp1, held0, held1].some((value) => value < 0n)) throw new Error('E_RECOVERY_CONTEXT')
    executed.push({ intent, spent, gained, receipt: row.receipt })
  }
  return { lp0, lp1, held0, held1, executed }
}

function gasEntries(job: RunnableJob, receipts: TransactionReceipt[]): LedgerEntry[] {
  const now = Math.floor(Date.now() / 1000)
  return receipts.map((receipt, index) => ({
    id: `${receipt.transactionHash}-gas-${index}`,
    strategyId: job.config.id,
    jobId: job.id,
    ts: now,
    blockNumber: receipt.blockNumber.toString(),
    txHash: receipt.transactionHash,
    kind: 'gas',
    amount: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
    meta: { unit: 'wei' },
  }))
}

/** Complete the terminal `hold_quote` action from durable chain facts. */
export async function finishHoldQuote(job: RunnableJob, privateKey: `0x${string}`) {
  const snapshot = job.plan.snapshot
  const context = getJobContext<PrecheckContext>(job.id, 'precheck')
  if (!context) throw new Error('E_RECOVERY_CONTEXT')
  let records = await confirmedReceipts(job.id)
  const funds = contextFunds(job.id, records, snapshot)
  const tax = await ensureFeeTaxPlan(job, funds)
  const prior = Object.fromEntries(Object.entries(context.prior).map(([token, value]) => [low(token), BigInt(value)]))
  const riskIs0 = low(job.config.riskToken) === low(snapshot.token0)
  const riskFunds = riskIs0 ? funds.principal0 + tax.fee0AfterTax : funds.principal1 + tax.fee1AfterTax
  const amountIn = riskFunds + (prior[low(job.config.riskToken)] ?? 0n)
  const pool = await readPoolState(job.config)

  let swapPlan = getJobContext<SwapPlanContext>(job.id, 'swap_plan') ?? { swaps: [] }
  let nextSwapTx = Math.max(nextTransactionIndex(job.id, 5), ...swapPlan.swaps.map((record) => record.txIndex + 1), 0)
  const taxReceipts: { intent: SwapIntent; quotedOut: bigint; spent: bigint; gained: bigint; receipt: TransactionReceipt; txIndex: number }[] = []
  for (const intent of tax.swaps) {
    let record = swapPlan.swaps.find((item) => item.purpose === 'fee_tax' && low(item.tokenIn) === low(intent.tokenIn) && BigInt(item.amountIn) === intent.amountIn)
    const existingReceipt = record ? records.find((row) => row.stepIndex === 5 && row.txIndex === record!.txIndex)?.receipt : undefined
    if (existingReceipt && record) {
      const spent = -receiptTokenDelta(existingReceipt, intent.tokenIn, job.config.owner)
      const gained = receiptTokenDelta(existingReceipt, SETTLEMENT, job.config.owner)
      allocateSwapExecution(intent, spent, gained, applySlippage(BigInt(record.quotedOut), job.config.safeguards.maxSlippageBps))
      taxReceipts.push({ intent, quotedOut: BigInt(record.quotedOut), spent, gained, receipt: existingReceipt, txIndex: record.txIndex })
      continue
    }
    const routeIn = routeCurrency(intent.tokenIn)
    const routeOut = routeCurrency(SETTLEMENT)
    const nativeIn = isNativeCurrency(intent.tokenIn)
    const quote = await quoteKyber(routeIn, routeOut, intent.amountIn)
    const quotedOut = BigInt(quote.routeSummary.amountOut)
    const txIndex = record?.txIndex ?? nextSwapTx++
    record = { txIndex, purpose: 'fee_tax', tokenIn: intent.tokenIn, tokenOut: SETTLEMENT, amountIn: intent.amountIn.toString(), quotedOut: quotedOut.toString(), principalIn: '0', feeIn: intent.amountIn.toString(), route: routeAudit(quote.routeSummary) }
    swapPlan = { ...swapPlan, swaps: upsertSwapRecords(swapPlan.swaps, [record]) }
    setJobContext(job.id, 'swap_plan', swapPlan)
    const approvalGate = await gatedKyberTx({ routeSummary: quote.routeSummary, tokenIn: routeIn, tokenOut: routeOut, sender: job.config.owner, recipient: job.config.owner, amountIn: intent.amountIn, slippageBps: job.config.safeguards.maxSlippageBps, nativeIn })
    if (!nativeIn) await grantStrategyAllowance({ config: job.config, jobId: job.id, stepIndex: 4, txIndexStart: nextTransactionIndex(job.id, 4), privateKey, token: intent.tokenIn, spender: approvalGate.approvalTarget, amount: intent.amountIn, forceExact: approvalGate.exactApproval })
    const gated = await gatedKyberTx({ routeSummary: quote.routeSummary, tokenIn: routeIn, tokenOut: routeOut, sender: job.config.owner, recipient: job.config.owner, amountIn: intent.amountIn, slippageBps: job.config.safeguards.maxSlippageBps, nativeIn })
    if (gated.approvalTarget.toLowerCase() !== approvalGate.approvalTarget.toLowerCase()) throw new Error('E_SWAP_SPENDER_CHANGED')
    const before = await readTokenBalances(job.config.owner, [intent.tokenIn, SETTLEMENT])
    const receipt = await sendTracked({ config: job.config, jobId: job.id, stepIndex: 5, txIndex, privateKey, tx: gated })
    const after = await readTokenBalances(job.config.owner, [intent.tokenIn, SETTLEMENT])
    const spent = spentByWallet(before[low(intent.tokenIn)], after[low(intent.tokenIn)], receipt, intent.tokenIn)
    const gained = receivedByWallet(before[low(SETTLEMENT)], after[low(SETTLEMENT)], receipt, SETTLEMENT)
    allocateSwapExecution(intent, spent, gained, gated.minOut)
    if (!nativeIn) {
      await revokeStrategyAllowance({ config: job.config, jobId: job.id, stepIndex: 4, txIndexStart: nextTransactionIndex(job.id, 4), privateKey, token: intent.tokenIn, spender: gated.approvalTarget, forceExact: gated.exactApproval })
      for (const spender of [EXECUTOR.kyberRouter, ADDR.CL_SWAP_ROUTER, UNI.V3_SWAP_ROUTER])
        await revokeStrategyAllowance({ config: job.config, jobId: job.id, stepIndex: 4, txIndexStart: nextTransactionIndex(job.id, 4), privateKey, token: intent.tokenIn, spender })
    }
    taxReceipts.push({ intent, quotedOut, spent, gained, receipt, txIndex })
    records = await confirmedReceipts(job.id)
  }

  const existingStrategyRecord = swapPlan.swaps.find((record) => record.purpose !== 'fee_tax' && low(record.tokenIn) === low(job.config.riskToken) && low(record.tokenOut) === low(job.config.quoteToken) && BigInt(record.amountIn) === amountIn)
  let swapReceipt = existingStrategyRecord ? records.find((row) => row.stepIndex === 5 && row.txIndex === existingStrategyRecord.txIndex)?.receipt : undefined
  let quotedOut = 0n
  let spent = 0n
  let gained = 0n
  if (amountIn > 0n) {
    if (job.config.execution.maxDailyTurnoverQuote !== undefined) {
      const quoteDecimals = low(job.config.quoteToken) === low(snapshot.token0) ? snapshot.token0Decimals : snapshot.token1Decimals
      const taxTurnover = tax.swaps.reduce((total, intent) => total + quoteTurnover(intent.amountIn, intent.tokenIn, job.config, snapshot, pool.sqrtPriceX96), 0n)
      reserveDailyTurnover({ jobId: job.id, walletId: job.walletId, quoteToken: job.config.quoteToken, amount: stakingRewardTurnover(job) + taxTurnover + quoteTurnover(amountIn, job.config.riskToken, job.config, snapshot, pool.sqrtPriceX96), limit: parseUnits(job.config.execution.maxDailyTurnoverQuote, quoteDecimals) })
    }
    const existingRecord = existingStrategyRecord
    if (swapReceipt) {
      if (!existingRecord || BigInt(existingRecord.amountIn) !== amountIn || low(existingRecord.tokenIn) !== low(job.config.riskToken) || low(existingRecord.tokenOut) !== low(job.config.quoteToken))
        throw new Error('E_RECOVERY_CONTEXT')
      spent = -receiptTokenDelta(swapReceipt, job.config.riskToken, job.config.owner)
      gained = receiptTokenDelta(swapReceipt, job.config.quoteToken, job.config.owner)
      quotedOut = BigInt(existingRecord.quotedOut)
      allocateSwapExecution(plannedIntent(existingRecord), spent, gained, applySlippage(quotedOut, job.config.safeguards.maxSlippageBps))
    } else {
      const quote = await quoteKyber(job.config.riskToken, job.config.quoteToken, amountIn, { protocol: job.config.protocol, tickSpacing: snapshot.tickSpacing, feePpm: snapshot.feePpm })
      quotedOut = BigInt(quote.routeSummary.amountOut)
      if (job.config.safeguards.enabled && job.config.safeguards.maxSwapImpactBps !== undefined && swapImpactBps(amountIn, quotedOut, job.config.riskToken, job.config.quoteToken, snapshot, pool.sqrtPriceX96) > BigInt(Math.floor(job.config.safeguards.maxSwapImpactBps)))
        throw new Error('E_SWAP_IMPACT')
      const txIndex = existingRecord?.txIndex ?? nextSwapTx++
      const strategyRecord: SwapPlanRecord = { txIndex, purpose: 'strategy', tokenIn: job.config.riskToken, tokenOut: job.config.quoteToken, amountIn: amountIn.toString(), quotedOut: quotedOut.toString(), principalIn: amountIn.toString(), feeIn: '0', route: routeAudit(quote.routeSummary) }
      swapPlan = { ...swapPlan, tick: pool.tick, sqrtPriceX96: pool.sqrtPriceX96.toString(), swaps: upsertSwapRecords(swapPlan.swaps, [strategyRecord]) }
      setJobContext(job.id, 'swap_plan', swapPlan)
      const approvalGate = await gatedKyberTx({ routeSummary: quote.routeSummary, tokenIn: job.config.riskToken, tokenOut: job.config.quoteToken, sender: job.config.owner, recipient: job.config.owner, amountIn, slippageBps: job.config.safeguards.maxSlippageBps, nativeIn: false })
      await grantStrategyAllowance({ config: job.config, jobId: job.id, stepIndex: 4, txIndexStart: nextTransactionIndex(job.id, 4), privateKey, token: job.config.riskToken, spender: approvalGate.approvalTarget, amount: amountIn, forceExact: approvalGate.exactApproval })
      const gated = await gatedKyberTx({ routeSummary: quote.routeSummary, tokenIn: job.config.riskToken, tokenOut: job.config.quoteToken, sender: job.config.owner, recipient: job.config.owner, amountIn, slippageBps: job.config.safeguards.maxSlippageBps, nativeIn: false })
      if (gated.approvalTarget.toLowerCase() !== approvalGate.approvalTarget.toLowerCase()) throw new Error('E_SWAP_SPENDER_CHANGED')
      const before = await readTokenBalances(job.config.owner, [job.config.riskToken, job.config.quoteToken])
      swapReceipt = await sendTracked({ config: job.config, jobId: job.id, stepIndex: 5, txIndex, privateKey, tx: gated })
      const after = await readTokenBalances(job.config.owner, [job.config.riskToken, job.config.quoteToken])
      spent = before[low(job.config.riskToken)] - after[low(job.config.riskToken)]
      gained = after[low(job.config.quoteToken)] - before[low(job.config.quoteToken)]
      allocateSwapExecution({ purpose: 'strategy', tokenIn: job.config.riskToken, tokenOut: job.config.quoteToken, amountIn, quotedOut, routeSummary: quote.routeSummary, principalIn: amountIn, feeIn: 0n }, spent, gained, gated.minOut)
      await revokeStrategyAllowance({ config: job.config, jobId: job.id, stepIndex: 4, txIndexStart: nextTransactionIndex(job.id, 4), privateKey, token: job.config.riskToken, spender: gated.approvalTarget, forceExact: gated.exactApproval })
      records = await confirmedReceipts(job.id)
    }
    for (const spender of [EXECUTOR.kyberRouter, ADDR.CL_SWAP_ROUTER, UNI.V3_SWAP_ROUTER])
      await revokeStrategyAllowance({ config: job.config, jobId: job.id, stepIndex: 4, txIndexStart: nextTransactionIndex(job.id, 4), privateKey, token: job.config.riskToken, spender })
  } else if (tax.swaps.length === 0) {
    markStep({ jobId: job.id, index: 4, state: 'confirmed', result: { skipped: true } })
    markStep({ jobId: job.id, index: 5, state: 'confirmed', result: { skipped: true } })
  }
  for (const index of [6, 7, 8, 9, 10]) markStep({ jobId: job.id, index, state: 'confirmed', result: { skipped: true, terminalAction: 'hold_quote' } })

  records = await confirmedReceipts(job.id)
  const finalBalances = await readTokenBalances(job.config.owner, context.trackedTokens)
  const gasSpent = records.reduce((total, row) => total + receiptGas(row.receipt), 0n)
  const economicFinal0 = finalBalances[low(snapshot.token0)] + (isNativeCurrency(snapshot.token0) ? gasSpent : 0n)
  const economicFinal1 = finalBalances[low(snapshot.token1)] + (isNativeCurrency(snapshot.token1) ? gasSpent : 0n)
  const taxUsdgActual = tax.retainedUsdg + taxReceipts.reduce((total, item) => total + item.gained, 0n)
  let allocation0 = economicFinal0 - BigInt(context.baseline[low(snapshot.token0)]) + (prior[low(snapshot.token0)] ?? 0n)
  let allocation1 = economicFinal1 - BigInt(context.baseline[low(snapshot.token1)]) + (prior[low(snapshot.token1)] ?? 0n)
  if (low(snapshot.token0) === low(SETTLEMENT)) allocation0 -= taxUsdgActual
  if (low(snapshot.token1) === low(SETTLEMENT)) allocation1 -= taxUsdgActual
  if (allocation0 < 0n || allocation1 < 0n) throw new Error('E_ALLOCATION_MISMATCH')
  const riskAllocation = riskIs0 ? allocation0 : allocation1
  if (riskAllocation !== 0n) throw new Error('E_ALLOCATION_MISMATCH')

  const decreaseReceipt = records.find((row) => row.stepIndex === 1)?.receipt
  const collectReceipt = records.find((row) => row.stepIndex === 2)?.receipt ?? (job.config.execution.lowTransactionMode ? decreaseReceipt : undefined)
  if (!decreaseReceipt || !collectReceipt) throw new Error('E_RECOVERY_CONTEXT')
  const now = Math.floor(Date.now() / 1000)
  const decreased = receiptLiquidityFlows(decreaseReceipt, job.config.positionManager, BigInt(snapshot.tokenId))
  const collected = receiptLiquidityFlows(collectReceipt, job.config.positionManager, BigInt(snapshot.tokenId))
  const ledger: LedgerEntry[] = attributeCollect({
    strategyId: job.config.id,
    cycleId: `cycle-${job.id}`,
    ts: now,
    token0: snapshot.token0,
    token1: snapshot.token1,
    principal0: decreased.principal0.toString(),
    principal1: decreased.principal1.toString(),
    collected0: collected.collected0.toString(),
    collected1: collected.collected1.toString(),
    unstakedLevyPpm: snapshot.unstakedFeePpm,
    txHash: collectReceipt.transactionHash,
    blockNumber: collectReceipt.blockNumber.toString(),
  }).map((entry, index) => ({ ...entry, id: `${job.id}-collect-${index}`, jobId: job.id }))
  for (const item of taxReceipts) {
    const common = { strategyId: job.config.id, cycleId: `cycle-${job.id}`, jobId: job.id, ts: now, txHash: item.receipt.transactionHash, blockNumber: item.receipt.blockNumber.toString() }
    ledger.push(
      { ...common, id: `${job.id}-hold-tax-in-${item.txIndex}`, kind: 'swap_in', token: item.intent.tokenIn, amount: item.spent.toString(), meta: { feeIn: item.spent.toString(), purpose: 'fee_tax' } },
      { ...common, id: `${job.id}-hold-tax-out-${item.txIndex}`, kind: 'swap_out', token: SETTLEMENT, amount: item.gained.toString(), meta: { quotedOut: item.quotedOut.toString(), purpose: 'fee_tax' } },
    )
  }
  if (swapReceipt) {
    const common = { strategyId: job.config.id, cycleId: `cycle-${job.id}`, jobId: job.id, ts: now, txHash: swapReceipt.transactionHash, blockNumber: swapReceipt.blockNumber.toString() }
    ledger.push(
      { ...common, id: `${job.id}-hold-swap-in`, kind: 'swap_in', token: job.config.riskToken, amount: spent.toString(), meta: { terminalAction: 'hold_quote' } },
      { ...common, id: `${job.id}-hold-swap-out`, kind: 'swap_out', token: job.config.quoteToken, amount: gained.toString(), meta: { quotedOut: quotedOut.toString(), terminalAction: 'hold_quote' } },
    )
    if (gained < quotedOut) ledger.push({ ...common, id: `${job.id}-hold-swap-cost`, kind: 'swap_cost', token: job.config.quoteToken, amount: (quotedOut - gained).toString(), meta: { basis: 'quoted_output_shortfall' } })
  }
  const retainedTaxEntry = incomeTaxRetentionEntry({
    id: `${job.id}-income-tax-retained`, strategyId: job.config.id, cycleId: `cycle-${job.id}`, jobId: job.id, ts: now,
    token: SETTLEMENT, amount: tax.retainedUsdg, txHash: collectReceipt.transactionHash, blockNumber: collectReceipt.blockNumber.toString(),
  })
  if (retainedTaxEntry) ledger.push(retainedTaxEntry)
  ledger.push(...gasEntries(job, records.map((row) => row.receipt)), ...stakingRewardLedger(job, now))
  commitHoldQuote({
    jobId: job.id,
    config: job.config,
    oldTokenId: snapshot.tokenId,
    triggerSide: job.plan.triggerSide,
    allocations: { [low(snapshot.token0)]: allocation0, [low(snapshot.token1)]: allocation1 },
    ledger,
    txHashes: records.map((row) => row.receipt.transactionHash),
    commitResult: { terminalAction: 'hold_quote', quoteAmount: (riskIs0 ? allocation1 : allocation0).toString(), incomeTaxApplied: tax.applied, incomeTaxUsdg: taxUsdgActual.toString() },
  })
}

/** Complete a threshold/interval fees-only collection and optional conversion. */
export async function finishFeeCollection(job: RunnableJob, privateKey: `0x${string}`) {
  const snapshot = job.plan.snapshot
  const context = getJobContext<PrecheckContext>(job.id, 'precheck')
  if (!context) throw new Error('E_RECOVERY_CONTEXT')
  markStep({ jobId: job.id, index: 1, state: 'confirmed', result: { skipped: true, action: 'collect_fees' } })
  markStep({ jobId: job.id, index: 3, state: 'confirmed', result: { skipped: true, action: 'collect_fees' } })
  let records = await confirmedReceipts(job.id)
  let collectReceipt = records.find((row) => row.stepIndex === 2)?.receipt
  let v4Collected: { collected0: bigint; collected1: bigint } | undefined
  if (!collectReceipt) {
    const before = await readTokenBalances(job.config.owner, [snapshot.token0, snapshot.token1])
    collectReceipt = await sendTracked({
      config: job.config,
      jobId: job.id,
      stepIndex: 2,
      txIndex: nextTransactionIndex(job.id, 2),
      privateKey,
      tx: job.config.protocol === 'univ4' ? v4CollectCall(job.config, snapshot) : collectCall(job.config, snapshot.tokenId),
    })
    const after = await readTokenBalances(job.config.owner, [snapshot.token0, snapshot.token1])
    if (job.config.protocol === 'univ4') {
      v4Collected = {
        collected0: receivedByWallet(before[low(snapshot.token0)], after[low(snapshot.token0)], collectReceipt, snapshot.token0),
        collected1: receivedByWallet(before[low(snapshot.token1)], after[low(snapshot.token1)], collectReceipt, snapshot.token1),
      }
      if (v4Collected.collected0 < 0n || v4Collected.collected1 < 0n) throw new Error('E_UNSUPPORTED_TOKEN')
    } else {
      const collectedNow = receiptLiquidityFlows(collectReceipt, job.config.positionManager, BigInt(snapshot.tokenId))
      if (after[low(snapshot.token0)] - before[low(snapshot.token0)] !== collectedNow.collected0 || after[low(snapshot.token1)] - before[low(snapshot.token1)] !== collectedNow.collected1)
        throw new Error('E_UNSUPPORTED_TOKEN')
    }
    records = await confirmedReceipts(job.id)
  }
  if (job.config.protocol === 'univ4' && !v4Collected) throw new Error('E_V4_RECOVERY_MANUAL')
  const collected = v4Collected ?? receiptLiquidityFlows(collectReceipt, job.config.positionManager, BigInt(snapshot.tokenId))
  const collectedFunds: CycleFunds = { principal0: 0n, principal1: 0n, fee0: collected.collected0, fee1: collected.collected1 }
  const tax = await ensureFeeTaxPlan(job, collectedFunds)
  let swapPlan = getJobContext<SwapPlanContext>(job.id, 'swap_plan') ?? { swaps: [] }
  let nextSwapTx = nextTransactionIndex(job.id, 5)
  const taxReceipts: { intent: SwapIntent; quotedOut: bigint; spent: bigint; gained: bigint; receipt: TransactionReceipt; txIndex: number }[] = []

  for (const intent of tax.swaps) {
    let record = swapPlan.swaps.find((item) => item.purpose === 'fee_tax' && low(item.tokenIn) === low(intent.tokenIn) && BigInt(item.amountIn) === intent.amountIn)
    const existingReceipt = record ? records.find((row) => row.stepIndex === 5 && row.txIndex === record!.txIndex)?.receipt : undefined
    if (existingReceipt && record) {
      const spent = -receiptTokenDelta(existingReceipt, intent.tokenIn, job.config.owner)
      const gained = receiptTokenDelta(existingReceipt, SETTLEMENT, job.config.owner)
      allocateSwapExecution(intent, spent, gained, applySlippage(BigInt(record.quotedOut), job.config.safeguards.maxSlippageBps))
      taxReceipts.push({ intent, quotedOut: BigInt(record.quotedOut), spent, gained, receipt: existingReceipt, txIndex: record.txIndex })
      continue
    }
    const quote = await quoteKyber(intent.tokenIn, SETTLEMENT, intent.amountIn)
    const quotedOut = BigInt(quote.routeSummary.amountOut)
    const txIndex = record?.txIndex ?? nextSwapTx++
    record = { txIndex, purpose: 'fee_tax', tokenIn: intent.tokenIn, tokenOut: SETTLEMENT, amountIn: intent.amountIn.toString(), quotedOut: quotedOut.toString(), principalIn: '0', feeIn: intent.amountIn.toString(), route: routeAudit(quote.routeSummary) }
    swapPlan = { ...swapPlan, swaps: upsertSwapRecords(swapPlan.swaps, [record]) }
    setJobContext(job.id, 'swap_plan', swapPlan)
    const approvalGate = await gatedKyberTx({ routeSummary: quote.routeSummary, tokenIn: intent.tokenIn, tokenOut: SETTLEMENT, sender: job.config.owner, recipient: job.config.owner, amountIn: intent.amountIn, slippageBps: job.config.safeguards.maxSlippageBps, nativeIn: false })
    await grantStrategyAllowance({ config: job.config, jobId: job.id, stepIndex: 4, txIndexStart: nextTransactionIndex(job.id, 4), privateKey, token: intent.tokenIn, spender: approvalGate.approvalTarget, amount: intent.amountIn, forceExact: approvalGate.exactApproval })
    const gated = await gatedKyberTx({ routeSummary: quote.routeSummary, tokenIn: intent.tokenIn, tokenOut: SETTLEMENT, sender: job.config.owner, recipient: job.config.owner, amountIn: intent.amountIn, slippageBps: job.config.safeguards.maxSlippageBps, nativeIn: false })
    if (gated.approvalTarget.toLowerCase() !== approvalGate.approvalTarget.toLowerCase()) throw new Error('E_SWAP_SPENDER_CHANGED')
    const before = await readTokenBalances(job.config.owner, [intent.tokenIn, SETTLEMENT])
    const receipt = await sendTracked({ config: job.config, jobId: job.id, stepIndex: 5, txIndex, privateKey, tx: gated })
    const after = await readTokenBalances(job.config.owner, [intent.tokenIn, SETTLEMENT])
    const spent = before[low(intent.tokenIn)] - after[low(intent.tokenIn)]
    const gained = after[low(SETTLEMENT)] - before[low(SETTLEMENT)]
    allocateSwapExecution(intent, spent, gained, gated.minOut)
    await revokeStrategyAllowance({ config: job.config, jobId: job.id, stepIndex: 4, txIndexStart: nextTransactionIndex(job.id, 4), privateKey, token: intent.tokenIn, spender: gated.approvalTarget, forceExact: gated.exactApproval })
    for (const spender of [EXECUTOR.kyberRouter, ADDR.CL_SWAP_ROUTER, UNI.V3_SWAP_ROUTER])
      await revokeStrategyAllowance({ config: job.config, jobId: job.id, stepIndex: 4, txIndexStart: nextTransactionIndex(job.id, 4), privateKey, token: intent.tokenIn, spender })
    taxReceipts.push({ intent, quotedOut, spent, gained, receipt, txIndex })
    records = await confirmedReceipts(job.id)
  }

  const riskAmount = low(job.config.riskToken) === low(snapshot.token0) ? tax.fee0AfterTax : tax.fee1AfterTax
  let swapReceipt: TransactionReceipt | undefined
  let quotedOut = 0n
  let strategySpent = 0n
  let gained = 0n
  const pool = await readPoolState(job.config)
  if (job.config.execution.maxDailyTurnoverQuote !== undefined) {
    const quoteDecimals = low(job.config.quoteToken) === low(snapshot.token0) ? snapshot.token0Decimals : snapshot.token1Decimals
    const taxTurnover = tax.swaps.reduce((total, intent) => total + quoteTurnover(intent.amountIn, intent.tokenIn, job.config, snapshot, pool.sqrtPriceX96), 0n)
    const strategyTurnover = job.config.fees.handling === 'convert_to_quote' ? quoteTurnover(riskAmount, job.config.riskToken, job.config, snapshot, pool.sqrtPriceX96) : 0n
    reserveDailyTurnover({ jobId: job.id, walletId: job.walletId, quoteToken: job.config.quoteToken, amount: taxTurnover + strategyTurnover, limit: parseUnits(job.config.execution.maxDailyTurnoverQuote, quoteDecimals) })
  }
  if (job.config.fees.handling === 'convert_to_quote' && riskAmount > 0n) {
    const existingRecord = swapPlan.swaps.find((record) => record.purpose !== 'fee_tax' && low(record.tokenIn) === low(job.config.riskToken) && BigInt(record.amountIn) === riskAmount)
    swapReceipt = existingRecord ? records.find((row) => row.stepIndex === 5 && row.txIndex === existingRecord.txIndex)?.receipt : undefined
    if (swapReceipt) {
      if (!existingRecord) throw new Error('E_RECOVERY_CONTEXT')
      quotedOut = BigInt(existingRecord.quotedOut)
      strategySpent = -receiptTokenDelta(swapReceipt, job.config.riskToken, job.config.owner)
      gained = receiptTokenDelta(swapReceipt, job.config.quoteToken, job.config.owner)
      allocateSwapExecution(plannedIntent(existingRecord), strategySpent, gained, applySlippage(quotedOut, job.config.safeguards.maxSlippageBps))
    } else {
      const routeIn = routeCurrency(job.config.riskToken)
      const routeOut = routeCurrency(job.config.quoteToken)
      const nativeIn = isNativeCurrency(job.config.riskToken)
      const quote = await quoteKyber(routeIn, routeOut, riskAmount, { protocol: job.config.protocol, tickSpacing: snapshot.tickSpacing, feePpm: snapshot.feePpm })
      quotedOut = BigInt(quote.routeSummary.amountOut)
      const impact = swapImpactBps(riskAmount, quotedOut, job.config.riskToken, job.config.quoteToken, snapshot, pool.sqrtPriceX96)
      if (job.config.safeguards.enabled && job.config.safeguards.maxSwapImpactBps !== undefined && impact > BigInt(Math.floor(job.config.safeguards.maxSwapImpactBps))) throw new Error('E_SWAP_IMPACT')
      const txIndex = existingRecord?.txIndex ?? nextSwapTx++
      const strategyRecord: SwapPlanRecord = { txIndex, purpose: 'strategy', tokenIn: job.config.riskToken, tokenOut: job.config.quoteToken, amountIn: riskAmount.toString(), quotedOut: quotedOut.toString(), principalIn: '0', feeIn: riskAmount.toString(), route: routeAudit(quote.routeSummary) }
      swapPlan = { ...swapPlan, tick: pool.tick, sqrtPriceX96: pool.sqrtPriceX96.toString(), swaps: upsertSwapRecords(swapPlan.swaps, [strategyRecord]) }
      setJobContext(job.id, 'swap_plan', swapPlan)
      const approvalGate = await gatedKyberTx({ routeSummary: quote.routeSummary, tokenIn: routeIn, tokenOut: routeOut, sender: job.config.owner, recipient: job.config.owner, amountIn: riskAmount, slippageBps: job.config.safeguards.maxSlippageBps, nativeIn })
      if (!nativeIn) await grantStrategyAllowance({ config: job.config, jobId: job.id, stepIndex: 4, txIndexStart: nextTransactionIndex(job.id, 4), privateKey, token: job.config.riskToken, spender: approvalGate.approvalTarget, amount: riskAmount, forceExact: approvalGate.exactApproval })
      const gated = await gatedKyberTx({ routeSummary: quote.routeSummary, tokenIn: routeIn, tokenOut: routeOut, sender: job.config.owner, recipient: job.config.owner, amountIn: riskAmount, slippageBps: job.config.safeguards.maxSlippageBps, nativeIn })
      if (gated.approvalTarget.toLowerCase() !== approvalGate.approvalTarget.toLowerCase()) throw new Error('E_SWAP_SPENDER_CHANGED')
      const before = await readTokenBalances(job.config.owner, [job.config.riskToken, job.config.quoteToken])
      swapReceipt = await sendTracked({ config: job.config, jobId: job.id, stepIndex: 5, txIndex, privateKey, tx: gated })
      const after = await readTokenBalances(job.config.owner, [job.config.riskToken, job.config.quoteToken])
      strategySpent = spentByWallet(before[low(job.config.riskToken)], after[low(job.config.riskToken)], swapReceipt, job.config.riskToken)
      gained = receivedByWallet(before[low(job.config.quoteToken)], after[low(job.config.quoteToken)], swapReceipt, job.config.quoteToken)
      allocateSwapExecution({ purpose: 'strategy', tokenIn: job.config.riskToken, tokenOut: job.config.quoteToken, amountIn: riskAmount, quotedOut, routeSummary: quote.routeSummary, principalIn: 0n, feeIn: riskAmount }, strategySpent, gained, gated.minOut)
      if (!nativeIn) await revokeStrategyAllowance({ config: job.config, jobId: job.id, stepIndex: 4, txIndexStart: nextTransactionIndex(job.id, 4), privateKey, token: job.config.riskToken, spender: gated.approvalTarget, forceExact: gated.exactApproval })
      records = await confirmedReceipts(job.id)
    }
    if (!isNativeCurrency(job.config.riskToken)) for (const spender of [EXECUTOR.kyberRouter, ADDR.CL_SWAP_ROUTER, UNI.V3_SWAP_ROUTER])
      await revokeStrategyAllowance({ config: job.config, jobId: job.id, stepIndex: 4, txIndexStart: nextTransactionIndex(job.id, 4), privateKey, token: job.config.riskToken, spender })
  } else if (tax.swaps.length === 0) {
    markStep({ jobId: job.id, index: 4, state: 'confirmed', result: { skipped: true } })
    markStep({ jobId: job.id, index: 5, state: 'confirmed', result: { skipped: true } })
  }
  for (const index of [6, 7, 8, 9, 10]) markStep({ jobId: job.id, index, state: 'confirmed', result: { skipped: true, action: 'collect_fees' } })

  const freshPosition = await readStrategySnapshot(job.config)
  if (freshPosition.tokenId !== snapshot.tokenId || freshPosition.liquidity !== snapshot.liquidity || low(freshPosition.owner) !== low(job.config.owner)) throw new Error('E_POSITION_CHANGED')
  records = await confirmedReceipts(job.id)
  const finalBalances = await readTokenBalances(job.config.owner, context.trackedTokens)
  const prior = Object.fromEntries(Object.entries(context.prior).map(([token, amount]) => [low(token), BigInt(amount)]))
  const taxUsdgActual = tax.retainedUsdg + taxReceipts.reduce((total, item) => total + item.gained, 0n)
  let allocation0 = finalBalances[low(snapshot.token0)] - BigInt(context.baseline[low(snapshot.token0)]) + (prior[low(snapshot.token0)] ?? 0n)
  let allocation1 = finalBalances[low(snapshot.token1)] - BigInt(context.baseline[low(snapshot.token1)]) + (prior[low(snapshot.token1)] ?? 0n)
  if (low(snapshot.token0) === low(SETTLEMENT)) allocation0 -= taxUsdgActual
  if (low(snapshot.token1) === low(SETTLEMENT)) allocation1 -= taxUsdgActual
  if (allocation0 < 0n || allocation1 < 0n) throw new Error('E_ALLOCATION_MISMATCH')
  const priorParts = priorComponents(context)
  const reinvest = job.config.fees.handling === 'reinvest'
  const heldProfit0 = priorParts.profit[low(snapshot.token0)] ?? 0n
  const heldProfit1 = priorParts.profit[low(snapshot.token1)] ?? 0n
  const principal0 = reinvest ? allocation0 - (priorParts.held[low(snapshot.token0)] ?? 0n) - heldProfit0 : (priorParts.principal[low(snapshot.token0)] ?? 0n)
  const principal1 = reinvest ? allocation1 - (priorParts.held[low(snapshot.token1)] ?? 0n) - heldProfit1 : (priorParts.principal[low(snapshot.token1)] ?? 0n)
  const heldFee0 = allocation0 - principal0 - heldProfit0
  const heldFee1 = allocation1 - principal1 - heldProfit1
  if ([principal0, principal1, heldFee0, heldFee1, heldProfit0, heldProfit1].some((value) => value < 0n)) throw new Error('E_ALLOCATION_MISMATCH')
  assertWalletAllocationUpdate(job.walletId, job.config.id, finalBalances, {
    [low(snapshot.token0)]: allocation0,
    [low(snapshot.token1)]: allocation1,
  })
  const now = Math.floor(Date.now() / 1000)
  const ledger: LedgerEntry[] = attributeCollect({
    strategyId: job.config.id,
    ts: now,
    token0: snapshot.token0,
    token1: snapshot.token1,
    principal0: '0',
    principal1: '0',
    collected0: collected.collected0.toString(),
    collected1: collected.collected1.toString(),
    unstakedLevyPpm: snapshot.unstakedFeePpm,
    txHash: collectReceipt.transactionHash,
    blockNumber: collectReceipt.blockNumber.toString(),
  }).map((entry, index) => ({ ...entry, id: `${job.id}-fee-${index}`, jobId: job.id }))
  for (const item of taxReceipts) {
    const common = { strategyId: job.config.id, jobId: job.id, ts: now, txHash: item.receipt.transactionHash, blockNumber: item.receipt.blockNumber.toString() }
    ledger.push(
      { ...common, id: `${job.id}-fee-tax-in-${item.txIndex}`, kind: 'swap_in', token: item.intent.tokenIn, amount: item.spent.toString(), meta: { feeIn: item.spent.toString(), purpose: 'fee_tax' } },
      { ...common, id: `${job.id}-fee-tax-out-${item.txIndex}`, kind: 'swap_out', token: SETTLEMENT, amount: item.gained.toString(), meta: { quotedOut: item.quotedOut.toString(), purpose: 'fee_tax' } },
    )
  }
  if (swapReceipt) {
    const common = { strategyId: job.config.id, jobId: job.id, ts: now, txHash: swapReceipt.transactionHash, blockNumber: swapReceipt.blockNumber.toString() }
    ledger.push(
      { ...common, id: `${job.id}-fee-swap-in`, kind: 'swap_in', token: job.config.riskToken, amount: strategySpent.toString(), meta: { feeIn: strategySpent.toString(), purpose: 'strategy' } },
      { ...common, id: `${job.id}-fee-swap-out`, kind: 'swap_out', token: job.config.quoteToken, amount: gained.toString(), meta: { quotedOut: quotedOut.toString(), purpose: 'strategy' } },
    )
  }
  const retainedTaxEntry = incomeTaxRetentionEntry({
    id: `${job.id}-income-tax-retained`, strategyId: job.config.id, jobId: job.id, ts: now,
    token: SETTLEMENT, amount: tax.retainedUsdg, txHash: collectReceipt.transactionHash, blockNumber: collectReceipt.blockNumber.toString(),
  })
  if (retainedTaxEntry) ledger.push(retainedTaxEntry)
  ledger.push(...gasEntries(job, records.map((row) => row.receipt)))
  commitFeeCollection({
    jobId: job.id,
    config: job.config,
    allocations: { [low(snapshot.token0)]: allocation0, [low(snapshot.token1)]: allocation1 },
    allocationComponents: {
      [low(snapshot.token0)]: { principal: principal0, heldFee: heldFee0, heldProfit: heldProfit0 },
      [low(snapshot.token1)]: { principal: principal1, heldFee: heldFee1, heldProfit: heldProfit1 },
    },
    ledger,
    txHashes: records.map((row) => row.receipt.transactionHash),
    commitResult: { action: 'collect_fees', collected0: collected.collected0.toString(), collected1: collected.collected1.toString(), feeTaxApplied: tax.applied, feeTaxUsdg: taxUsdgActual.toString() },
  })
}

async function commitFromChainFacts(job: RunnableJob, privateKey?: `0x${string}`) {
  const snapshot = job.plan.snapshot
  const context = getJobContext<PrecheckContext>(job.id, 'precheck')
  if (!context) throw new Error('E_RECOVERY_CONTEXT')
  let records = await confirmedReceipts(job.id)
  const decreaseReceipt = records.find((row) => row.stepIndex === 1)?.receipt
  const collectReceipt = records.find((row) => row.stepIndex === 2)?.receipt ?? (job.config.execution.lowTransactionMode ? decreaseReceipt : undefined)
  const mintReceipt = records.find((row) => row.stepIndex === 8)?.receipt
  if (!decreaseReceipt || !collectReceipt || !mintReceipt) throw new Error('E_RECOVERY_CONTEXT')
  const decreased = receiptLiquidityFlows(decreaseReceipt, job.config.positionManager, BigInt(snapshot.tokenId))
  const collected = receiptLiquidityFlows(collectReceipt, job.config.positionManager, BigInt(snapshot.tokenId))
  const minted = receiptLiquidityFlows(mintReceipt, job.config.positionManager, 0n)
  if (!minted.mintedTokenId) throw new Error('E_MINT_TOKEN_ID')
  if (job.config.staking?.enabled) {
    if (!privateKey) throw new Error('E_RECOVERY_CONTEXT')
    await ensureRestaked(job, privateKey, minted.mintedTokenId.toString())
    records = await confirmedReceipts(job.id)
  }
  const receipts = records.map((row) => row.receipt)
  const newOwner = await publicClient.readContract({ address: job.config.positionManager, abi: clPmAbi, functionName: 'ownerOf', args: [minted.mintedTokenId] })
  const expectedOwner = job.config.staking?.enabled ? job.config.staking.gauge! : job.config.owner
  if (low(newOwner) !== low(expectedOwner)) throw new Error('E_OWNER')

  const tracked = [...new Set([...context.trackedTokens.map(low), low(snapshot.token0), low(snapshot.token1), low(SETTLEMENT)])] as Address[]
  const finalBalances = await readTokenBalances(job.config.owner, tracked)
  const prior = priorComponents(context)
  const collectedFunds = contextFunds(job.id, records, snapshot)
  const reward = stakingReward(job)
  const rewardAfterTax = stakingRewardAfterTax(job)
  const taxedCollectedFunds = applyStoredFeeTax(job.id, collectedFunds)
  const deployableFunds = {
    ...taxedCollectedFunds,
    principal0: collectedFunds.principal0 + (prior.principal[low(snapshot.token0)] ?? 0n) + (job.config.fees.handling === 'reinvest' && low(snapshot.token0) === low(job.config.quoteToken) ? rewardAfterTax : 0n),
    principal1: collectedFunds.principal1 + (prior.principal[low(snapshot.token1)] ?? 0n) + (job.config.fees.handling === 'reinvest' && low(snapshot.token1) === low(job.config.quoteToken) ? rewardAfterTax : 0n),
  }
  const state = applyExecutedSwaps({ job, funds: deployableFunds, receipts: records })
  const feeTaxContext = getJobContext<FeeTaxContext>(job.id, 'fee_tax')
  const capital = getJobContext<CapitalAllocationContext>(job.id, 'capital_allocation')
  const deploy0 = BigInt(capital?.deploy0 ?? state.lp0.toString())
  const deploy1 = BigInt(capital?.deploy1 ?? state.lp1.toString())
  const profit0 = BigInt(capital?.profit0 ?? '0')
  const profit1 = BigInt(capital?.profit1 ?? '0')
  if (deploy0 + profit0 !== state.lp0 || deploy1 + profit1 !== state.lp1) throw new Error('E_RECOVERY_CONTEXT')
  const principalCarry0 = deploy0 - minted.minted0
  const principalCarry1 = deploy1 - minted.minted1
  const heldFee0 = (prior.held[low(snapshot.token0)] ?? 0n) + state.held0 + (job.config.fees.handling !== 'reinvest' && low(snapshot.token0) === low(job.config.quoteToken) ? rewardAfterTax : 0n)
  const heldFee1 = (prior.held[low(snapshot.token1)] ?? 0n) + state.held1 + (job.config.fees.handling !== 'reinvest' && low(snapshot.token1) === low(job.config.quoteToken) ? rewardAfterTax : 0n)
  const heldProfit0 = (prior.profit[low(snapshot.token0)] ?? 0n) + profit0
  const heldProfit1 = (prior.profit[low(snapshot.token1)] ?? 0n) + profit1
  const allocation0 = principalCarry0 + heldFee0 + heldProfit0
  const allocation1 = principalCarry1 + heldFee1 + heldProfit1
  if (allocation0 < 0n || allocation1 < 0n) throw new Error('E_ALLOCATION_MISMATCH')
  assertWalletAllocationUpdate(job.walletId, job.config.id, finalBalances, {
    [low(snapshot.token0)]: allocation0,
    [low(snapshot.token1)]: allocation1,
  })

  const now = Math.floor(Date.now() / 1000)
  const ledger: LedgerEntry[] = attributeCollect({
    strategyId: job.config.id,
    cycleId: `cycle-${job.id}`,
    ts: now,
    token0: snapshot.token0,
    token1: snapshot.token1,
    principal0: decreased.principal0.toString(),
    principal1: decreased.principal1.toString(),
    collected0: collected.collected0.toString(),
    collected1: collected.collected1.toString(),
    unstakedLevyPpm: snapshot.unstakedFeePpm,
    txHash: collectReceipt.transactionHash,
    blockNumber: collectReceipt.blockNumber.toString(),
  }).map((entry, index) => ({ ...entry, id: `${job.id}-collect-${index}`, jobId: job.id }))

  const swapPlan = getJobContext<SwapPlanContext>(job.id, 'swap_plan')
  for (const row of records.filter((item) => item.stepIndex === 5)) {
    const record = latestSwapRecord(swapPlan?.swaps, row.txIndex)
    if (!record) throw new Error('E_RECOVERY_CONTEXT')
    const intent = plannedIntent(record)
    const spent = -receiptTokenDelta(row.receipt, intent.tokenIn, job.config.owner)
    const gained = receiptTokenDelta(row.receipt, intent.tokenOut, job.config.owner)
    const execution = allocateSwapExecution(intent, spent, gained, 0n)
    const common = { strategyId: job.config.id, cycleId: `cycle-${job.id}`, jobId: job.id, ts: now, txHash: row.receipt.transactionHash, blockNumber: row.receipt.blockNumber.toString() }
    ledger.push(
      { ...common, id: `${job.id}-swap-in-${row.txIndex}`, kind: 'swap_in', token: intent.tokenIn, amount: spent.toString(), meta: { principalIn: execution.principalSpent.toString(), feeIn: execution.feeSpent.toString(), purpose: intent.purpose } },
      { ...common, id: `${job.id}-swap-out-${row.txIndex}`, kind: 'swap_out', token: intent.tokenOut, amount: gained.toString(), meta: { quotedOut: intent.quotedOut.toString(), purpose: intent.purpose } },
    )
    if (gained < intent.quotedOut) ledger.push({ ...common, id: `${job.id}-swap-cost-${row.txIndex}`, kind: 'swap_cost', token: intent.tokenOut, amount: (intent.quotedOut - gained).toString(), meta: { basis: 'quoted_output_shortfall' } })
  }
  const retainedTaxEntry = incomeTaxRetentionEntry({
    id: `${job.id}-income-tax-retained`, strategyId: job.config.id, cycleId: `cycle-${job.id}`, jobId: job.id, ts: now,
    token: SETTLEMENT, amount: BigInt(feeTaxContext?.retainedUsdg ?? '0'), txHash: collectReceipt.transactionHash, blockNumber: collectReceipt.blockNumber.toString(),
  })
  if (retainedTaxEntry) ledger.push(retainedTaxEntry)
  if (capital?.triggered) ledger.push(
    { id: `${job.id}-profit-0`, strategyId: job.config.id, cycleId: `cycle-${job.id}`, jobId: job.id, ts: now, kind: 'profit_harvest', token: snapshot.token0, amount: profit0.toString(), meta: { thresholdUsdg: job.config.capitalProtection.profitThresholdUsdg, excessValueUsdg: capital.excessValueUsdg } },
    { id: `${job.id}-profit-1`, strategyId: job.config.id, cycleId: `cycle-${job.id}`, jobId: job.id, ts: now, kind: 'profit_harvest', token: snapshot.token1, amount: profit1.toString(), meta: { thresholdUsdg: job.config.capitalProtection.profitThresholdUsdg, excessValueUsdg: capital.excessValueUsdg } },
  )
  ledger.push(
    { id: `${job.id}-mint-0`, strategyId: job.config.id, cycleId: `cycle-${job.id}`, jobId: job.id, ts: now, kind: 'mint_principal', token: snapshot.token0, amount: minted.minted0.toString(), txHash: mintReceipt.transactionHash },
    { id: `${job.id}-mint-1`, strategyId: job.config.id, cycleId: `cycle-${job.id}`, jobId: job.id, ts: now, kind: 'mint_principal', token: snapshot.token1, amount: minted.minted1.toString(), txHash: mintReceipt.transactionHash },
    ...gasEntries(job, receipts),
    ...stakingRewardLedger(job, now),
  )
  commitRebalance({
    jobId: job.id,
    config: job.config,
    oldTokenId: snapshot.tokenId,
    newTokenId: minted.mintedTokenId.toString(),
    triggerSide: job.plan.triggerSide,
    rangeScale: job.plan.rangeScale ?? 1,
    allocations: { [low(snapshot.token0)]: allocation0, [low(snapshot.token1)]: allocation1 },
    allocationComponents: {
      [low(snapshot.token0)]: { principal: principalCarry0, heldFee: heldFee0, heldProfit: heldProfit0 },
      [low(snapshot.token1)]: { principal: principalCarry1, heldFee: heldFee1, heldProfit: heldProfit1 },
    },
    ledger,
    txHashes: receipts.map((receipt) => receipt.transactionHash),
    commitResult: { newTokenId: minted.mintedTokenId.toString(), held0: state.held0.toString(), held1: state.held1.toString(), rewardUp: reward.rewardUp.toString(), rewardWeth: reward.rewardWeth.toString(), rewardQuote: reward.rewardQuote.toString(), rewardQuoteToken: job.config.quoteToken, rewardTaxWeth: low(job.config.quoteToken) === low(WRAPPED_NATIVE) ? (reward.rewardQuote - rewardAfterTax).toString() : '0', rewardTaxQuote: (reward.rewardQuote - rewardAfterTax).toString(), incomeTaxApplied: getJobContext<FeeTaxContext>(job.id, 'fee_tax')?.applied === true, feeTaxApplied: getJobContext<FeeTaxContext>(job.id, 'fee_tax')?.applied === true, staked: job.config.staking?.enabled === true, recovered: true },
  })
}

async function finishFromWallet(job: RunnableJob, privateKey: `0x${string}`) {
  const snapshot = job.plan.snapshot
  const context = getJobContext<PrecheckContext>(job.id, 'precheck')
  if (!context) throw new Error('E_RECOVERY_CONTEXT')
  let records = await confirmedReceipts(job.id)
  const collectedFunds = contextFunds(job.id, records, snapshot)
  const feeTax = await ensureFeeTaxPlan(job, collectedFunds)
  const prior = priorComponents(context)
  const deployableFunds = {
    ...collectedFunds,
    principal0: collectedFunds.principal0 + (prior.principal[low(snapshot.token0)] ?? 0n) + (job.config.fees.handling === 'reinvest' && low(snapshot.token0) === low(job.config.quoteToken) ? feeTax.rewardAfterTax : 0n),
    principal1: collectedFunds.principal1 + (prior.principal[low(snapshot.token1)] ?? 0n) + (job.config.fees.handling === 'reinvest' && low(snapshot.token1) === low(job.config.quoteToken) ? feeTax.rewardAfterTax : 0n),
    fee0: feeTax.fee0AfterTax,
    fee1: feeTax.fee1AfterTax,
  }
  const state = applyExecutedSwaps({ job, funds: deployableFunds, receipts: records })
  const current = await readTokenBalances(job.config.owner, [snapshot.token0, snapshot.token1])
  assertWalletAllocationUpdate(job.walletId, job.config.id, current, {
    [low(snapshot.token0)]: (prior.held[low(snapshot.token0)] ?? 0n) + state.lp0 + state.held0 + (job.config.fees.handling !== 'reinvest' && low(snapshot.token0) === low(job.config.quoteToken) ? feeTax.rewardAfterTax : 0n),
    [low(snapshot.token1)]: (prior.held[low(snapshot.token1)] ?? 0n) + state.lp1 + state.held1 + (job.config.fees.handling !== 'reinvest' && low(snapshot.token1) === low(job.config.quoteToken) ? feeTax.rewardAfterTax : 0n),
  })

  let oldOwner: Address | undefined
  try {
    oldOwner = await publicClient.readContract({ address: job.config.positionManager, abi: clPmAbi, functionName: 'ownerOf', args: [BigInt(snapshot.tokenId)] })
  } catch {
    // A successfully burned ERC-721 no longer has an owner.
  }
  if (oldOwner) {
    if (low(oldOwner) !== low(job.config.owner)) throw new Error('E_OWNER')
    const empty = await readStrategySnapshot(walletCustodyConfig(job))
    if (BigInt(empty.liquidity) !== 0n || BigInt(empty.tokensOwed0) !== 0n || BigInt(empty.tokensOwed1) !== 0n) throw new Error('E_POSITION_CHANGED')
    if (job.config.execution.lowTransactionMode) {
      markStep({ jobId: job.id, index: 3, state: 'confirmed', result: { skipped: true, retainedEmptyNft: true, lowTransactionMode: true } })
    } else try {
      const burnReceipt = await sendTracked({ config: job.config, jobId: job.id, stepIndex: 3, txIndex: nextTransactionIndex(job.id, 3), privateKey, tx: burnCall(job.config, snapshot.tokenId) })
      records.push({ stepIndex: 3, txIndex: 0, receipt: burnReceipt })
    } catch (error) {
      // Burning the empty NFT is optional; no token funds are at risk.
      audit('recovery', 'empty_nft_retained', 'job', job.id, { reason: error instanceof Error ? error.message.slice(0, 80) : 'unknown' })
    }
  }

  const pool = await readPoolState(job.config)
  const range = freshRange(job.config, snapshot, pool.tick, job.plan.triggerSide, job.plan.rangeScale ?? 1)
  const remainingFunds: CycleFunds = { principal0: state.lp0, principal1: state.lp1, fee0: state.held0, fee1: state.held1 }
  const cycle = await planCycleSwaps({
    config: job.config,
    snapshot,
    sqrtPriceX96: pool.sqrtPriceX96,
    tickLower: range.tickLower,
    tickUpper: range.tickUpper,
    funds: remainingFunds,
    quote: async (tokenIn, tokenOut, amountIn) => {
      const route = await quoteKyber(tokenIn, tokenOut, amountIn, { protocol: job.config.protocol, tickSpacing: snapshot.tickSpacing, feePpm: snapshot.feePpm })
      return { amountOut: BigInt(route.routeSummary.amountOut), routeSummary: route.routeSummary }
    },
  })
  let lp0 = cycle.lp0
  let lp1 = cycle.lp1
  let held0 = cycle.held0
  let held1 = cycle.held1
  const projected = { amount0: lp0, amount1: lp1 }
  const projectedTotal = {
    amount0: lp0 + held0 + (prior.held[low(snapshot.token0)] ?? 0n) + (job.config.fees.handling !== 'reinvest' && low(snapshot.token0) === low(job.config.quoteToken) ? feeTax.rewardAfterTax : 0n),
    amount1: lp1 + held1 + (prior.held[low(snapshot.token1)] ?? 0n) + (job.config.fees.handling !== 'reinvest' && low(snapshot.token1) === low(job.config.quoteToken) ? feeTax.rewardAfterTax : 0n),
  }
  for (const intent of cycle.swaps) {
    const split = allocateSwapOutput(intent, intent.quotedOut)
    if (low(intent.tokenIn) === low(snapshot.token0)) {
      projected.amount0 -= intent.principalIn
      projected.amount1 += split.principalOut
      projectedTotal.amount0 -= intent.amountIn
      projectedTotal.amount1 += intent.quotedOut
    } else {
      projected.amount1 -= intent.principalIn
      projected.amount0 += split.principalOut
      projectedTotal.amount1 -= intent.amountIn
      projectedTotal.amount0 += intent.quotedOut
    }
    if (job.config.safeguards.enabled && job.config.safeguards.maxSwapImpactBps !== undefined && swapImpactBps(intent.amountIn, intent.quotedOut, intent.tokenIn, intent.tokenOut, snapshot, pool.sqrtPriceX96) > BigInt(Math.floor(job.config.safeguards.maxSwapImpactBps)))
      throw new Error('E_SWAP_IMPACT')
  }
  if (job.config.safeguards.enabled && job.config.safeguards.maxRiskAssetPct !== undefined && riskAssetPct(projectedTotal.amount0, projectedTotal.amount1, job.config, snapshot, pool.sqrtPriceX96) > job.config.safeguards.maxRiskAssetPct)
    throw new Error('E_RISK_LIMIT')

  let swapPlan = getJobContext<SwapPlanContext>(job.id, 'swap_plan') ?? { swaps: [] }
  const executedSwapIndexes = new Set(records.filter((row) => row.stepIndex === 5).map((row) => row.txIndex))
  let nextSwapTx = Math.max(nextTransactionIndex(job.id, 5), ...swapPlan.swaps.map((record) => record.txIndex + 1), 0)
  const pendingTax: { intent: SwapIntent; txIndex: number }[] = []
  const taxRecords: SwapPlanRecord[] = []
  for (const intent of feeTax.swaps) {
    const existing = swapPlan.swaps.find((record) => record.purpose === 'fee_tax' && low(record.tokenIn) === low(intent.tokenIn) && BigInt(record.amountIn) === intent.amountIn)
    const txIndex = existing?.txIndex ?? nextSwapTx++
    const record: SwapPlanRecord = { txIndex, purpose: 'fee_tax', tokenIn: intent.tokenIn, tokenOut: intent.tokenOut, amountIn: intent.amountIn.toString(), quotedOut: intent.quotedOut.toString(), principalIn: '0', feeIn: intent.feeIn.toString() }
    taxRecords.push(record)
    if (!executedSwapIndexes.has(txIndex)) pendingTax.push({ intent, txIndex })
  }
  while (taxRecords.some((record) => record.txIndex === nextSwapTx)) nextSwapTx += 1
  const reusableStrategyRecords = swapPlan.swaps.filter((record) => record.purpose !== 'fee_tax' && !executedSwapIndexes.has(record.txIndex))
  const strategyRecords = cycle.swaps.map((intent) => {
    const reusableIndex = reusableStrategyRecords.findIndex((record) => low(record.tokenIn) === low(intent.tokenIn) && low(record.tokenOut) === low(intent.tokenOut))
    const reusable = reusableIndex >= 0 ? reusableStrategyRecords.splice(reusableIndex, 1)[0] : undefined
    const txIndex = reusable?.txIndex ?? nextSwapTx++
    return { txIndex, purpose: intent.purpose, tokenIn: intent.tokenIn, tokenOut: intent.tokenOut, amountIn: intent.amountIn.toString(), quotedOut: intent.quotedOut.toString(), principalIn: intent.principalIn.toString(), feeIn: intent.feeIn.toString(), route: routeAudit(intent.routeSummary) }
  })
  const pendingSwaps = [...pendingTax, ...cycle.swaps.map((intent, index) => ({ intent, txIndex: strategyRecords[index].txIndex }))]
  swapPlan = {
    ...swapPlan,
    tick: pool.tick,
    sqrtPriceX96: pool.sqrtPriceX96.toString(),
    tickLower: range.tickLower,
    tickUpper: range.tickUpper,
    swaps: upsertSwapRecords(swapPlan.swaps, [...taxRecords, ...strategyRecords]),
  }
  setJobContext(job.id, 'swap_plan', swapPlan)

  if (job.config.execution.maxDailyTurnoverQuote !== undefined) {
    const quoteDecimals = low(job.config.quoteToken) === low(snapshot.token0) ? snapshot.token0Decimals : snapshot.token1Decimals
    const limit = parseUnits(job.config.execution.maxDailyTurnoverQuote, quoteDecimals)
    const priorTurnover = state.executed.reduce((total, item) => total + quoteTurnover(item.spent, item.intent.tokenIn, job.config, snapshot, pool.sqrtPriceX96), 0n)
    const newTurnover = pendingSwaps.reduce((total, item) => total + quoteTurnover(item.intent.amountIn, item.intent.tokenIn, job.config, snapshot, pool.sqrtPriceX96), 0n)
    reserveDailyTurnover({ jobId: job.id, walletId: job.walletId, quoteToken: job.config.quoteToken, amount: stakingRewardTurnover(job) + priorTurnover + newTurnover, limit })
  }

  let approvalTx = nextTransactionIndex(job.id, 4)
  for (const { intent, txIndex } of pendingSwaps) {
    const fallback = intent.purpose === 'fee_tax' ? undefined : { protocol: job.config.protocol, tickSpacing: snapshot.tickSpacing, feePpm: snapshot.feePpm }
    const approvalQuote = await quoteKyber(intent.tokenIn, intent.tokenOut, intent.amountIn, fallback)
    const approvalGate = await gatedKyberTx({ routeSummary: approvalQuote.routeSummary, tokenIn: intent.tokenIn, tokenOut: intent.tokenOut, sender: job.config.owner, recipient: job.config.owner, amountIn: intent.amountIn, slippageBps: job.config.safeguards.maxSlippageBps, nativeIn: false })
    const approvals = await grantStrategyAllowance({ config: job.config, jobId: job.id, stepIndex: 4, txIndexStart: approvalTx, privateKey, token: intent.tokenIn, spender: approvalGate.approvalTarget, amount: intent.amountIn, forceExact: approvalGate.exactApproval })
    approvalTx += approvals.length
    const quote = approvalQuote
    const gated = await gatedKyberTx({ routeSummary: quote.routeSummary, tokenIn: intent.tokenIn, tokenOut: intent.tokenOut, sender: job.config.owner, recipient: job.config.owner, amountIn: intent.amountIn, slippageBps: job.config.safeguards.maxSlippageBps, nativeIn: false })
    const executableIntent = { ...intent, quotedOut: BigInt(quote.routeSummary.amountOut), routeSummary: quote.routeSummary }
    const currentRecord = latestSwapRecord(swapPlan.swaps, txIndex)
    if (!currentRecord) throw new Error('E_RECOVERY_CONTEXT')
    swapPlan = {
      ...swapPlan,
      swaps: upsertSwapRecords(swapPlan.swaps, [{
        ...currentRecord,
        quotedOut: quote.routeSummary.amountOut,
        minOut: gated.minOut.toString(),
        route: routeAudit(quote.routeSummary, gated),
      }]),
    }
    setJobContext(job.id, 'swap_plan', swapPlan)
    const before = await readTokenBalances(job.config.owner, [intent.tokenIn, intent.tokenOut])
    const receipt = await sendTracked({ config: job.config, jobId: job.id, stepIndex: 5, txIndex, privateKey, tx: gated })
    const after = await readTokenBalances(job.config.owner, [intent.tokenIn, intent.tokenOut])
    const spent = before[low(intent.tokenIn)] - after[low(intent.tokenIn)]
    const gained = after[low(intent.tokenOut)] - before[low(intent.tokenOut)]
    const execution = allocateSwapExecution(executableIntent, spent, gained, gated.minOut)
    if (gated.approvalTarget.toLowerCase() !== approvalGate.approvalTarget.toLowerCase()) throw new Error('E_SWAP_SPENDER_CHANGED')
    const revokeReceipts = await revokeStrategyAllowance({ config: job.config, jobId: job.id, stepIndex: 4, txIndexStart: approvalTx, privateKey, token: intent.tokenIn, spender: gated.approvalTarget, forceExact: gated.exactApproval })
    approvalTx += revokeReceipts.length
    if (intent.purpose === 'fee_tax') {
      const refundToLp = job.config.fees.handling === 'reinvest'
      if (low(intent.tokenIn) === low(snapshot.token0)) {
        if (refundToLp) lp0 += execution.unspentFee
        else held0 += execution.unspentFee
      } else {
        if (refundToLp) lp1 += execution.unspentFee
        else held1 += execution.unspentFee
      }
      continue
    }
    if (low(intent.tokenIn) === low(snapshot.token0)) {
      lp0 -= execution.principalSpent
      held0 -= execution.feeSpent
      lp1 += execution.principalOut
      held1 += execution.feeOut
    } else {
      lp1 -= execution.principalSpent
      held1 -= execution.feeSpent
      lp0 += execution.principalOut
      held0 += execution.feeOut
    }
  }
  if (job.config.safeguards.enabled && job.config.safeguards.maxRiskAssetPct !== undefined && riskAssetPct(
    lp0 + held0 + (prior.held[low(snapshot.token0)] ?? 0n) + (job.config.fees.handling !== 'reinvest' && low(snapshot.token0) === low(job.config.quoteToken) ? feeTax.rewardAfterTax : 0n),
    lp1 + held1 + (prior.held[low(snapshot.token1)] ?? 0n) + (job.config.fees.handling !== 'reinvest' && low(snapshot.token1) === low(job.config.quoteToken) ? feeTax.rewardAfterTax : 0n),
    job.config,
    snapshot,
    pool.sqrtPriceX96,
  ) > job.config.safeguards.maxRiskAssetPct)
    throw new Error('E_RISK_LIMIT')

  const mintPool = await readPoolState(job.config)
  const capital = await strategyCapitalHarvest({ config: job.config, snapshot, sqrtPriceX96: mintPool.sqrtPriceX96, amount0: lp0, amount1: lp1 })
  setJobContext(job.id, 'capital_allocation', {
    triggered: capital.triggered,
    deploy0: capital.deploy0.toString(), deploy1: capital.deploy1.toString(),
    profit0: capital.profit0.toString(), profit1: capital.profit1.toString(),
    activeValueQuote: capital.activeValueQuote.toString(), capitalCapQuote: capital.capitalCapQuote.toString(),
    excessValueQuote: capital.excessValueQuote.toString(), excessValueUsdg: capital.excessValueUsdg.toString(),
  })
  await grantStrategyAllowance({ config: job.config, jobId: job.id, stepIndex: 6, txIndexStart: nextTransactionIndex(job.id, 6), privateKey, token: snapshot.token0, spender: job.config.positionManager, amount: capital.deploy0 })
  await grantStrategyAllowance({ config: job.config, jobId: job.id, stepIndex: 7, txIndexStart: nextTransactionIndex(job.id, 7), privateKey, token: snapshot.token1, spender: job.config.positionManager, amount: capital.deploy1 })
  const mintRange = freshRange(job.config, snapshot, mintPool.tick, job.plan.triggerSide, job.plan.rangeScale ?? 1)
  const mintReceipt = await sendTracked({
    config: job.config,
    jobId: job.id,
    stepIndex: 8,
    txIndex: nextTransactionIndex(job.id, 8),
    privateKey,
    tx: mintCall({ config: job.config, snapshot, tickLower: mintRange.tickLower, tickUpper: mintRange.tickUpper, amount0Desired: capital.deploy0, amount1Desired: capital.deploy1, feePpm: mintPool.feePpm, sqrtPriceX96: mintPool.sqrtPriceX96 }),
  })
  const minted = receiptLiquidityFlows(mintReceipt, job.config.positionManager, 0n)
  if (!minted.mintedTokenId) throw new Error('E_MINT_TOKEN_ID')
  const owner = await publicClient.readContract({ address: job.config.positionManager, abi: clPmAbi, functionName: 'ownerOf', args: [minted.mintedTokenId] })
  if (low(owner) !== low(job.config.owner)) throw new Error('E_OWNER')
  await revokeStrategyAllowance({ config: job.config, jobId: job.id, stepIndex: 9, txIndexStart: nextTransactionIndex(job.id, 9), privateKey, token: snapshot.token0, spender: job.config.positionManager })
  await revokeStrategyAllowance({ config: job.config, jobId: job.id, stepIndex: 10, txIndexStart: nextTransactionIndex(job.id, 10), privateKey, token: snapshot.token1, spender: job.config.positionManager })
  await commitFromChainFacts(job, privateKey)
}

async function executeRecoveryLocked(jobId: string) {
  let job = recoveryJobById(jobId)
  if (!job) return { disposition: 'already_completed', completed: true }
  const inspection = await inspectRecovery(jobId, { reconcile: true })
  if (inspection.disposition === 'manual_review' || inspection.disposition === 'wait_pending') throw new Error(inspection.disposition === 'wait_pending' ? 'E_RECOVERY_PENDING' : 'E_NONCE')
  if (inspection.disposition === 'restart_safe') {
    job = await refreshAutomaticDailyLimit(job)
    abandonRecoveryJob(jobId)
    audit('recovery', 'job_abandoned_safe', 'job', jobId)
    return { disposition: 'restart_safe', completed: true }
  }

  job = await normalizeWethQuoteBeforeRecovery(job, inspection.disposition)

  setJobState(jobId, 'running')
  setStrategyState(job.config.id, 'executing')
  try {
    const unlocked = unlockPrivateKey(job.walletId)
    if (low(unlocked.address) !== low(job.config.owner)) throw new Error('E_OWNER')
    const finish = job.plan.action === 'collect_fees' ? finishFeeCollection : job.plan.action === 'hold_quote' ? finishHoldQuote : finishFromWallet
    if (inspection.disposition === 'resume_collect') {
      if (job.config.staking?.enabled) await ensureUnstakedAndRewardConverted(job, unlocked.privateKey)
      const position = await readStrategySnapshot(walletCustodyConfig(job))
      if (BigInt(position.liquidity) !== 0n) throw new Error('E_POSITION_CHANGED')
      if (job.config.execution.lowTransactionMode) markStep({ jobId, index: 2, state: 'confirmed', result: { bundledWithStep: 1, recovered: true } })
      else await sendTracked({ config: job.config, jobId, stepIndex: 2, txIndex: nextTransactionIndex(jobId, 2), privateKey: unlocked.privateKey, tx: collectCall(job.config, job.plan.snapshot.tokenId) })
      const records = await confirmedReceipts(jobId)
      contextFunds(jobId, records, job.plan.snapshot)
      await finish(job, unlocked.privateKey)
    } else if (inspection.disposition === 'resume_staking_exit') {
      if (!job.config.staking?.enabled || job.plan.action === 'collect_fees') throw new Error('E_RECOVERY_CONTEXT')
      await ensureUnstakedAndRewardConverted(job, unlocked.privateKey)
      const position = await readStrategySnapshot(walletCustodyConfig(job))
      if (position.liquidity !== job.plan.snapshot.liquidity || low(position.owner) !== low(job.config.owner)) throw new Error('E_POSITION_CHANGED')
      setJobContext(job.id, 'exit_valuation', { observedAt: position.observedAt, blockNumber: position.blockNumber, tick: position.tick, sqrtPriceX96: position.sqrtPriceX96, source: 'recovery_pre_decrease_snapshot' })
      await sendTracked({ config: job.config, jobId, stepIndex: 1, txIndex: nextTransactionIndex(jobId, 1), privateKey: unlocked.privateKey, tx: job.config.execution.lowTransactionMode ? decreaseCollectCall(job.config, position) : decreaseCall(job.config, position) })
      if (job.config.execution.lowTransactionMode) markStep({ jobId, index: 2, state: 'confirmed', result: { bundledWithStep: 1, recovered: true } })
      else await sendTracked({ config: job.config, jobId, stepIndex: 2, txIndex: nextTransactionIndex(jobId, 2), privateKey: unlocked.privateKey, tx: collectCall(job.config, job.plan.snapshot.tokenId) })
      const records = await confirmedReceipts(jobId)
      contextFunds(jobId, records, job.plan.snapshot)
      await finish(job, unlocked.privateKey)
    } else if (inspection.disposition === 'resume_from_wallet') {
      if (job.config.staking?.enabled) await ensureUnstakedAndRewardConverted(job, unlocked.privateKey)
      await finish(job, unlocked.privateKey)
    } else if (inspection.disposition === 'resume_revoke') {
      await revokeStrategyAllowance({ config: job.config, jobId, stepIndex: 9, txIndexStart: nextTransactionIndex(jobId, 9), privateKey: unlocked.privateKey, token: job.plan.snapshot.token0, spender: job.config.positionManager })
      await revokeStrategyAllowance({ config: job.config, jobId, stepIndex: 10, txIndexStart: nextTransactionIndex(jobId, 10), privateKey: unlocked.privateKey, token: job.plan.snapshot.token1, spender: job.config.positionManager })
      await commitFromChainFacts(job, unlocked.privateKey)
    } else {
      await commitFromChainFacts(job, unlocked.privateKey)
    }
    audit('recovery', 'job_recovered', 'job', jobId, { from: inspection.disposition })
    return { disposition: inspection.disposition, completed: true }
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 120) : 'E_RECOVERY'
    setJobState(jobId, 'recovery')
    setStrategyState(job.config.id, 'recovery')
    audit('recovery', 'job_recovery_failed', 'job', jobId, { code })
    throw error
  }
}

export async function executeRecovery(jobId: string) {
  const job = recoveryJobById(jobId)
  if (!job) throw new Error('E_RECOVERY_JOB')
  if ((job.plan as unknown as { kind?: string }).kind === 'profit_withdrawal')
    return withWalletLock(job.walletId, () => recoverRetainedProfit(jobId))
  return withWalletLock(job.walletId, () => executeRecoveryLocked(jobId))
}

/**
 * Stop automation and archive its local record without signing a transaction.
 * Recovery may only be abandoned after chain facts prove that no approval,
 * swap, mint, or pending/ambiguous transaction needs cleanup.
 */
export async function stopAndArchiveStrategy(strategyId: string) {
  const initial = strategyById(strategyId)
  if (!initial) throw new Error('E_STRATEGY_MISSING')
  const walletId = initial.config.execution.walletId
  const stop = async () => {
    const current = strategyById(strategyId)
    if (!current) return { archived: true, chainTransactions: 0, assetLocation: 'unchanged' }
    if (current.state === 'executing') throw new Error('E_STRATEGY_BUSY')
    const finalPerformance = async () => {
      try {
        const value = await strategyPerformance(current.config, current.state)
        recordPerformanceDay(value)
        return value.summary.currentValueQuoteRaw === null ? undefined : value
      } catch { return undefined }
    }
    const activeJob = activeJobForStrategy(strategyId)
    if (!activeJob) {
      const assetLocation = current.config.activeTokenId ? 'position' : 'wallet'
      archiveStrategy({ strategyId, assetLocation, performance: await finalPerformance() })
      return { archived: true, chainTransactions: 0, assetLocation }
    }
    if (activeJob.state === 'running') throw new Error('E_STRATEGY_BUSY')
    if (activeJob.state === 'planned') {
      if (jobTransactions(activeJob.id).length) throw new Error('E_STRATEGY_BUSY')
      archiveStrategy({ strategyId, jobId: activeJob.id, assetLocation: 'position', performance: await finalPerformance() })
      return { archived: true, chainTransactions: 0, assetLocation: 'position' }
    }

    const inspection = await inspectRecovery(activeJob.id, { reconcile: true })
    if (inspection.disposition === 'manual_review' || inspection.disposition === 'wait_pending')
      throw new Error(inspection.disposition === 'wait_pending' ? 'E_RECOVERY_PENDING' : 'E_NONCE')
    const confirmed = inspection.transactions.filter((tx) => tx.state === 'confirmed')
    // Stopping automation is always possible once every submitted transaction
    // has a definite chain outcome. Later swap/mint/stake facts may make exact
    // strategy attribution impossible (especially after manual wallet actions),
    // but they do not justify trapping the user in an undeletable retry loop.
    if (confirmed.some((tx) => tx.stepIndex >= 4)) {
      archiveStrategy({ strategyId, jobId: activeJob.id, assetLocation: 'recovery_interrupted' })
      return { archived: true, chainTransactions: 0, assetLocation: 'recovery_interrupted' }
    }

    let allocations: Record<string, bigint> | undefined
    let assetLocation = inspection.disposition === 'restart_safe' ? 'position' : 'position_owed'
    if (inspection.disposition === 'resume_from_wallet') {
      const job = recoveryJobById(activeJob.id)
      if (!job || job.plan.action !== 'recenter') throw new Error('E_STOP_REQUIRES_RECOVERY')
      const context = getJobContext<PrecheckContext>(job.id, 'precheck')
      if (!context) throw new Error('E_RECOVERY_CONTEXT')
      const records = await confirmedReceipts(job.id)
      const funds = contextFunds(job.id, records, job.plan.snapshot)
      const state = applyExecutedSwaps({ job, funds: applyStoredFeeTax(job.id, funds), receipts: records })
      const prior = Object.fromEntries(Object.entries(context.prior).map(([token, amount]) => [low(token), BigInt(amount)]))
      allocations = {
        [low(job.plan.snapshot.token0)]: (prior[low(job.plan.snapshot.token0)] ?? 0n) + state.lp0 + state.held0,
        [low(job.plan.snapshot.token1)]: (prior[low(job.plan.snapshot.token1)] ?? 0n) + state.lp1 + state.held1,
      }
      const balances = await readTokenBalances(job.config.owner, context.trackedTokens)
      assertWalletAllocationUpdate(job.walletId, job.config.id, balances, allocations)
      assetLocation = 'wallet'
    }
    archiveStrategy({ strategyId, jobId: activeJob.id, allocations, assetLocation, performance: assetLocation === 'position' ? await finalPerformance() : undefined })
    return { archived: true, chainTransactions: 0, assetLocation }
  }
  return walletId ? withWalletLock(walletId, stop) : stop()
}
