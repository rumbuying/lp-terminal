import { keccak256, zeroAddress, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { FABLES_AUTO_POOL_IDS } from '../src/config/fables'
import { broadcastClient, publicClient } from './chain'
import { EXECUTOR } from './config'
import { executorPaused } from './store'
import { appendFablesLedger, fablesJobById, fablesJobTransactions,
  setFablesJobProgress, updateFablesTx, type FablesJob } from './fablesJobs'

export type FablesRecoveryResult = {
  unresolved: number
  confirmed: number
  reverted: number
}

/** Manual recovery broadcasts only the original durable signed bytes. */
export async function rebroadcastFablesTransaction(
  jobId: string,
  ordinal: number,
  client: Pick<PublicClient, 'sendRawTransaction' | 'getChainId'> = broadcastClient,
): Promise<Hex> {
  const job = fablesJobById(jobId)
  if (!job || job.state !== 'recovery') throw new Error('E_FABLES_NOT_IN_RECOVERY')
  if (executorPaused()) throw new Error('E_EXECUTOR_PAUSED')
  if (EXECUTOR.chainId !== 4663 || await client.getChainId() !== 4663)
    throw new Error('E_FABLES_CHAIN')
  if (!FABLES_AUTO_POOL_IDS.has(job.config.positionRef.poolId.toLowerCase()))
    throw new Error('E_FABLES_AUTO_POOL_NOT_APPROVED')
  const tx = fablesJobTransactions(jobId).find(row => row.ordinal === ordinal)
  if (!tx || (tx.state !== 'sending' && tx.state !== 'sent'))
    throw new Error('E_FABLES_TX_NOT_UNRESOLVED')
  if (!tx.signedTx) throw new Error('E_FABLES_SIGNED_TX_UNAVAILABLE')
  if (keccak256(tx.signedTx).toLowerCase() !== tx.hash.toLowerCase())
    throw new Error('E_FABLES_SIGNED_HASH_MISMATCH')
  const returned = await client.sendRawTransaction({ serializedTransaction: tx.signedTx })
  if (returned.toLowerCase() !== tx.hash.toLowerCase()) throw new Error('E_FABLES_BROADCAST_HASH')
  updateFablesTx(jobId, ordinal, { state: 'sent' })
  return returned
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
