import { keccak256, zeroAddress, type Address, type Hex, type TransactionReceipt } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bufferedLegacyGasPrice } from '../src/lib/gasPrice'
import { FABLES_AUTO_POOL_IDS } from '../src/config/fables'
import { broadcastClient, publicClient } from './chain'
import { EXECUTOR } from './config'
import { appendFablesLedger, fablesJobTransactions, recordFablesTxIntent,
  setFablesJobProgress, updateFablesTx, type FablesJob, type FablesJobStage } from './fablesJobs'
import { executorPaused } from './store'

export type FablesSafeTx = { to: Address; data: Hex; value?: bigint }

/** Single-shot Fables sender. A deterministic hash is stored before broadcast. */
export async function sendFablesTracked(args: {
  job: FablesJob; stage: FablesJobStage; ordinal: number; privateKey: Hex; tx: FablesSafeTx
}): Promise<TransactionReceipt> {
  const { job, stage, ordinal, tx } = args
  if (executorPaused()) throw new Error('E_EXECUTOR_PAUSED')
  if (!FABLES_AUTO_POOL_IDS.has(job.config.positionRef.poolId.toLowerCase()))
    throw new Error('E_FABLES_AUTO_POOL_NOT_APPROVED')
  if (job.state !== 'running' && job.state !== 'recovery') throw new Error('E_FABLES_JOB_NOT_RUNNING')
  if (job.stage !== stage) throw new Error('E_FABLES_STAGE_CHANGED')
  if (fablesJobTransactions(job.id).some(record => record.ordinal === ordinal
    || (record.stage === stage && ['sending','sent'].includes(record.state))))
    throw new Error('E_FABLES_TX_ALREADY_SENT')
  const account = privateKeyToAccount(args.privateKey)
  if (account.address.toLowerCase() !== job.config.owner.toLowerCase()
    || account.address.toLowerCase() !== job.config.execution.signerAddress?.toLowerCase())
    throw new Error('E_FABLES_OWNER')
  if (await publicClient.getChainId() !== 4663 || EXECUTOR.chainId !== 4663)
    throw new Error('E_FABLES_CHAIN')
  const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' })
  const estimatedGas = await publicClient.estimateGas({
    account: account.address, to: tx.to, data: tx.data, value: tx.value ?? 0n,
  })
  const gas = (estimatedGas * 120n + 99n) / 100n
  const [suggested, latestBlock, nativeBalance] = await Promise.all([
    publicClient.getGasPrice(), publicClient.getBlock({ blockTag: 'latest' }),
    publicClient.getBalance({ address: account.address }),
  ])
  const gasPrice = bufferedLegacyGasPrice(suggested, latestBlock.baseFeePerGas ?? undefined)
  if (job.config.execution.maxGasPriceWei && gasPrice > BigInt(job.config.execution.maxGasPriceWei))
    throw new Error('E_FABLES_GAS_PRICE_LIMIT')
  if (nativeBalance < (tx.value ?? 0n) + gas * gasPrice + BigInt(job.config.safeguards.minNativeGasReserveWei))
    throw new Error('E_FABLES_GAS_RESERVE')
  const serialized = await account.signTransaction({
    chainId: 4663, type: 'legacy', to: tx.to, data: tx.data,
    value: tx.value ?? 0n, nonce, gasPrice, gas,
  })
  const hash = keccak256(serialized)
  recordFablesTxIntent({ jobId: job.id, ordinal, stage, nonce: BigInt(nonce),
    hash, to: tx.to, calldataHash: keccak256(tx.data) })
  try {
    const returned = await broadcastClient.sendRawTransaction({ serializedTransaction: serialized })
    if (returned.toLowerCase() !== hash.toLowerCase()) throw new Error('E_FABLES_BROADCAST_HASH')
    updateFablesTx(job.id, ordinal, { state: 'sent' })
  } catch (error) {
    // The network may have accepted the exact signed payload before its HTTP
    // response was lost. Recovery checks this durable hash and never resends.
    setFablesJobProgress(job.id, { state: 'recovery', errorCode: 'E_FABLES_BROADCAST_UNKNOWN' })
    throw error
  }
  let receipt: TransactionReceipt
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: EXECUTOR.confirmations, timeout: 60_000 })
  } catch (error) {
    setFablesJobProgress(job.id, { state: 'recovery', errorCode: 'E_FABLES_RECEIPT_UNKNOWN' })
    throw error
  }
  if (receipt.status !== 'success') {
    updateFablesTx(job.id, ordinal, { state: 'failed', blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed, gasPrice: receipt.effectiveGasPrice, errorCode: 'E_FABLES_TX_REVERTED' })
    setFablesJobProgress(job.id, { state: 'recovery', errorCode: 'E_FABLES_TX_REVERTED' })
    throw new Error('E_FABLES_TX_REVERTED')
  }
  updateFablesTx(job.id, ordinal, { state: 'confirmed', blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed, gasPrice: receipt.effectiveGasPrice })
  appendFablesLedger({ strategyId: job.strategyId, jobId: job.id,
    blockNumber: receipt.blockNumber, txHash: hash, kind: 'gas', token: zeroAddress,
    amount: receipt.gasUsed * receipt.effectiveGasPrice,
    meta: { stage, ordinal },
  })
  return receipt
}
