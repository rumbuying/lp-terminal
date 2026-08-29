import type { Hex, TransactionReceipt } from 'viem'
import { clGaugeAbi, clPmAbi } from '../src/abi'
import { ADDR, requireGov } from '../src/config/addresses'
import { grantStrategyAllowance, revokeStrategyAllowance } from './allowance'
import { publicClient, readTokenBalances } from './chain'
import { gatedKyberTx, quoteWithNativeFallback, routeAudit } from './kyber'
import { quoteRewardToWeth } from './reward'
import { receiptTokenDelta } from './receipts'
import { sendTracked } from './signer'
import { nftApprovalCall, nftOperatorApprovalCall, stakeCall, unstakeCall } from './steps'
import { getJobContext, jobTransactions, markStep, nextTransactionIndex, setJobContext, type RunnableJob } from './store'

const low = (value: string) => value.toLowerCase()

async function receiptAt(jobId: string, stepIndex: number, txIndex?: number): Promise<TransactionReceipt | undefined> {
  const row = jobTransactions(jobId).find((item) => Number(item.step_index) === stepIndex && (txIndex === undefined || Number(item.tx_index) === txIndex) && item.state === 'confirmed' && typeof item.tx_hash === 'string')
  if (!row?.tx_hash) return undefined
  return publicClient.getTransactionReceipt({ hash: row.tx_hash as Hex }) as Promise<TransactionReceipt>
}

export type StakingRewardResult = {
  rewardUp: bigint
  rewardWeth: bigint
  rewardQuote: bigint
  quotedWeth: bigint
  quotedQuote: bigint
  receipts: TransactionReceipt[]
}

export type StakingRewardContext = {
  rewardUp: string
  rewardWeth: string
  rewardQuote: string
  quotedWeth: string
  quotedQuote: string
  settlementToken: string
  withdrawTxHash?: Hex
  swapTxHash?: Hex
  quoteSwapTxHash?: Hex
  wethRoute?: unknown
  quoteRoute?: unknown
}

/** Idempotently withdraw the old NFT and settle newly claimed UP through WETH into quote. */
export async function ensureUnstakedAndRewardConverted(job: RunnableJob, privateKey: `0x${string}`): Promise<StakingRewardResult> {
  const gauge = job.config.staking?.gauge
  if (!job.config.staking?.enabled || !gauge || !job.config.activeTokenId) return { rewardUp: 0n, rewardWeth: 0n, rewardQuote: 0n, quotedWeth: 0n, quotedQuote: 0n, receipts: [] }
  const tokenId = job.config.activeTokenId
  const receipts: TransactionReceipt[] = []
  let withdrawReceipt = await receiptAt(job.id, 12)
  if (!withdrawReceipt) {
    const owner = await publicClient.readContract({ address: job.config.positionManager, abi: clPmAbi, functionName: 'ownerOf', args: [BigInt(tokenId)] })
    if (low(owner) !== low(gauge)) throw new Error('E_STAKING_CUSTODY')
    withdrawReceipt = await sendTracked({ config: job.config, jobId: job.id, stepIndex: 12, txIndex: nextTransactionIndex(job.id, 12), privateKey, tx: unstakeCall(gauge, tokenId) })
    receipts.push(withdrawReceipt)
  }
  const rewardUp = receiptTokenDelta(withdrawReceipt, requireGov().UP, job.config.owner)
  if (rewardUp < 0n) throw new Error('E_REWARD_ACCOUNTING')
  const [nftOwner, stakedIds] = await Promise.all([
    publicClient.readContract({ address: job.config.positionManager, abi: clPmAbi, functionName: 'ownerOf', args: [BigInt(tokenId)] }),
    publicClient.readContract({ address: gauge, abi: clGaugeAbi, functionName: 'stakedValues', args: [job.config.owner] }),
  ])
  if (low(nftOwner) !== low(job.config.owner) || stakedIds.some((id) => id === BigInt(tokenId))) throw new Error('E_STAKING_CUSTODY')

  if (rewardUp === 0n) {
    markStep({ jobId: job.id, index: 13, state: 'confirmed', result: { skipped: true, rewardUp: '0' } })
    markStep({ jobId: job.id, index: 14, state: 'confirmed', result: { skipped: true, rewardUp: '0' } })
    setJobContext(job.id, 'staking_reward', { rewardUp: '0', rewardWeth: '0', rewardQuote: '0', quotedWeth: '0', quotedQuote: '0', settlementToken: job.config.quoteToken, withdrawTxHash: withdrawReceipt.transactionHash })
    return { rewardUp, rewardWeth: 0n, rewardQuote: 0n, quotedWeth: 0n, quotedQuote: 0n, receipts }
  }

  const prior = getJobContext<Partial<StakingRewardContext>>(job.id, 'staking_reward')
  if (prior?.rewardUp !== undefined && BigInt(prior.rewardUp) !== rewardUp) throw new Error('E_RECOVERY_CONTEXT')
  if (prior?.settlementToken && low(prior.settlementToken) !== low(job.config.quoteToken)) throw new Error('E_RECOVERY_CONTEXT')
  let swapReceipt = await receiptAt(job.id, 14, 0)
  let quotedWeth = prior?.quotedWeth ? BigInt(prior.quotedWeth) : 0n
  let rewardWeth = 0n
  if (swapReceipt) {
    rewardWeth = receiptTokenDelta(swapReceipt, ADDR.WNATIVE, job.config.owner)
    const spent = -receiptTokenDelta(swapReceipt, requireGov().UP, job.config.owner)
    if (spent !== rewardUp || rewardWeth <= 0n) throw new Error('E_REWARD_ACCOUNTING')
  } else {
    const quote = await quoteRewardToWeth(rewardUp)
    quotedWeth = BigInt(quote.routeSummary.amountOut)
    setJobContext(job.id, 'staking_reward', { rewardUp: rewardUp.toString(), rewardWeth: '0', rewardQuote: '0', quotedWeth: quotedWeth.toString(), quotedQuote: '0', settlementToken: job.config.quoteToken, withdrawTxHash: withdrawReceipt.transactionHash })
    const gated = await gatedKyberTx({ routeSummary: quote.routeSummary, tokenIn: requireGov().UP, tokenOut: ADDR.WNATIVE, sender: job.config.owner, recipient: job.config.owner, amountIn: rewardUp, slippageBps: job.config.safeguards.maxSlippageBps, nativeIn: false })
    setJobContext(job.id, 'staking_reward', { ...getJobContext<Partial<StakingRewardContext>>(job.id, 'staking_reward'), wethRoute: routeAudit(quote.routeSummary, gated) })
    receipts.push(...await grantStrategyAllowance({ config: job.config, jobId: job.id, stepIndex: 13, txIndexStart: nextTransactionIndex(job.id, 13), privateKey, token: requireGov().UP, spender: gated.approvalTarget, amount: rewardUp, forceExact: gated.exactApproval }))
    const before = await readTokenBalances(job.config.owner, [requireGov().UP, ADDR.WNATIVE])
    swapReceipt = await sendTracked({ config: job.config, jobId: job.id, stepIndex: 14, txIndex: nextTransactionIndex(job.id, 14), privateKey, tx: gated })
    receipts.push(swapReceipt)
    const after = await readTokenBalances(job.config.owner, [requireGov().UP, ADDR.WNATIVE])
    const spent = before[low(requireGov().UP)] - after[low(requireGov().UP)]
    rewardWeth = after[low(ADDR.WNATIVE)] - before[low(ADDR.WNATIVE)]
    if (spent !== rewardUp || rewardWeth < gated.minOut) throw new Error('E_REWARD_ACCOUNTING')
    receipts.push(...await revokeStrategyAllowance({ config: job.config, jobId: job.id, stepIndex: 13, txIndexStart: nextTransactionIndex(job.id, 13), privateKey, token: requireGov().UP, spender: gated.approvalTarget, forceExact: gated.exactApproval }))
  }
  setJobContext(job.id, 'staking_reward', { ...getJobContext<Partial<StakingRewardContext>>(job.id, 'staking_reward'), rewardUp: rewardUp.toString(), rewardWeth: rewardWeth.toString(), rewardQuote: low(job.config.quoteToken) === low(ADDR.WNATIVE) ? rewardWeth.toString() : '0', quotedWeth: quotedWeth.toString(), quotedQuote: low(job.config.quoteToken) === low(ADDR.WNATIVE) ? quotedWeth.toString() : '0', settlementToken: job.config.quoteToken, withdrawTxHash: withdrawReceipt.transactionHash, swapTxHash: swapReceipt.transactionHash })

  if (low(job.config.quoteToken) === low(ADDR.WNATIVE))
    return { rewardUp, rewardWeth, rewardQuote: rewardWeth, quotedWeth, quotedQuote: quotedWeth, receipts }

  let quoteSwapReceipt = await receiptAt(job.id, 14, 1)
  let quotedQuote = prior?.quotedQuote ? BigInt(prior.quotedQuote) : 0n
  let rewardQuote = 0n
  if (quoteSwapReceipt) {
    const spent = -receiptTokenDelta(quoteSwapReceipt, ADDR.WNATIVE, job.config.owner)
    rewardQuote = receiptTokenDelta(quoteSwapReceipt, job.config.quoteToken, job.config.owner)
    if (spent !== rewardWeth || rewardQuote <= 0n) throw new Error('E_REWARD_ACCOUNTING')
  } else {
    const quote = await quoteWithNativeFallback(ADDR.WNATIVE, job.config.quoteToken, rewardWeth)
    quotedQuote = BigInt(quote.routeSummary.amountOut)
    setJobContext(job.id, 'staking_reward', { rewardUp: rewardUp.toString(), rewardWeth: rewardWeth.toString(), rewardQuote: '0', quotedWeth: quotedWeth.toString(), quotedQuote: quotedQuote.toString(), settlementToken: job.config.quoteToken, withdrawTxHash: withdrawReceipt.transactionHash, swapTxHash: swapReceipt.transactionHash })
    const gated = await gatedKyberTx({ routeSummary: quote.routeSummary, tokenIn: ADDR.WNATIVE, tokenOut: job.config.quoteToken, sender: job.config.owner, recipient: job.config.owner, amountIn: rewardWeth, slippageBps: job.config.safeguards.maxSlippageBps, nativeIn: false })
    setJobContext(job.id, 'staking_reward', { ...getJobContext<Partial<StakingRewardContext>>(job.id, 'staking_reward'), quoteRoute: routeAudit(quote.routeSummary, gated) })
    receipts.push(...await grantStrategyAllowance({ config: job.config, jobId: job.id, stepIndex: 13, txIndexStart: nextTransactionIndex(job.id, 13), privateKey, token: ADDR.WNATIVE, spender: gated.approvalTarget, amount: rewardWeth, forceExact: gated.exactApproval }))
    const before = await readTokenBalances(job.config.owner, [ADDR.WNATIVE, job.config.quoteToken])
    quoteSwapReceipt = await sendTracked({ config: job.config, jobId: job.id, stepIndex: 14, txIndex: 1, privateKey, tx: gated })
    receipts.push(quoteSwapReceipt)
    const after = await readTokenBalances(job.config.owner, [ADDR.WNATIVE, job.config.quoteToken])
    const spent = before[low(ADDR.WNATIVE)] - after[low(ADDR.WNATIVE)]
    rewardQuote = after[low(job.config.quoteToken)] - before[low(job.config.quoteToken)]
    if (spent !== rewardWeth || rewardQuote < gated.minOut) throw new Error('E_REWARD_ACCOUNTING')
    receipts.push(...await revokeStrategyAllowance({ config: job.config, jobId: job.id, stepIndex: 13, txIndexStart: nextTransactionIndex(job.id, 13), privateKey, token: ADDR.WNATIVE, spender: gated.approvalTarget, forceExact: gated.exactApproval }))
  }
  setJobContext(job.id, 'staking_reward', { ...getJobContext<Partial<StakingRewardContext>>(job.id, 'staking_reward'), rewardUp: rewardUp.toString(), rewardWeth: rewardWeth.toString(), rewardQuote: rewardQuote.toString(), quotedWeth: quotedWeth.toString(), quotedQuote: quotedQuote.toString(), settlementToken: job.config.quoteToken, withdrawTxHash: withdrawReceipt.transactionHash, swapTxHash: swapReceipt.transactionHash, quoteSwapTxHash: quoteSwapReceipt.transactionHash })
  return { rewardUp, rewardWeth, rewardQuote, quotedWeth, quotedQuote, receipts }
}

/** Idempotently approve and deposit the replacement NFT, then prove gauge custody. */
export async function ensureRestaked(job: RunnableJob, privateKey: `0x${string}`, tokenId: string): Promise<TransactionReceipt[]> {
  const gauge = job.config.staking?.gauge
  if (!job.config.staking?.enabled || !gauge) return []
  const receipts: TransactionReceipt[] = []
  let owner = await publicClient.readContract({ address: job.config.positionManager, abi: clPmAbi, functionName: 'ownerOf', args: [BigInt(tokenId)] })
  if (low(owner) === low(job.config.owner)) {
    if (job.config.execution.lowTransactionMode) {
      const approvedForAll = await publicClient.readContract({ address: job.config.positionManager, abi: clPmAbi, functionName: 'isApprovedForAll', args: [job.config.owner, gauge] })
      if (!approvedForAll) receipts.push(await sendTracked({ config: job.config, jobId: job.id, stepIndex: 15, txIndex: nextTransactionIndex(job.id, 15), privateKey, tx: nftOperatorApprovalCall(job.config.positionManager, gauge) }))
      else markStep({ jobId: job.id, index: 15, state: 'confirmed', result: { alreadyApprovedForAll: true, tokenId } })
    } else {
      const approved = await publicClient.readContract({ address: job.config.positionManager, abi: clPmAbi, functionName: 'getApproved', args: [BigInt(tokenId)] })
      if (low(approved) !== low(gauge)) receipts.push(await sendTracked({ config: job.config, jobId: job.id, stepIndex: 15, txIndex: nextTransactionIndex(job.id, 15), privateKey, tx: nftApprovalCall(job.config.positionManager, gauge, tokenId) }))
      else markStep({ jobId: job.id, index: 15, state: 'confirmed', result: { alreadyApproved: true, tokenId } })
    }
    receipts.push(await sendTracked({ config: job.config, jobId: job.id, stepIndex: 16, txIndex: nextTransactionIndex(job.id, 16), privateKey, tx: stakeCall(gauge, tokenId) }))
    owner = await publicClient.readContract({ address: job.config.positionManager, abi: clPmAbi, functionName: 'ownerOf', args: [BigInt(tokenId)] })
  } else {
    markStep({ jobId: job.id, index: 15, state: 'confirmed', result: { alreadyDeposited: true, tokenId } })
    markStep({ jobId: job.id, index: 16, state: 'confirmed', result: { alreadyDeposited: true, tokenId } })
  }
  const stakedIds = await publicClient.readContract({ address: gauge, abi: clGaugeAbi, functionName: 'stakedValues', args: [job.config.owner] })
  if (low(owner) !== low(gauge) || !stakedIds.some((id) => id === BigInt(tokenId))) throw new Error('E_STAKING_CUSTODY')
  return receipts
}
