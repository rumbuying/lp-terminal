import { keccak256, parseUnits, toHex, type Address, type TransactionReceipt } from 'viem'
import { clPmAbi } from '../src/abi'
import { makeFeeCollectionPlan, makeRebalancePlan } from '../shared/strategy/planner'
import { attributeCollect, incomeTaxRetentionEntry } from '../shared/strategy/accounting'
import type { LedgerEntry, StrategyConfig, StrategyPositionSnapshot } from '../shared/strategy/types'
import { readCollectableFees, readPoolState, readStrategySnapshot, readTokenBalances, publicClient } from './chain'
import {
  assertWalletAllocationUpdate,
  assertWalletAllocations,
  abandonRecoveryJob,
  audit,
  commitRebalance,
  completedCyclesSince,
  consecutiveLowerBreaks,
  getJobContext,
  jobTransactions,
  markStep,
  reserveDailyTurnover,
  runnableJobs,
  setJobContext,
  setJobState,
  setStrategyState,
  strategyAllocations,
  strategyAllocationComponents,
  walletAllocationTokens,
  walletHasUnfinishedMutation,
  executorPaused,
} from './store'
import { unlockPrivateKey } from './vault'
import { sendTracked } from './signer'
import { burnCall, collectCall, decreaseCall, decreaseCollectCall, mintCall } from './steps'
import { grantStrategyAllowance, revokeStrategyAllowance } from './allowance'
import { gatedKyberTx, quoteKyber, routeAudit, type GatedSwapTx, type KyberRouteSummary } from './kyber'
import { allocateSwapExecution, allocateSwapOutput, planCycleSwaps } from './rebalance'
import { FEE_TAX_SELECTION_VERSION, planFeeTax } from './fee-tax'
import { receiptLiquidityFlows } from './receipts'
import { freshRange, quoteTurnover, riskAssetPct, swapImpactBps } from './risk'
import { finishFeeCollection, finishHoldQuote } from './recovery-runner'
import { preflightStrategy } from './preflight'
import { walletBusy, withWalletLock } from './wallet-lock'
import { ADDR } from '../src/config/addresses'
import { ensureRestaked, ensureUnstakedAndRewardConverted } from './staking'
import { clearStrategyRetry, deferStrategyRetry, strategyRetryReady } from './retry-state'
import { strategyCapitalHarvest } from './capital-policy'

const low = (value: string) => value.toLowerCase()

export async function runOnce() {
  if (executorPaused()) return
  const running: Promise<void>[] = []
  for (const job of runnableJobs()) {
    if (!strategyRetryReady(job.config.id)) continue
    if (walletHasUnfinishedMutation(job.walletId)) continue
    if (walletBusy(job.walletId)) continue
    running.push(withWalletLock(job.walletId, () => runJob(job)))
  }
  await Promise.allSettled(running)
}

function gasEntries(config: StrategyConfig, jobId: string, receipts: TransactionReceipt[]): LedgerEntry[] {
  const ts = Math.floor(Date.now() / 1000)
  return receipts.map((receipt, index) => ({
    id: `${receipt.transactionHash}-gas-${index}`,
    strategyId: config.id,
    jobId,
    ts,
    blockNumber: receipt.blockNumber.toString(),
    txHash: receipt.transactionHash,
    kind: 'gas',
    amount: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
    meta: { unit: 'wei' },
  }))
}

async function runJob(job: ReturnType<typeof runnableJobs>[number]) {
  let stepIndex = 0
  const receipts: TransactionReceipt[] = []
  try {
    setJobState(job.id, 'running')
    setStrategyState(job.config.id, 'executing')
    const queueCheckAt = Math.floor(Date.now() / 1000)
    const maxQueueAge = Math.max(300, job.plan.safeguards.maxPlanAgeSeconds * 2)
    if (job.plan.createdAt < queueCheckAt - maxQueueAge) throw new Error('E_PLAN_QUEUE_STALE')
    const snapshot = await readStrategySnapshot(job.config)
    const fresh = job.plan.action === 'collect_fees'
      ? makeFeeCollectionPlan({ config: job.config, snapshot })
      : makeRebalancePlan({ config: job.config, snapshot, triggerSide: job.plan.triggerSide, rangeScale: job.plan.rangeScale ?? 1 })
    // Unguarded ORIGINAL mode re-reads the complete position and pool before
    // every state-changing step. A slow RPC response must not invalidate that
    // fresh chain state merely because the deterministic planning envelope is
    // older than 30 seconds. Guarded strategies continue to enforce expiry.
    if (job.plan.strategyRevision !== job.config.revision || (job.config.safeguards.enabled && job.plan.expiresAt < Math.floor(Date.now() / 1000))) throw new Error('E_PLAN_STALE')
    if (fresh.snapshot.tokenId !== job.plan.snapshot.tokenId || fresh.snapshot.liquidity !== job.plan.snapshot.liquidity || low(fresh.snapshot.owner) !== low(job.plan.snapshot.owner))
      throw new Error('E_POSITION_CHANGED')

    const tokens = [snapshot.token0, snapshot.token1] as const
    const trackedTokens = [...new Set([...walletAllocationTokens(job.walletId), ...tokens.map(low), low(ADDR.USDG), ...(job.config.staking?.enabled ? [low(ADDR.UP)] : [])])] as Address[]
    const baseline = await readTokenBalances(job.config.owner, trackedTokens)
    assertWalletAllocations(job.walletId, baseline)
    const prior = strategyAllocations(job.config.id)
    const priorComponents = strategyAllocationComponents(job.config.id)
    const priorPrincipal = Object.fromEntries(Object.entries(priorComponents).map(([token, component]) => [token, component.principal]))
    const priorHeld = Object.fromEntries(Object.entries(priorComponents).map(([token, component]) => [token, component.heldFee]))
    const priorProfit = Object.fromEntries(Object.entries(priorComponents).map(([token, component]) => [token, component.heldProfit]))
    for (const token of tokens) if ((prior[low(token)] ?? 0n) > baseline[low(token)]) throw new Error('E_ALLOCATION_MISMATCH')
    const gasPrice = await publicClient.getGasPrice()
    const nativeBalance = await publicClient.getBalance({ address: job.config.owner })
    const reserve = (gasPrice * 5_000_000n * BigInt(Math.ceil(job.config.execution.gasReserveMultiplier * 100))) / 100n
    if (nativeBalance < reserve) throw new Error('E_GAS_LIMIT')
    if (job.config.safeguards.enabled) {
      const utcStart = Math.floor(Date.now() / 86_400_000) * 86_400
      if (job.config.safeguards.maxRebalancesPerDay !== undefined && completedCyclesSince(job.config.id, utcStart) >= job.config.safeguards.maxRebalancesPerDay)
        throw new Error('E_DAILY_LIMIT')
      if (job.plan.triggerSide === 'lower' && job.config.safeguards.maxConsecutiveLowerBreaks !== undefined && consecutiveLowerBreaks(job.config.id) >= job.config.safeguards.maxConsecutiveLowerBreaks)
        throw new Error('E_LOWER_BREAK_LIMIT')
    }
    setJobContext(job.id, 'precheck', {
      baseline: Object.fromEntries(Object.entries(baseline).map(([token, value]) => [token, value.toString()])),
      prior: Object.fromEntries(Object.entries(prior).map(([token, value]) => [token, value.toString()])),
      priorPrincipal: Object.fromEntries(Object.entries(priorPrincipal).map(([token, value]) => [token, value.toString()])),
      priorHeld: Object.fromEntries(Object.entries(priorHeld).map(([token, value]) => [token, value.toString()])),
      priorProfit: Object.fromEntries(Object.entries(priorProfit).map(([token, value]) => [token, value.toString()])),
      trackedTokens,
      blockNumber: snapshot.blockNumber,
    })
    markStep({ jobId: job.id, index: 0, state: 'confirmed', result: { blockNumber: snapshot.blockNumber, baseline0: baseline[low(tokens[0])].toString(), baseline1: baseline[low(tokens[1])].toString(), gasReserveWei: reserve.toString() } })
    if (job.config.execution.dryRun) {
      setJobState(job.id, 'completed')
      setStrategyState(job.config.id, 'dry_run_ready')
      clearStrategyRetry(job.config.id)
      audit('runner', 'dry_run_confirmed', 'job', job.id)
      return
    }

    // A live job must prove route availability and reserve its projected daily
    // turnover before the first state-changing signature. The extra 5% absorbs
    // fee accrual and integer rounding between simulation and actual receipts;
    // the reservation is reduced to the actual amount later in the runner.
    const collectiblePreview = await readCollectableFees(job.config)
    const taxPreview = await planFeeTax({
      token0: snapshot.token0,
      token1: snapshot.token1,
      fee0: collectiblePreview.amount0,
      fee1: collectiblePreview.amount1,
      rewardToken: job.config.quoteToken,
      rewardAmount: 0n,
      quote: async (tokenIn, tokenOut, amountIn) => {
        const route = await quoteKyber(tokenIn, tokenOut, amountIn)
        return { amountOut: BigInt(route.routeSummary.amountOut), routeSummary: route.routeSummary }
      },
    })
    if (job.plan.action === 'collect_fees') {
      const pool = await readPoolState(job.config)
      let estimated = taxPreview.swaps.reduce((total, intent) => total + quoteTurnover(intent.amountIn, intent.tokenIn, job.config, snapshot, pool.sqrtPriceX96), 0n)
      if (job.config.fees.handling === 'convert_to_quote') {
        const riskAmount = low(job.config.riskToken) === low(snapshot.token0) ? taxPreview.fee0AfterTax : taxPreview.fee1AfterTax
        if (riskAmount > 0n) {
          const quote = await quoteKyber(job.config.riskToken, job.config.quoteToken, riskAmount, { protocol: job.config.protocol, tickSpacing: snapshot.tickSpacing, feePpm: snapshot.feePpm })
          await gatedKyberTx({ routeSummary: quote.routeSummary, tokenIn: job.config.riskToken, tokenOut: job.config.quoteToken, sender: job.config.owner, recipient: job.config.owner, amountIn: riskAmount, slippageBps: job.config.safeguards.maxSlippageBps, nativeIn: false })
          estimated += quoteTurnover(riskAmount, job.config.riskToken, job.config, snapshot, pool.sqrtPriceX96)
        }
      }
      const quoteDecimals = low(job.config.quoteToken) === low(snapshot.token0) ? snapshot.token0Decimals : snapshot.token1Decimals
      const withHeadroom = (estimated * 105n + 99n) / 100n
      reserveDailyTurnover({ jobId: job.id, walletId: job.walletId, quoteToken: job.config.quoteToken, amount: withHeadroom, limit: parseUnits(job.config.execution.maxDailyTurnoverQuote!, quoteDecimals) })
    } else {
      const livePreflight = await preflightStrategy(job.config, { rangeScale: job.plan.rangeScale ?? 1 })
      if (livePreflight.position.tokenId !== snapshot.tokenId || livePreflight.position.liquidity !== snapshot.liquidity || low(livePreflight.position.owner) !== low(snapshot.owner))
        throw new Error('E_POSITION_CHANGED')
      const quoteDecimals = low(job.config.quoteToken) === low(snapshot.token0) ? snapshot.token0Decimals : snapshot.token1Decimals
      const previewPool = await readPoolState(job.config)
      reserveDailyTurnover({
        jobId: job.id,
        walletId: job.walletId,
        quoteToken: job.config.quoteToken,
        amount: BigInt(livePreflight.expected.projectedTurnoverWithHeadroomQuoteRaw)
          + taxPreview.swaps.reduce((total, intent) => total + quoteTurnover(intent.amountIn, intent.tokenIn, job.config, snapshot, previewPool.sqrtPriceX96), 0n),
        limit: parseUnits(job.config.execution.maxDailyTurnoverQuote!, quoteDecimals),
      })
    }

    const unlocked = unlockPrivateKey(job.walletId)
    if (low(unlocked.address) !== low(job.config.owner)) throw new Error('E_OWNER')
    audit('runner', 'job_execution_started', 'job', job.id, { wallet: keccak256(toHex(unlocked.address)) })

    if (job.plan.action === 'collect_fees') {
      await finishFeeCollection(job, unlocked.privateKey)
      clearStrategyRetry(job.config.id)
      audit('runner', 'job_completed', 'job', job.id, { action: 'collect_fees' })
      return
    }

    let rewardUp = 0n
    let rewardWeth = 0n
    let rewardQuote = 0n
    let rewardQuotedWeth = 0n
    let rewardQuotedQuote = 0n
    const walletCustodyConfig: StrategyConfig = job.config.staking?.enabled ? { ...job.config, staking: { enabled: false } } : job.config
    if (job.config.staking?.enabled) {
      // The helper tracks the exact unstake/approval/swap substep itself. If it
      // throws, attribute the outer failure to the final reward-conversion gate
      // without overwriting a confirmed withdrawal step.
      stepIndex = 14
      const reward = await ensureUnstakedAndRewardConverted(job, unlocked.privateKey)
      rewardUp = reward.rewardUp
      rewardWeth = reward.rewardWeth
      rewardQuote = reward.rewardQuote
      rewardQuotedWeth = reward.quotedWeth
      rewardQuotedQuote = reward.quotedQuote
      receipts.push(...reward.receipts)
    }
    const positionBaseline = job.config.staking?.enabled ? await readTokenBalances(job.config.owner, tokens) : baseline

    stepIndex = 1
    const beforeDecrease = await readStrategySnapshot(walletCustodyConfig)
    if (beforeDecrease.liquidity !== snapshot.liquidity || low(beforeDecrease.owner) !== low(job.config.owner)) throw new Error('E_POSITION_CHANGED')
    // Persist the valuation point immediately before the first state-changing
    // transaction. Performance accounting must never substitute a later
    // rebalance/swap price: a recovery delay can otherwise move the cost basis
    // enough to flip the reported P/L sign.
    setJobContext(job.id, 'exit_valuation', {
      observedAt: beforeDecrease.observedAt,
      blockNumber: beforeDecrease.blockNumber,
      tick: beforeDecrease.tick,
      sqrtPriceX96: beforeDecrease.sqrtPriceX96,
      source: 'pre_decrease_snapshot',
    })
    const decreaseReceipt = await sendTracked({
      config: job.config,
      jobId: job.id,
      stepIndex,
      privateKey: unlocked.privateKey,
      tx: job.config.execution.lowTransactionMode ? decreaseCollectCall(job.config, beforeDecrease) : decreaseCall(job.config, beforeDecrease),
    })
    receipts.push(decreaseReceipt)
    const decreaseFlows = receiptLiquidityFlows(decreaseReceipt, job.config.positionManager, BigInt(snapshot.tokenId))
    if (decreaseFlows.principal0 === 0n && decreaseFlows.principal1 === 0n) throw new Error('E_RECEIPT_FACT')

    stepIndex = 2
    let collectReceipt = decreaseReceipt
    if (job.config.execution.lowTransactionMode) {
      markStep({ jobId: job.id, index: stepIndex, state: 'confirmed', result: { bundledWithStep: 1, txHash: decreaseReceipt.transactionHash } })
    } else {
      const afterDecreasePosition = await readStrategySnapshot(walletCustodyConfig)
      if (BigInt(afterDecreasePosition.liquidity) !== 0n) throw new Error('E_POSITION_CHANGED')
      collectReceipt = await sendTracked({ config: job.config, jobId: job.id, stepIndex, privateKey: unlocked.privateKey, tx: collectCall(job.config, snapshot.tokenId) })
      receipts.push(collectReceipt)
    }
    const collectFlows = receiptLiquidityFlows(collectReceipt, job.config.positionManager, BigInt(snapshot.tokenId))
    if (collectFlows.collected0 < decreaseFlows.principal0 || collectFlows.collected1 < decreaseFlows.principal1) throw new Error('E_UNSUPPORTED_TOKEN')

    const afterCollect = await readTokenBalances(job.config.owner, tokens)
    const delta0 = afterCollect[low(tokens[0])] - positionBaseline[low(tokens[0])]
    const delta1 = afterCollect[low(tokens[1])] - positionBaseline[low(tokens[1])]
    if (delta0 !== collectFlows.collected0 || delta1 !== collectFlows.collected1) throw new Error('E_UNSUPPORTED_TOKEN')
    const funds = {
      principal0: decreaseFlows.principal0,
      principal1: decreaseFlows.principal1,
      fee0: collectFlows.collected0 - decreaseFlows.principal0,
      fee1: collectFlows.collected1 - decreaseFlows.principal1,
    }
    setJobContext(job.id, 'funds', Object.fromEntries(Object.entries(funds).map(([key, value]) => [key, value.toString()])))
    const tax = await planFeeTax({
      token0: snapshot.token0,
      token1: snapshot.token1,
      fee0: funds.fee0,
      fee1: funds.fee1,
      rewardToken: job.config.quoteToken,
      rewardAmount: rewardQuote,
      quote: async (tokenIn, tokenOut, amountIn) => {
        const route = await quoteKyber(tokenIn, tokenOut, amountIn)
        return { amountOut: BigInt(route.routeSummary.amountOut), routeSummary: route.routeSummary }
      },
    })
    setJobContext(job.id, 'fee_tax', {
      selectionVersion: FEE_TAX_SELECTION_VERSION,
      applied: tax.applied,
      totalFeeUsdg: tax.totalFeeUsdg.toString(),
      totalIncomeUsdg: tax.totalIncomeUsdg.toString(),
      tax0: tax.tax0.toString(),
      tax1: tax.tax1.toString(),
      rewardTax: tax.rewardTax.toString(),
      retainedUsdg: tax.retainedUsdg.toString(),
    })
    const rewardAfterTax = tax.rewardAfterTax
    const deployableFunds = {
      principal0: funds.principal0 + (priorPrincipal[low(snapshot.token0)] ?? 0n) + (job.config.fees.handling === 'reinvest' && low(snapshot.token0) === low(job.config.quoteToken) ? rewardAfterTax : 0n),
      principal1: funds.principal1 + (priorPrincipal[low(snapshot.token1)] ?? 0n) + (job.config.fees.handling === 'reinvest' && low(snapshot.token1) === low(job.config.quoteToken) ? rewardAfterTax : 0n),
      fee0: tax.fee0AfterTax,
      fee1: tax.fee1AfterTax,
    }

    stepIndex = 3
    const empty = await readStrategySnapshot(walletCustodyConfig)
    if (BigInt(empty.liquidity) !== 0n || BigInt(empty.tokensOwed0) !== 0n || BigInt(empty.tokensOwed1) !== 0n) {
      markStep({ jobId: job.id, index: stepIndex, state: 'confirmed', result: { skipped: true, retainedEmptyNft: true } })
    } else if (job.config.execution.lowTransactionMode) {
      markStep({ jobId: job.id, index: stepIndex, state: 'confirmed', result: { skipped: true, retainedEmptyNft: true, lowTransactionMode: true } })
    } else {
      try {
        const burnReceipt = await sendTracked({ config: job.config, jobId: job.id, stepIndex, privateKey: unlocked.privateKey, tx: burnCall(job.config, snapshot.tokenId) })
        receipts.push(burnReceipt)
      } catch (error) {
        audit('runner', 'empty_nft_burn_failed', 'job', job.id, { error: error instanceof Error ? error.message : 'E_BURN' })
        markStep({ jobId: job.id, index: stepIndex, state: 'confirmed', result: { skipped: true, retainedEmptyNft: true } })
      }
    }

    if (job.plan.action === 'hold_quote') {
      await finishHoldQuote(job, unlocked.privateKey)
      clearStrategyRetry(job.config.id)
      audit('runner', 'job_completed', 'job', job.id, { terminalAction: 'hold_quote' })
      return
    }

    const pool = await readPoolState(job.config)
    const range = freshRange(job.config, snapshot, pool.tick, job.plan.triggerSide, job.plan.rangeScale ?? 1)
    const cycle = await planCycleSwaps({
      config: job.config,
      snapshot,
      sqrtPriceX96: pool.sqrtPriceX96,
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      funds: deployableFunds,
      quote: async (tokenIn, tokenOut, amountIn) => {
        const route = await quoteKyber(tokenIn, tokenOut, amountIn, { protocol: job.config.protocol, tickSpacing: snapshot.tickSpacing, feePpm: snapshot.feePpm })
        return { amountOut: BigInt(route.routeSummary.amountOut), routeSummary: route.routeSummary }
      },
    })
    const allSwaps = [...tax.swaps, ...cycle.swaps]
    let swapPlan = {
      tick: pool.tick,
      sqrtPriceX96: pool.sqrtPriceX96.toString(),
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      swaps: allSwaps.map((intent, txIndex) => ({
        txIndex,
        purpose: intent.purpose,
        tokenIn: intent.tokenIn,
        tokenOut: intent.tokenOut,
        amountIn: intent.amountIn.toString(),
        quotedOut: intent.quotedOut.toString(),
        principalIn: intent.principalIn.toString(),
        feeIn: intent.feeIn.toString(),
        route: routeAudit(intent.routeSummary),
      })),
    }
    setJobContext(job.id, 'swap_plan', swapPlan)
    let lp0 = cycle.lp0
    let lp1 = cycle.lp1
    let held0 = cycle.held0 + (job.config.fees.handling !== 'reinvest' && low(snapshot.token0) === low(job.config.quoteToken) ? rewardAfterTax : 0n)
    let held1 = cycle.held1 + (job.config.fees.handling !== 'reinvest' && low(snapshot.token1) === low(job.config.quoteToken) ? rewardAfterTax : 0n)
    const projected = { amount0: lp0, amount1: lp1 }
    const projectedTotal = {
      amount0: lp0 + held0 + (priorHeld[low(snapshot.token0)] ?? 0n) + (priorProfit[low(snapshot.token0)] ?? 0n),
      amount1: lp1 + held1 + (priorHeld[low(snapshot.token1)] ?? 0n) + (priorProfit[low(snapshot.token1)] ?? 0n),
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
      if (job.config.safeguards.enabled && job.config.safeguards.maxSwapImpactBps !== undefined) {
        const impact = swapImpactBps(intent.amountIn, intent.quotedOut, intent.tokenIn, intent.tokenOut, snapshot, pool.sqrtPriceX96)
        if (impact > BigInt(Math.floor(job.config.safeguards.maxSwapImpactBps))) throw new Error('E_SWAP_IMPACT')
      }
    }
    if (job.config.safeguards.enabled && job.config.safeguards.maxRiskAssetPct !== undefined) {
      const projectedRiskPct = riskAssetPct(projectedTotal.amount0, projectedTotal.amount1, job.config, snapshot, pool.sqrtPriceX96)
      if (projectedRiskPct > job.config.safeguards.maxRiskAssetPct) throw new Error('E_RISK_LIMIT')
    }
    if (job.config.execution.maxDailyTurnoverQuote !== undefined) {
      const quoteDecimals = low(job.config.quoteToken) === low(snapshot.token0) ? snapshot.token0Decimals : snapshot.token1Decimals
      let dailyLimit: bigint
      try {
        dailyLimit = parseUnits(job.config.execution.maxDailyTurnoverQuote, quoteDecimals)
      } catch {
        throw new Error('E_DAILY_LIMIT')
      }
      const rewardTurnover = rewardQuote * (low(job.config.quoteToken) === low(ADDR.WETH) ? 1n : 2n)
      const turnover = rewardTurnover + allSwaps.reduce((total, intent) => total + quoteTurnover(intent.amountIn, intent.tokenIn, job.config, snapshot, pool.sqrtPriceX96), 0n)
      reserveDailyTurnover({ jobId: job.id, walletId: job.walletId, quoteToken: job.config.quoteToken, amount: turnover, limit: dailyLimit })
    }
    // Prove the immutable baseline and USDG threshold route before the first
    // swap. The actual retained amounts are recomputed from receipt-backed
    // balances immediately before minting.
    await strategyCapitalHarvest({
      config: job.config,
      snapshot,
      sqrtPriceX96: pool.sqrtPriceX96,
      amount0: projected.amount0,
      amount1: projected.amount1,
    })

    stepIndex = 4
    let approvalTx = 0
    let swapTx = 0
    const executedSwaps: { intent: (typeof allSwaps)[number]; spent: bigint; gained: bigint; receipt: TransactionReceipt; routeSummary: KyberRouteSummary; gated: GatedSwapTx }[] = []
    for (const intent of allSwaps) {
      // Validate an opaque Kyber build before granting any allowance. The
      // returned `to` is guaranteed by gatedKyberTx() to equal our configured
      // router allowlist entry; an untrusted quote can never choose a spender.
      const fallback = intent.purpose === 'fee_tax' ? undefined : { protocol: job.config.protocol, tickSpacing: snapshot.tickSpacing, feePpm: snapshot.feePpm }
      const approvalQuote = await quoteKyber(intent.tokenIn, intent.tokenOut, intent.amountIn, fallback)
      const approvalGate = await gatedKyberTx({ routeSummary: approvalQuote.routeSummary, tokenIn: intent.tokenIn, tokenOut: intent.tokenOut, sender: job.config.owner, recipient: job.config.owner, amountIn: intent.amountIn, slippageBps: job.config.safeguards.maxSlippageBps, nativeIn: false })
      const approvalReceipts = await grantStrategyAllowance({ config: job.config, jobId: job.id, stepIndex: 4, txIndexStart: approvalTx, privateKey: unlocked.privateKey, token: intent.tokenIn, spender: approvalGate.approvalTarget, amount: intent.amountIn, forceExact: approvalGate.exactApproval })
      receipts.push(...approvalReceipts)
      approvalTx += approvalReceipts.length

      stepIndex = 5
      const quote = approvalQuote
      const gated = await gatedKyberTx({ routeSummary: quote.routeSummary, tokenIn: intent.tokenIn, tokenOut: intent.tokenOut, sender: job.config.owner, recipient: job.config.owner, amountIn: intent.amountIn, slippageBps: job.config.safeguards.maxSlippageBps, nativeIn: false })
      if (gated.approvalTarget.toLowerCase() !== approvalGate.approvalTarget.toLowerCase()) throw new Error('E_SWAP_SPENDER_CHANGED')
      const txIndex = swapTx++
      const executableIntent = { ...intent, quotedOut: BigInt(quote.routeSummary.amountOut), routeSummary: quote.routeSummary }
      swapPlan = {
        ...swapPlan,
        swaps: swapPlan.swaps.map((record) => record.txIndex === txIndex ? {
          ...record,
          quotedOut: quote.routeSummary.amountOut,
          minOut: gated.minOut.toString(),
          route: routeAudit(quote.routeSummary, gated),
        } : record),
      }
      // The exact quote/minimum and route identity are durable before signing.
      // Recovery must validate a confirmed transaction against what it actually
      // executed, never against an older numerical-planning quote.
      setJobContext(job.id, 'swap_plan', swapPlan)
      const before = await readTokenBalances(job.config.owner, [intent.tokenIn, intent.tokenOut])
      const swapReceipt = await sendTracked({ config: job.config, jobId: job.id, stepIndex: 5, txIndex, privateKey: unlocked.privateKey, tx: gated })
      receipts.push(swapReceipt)
      const after = await readTokenBalances(job.config.owner, [intent.tokenIn, intent.tokenOut])
      const spent = before[low(intent.tokenIn)] - after[low(intent.tokenIn)]
      const gained = after[low(intent.tokenOut)] - before[low(intent.tokenOut)]
      const execution = allocateSwapExecution(executableIntent, spent, gained, gated.minOut)
      const revokeReceipts = await revokeStrategyAllowance({ config: job.config, jobId: job.id, stepIndex: 4, txIndexStart: approvalTx, privateKey: unlocked.privateKey, token: intent.tokenIn, spender: gated.approvalTarget, forceExact: gated.exactApproval })
      receipts.push(...revokeReceipts)
      approvalTx += revokeReceipts.length
      executedSwaps.push({ intent: executableIntent, spent, gained, receipt: swapReceipt, routeSummary: quote.routeSummary, gated })
      setJobContext(job.id, 'executed_swaps', executedSwaps.map((item) => ({
        tokenIn: item.intent.tokenIn,
        tokenOut: item.intent.tokenOut,
        purpose: item.intent.purpose,
        amountIn: item.intent.amountIn.toString(),
        principalIn: item.intent.principalIn.toString(),
        feeIn: item.intent.feeIn.toString(),
        quotedOut: item.intent.quotedOut.toString(),
        spent: item.spent.toString(),
        gained: item.gained.toString(),
        txHash: item.receipt.transactionHash,
        route: routeAudit(item.routeSummary, item.gated),
      })))
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
      const inIs0 = low(intent.tokenIn) === low(snapshot.token0)
      if (inIs0) {
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
    if (allSwaps.length === 0) {
      markStep({ jobId: job.id, index: 4, state: 'confirmed', result: { skipped: true } })
      markStep({ jobId: job.id, index: 5, state: 'confirmed', result: { skipped: true } })
    } else {
      markStep({ jobId: job.id, index: 4, state: 'confirmed', result: { transactions: approvalTx } })
      markStep({ jobId: job.id, index: 5, state: 'confirmed', result: { transactions: swapTx } })
    }
    if (job.config.safeguards.enabled && job.config.safeguards.maxRiskAssetPct !== undefined) {
      const actualRiskPct = riskAssetPct(
        lp0 + held0 + (priorHeld[low(snapshot.token0)] ?? 0n) + (priorProfit[low(snapshot.token0)] ?? 0n),
        lp1 + held1 + (priorHeld[low(snapshot.token1)] ?? 0n) + (priorProfit[low(snapshot.token1)] ?? 0n),
        job.config,
        snapshot,
        pool.sqrtPriceX96,
      )
      if (actualRiskPct > job.config.safeguards.maxRiskAssetPct) throw new Error('E_RISK_LIMIT')
    }

    const mintPool = await readPoolState(job.config)
    const capital = await strategyCapitalHarvest({ config: job.config, snapshot, sqrtPriceX96: mintPool.sqrtPriceX96, amount0: lp0, amount1: lp1 })
    setJobContext(job.id, 'capital_allocation', {
      triggered: capital.triggered,
      deploy0: capital.deploy0.toString(), deploy1: capital.deploy1.toString(),
      profit0: capital.profit0.toString(), profit1: capital.profit1.toString(),
      activeValueQuote: capital.activeValueQuote.toString(), capitalCapQuote: capital.capitalCapQuote.toString(),
      excessValueQuote: capital.excessValueQuote.toString(), excessValueUsdg: capital.excessValueUsdg.toString(),
    })

    stepIndex = 6
    receipts.push(...await grantStrategyAllowance({ config: job.config, jobId: job.id, stepIndex, privateKey: unlocked.privateKey, token: snapshot.token0, spender: job.config.positionManager, amount: capital.deploy0 }))
    stepIndex = 7
    receipts.push(...await grantStrategyAllowance({ config: job.config, jobId: job.id, stepIndex, privateKey: unlocked.privateKey, token: snapshot.token1, spender: job.config.positionManager, amount: capital.deploy1 }))

    stepIndex = 8
    const mintRange = freshRange(job.config, snapshot, mintPool.tick, job.plan.triggerSide, job.plan.rangeScale ?? 1)
    const mintReceipt = await sendTracked({
      config: job.config,
      jobId: job.id,
      stepIndex,
      privateKey: unlocked.privateKey,
      tx: mintCall({ config: job.config, snapshot, tickLower: mintRange.tickLower, tickUpper: mintRange.tickUpper, amount0Desired: capital.deploy0, amount1Desired: capital.deploy1, feePpm: mintPool.feePpm, sqrtPriceX96: mintPool.sqrtPriceX96 }),
    })
    receipts.push(mintReceipt)
    const mintFlows = receiptLiquidityFlows(mintReceipt, job.config.positionManager, 0n)
    if (!mintFlows.mintedTokenId) throw new Error('E_MINT_TOKEN_ID')
    const newOwner = await publicClient.readContract({ address: job.config.positionManager, abi: clPmAbi, functionName: 'ownerOf', args: [mintFlows.mintedTokenId] })
    if (low(newOwner) !== low(job.config.owner)) throw new Error('E_OWNER')

    stepIndex = 9
    receipts.push(...await revokeStrategyAllowance({ config: job.config, jobId: job.id, stepIndex, privateKey: unlocked.privateKey, token: snapshot.token0, spender: job.config.positionManager }))
    stepIndex = 10
    receipts.push(...await revokeStrategyAllowance({ config: job.config, jobId: job.id, stepIndex, privateKey: unlocked.privateKey, token: snapshot.token1, spender: job.config.positionManager }))

    if (job.config.staking?.enabled) {
      stepIndex = 15
      receipts.push(...await ensureRestaked(job, unlocked.privateKey, mintFlows.mintedTokenId.toString()))
    }

    stepIndex = 11
    const finalBalances = await readTokenBalances(job.config.owner, trackedTokens)
    const principalCarry0 = capital.deploy0 - mintFlows.minted0
    const principalCarry1 = capital.deploy1 - mintFlows.minted1
    const heldFee0 = (priorHeld[low(tokens[0])] ?? 0n) + held0
    const heldFee1 = (priorHeld[low(tokens[1])] ?? 0n) + held1
    const heldProfit0 = (priorProfit[low(tokens[0])] ?? 0n) + capital.profit0
    const heldProfit1 = (priorProfit[low(tokens[1])] ?? 0n) + capital.profit1
    const allocation0 = principalCarry0 + heldFee0 + heldProfit0
    const allocation1 = principalCarry1 + heldFee1 + heldProfit1
    if ([principalCarry0, principalCarry1, heldFee0, heldFee1, heldProfit0, heldProfit1].some((value) => value < 0n)) throw new Error('E_ALLOCATION_MISMATCH')
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
      principal0: funds.principal0.toString(),
      principal1: funds.principal1.toString(),
      collected0: collectFlows.collected0.toString(),
      collected1: collectFlows.collected1.toString(),
      unstakedLevyPpm: snapshot.unstakedFeePpm,
      txHash: collectReceipt.transactionHash,
      blockNumber: collectReceipt.blockNumber.toString(),
    }).map((entry, index) => ({ ...entry, id: `${job.id}-collect-${index}`, jobId: job.id }))
    executedSwaps.forEach(({ intent, spent, gained, receipt }, index) => {
      const execution = allocateSwapExecution(intent, spent, gained, 0n)
      const common = { strategyId: job.config.id, cycleId: `cycle-${job.id}`, jobId: job.id, ts: now, txHash: receipt.transactionHash, blockNumber: receipt.blockNumber.toString() }
      ledger.push(
        { ...common, id: `${job.id}-swap-in-${index}`, kind: 'swap_in', token: intent.tokenIn, amount: spent.toString(), meta: { principalIn: execution.principalSpent.toString(), feeIn: execution.feeSpent.toString(), purpose: intent.purpose } },
        { ...common, id: `${job.id}-swap-out-${index}`, kind: 'swap_out', token: intent.tokenOut, amount: gained.toString(), meta: { quotedOut: intent.quotedOut.toString(), purpose: intent.purpose } },
      )
      if (gained < intent.quotedOut) ledger.push({ ...common, id: `${job.id}-swap-cost-${index}`, kind: 'swap_cost', token: intent.tokenOut, amount: (intent.quotedOut - gained).toString(), meta: { basis: 'quoted_output_shortfall' } })
    })
    if (job.config.staking?.enabled) {
      const rewardContext = getJobContext<{ withdrawTxHash?: `0x${string}`; swapTxHash?: `0x${string}`; quoteSwapTxHash?: `0x${string}` }>(job.id, 'staking_reward')
      const hasQuoteHop = low(job.config.quoteToken) !== low(ADDR.WETH)
      ledger.push({ id: `${job.id}-staking-reward`, strategyId: job.config.id, cycleId: `cycle-${job.id}`, jobId: job.id, ts: now, kind: 'staking_reward', token: ADDR.UP, amount: rewardUp.toString(), txHash: rewardContext?.withdrawTxHash, meta: { convertedToWeth: rewardWeth.toString(), convertedToQuote: rewardQuote.toString(), quoteToken: job.config.quoteToken } })
      if (rewardUp > 0n && rewardContext?.swapTxHash) ledger.push(
        { id: `${job.id}-reward-swap-in`, strategyId: job.config.id, cycleId: `cycle-${job.id}`, jobId: job.id, ts: now, kind: 'swap_in', token: ADDR.UP, amount: rewardUp.toString(), txHash: rewardContext.swapTxHash, meta: { source: 'staking_reward' } },
        { id: `${job.id}-reward-swap-out`, strategyId: job.config.id, cycleId: `cycle-${job.id}`, jobId: job.id, ts: now, kind: 'swap_out', token: ADDR.WETH, amount: rewardWeth.toString(), txHash: rewardContext.swapTxHash, meta: { source: 'staking_reward', rewardFinal: !hasQuoteHop, quotedOut: rewardQuotedWeth.toString() } },
      )
      if (hasQuoteHop && rewardWeth > 0n && rewardContext?.quoteSwapTxHash) ledger.push(
        { id: `${job.id}-reward-quote-swap-in`, strategyId: job.config.id, cycleId: `cycle-${job.id}`, jobId: job.id, ts: now, kind: 'swap_in', token: ADDR.WETH, amount: rewardWeth.toString(), txHash: rewardContext.quoteSwapTxHash, meta: { source: 'staking_reward' } },
        { id: `${job.id}-reward-quote-swap-out`, strategyId: job.config.id, cycleId: `cycle-${job.id}`, jobId: job.id, ts: now, kind: 'swap_out', token: job.config.quoteToken, amount: rewardQuote.toString(), txHash: rewardContext.quoteSwapTxHash, meta: { source: 'staking_reward', rewardFinal: true, quotedOut: rewardQuotedQuote.toString() } },
      )
    }
    const retainedTaxEntry = incomeTaxRetentionEntry({
      id: `${job.id}-income-tax-retained`,
      strategyId: job.config.id,
      cycleId: `cycle-${job.id}`,
      jobId: job.id,
      ts: now,
      token: ADDR.USDG,
      amount: tax.retainedUsdg,
      txHash: collectReceipt.transactionHash,
      blockNumber: collectReceipt.blockNumber.toString(),
    })
    if (retainedTaxEntry) ledger.push(retainedTaxEntry)
    if (capital.triggered) ledger.push(
      { id: `${job.id}-profit-0`, strategyId: job.config.id, cycleId: `cycle-${job.id}`, jobId: job.id, ts: now, kind: 'profit_harvest', token: snapshot.token0, amount: capital.profit0.toString(), meta: { thresholdUsdg: job.config.capitalProtection.profitThresholdUsdg, excessValueUsdg: capital.excessValueUsdg.toString() } },
      { id: `${job.id}-profit-1`, strategyId: job.config.id, cycleId: `cycle-${job.id}`, jobId: job.id, ts: now, kind: 'profit_harvest', token: snapshot.token1, amount: capital.profit1.toString(), meta: { thresholdUsdg: job.config.capitalProtection.profitThresholdUsdg, excessValueUsdg: capital.excessValueUsdg.toString() } },
    )
    ledger.push(
      { id: `${job.id}-mint-0`, strategyId: job.config.id, cycleId: `cycle-${job.id}`, jobId: job.id, ts: now, kind: 'mint_principal', token: snapshot.token0, amount: mintFlows.minted0.toString(), txHash: mintReceipt.transactionHash },
      { id: `${job.id}-mint-1`, strategyId: job.config.id, cycleId: `cycle-${job.id}`, jobId: job.id, ts: now, kind: 'mint_principal', token: snapshot.token1, amount: mintFlows.minted1.toString(), txHash: mintReceipt.transactionHash },
      ...gasEntries(job.config, job.id, receipts),
    )
    commitRebalance({
      jobId: job.id,
      config: job.config,
      oldTokenId: snapshot.tokenId,
      newTokenId: mintFlows.mintedTokenId.toString(),
      triggerSide: job.plan.triggerSide,
      rangeScale: job.plan.rangeScale ?? 1,
      allocations: { [low(snapshot.token0)]: allocation0, [low(snapshot.token1)]: allocation1 },
      allocationComponents: {
        [low(snapshot.token0)]: { principal: principalCarry0, heldFee: heldFee0, heldProfit: heldProfit0 },
        [low(snapshot.token1)]: { principal: principalCarry1, heldFee: heldFee1, heldProfit: heldProfit1 },
      },
      ledger,
      txHashes: receipts.map((receipt) => receipt.transactionHash),
      commitResult: { newTokenId: mintFlows.mintedTokenId.toString(), held0: held0.toString(), held1: held1.toString(), heldProfit0: heldProfit0.toString(), heldProfit1: heldProfit1.toString(), profitHarvested: capital.triggered, profitHarvestUsdg: capital.excessValueUsdg.toString(), capitalCapQuote: capital.capitalCapQuote.toString(), rangeScale: job.plan.rangeScale ?? 1, rewardUp: rewardUp.toString(), rewardWeth: rewardWeth.toString(), rewardQuote: rewardQuote.toString(), rewardQuoteToken: job.config.quoteToken, rewardTaxWeth: low(job.config.quoteToken) === low(ADDR.WETH) ? tax.rewardTax.toString() : '0', rewardTaxQuote: tax.rewardTax.toString(), incomeTaxApplied: tax.applied, feeTaxApplied: tax.applied, incomeTaxUsdgQuoted: tax.swaps.reduce((total, intent) => total + intent.quotedOut, tax.retainedUsdg).toString(), feeTaxUsdgQuoted: tax.swaps.reduce((total, intent) => total + intent.quotedOut, tax.retainedUsdg).toString(), staked: job.config.staking?.enabled === true },
    })
    clearStrategyRetry(job.config.id)
    audit('runner', 'job_completed', 'job', job.id, { newTokenId: mintFlows.mintedTokenId.toString() })
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 120) : 'E_RUNNER'
    const delayMs = deferStrategyRetry(job.config.id)
    markStep({ jobId: job.id, index: stepIndex, state: 'failed', errorCode: code })
    setJobState(job.id, 'recovery')
    const transactions = jobTransactions(job.id)
    const noConfirmedMutation = transactions.every((tx) => tx.state !== 'confirmed')
    const allAttemptsDefinitelyReverted = transactions.length > 0
      && transactions.every((tx) => tx.state === 'failed' && tx.error_code === 'E_TX_REVERTED')
    const retryableBeforeMutation = transactions.length === 0 && (
      code === 'E_PLAN_STALE'
      || code === 'E_PLAN_QUEUE_STALE'
      || code === 'E_KYBER_QUOTE'
      || code === 'E_SWAP_IMPACT'
      || /RPC Request failed|HTTP request failed|fetch failed|network|socket|timeout|timed out|rate limit|\b429\b|\b502\b|\b503\b|\b504\b/i.test(code)
    )
    if (noConfirmedMutation && (allAttemptsDefinitelyReverted || retryableBeforeMutation)) {
      // No successful state change exists to recover. Release reservations and
      // let the monitor build a fresh plan automatically; exposing an alarming
      // manual-recovery action here only invites duplicate operator clicks.
      abandonRecoveryJob(job.id)
      if (code === 'E_SWAP_IMPACT') setStrategyState(job.config.id, 'guard_wait')
      audit('runner', 'job_auto_restarted_safe', 'job', job.id, { code, stepIndex, attempts: transactions.length, delayMs })
    } else {
      setStrategyState(job.config.id, 'recovery')
      audit('runner', 'job_recovery', 'job', job.id, { code, stepIndex, delayMs })
    }
  }
}
