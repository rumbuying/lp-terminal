import { zeroAddress, type PublicClient, type TransactionReceipt } from 'viem'
import { publicClient } from './chain'
import { EXECUTOR } from './config'
import { appendFablesLedger, fablesJobById, fablesJobTransactions,
  setFablesJobProgress, updateFablesTx, type FablesJob } from './fablesJobs'

export type FablesRecoveryResult = {
  unresolved: number
  confirmed: number
  reverted: number
}

/** Reconcile durable hashes before any stage may construct another transaction. */
export async function reconcileFablesTransactions(
  job: FablesJob,
  client: Pick<PublicClient, 'getTransactionReceipt' | 'getBlockNumber'> = publicClient,
): Promise<FablesRecoveryResult> {
  let unresolved = 0
  let confirmed = 0
  let reverted = 0
  for (const tx of fablesJobTransactions(job.id)) {
    if (tx.state !== 'sending' && tx.state !== 'sent') continue
    let receipt: TransactionReceipt
    try { receipt = await client.getTransactionReceipt({ hash: tx.hash }) }
    catch {
      unresolved += 1
      continue
    }
    if (receipt.transactionHash.toLowerCase() !== tx.hash.toLowerCase())
      throw new Error('E_FABLES_RECEIPT_HASH_MISMATCH')
    const head = await client.getBlockNumber()
    if (head < receipt.blockNumber + BigInt(EXECUTOR.confirmations - 1)) {
      unresolved += 1
      continue
    }
    if (receipt.status === 'success') {
      updateFablesTx(job.id, tx.ordinal, { state: 'confirmed', blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed, gasPrice: receipt.effectiveGasPrice })
      appendFablesLedger({ strategyId: job.strategyId, jobId: job.id,
        blockNumber: receipt.blockNumber, txHash: tx.hash, kind: 'gas', token: zeroAddress,
        amount: receipt.gasUsed * receipt.effectiveGasPrice,
        meta: { stage: tx.stage, ordinal: tx.ordinal, recovered: true },
      })
      confirmed += 1
    } else {
      updateFablesTx(job.id, tx.ordinal, { state: 'failed', blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed, gasPrice: receipt.effectiveGasPrice,
        errorCode: 'E_FABLES_TX_REVERTED' })
      appendFablesLedger({ strategyId: job.strategyId, jobId: job.id,
        blockNumber: receipt.blockNumber, txHash: tx.hash, kind: 'gas', token: zeroAddress,
        amount: receipt.gasUsed * receipt.effectiveGasPrice,
        meta: { stage: tx.stage, ordinal: tx.ordinal, reverted: true },
      })
      reverted += 1
    }
  }
  const current = fablesJobById(job.id)
  if (unresolved && current && current.state !== 'recovery')
    setFablesJobProgress(job.id, { state: 'recovery', errorCode: 'E_FABLES_TX_UNRESOLVED' })
  return { unresolved, confirmed, reverted }
}
