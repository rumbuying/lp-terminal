import { keccak256, parseUnits, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { StrategyConfig } from '../shared/strategy/types'
import { ADDR } from '../src/config/addresses'
import { bufferedLegacyGasPrice, isRetryableFeeRejection } from '../src/lib/gasPrice'
import { broadcastClient, publicClient } from './chain'
import { EXECUTOR } from './config'
import { executorPaused, markStep, markTransaction } from './store'
import { isTransientRpcFailure, retryDelay } from './rpc-retry'

const CHAIN_ID = 4663

export type SafeTx = { to: Address; data: Hex; value?: bigint }

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Reads performed before signing are safe to retry: no nonce has been marked
 * and no transaction can have reached the mempool. Keep broadcast itself
 * single-shot except for the explicit fee-rejection path below.
 */
async function retryPreflightRpc<T>(read: () => Promise<T>): Promise<T> {
  let last: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await read()
    } catch (error) {
      last = error
      if (attempt < 2) await wait(250 * (2 ** attempt))
    }
  }
  throw last
}

async function broadcastExact(serializedTransaction: Hex, localHash: Hex): Promise<Hex> {
  let last: unknown
  for (let attempt = 0; attempt <= EXECUTOR.rpcRetryCount; attempt += 1) {
    try {
      const returned = await broadcastClient.sendRawTransaction({ serializedTransaction })
      if (returned.toLowerCase() !== localHash.toLowerCase()) throw new Error('E_BROADCAST_HASH')
      return localHash
    } catch (error) {
      last = error
      // A previous attempt may have reached the mempool even if its HTTP
      // response was lost. The locally-derived durable hash makes that fact
      // unambiguous and lets us continue without changing nonce or calldata.
      try {
        await publicClient.getTransaction({ hash: localHash })
        return localHash
      } catch {
        // Not visible yet. Retry only provider/network availability failures.
      }
      if (attempt === EXECUTOR.rpcRetryCount || !isTransientRpcFailure(error)) throw error
      await wait(retryDelay(EXECUTOR.rpcRetryDelayMs, attempt))
    }
  }
  throw last ?? new Error('E_BROADCAST')
}

/** The executor's only transaction sender. Never accepts arbitrary RPC method names. */
export async function sendTracked(args: { config: StrategyConfig; jobId: string; stepIndex: number; txIndex?: number; privateKey: Hex; tx: SafeTx }) {
  if (executorPaused()) throw new Error('E_EXECUTOR_PAUSED')
  const account = privateKeyToAccount(args.privateKey)
  if (account.address.toLowerCase() !== args.config.owner.toLowerCase()) throw new Error('E_OWNER')
  if ((await retryPreflightRpc(() => publicClient.getChainId())) !== CHAIN_ID) throw new Error('E_CHAIN')
  const nonce = await retryPreflightRpc(() => publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }))
  const estimatedGas = await retryPreflightRpc(() => publicClient.estimateGas({ account: account.address, to: args.tx.to, data: args.tx.data, value: args.tx.value ?? 0n }))
  const gas = (estimatedGas * 120n + 99n) / 100n
  const calldataHash = keccak256(args.tx.data)
  markStep({ jobId: args.jobId, index: args.stepIndex, state: 'sending', nonce: BigInt(nonce), txTo: args.tx.to, calldataHash })
  const txIndex = args.txIndex ?? 0
  markTransaction({ jobId: args.jobId, stepIndex: args.stepIndex, txIndex, state: 'sending', nonce: BigInt(nonce), txTo: args.tx.to, calldataHash })
  let hash: Hex | undefined
  let previousGasPrice: bigint | undefined
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [suggested, latestBlock] = await retryPreflightRpc(() => Promise.all([
      publicClient.getGasPrice(),
      publicClient.getBlock({ blockTag: 'latest' }),
    ]))
    const gasPrice = bufferedLegacyGasPrice(suggested, latestBlock.baseFeePerGas ?? undefined, previousGasPrice)
    if (args.config.execution.maxGasPriceWei && gasPrice > BigInt(args.config.execution.maxGasPriceWei)) throw new Error('E_GAS_PRICE_LIMIT')
    if (args.config.execution.maxGasQuotePerTx) {
      // On Robinhood Chain native gas and canonical WETH are 1:1. Any other
      // quote token needs a fresh oracle/route; fail closed until one exists.
      if (args.config.quoteToken.toLowerCase() !== ADDR.WETH.toLowerCase()) throw new Error('E_LIMIT_PRICE')
      if (gas * gasPrice > parseUnits(args.config.execution.maxGasQuotePerTx, 18)) throw new Error('E_GAS_LIMIT')
    }
    const serializedTransaction = await account.signTransaction({
      chainId: CHAIN_ID,
      type: 'legacy',
      to: args.tx.to,
      data: args.tx.data,
      value: args.tx.value ?? 0n,
      nonce,
      gasPrice,
      gas,
    })
    const localHash = keccak256(serializedTransaction)
    // Persist the deterministic transaction hash before the first network
    // send. Recovery can now query an ambiguously-broadcast transaction by
    // hash instead of treating a consumed nonce as unknowable.
    markStep({ jobId: args.jobId, index: args.stepIndex, state: 'sending', nonce: BigInt(nonce), txHash: localHash, txTo: args.tx.to, calldataHash })
    markTransaction({ jobId: args.jobId, stepIndex: args.stepIndex, txIndex, state: 'sending', nonce: BigInt(nonce), txHash: localHash, txTo: args.tx.to, calldataHash })
    try {
      hash = await broadcastExact(serializedTransaction, localHash)
      break
    } catch (error) {
      // These errors prove the node rejected the transaction before admitting
      // it to the mempool, so re-signing the same nonce with a higher fee is
      // safe. Ambiguous transport failures are never retried here.
      if (attempt === 2 || !isRetryableFeeRejection(error)) throw error
      previousGasPrice = gasPrice
    }
  }
  if (!hash) throw new Error('E_BROADCAST')
  // The hash is durable before any receipt wait or subsequent chain read.
  markStep({ jobId: args.jobId, index: args.stepIndex, state: 'sent', nonce: BigInt(nonce), txHash: hash, txTo: args.tx.to, calldataHash })
  markTransaction({ jobId: args.jobId, stepIndex: args.stepIndex, txIndex, state: 'sent', nonce: BigInt(nonce), txHash: hash, txTo: args.tx.to, calldataHash })
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: EXECUTOR.confirmations, timeout: 180_000 })
  if (receipt.status !== 'success') {
    markStep({ jobId: args.jobId, index: args.stepIndex, state: 'failed', txHash: hash, blockNumber: receipt.blockNumber, errorCode: 'E_TX_REVERTED' })
    markTransaction({ jobId: args.jobId, stepIndex: args.stepIndex, txIndex, state: 'failed', txHash: hash, txTo: args.tx.to, calldataHash, blockNumber: receipt.blockNumber, errorCode: 'E_TX_REVERTED' })
    throw new Error('E_TX_REVERTED')
  }
  markStep({ jobId: args.jobId, index: args.stepIndex, state: 'confirmed', txHash: hash, blockNumber: receipt.blockNumber, result: { gasUsed: receipt.gasUsed.toString() } })
  markTransaction({ jobId: args.jobId, stepIndex: args.stepIndex, txIndex, state: 'confirmed', txHash: hash, txTo: args.tx.to, calldataHash, blockNumber: receipt.blockNumber, result: { gasUsed: receipt.gasUsed.toString() } })
  return receipt
}
