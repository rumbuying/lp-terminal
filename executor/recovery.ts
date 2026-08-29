import { keccak256, type Hex, type TransactionReceipt } from 'viem'
import { clPmAbi } from '../src/abi'
import { confirmedTransactionsAtNonce, jobSteps, jobTransactions, reconcileJobTransaction, recoveryJobById } from './store'
import { publicClient } from './chain'
import { receiptLiquidityFlows, receiptV4MintedTokenId } from './receipts'
import { v4PositionManagerAbi } from '../src/lib/uniV4'

export type RecoveryTxState = 'confirmed' | 'reverted' | 'pending' | 'absent' | 'ambiguous'
export type RecoveryTxFact = {
  stepIndex: number
  txIndex: number
  nonce?: bigint
  hash?: Hex
  state: RecoveryTxState
  blockNumber?: bigint
}

export type RecoveryDisposition =
  | 'restart_safe'
  | 'resume_collect'
  | 'resume_from_wallet'
  | 'resume_staking_exit'
  | 'resume_revoke'
  | 'commit_ready'
  | 'wait_pending'
  | 'manual_review'

/** Pure recovery policy. It never treats an uncertain nonce as safe to resend. */
export function classifyRecovery(transactions: readonly RecoveryTxFact[], confirmedSteps: readonly number[] = []): RecoveryDisposition {
  if (transactions.some((tx) => tx.state === 'ambiguous')) return 'manual_review'
  if (transactions.some((tx) => tx.state === 'pending')) return 'wait_pending'
  const confirmed = transactions.filter((tx) => tx.state === 'confirmed')
  if (confirmed.some((tx) => tx.stepIndex === 8)) return confirmedSteps.includes(9) && confirmedSteps.includes(10) ? 'commit_ready' : 'resume_revoke'
  if (confirmed.some((tx) => tx.stepIndex >= 2 && tx.stepIndex <= 7)) return 'resume_from_wallet'
  if (confirmed.some((tx) => tx.stepIndex === 1)) return 'resume_collect'
  if (confirmed.some((tx) => tx.stepIndex >= 12 && tx.stepIndex <= 14)) return 'resume_staking_exit'
  return 'restart_safe'
}

async function hasConfirmedLocalReplacement(row: Record<string, unknown>, owner: `0x${string}`, nonce: bigint): Promise<boolean> {
  const originalTo = String(row.tx_to ?? '').toLowerCase()
  const originalCalldata = String(row.calldata_hash ?? '').toLowerCase()
  for (const candidate of confirmedTransactionsAtNonce(nonce)) {
    if (candidate.job_id === row.job_id && Number(candidate.step_index) === Number(row.step_index) && Number(candidate.tx_index) === Number(row.tx_index)) continue
    const candidateHash = typeof candidate.tx_hash === 'string' ? candidate.tx_hash as Hex : undefined
    if (!candidateHash) continue
    try {
      const [transaction, receipt] = await Promise.all([
        publicClient.getTransaction({ hash: candidateHash }),
        publicClient.getTransactionReceipt({ hash: candidateHash }),
      ])
      const candidateTo = String(candidate.tx_to).toLowerCase()
      const candidateCalldata = String(candidate.calldata_hash).toLowerCase()
      const candidateMatchesChain = receipt.status === 'success'
        && transaction.from.toLowerCase() === owner.toLowerCase()
        && BigInt(transaction.nonce) === nonce
        && transaction.to?.toLowerCase() === candidateTo
        && keccak256(transaction.input).toLowerCase() === candidateCalldata
      const definitelyDifferent = candidateTo !== originalTo || candidateCalldata !== originalCalldata
      if (candidateMatchesChain && definitelyDifferent) return true
    } catch {
      // A candidate that cannot be fully verified never relaxes recovery.
    }
  }
  return false
}

async function transactionFact(row: Record<string, unknown>, owner: `0x${string}`): Promise<RecoveryTxFact> {
  const stepIndex = Number(row.step_index)
  const txIndex = Number(row.tx_index)
  const nonce = row.nonce === null || row.nonce === undefined ? undefined : BigInt(String(row.nonce))
  const hash = typeof row.tx_hash === 'string' ? row.tx_hash as Hex : undefined
  const base = { stepIndex, txIndex, nonce, hash }

  if (hash) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash })
      const transaction = await publicClient.getTransaction({ hash })
      const expectedTo = String(row.tx_to).toLowerCase()
      const expectedCalldata = String(row.calldata_hash).toLowerCase()
      if (transaction.from.toLowerCase() !== owner.toLowerCase() || transaction.to?.toLowerCase() !== expectedTo || keccak256(transaction.input).toLowerCase() !== expectedCalldata)
        return { ...base, state: 'ambiguous' }
      return { ...base, state: receipt.status === 'success' ? 'confirmed' : 'reverted', blockNumber: receipt.blockNumber }
    } catch {
      try {
        await publicClient.getTransaction({ hash })
        return { ...base, state: 'pending' }
      } catch {
        if (nonce === undefined) return { ...base, state: 'ambiguous' }
        const [latest, pending] = await Promise.all([
          publicClient.getTransactionCount({ address: owner, blockTag: 'latest' }),
          publicClient.getTransactionCount({ address: owner, blockTag: 'pending' }),
        ])
        if (latest <= nonce && pending <= nonce) return { ...base, state: 'absent' }
        return { ...base, state: await hasConfirmedLocalReplacement(row, owner, nonce) ? 'absent' : 'ambiguous' }
      }
    }
  }

  if (nonce === undefined) return { ...base, state: 'absent' }
  const [latest, pending] = await Promise.all([
    publicClient.getTransactionCount({ address: owner, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: owner, blockTag: 'pending' }),
  ])
  if (latest <= nonce && pending <= nonce) return { ...base, state: 'absent' }

  // A later local job can legitimately reuse a nonce after this transaction
  // was rejected before mempool admission. Unknown/external nonce consumption
  // remains manual-review only.
  if (await hasConfirmedLocalReplacement(row, owner, nonce)) return { ...base, state: 'absent' }
  return { ...base, state: 'ambiguous' }
}

export async function inspectRecovery(jobId: string, options?: { reconcile?: boolean }) {
  const job = recoveryJobById(jobId)
  if (!job) throw new Error('E_RECOVERY_JOB')
  const { transactions, steps } = await reconcileRecoveryTransactions(jobId, options)
  const confirmedSteps = steps.filter((step) => step.state === 'confirmed').map((step) => Number(step.step_index))
  const classified = classifyRecovery(transactions, confirmedSteps)
  // v4 exit/mint receipts do not expose the v3 amount events used by the
  // automated recovery ledger. A normal run is fully supported; after an
  // interrupted confirmed mutation, fail closed for operator reconciliation
  // instead of replaying a v3 recovery call against the v4 manager.
  const disposition = job.config.protocol === 'univ4' && transactions.some((tx) => tx.state === 'confirmed')
    ? 'manual_review'
    : classified
  if ((job.plan as unknown as { kind?: string }).kind === 'profit_withdrawal') {
    const profitDisposition = transactions.some((tx) => tx.state === 'ambiguous')
      ? 'manual_review'
      : transactions.some((tx) => tx.state === 'pending') ? 'wait_pending' : 'commit_ready'
    return {
      jobId,
      strategyId: job.config.id,
      kind: 'profit_withdrawal' as const,
      disposition: profitDisposition,
      transactions: transactions.map((tx) => ({ ...tx, nonce: tx.nonce?.toString(), blockNumber: tx.blockNumber?.toString() })),
    }
  }

  let mintedTokenId: string | undefined
  const mintFact = transactions.find((tx) => tx.stepIndex === 8 && tx.state === 'confirmed' && tx.hash)
  if (mintFact?.hash) {
    const receipt = await publicClient.getTransactionReceipt({ hash: mintFact.hash }) as TransactionReceipt
    mintedTokenId = (job.config.protocol === 'univ4'
      ? receiptV4MintedTokenId(receipt, job.config.positionManager, job.config.owner)
      : receiptLiquidityFlows(receipt, job.config.positionManager, 0n).mintedTokenId)?.toString()
  }

  let activePosition: { owner?: string; liquidity?: string; exists: boolean }
  try {
    const tokenId = BigInt(job.plan.snapshot.tokenId)
    const [owner, liquidity] = await Promise.all([
      publicClient.readContract({ address: job.config.positionManager, abi: job.config.protocol === 'univ4' ? v4PositionManagerAbi : clPmAbi, functionName: 'ownerOf', args: [tokenId] }),
      job.config.protocol === 'univ4'
        ? publicClient.readContract({ address: job.config.positionManager, abi: v4PositionManagerAbi, functionName: 'getPositionLiquidity', args: [tokenId] })
        : publicClient.readContract({ address: job.config.positionManager, abi: clPmAbi, functionName: 'positions', args: [tokenId] }).then((raw) => (raw as readonly unknown[])[7] as bigint),
    ])
    activePosition = { owner, liquidity: liquidity.toString(), exists: true }
  } catch {
    activePosition = { exists: false }
  }

  return {
    jobId,
    strategyId: job.config.id,
    disposition,
    transactions: transactions.map((tx) => ({ ...tx, nonce: tx.nonce?.toString(), blockNumber: tx.blockNumber?.toString() })),
    oldPosition: activePosition,
    mintedTokenId,
  }
}

export async function reconcileRecoveryTransactions(jobId: string, options?: { reconcile?: boolean }) {
  const job = recoveryJobById(jobId)
  if (!job) throw new Error('E_RECOVERY_JOB')
  const rows = jobTransactions(jobId)
  const steps = jobSteps(jobId)
  const transactions: RecoveryTxFact[] = []
  for (const row of rows) transactions.push(await transactionFact(row, job.config.owner))
  if (options?.reconcile) {
    for (const tx of transactions) {
      if (tx.state === 'confirmed') reconcileJobTransaction({ jobId, stepIndex: tx.stepIndex, txIndex: tx.txIndex, state: 'confirmed', blockNumber: tx.blockNumber })
      if (tx.state === 'reverted' || tx.state === 'absent') reconcileJobTransaction({
        jobId, stepIndex: tx.stepIndex, txIndex: tx.txIndex, state: 'failed', blockNumber: tx.blockNumber,
        errorCode: tx.state === 'reverted' ? 'E_TX_REVERTED' : 'E_TX_ABSENT',
      })
    }
  }
  return { transactions, steps }
}
