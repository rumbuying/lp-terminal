import { randomUUID } from 'node:crypto'
import { encodeFunctionData, zeroAddress, type Address, type TransactionReceipt } from 'viem'
import { wethAbi } from '../src/abi'
import { ADDR, NATIVE } from '../src/config/addresses'
import type { LedgerEntry } from '../shared/strategy/types'
import { exactAllowance } from './allowance'
import { publicClient, readStrategySnapshot, readTokenBalances } from './chain'
import { gatedKyberTx, quoteKyber, routeAudit } from './kyber'
import { currentUsdgValueInWeth, quoteValueInUsdg } from './stable-valuation'
import { invalidateStrategyPerformance } from './performance'
import { sendTracked } from './signer'
import {
  activeJobForStrategy,
  assertWalletAllocations,
  audit,
  abandonProfitWithdrawalJob,
  commitProfitAllocationMutation,
  completeProfitWithdrawalJob,
  createProfitWithdrawalJob,
  db,
  executorPaused,
  failProfitWithdrawalJob,
  getJobContext,
  recoveryJobById,
  setJobContext,
  strategyAllocationComponents,
  strategyById,
  walletAllocationTokens,
  walletHasUnfinishedMutation,
  type AllocationComponent,
  type ProfitWithdrawalTarget,
} from './store'
import { unlockPrivateKey } from './vault'
import { withWalletLock } from './wallet-lock'
import { receiptTokenDelta } from './receipts'
import { reconcileRecoveryTransactions } from './recovery'

const low = (value: string) => value.toLowerCase()
const zeroComponent = (): AllocationComponent => ({ principal: 0n, heldFee: 0n, heldProfit: 0n })
const isNativeCurrency = (token: Address) => low(token) === low(zeroAddress) || low(token) === low(NATIVE)
const routeCurrency = (token: Address) => isNativeCurrency(token) ? NATIVE : token
const receiptGas = (receipt: TransactionReceipt) => receipt.gasUsed * receipt.effectiveGasPrice
const receivedByWallet = (before: bigint, after: bigint, receipt: TransactionReceipt, token: Address) =>
  after - before + (isNativeCurrency(token) ? receiptGas(receipt) : 0n)
const spentByWallet = (before: bigint, after: bigint, receipt: TransactionReceipt, token: Address) =>
  before - after - (isNativeCurrency(token) ? receiptGas(receipt) : 0n)

export type ProfitWithdrawalResult = {
  id: string
  strategyId: string
  target: ProfitWithdrawalTarget
  amountRaw: string
  decimals: number
  quoteValueRaw: string
  usdgValueRaw: string
  gasWei: string
  txHashes: string[]
  withdrawnAt: number
}

type ProfitSwapRecord = {
  stepIndex: number
  tokenIn: Address
  tokenOut: Address
  amountIn: string
  quotedOut: string
  minOut: string
}

type ProfitWithdrawalContext = {
  target: ProfitWithdrawalTarget
  settlementToken: Address
  trackedTokens: Address[]
  sources: { token: Address; amount: string }[]
  swaps: ProfitSwapRecord[]
  release?: { amountOut: string; quoteValue: string; usdgValue: string; decimals: number }
}

function gasUsed(receipts: TransactionReceipt[]) {
  return receipts.reduce((total, receipt) => total + receipt.gasUsed * receipt.effectiveGasPrice, 0n)
}

async function finalizeWithdrawal(args: {
  jobId: string
  walletId: string
  config: NonNullable<ReturnType<typeof strategyById>>['config']
  context: ProfitWithdrawalContext
  receipts: TransactionReceipt[]
  sourceAudit: { token: string; amountIn: string; amountOut: string; txHash?: string }[]
}): Promise<ProfitWithdrawalResult> {
  const release = args.context.release
  if (!release) throw new Error('E_PROFIT_WITHDRAWAL_CONTEXT')
  const amountOut = BigInt(release.amountOut)
  const quoteValue = BigInt(release.quoteValue)
  const usdgValue = BigInt(release.usdgValue)
  const gasWei = gasUsed(args.receipts)
  let gasQuote = 0n
  if (gasWei > 0n) {
    gasQuote = low(args.config.quoteToken) === low(ADDR.WNATIVE) || isNativeCurrency(args.config.quoteToken)
      ? gasWei
      : await quoteKyber(ADDR.WNATIVE, routeCurrency(args.config.quoteToken), gasWei).then((quote) => BigInt(quote.routeSummary.amountOut)).catch(() => 0n)
  }
  const gasUsdg = quoteValue > 0n ? (gasQuote * usdgValue) / quoteValue : 0n
  const finalBalances = await readTokenBalances(args.config.owner, args.context.trackedTokens)
  const releaseBefore = strategyAllocationComponents(args.config.id)[low(args.context.settlementToken)] ?? zeroComponent()
  if (releaseBefore.heldProfit !== amountOut) throw new Error('E_ALLOCATION_CHANGED')
  const releaseAfter = { ...releaseBefore, heldProfit: 0n }
  const withdrawnAt = Math.floor(Date.now() / 1000)
  const txHashes = args.receipts.map((receipt) => receipt.transactionHash)
  const finalTx = args.receipts.at(-1)
  const result: ProfitWithdrawalResult = {
    id: args.jobId,
    strategyId: args.config.id,
    target: args.context.target,
    amountRaw: amountOut.toString(),
    decimals: release.decimals,
    quoteValueRaw: quoteValue.toString(),
    usdgValueRaw: usdgValue.toString(),
    gasWei: gasWei.toString(),
    txHashes,
    withdrawnAt,
  }
  const summaryEntry: LedgerEntry = {
    id: `${args.jobId}-withdrawal`, strategyId: args.config.id, jobId: args.jobId, ts: withdrawnAt,
    blockNumber: finalTx?.blockNumber.toString(), txHash: finalTx?.transactionHash,
    kind: 'profit_withdrawal', token: args.context.settlementToken, amount: amountOut.toString(), quoteValue: quoteValue.toString(),
    meta: { id: args.jobId, target: args.context.target, decimals: result.decimals, withdrawnAt, usdgValueRaw: usdgValue.toString(), gasWei: gasWei.toString(), gasQuoteRaw: gasQuote.toString(), gasUsdgRaw: gasUsdg.toString(), txHashes, sources: args.sourceAudit },
  }
  commitProfitAllocationMutation({
    strategyId: args.config.id, walletId: args.walletId,
    expected: { [low(args.context.settlementToken)]: releaseBefore },
    next: { [low(args.context.settlementToken)]: releaseAfter },
    balances: finalBalances,
    ledger: [summaryEntry],
  })
  completeProfitWithdrawalJob(args.jobId, result)
  invalidateStrategyPerformance(args.config.id)
  audit('api', 'retained_profit_withdrawn', 'strategy', args.config.id, result)
  return result
}

async function valueOutput(amount: bigint, token: Address, quoteToken: Address) {
  const quoteValue = low(token) === low(quoteToken)
    ? amount
    : low(token) === low(ADDR.WNATIVE) && isNativeCurrency(quoteToken)
    ? amount
    : low(token) === low(ADDR.STABLE) && (low(quoteToken) === low(ADDR.WNATIVE) || isNativeCurrency(quoteToken))
    ? await currentUsdgValueInWeth(amount)
    : BigInt((await quoteKyber(routeCurrency(token), routeCurrency(quoteToken), amount)).routeSummary.amountOut)
  const usdgValue = low(token) === low(ADDR.STABLE)
    ? amount
    : await quoteValueInUsdg(quoteValue, quoteToken)
  return { quoteValue, usdgValue }
}

/**
 * Settle every currently retained-profit component into one user-selected
 * currency. ERC-20 output remains in the owner wallet but is released from
 * strategy allocation; ETH output is unwrapped from only the attributed WETH.
 */
export async function withdrawRetainedProfit(strategyId: string, target: ProfitWithdrawalTarget): Promise<ProfitWithdrawalResult> {
  if (!['USDG', 'WETH', 'ETH'].includes(target)) throw new Error('E_PROFIT_TARGET')
  const initial = strategyById(strategyId)
  if (!initial) throw new Error('strategy not found')
  const walletId = initial.config.execution.walletId
  if (!walletId) throw new Error('E_WALLET')

  return withWalletLock(walletId, async () => {
    if (executorPaused()) throw new Error('E_EXECUTOR_PAUSED')
    const row = strategyById(strategyId)
    if (!row || row.config.execution.walletId !== walletId) throw new Error('E_STRATEGY_CHANGED')
    if (['planned', 'executing', 'recovery', 'recovery_quarantined'].includes(row.state) || activeJobForStrategy(strategyId)) throw new Error('E_STRATEGY_BUSY')
    if (walletHasUnfinishedMutation(walletId)) throw new Error('E_WALLET_RECOVERY')

    const settlementToken = target === 'USDG' ? ADDR.STABLE : ADDR.WNATIVE
    const initialComponents = strategyAllocationComponents(strategyId)
    const sources = Object.entries(initialComponents)
      .filter(([, component]) => component.heldProfit > 0n)
      .map(([token, component]) => ({ token: token as Address, amount: component.heldProfit }))
    if (!sources.length) throw new Error('E_NO_RETAINED_PROFIT')

    const trackedTokens = [...new Set([...walletAllocationTokens(walletId), low(settlementToken), ...sources.map((source) => low(source.token))])] as Address[]
    const baseline = await readTokenBalances(row.config.owner, trackedTokens)
    assertWalletAllocations(walletId, baseline)
    for (const source of sources) if ((baseline[low(source.token)] ?? 0n) < source.amount) throw new Error('E_ALLOCATION_MISMATCH')

    // Reading the position here proves that the strategy identity still
    // matches its configured pool before any retained assets are exchanged.
    await readStrategySnapshot(row.config, { allowRewardReadFailure: true })
    const unlocked = unlockPrivateKey(walletId)
    if (low(unlocked.address) !== low(row.config.owner)) throw new Error('E_OWNER')

    const jobId = `profit-${randomUUID()}`
    const steps = sources.filter((source) => low(source.token) !== low(settlementToken)).flatMap((_, index) => {
      const base = index * 3
      return [{ index: base, kind: 'profit_approve' }, { index: base + 1, kind: 'profit_swap' }, { index: base + 2, kind: 'profit_revoke' }]
    })
    if (target === 'ETH') steps.push({ index: 9, kind: 'profit_unwrap' })
    steps.push({ index: 11, kind: 'profit_withdrawal_commit' })
    if (!createProfitWithdrawalJob({ id: jobId, strategyId, target, steps })) throw new Error('E_STRATEGY_BUSY')
    let context: ProfitWithdrawalContext = {
      target,
      settlementToken,
      trackedTokens,
      sources: sources.map((source) => ({ token: source.token, amount: source.amount.toString() })),
      swaps: [],
    }
    setJobContext(jobId, 'profit_withdrawal', context)

    const receipts: TransactionReceipt[] = []
    const sourceAudit: { token: string; amountIn: string; amountOut: string; txHash?: string }[] = []
    try {
      let conversionIndex = 0
      for (const source of sources) {
        if (low(source.token) === low(settlementToken)) {
          sourceAudit.push({ token: source.token, amountIn: source.amount.toString(), amountOut: source.amount.toString() })
          continue
        }
        const approvalStep = conversionIndex * 3
        const swapStep = approvalStep + 1
        const revokeStep = approvalStep + 2
        conversionIndex += 1

        const routeIn = routeCurrency(source.token)
        const routeOut = routeCurrency(settlementToken)
        const nativeIn = isNativeCurrency(source.token)
        const quote = await quoteKyber(routeIn, routeOut, source.amount)
        const gated = await gatedKyberTx({
          routeSummary: quote.routeSummary,
          tokenIn: routeIn,
          tokenOut: routeOut,
          sender: row.config.owner,
          recipient: row.config.owner,
          amountIn: source.amount,
          slippageBps: row.config.safeguards.maxSlippageBps,
          nativeIn,
        })
        context = {
          ...context,
          swaps: [...context.swaps, {
            stepIndex: swapStep,
            tokenIn: source.token,
            tokenOut: settlementToken,
            amountIn: source.amount.toString(),
            quotedOut: quote.routeSummary.amountOut,
            minOut: gated.minOut.toString(),
          }],
        }
        setJobContext(jobId, 'profit_withdrawal', context)
        receipts.push(...await exactAllowance({
          config: row.config, jobId, stepIndex: approvalStep, privateKey: unlocked.privateKey,
          token: source.token, spender: gated.approvalTarget, amount: source.amount,
          forceExact: true,
        }))
        const before = await readTokenBalances(row.config.owner, trackedTokens)
        const swapReceipt = await sendTracked({ config: row.config, jobId, stepIndex: swapStep, privateKey: unlocked.privateKey, tx: gated })
        receipts.push(swapReceipt)
        const after = await readTokenBalances(row.config.owner, trackedTokens)
        const spent = spentByWallet(before[low(source.token)], after[low(source.token)], swapReceipt, source.token)
        const gained = receivedByWallet(before[low(settlementToken)], after[low(settlementToken)], swapReceipt, settlementToken)
        if (spent !== source.amount || gained < gated.minOut) throw new Error('E_UNSUPPORTED_TOKEN')

        const current = strategyAllocationComponents(strategyId)
        const sourceBefore = current[low(source.token)] ?? zeroComponent()
        const targetBefore = current[low(settlementToken)] ?? zeroComponent()
        if (sourceBefore.heldProfit < spent) throw new Error('E_ALLOCATION_CHANGED')
        const expected: Record<string, AllocationComponent> = { [low(source.token)]: sourceBefore, [low(settlementToken)]: targetBefore }
        const next: Record<string, AllocationComponent> = {
          [low(source.token)]: { ...sourceBefore, heldProfit: sourceBefore.heldProfit - spent },
          [low(settlementToken)]: { ...targetBefore, heldProfit: targetBefore.heldProfit + gained },
        }
        const now = Math.floor(Date.now() / 1000)
        commitProfitAllocationMutation({
          strategyId, walletId, expected, next, balances: after,
          ledger: [
            { id: `${swapReceipt.transactionHash}-profit-in`, strategyId, jobId, ts: now, blockNumber: swapReceipt.blockNumber.toString(), txHash: swapReceipt.transactionHash, kind: 'profit_withdrawal_swap_in', token: source.token, amount: spent.toString(), meta: { target, route: routeAudit(quote.routeSummary, gated) } },
            { id: `${swapReceipt.transactionHash}-profit-out`, strategyId, jobId, ts: now, blockNumber: swapReceipt.blockNumber.toString(), txHash: swapReceipt.transactionHash, kind: 'profit_withdrawal_swap_out', token: settlementToken, amount: gained.toString(), meta: { target, quotedOut: quote.routeSummary.amountOut } },
          ],
        })
        sourceAudit.push({ token: source.token, amountIn: spent.toString(), amountOut: gained.toString(), txHash: swapReceipt.transactionHash })
        receipts.push(...await exactAllowance({
          config: row.config, jobId, stepIndex: revokeStep, privateKey: unlocked.privateKey,
          token: source.token, spender: gated.approvalTarget, amount: 0n,
          forceExact: true,
        }))
      }

      const consolidated = strategyAllocationComponents(strategyId)
      const settlementBefore = consolidated[low(settlementToken)] ?? zeroComponent()
      const amountOut = settlementBefore.heldProfit
      if (amountOut <= 0n) throw new Error('E_NO_RETAINED_PROFIT')
      // Finish every fallible price read before an ETH unwrap. Once WETH has
      // become native ETH there must be no quote dependency between the
      // confirmed chain mutation and releasing its allocation record.
      const { quoteValue, usdgValue } = await valueOutput(amountOut, settlementToken, row.config.quoteToken)
      context = {
        ...context,
        release: { amountOut: amountOut.toString(), quoteValue: quoteValue.toString(), usdgValue: usdgValue.toString(), decimals: target === 'USDG' ? 6 : 18 },
      }
      setJobContext(jobId, 'profit_withdrawal', context)

      if (target === 'ETH') {
        const before = await readTokenBalances(row.config.owner, trackedTokens)
        const unwrapReceipt = await sendTracked({
          config: row.config,
          jobId,
          stepIndex: 9,
          privateKey: unlocked.privateKey,
          tx: { to: ADDR.WNATIVE, data: encodeFunctionData({ abi: wethAbi, functionName: 'withdraw', args: [amountOut] }), value: 0n },
        })
        receipts.push(unwrapReceipt)
        const after = await readTokenBalances(row.config.owner, trackedTokens)
        if (before[low(ADDR.WNATIVE)] - after[low(ADDR.WNATIVE)] !== amountOut) throw new Error('E_UNSUPPORTED_TOKEN')
      }

      return await finalizeWithdrawal({ jobId, walletId, config: row.config, context, receipts, sourceAudit })
    } catch (error) {
      const code = error instanceof Error ? error.message.slice(0, 120) : 'E_PROFIT_WITHDRAWAL'
      failProfitWithdrawalJob(jobId, code)
      audit('api', 'retained_profit_withdrawal_failed', 'strategy', strategyId, { jobId, target, code })
      throw error
    }
  })
}

/**
 * Reconcile a withdrawal interrupted after broadcast. Confirmed swaps are
 * reconstructed from Transfer logs; an absent/reverted next step leaves the
 * remaining profit retained and returns the strategy to monitoring.
 */
export async function recoverRetainedProfit(jobId: string) {
  const job = recoveryJobById(jobId)
  if (!job || (job.plan as unknown as { kind?: string }).kind !== 'profit_withdrawal') throw new Error('E_PROFIT_WITHDRAWAL_JOB')
  const context = getJobContext<ProfitWithdrawalContext>(jobId, 'profit_withdrawal')
  if (!context) throw new Error('E_PROFIT_WITHDRAWAL_CONTEXT')
  const { transactions } = await reconcileRecoveryTransactions(jobId, { reconcile: true })
  if (transactions.some((tx) => tx.state === 'ambiguous')) throw new Error('E_NONCE')
  if (transactions.some((tx) => tx.state === 'pending')) throw new Error('E_RECOVERY_PENDING')

  const confirmed = transactions.filter((tx) => tx.state === 'confirmed' && tx.hash)
  const receipts = await Promise.all(confirmed.map((tx) => publicClient.getTransactionReceipt({ hash: tx.hash! }) as Promise<TransactionReceipt>))
  const receiptByStep = new Map<number, TransactionReceipt>()
  confirmed.forEach((tx, index) => receiptByStep.set(tx.stepIndex, receipts[index]))
  const sourceAudit: { token: string; amountIn: string; amountOut: string; txHash?: string }[] = context.sources
    .filter((source) => low(source.token) === low(context.settlementToken))
    .map((source) => ({ token: source.token, amountIn: source.amount, amountOut: source.amount }))

  let allSwapsConfirmed = true
  for (const swap of context.swaps) {
    const receipt = receiptByStep.get(swap.stepIndex)
    if (!receipt) {
      allSwapsConfirmed = false
      continue
    }
    const recorded = db.prepare(
      `SELECT kind,amount FROM ledger_entries
       WHERE strategy_id=? AND tx_hash=?
         AND kind IN ('profit_withdrawal_swap_in','profit_withdrawal_swap_out')`,
    ).all(job.config.id, receipt.transactionHash) as { kind: string; amount: string }[]
    if (recorded.length) {
      const recordedIn = recorded.find((row) => row.kind === 'profit_withdrawal_swap_in')
      const recordedOut = recorded.find((row) => row.kind === 'profit_withdrawal_swap_out')
      if (!recordedIn || !recordedOut || BigInt(recordedIn.amount) !== BigInt(swap.amountIn) || BigInt(recordedOut.amount) < BigInt(swap.minOut))
        throw new Error('E_ALLOCATION_CHANGED')
      sourceAudit.push({ token: swap.tokenIn, amountIn: recordedIn.amount, amountOut: recordedOut.amount, txHash: receipt.transactionHash })
      continue
    }
    // ERC-20 Transfer logs are sufficient to reconstruct an interrupted swap.
    // Native currency has no equivalent receipt log, and a router may refund
    // value, so do not guess an economic delta after a crash. Normal v4-native
    // withdrawals are supported above; an unrecorded confirmed native swap is
    // deliberately left for operator reconciliation.
    if (isNativeCurrency(swap.tokenIn) || isNativeCurrency(swap.tokenOut))
      throw new Error('E_V4_NATIVE_PROFIT_RECOVERY')
    const spent = -receiptTokenDelta(receipt, swap.tokenIn, job.config.owner)
    const gained = receiptTokenDelta(receipt, swap.tokenOut, job.config.owner)
    if (spent !== BigInt(swap.amountIn) || gained < BigInt(swap.minOut)) throw new Error('E_UNSUPPORTED_TOKEN')
    sourceAudit.push({ token: swap.tokenIn, amountIn: spent.toString(), amountOut: gained.toString(), txHash: receipt.transactionHash })

    const current = strategyAllocationComponents(job.config.id)
    const sourceBefore = current[low(swap.tokenIn)] ?? zeroComponent()
    const targetBefore = current[low(swap.tokenOut)] ?? zeroComponent()
    if (sourceBefore.heldProfit < spent) throw new Error('E_ALLOCATION_CHANGED')
    const balances = await readTokenBalances(job.config.owner, context.trackedTokens)
    commitProfitAllocationMutation({
      strategyId: job.config.id,
      walletId: job.walletId,
      expected: { [low(swap.tokenIn)]: sourceBefore, [low(swap.tokenOut)]: targetBefore },
      next: {
        [low(swap.tokenIn)]: { ...sourceBefore, heldProfit: sourceBefore.heldProfit - spent },
        [low(swap.tokenOut)]: { ...targetBefore, heldProfit: targetBefore.heldProfit + gained },
      },
      balances,
      ledger: [
        { id: `${receipt.transactionHash}-profit-in`, strategyId: job.config.id, jobId, ts: Math.floor(Date.now() / 1000), blockNumber: receipt.blockNumber.toString(), txHash: receipt.transactionHash, kind: 'profit_withdrawal_swap_in', token: swap.tokenIn, amount: spent.toString(), meta: { target: context.target, recovered: true } },
        { id: `${receipt.transactionHash}-profit-out`, strategyId: job.config.id, jobId, ts: Math.floor(Date.now() / 1000), blockNumber: receipt.blockNumber.toString(), txHash: receipt.transactionHash, kind: 'profit_withdrawal_swap_out', token: swap.tokenOut, amount: gained.toString(), meta: { target: context.target, quotedOut: swap.quotedOut, recovered: true } },
      ],
    })
  }
  const postSwapComponents = strategyAllocationComponents(job.config.id)
  if (context.sources.some((source) => low(source.token) !== low(context.settlementToken) && (postSwapComponents[low(source.token)]?.heldProfit ?? 0n) > 0n))
    allSwapsConfirmed = false

  const existingSummary = db.prepare(`SELECT amount,quote_value,meta_json FROM ledger_entries WHERE strategy_id=? AND job_id=? AND kind='profit_withdrawal' LIMIT 1`).get(job.config.id, jobId) as { amount: string; quote_value: string; meta_json: string } | undefined
  if (existingSummary) {
    const meta = JSON.parse(existingSummary.meta_json) as Record<string, unknown>
    const result: ProfitWithdrawalResult = {
      id: jobId,
      strategyId: job.config.id,
      target: context.target,
      amountRaw: existingSummary.amount,
      decimals: Number(meta.decimals ?? (context.target === 'USDG' ? 6 : 18)),
      quoteValueRaw: existingSummary.quote_value,
      usdgValueRaw: String(meta.usdgValueRaw ?? '0'),
      gasWei: String(meta.gasWei ?? '0'),
      txHashes: Array.isArray(meta.txHashes) ? meta.txHashes.filter((value): value is string => typeof value === 'string') : [],
      withdrawnAt: Number(meta.withdrawnAt ?? Math.floor(Date.now() / 1000)),
    }
    completeProfitWithdrawalJob(jobId, result)
    invalidateStrategyPerformance(job.config.id)
    return { disposition: 'profit_withdrawal_committed', completed: true, withdrawal: result }
  }

  if (!allSwapsConfirmed) {
    abandonProfitWithdrawalJob(jobId)
    invalidateStrategyPerformance(job.config.id)
    audit('recovery', 'profit_withdrawal_left_retained', 'job', jobId, { reason: 'swap_not_confirmed' })
    return { disposition: 'profit_withdrawal_retry', completed: true }
  }

  let recoveredContext = context
  const settlement = strategyAllocationComponents(job.config.id)[low(context.settlementToken)] ?? zeroComponent()
  if (!recoveredContext.release) {
    if (settlement.heldProfit <= 0n) throw new Error('E_NO_RETAINED_PROFIT')
    const mark = await valueOutput(settlement.heldProfit, context.settlementToken, job.config.quoteToken)
    recoveredContext = {
      ...context,
      release: {
        amountOut: settlement.heldProfit.toString(),
        quoteValue: mark.quoteValue.toString(),
        usdgValue: mark.usdgValue.toString(),
        decimals: context.target === 'USDG' ? 6 : 18,
      },
    }
    setJobContext(jobId, 'profit_withdrawal', recoveredContext)
  }

  if (context.target === 'ETH' && !receiptByStep.has(9)) {
    abandonProfitWithdrawalJob(jobId)
    invalidateStrategyPerformance(job.config.id)
    audit('recovery', 'profit_withdrawal_left_retained', 'job', jobId, { reason: 'unwrap_not_confirmed' })
    return { disposition: 'profit_withdrawal_retry', completed: true }
  }

  const result = await finalizeWithdrawal({ jobId, walletId: job.walletId, config: job.config, context: recoveredContext, receipts, sourceAudit })
  audit('recovery', 'profit_withdrawal_recovered', 'job', jobId, { target: context.target, amountRaw: result.amountRaw })
  return { disposition: 'profit_withdrawal_committed', completed: true, withdrawal: result }
}
