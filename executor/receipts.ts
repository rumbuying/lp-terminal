import { parseEventLogs, type Address, type TransactionReceipt } from 'viem'
import { clPmAbi, erc20Abi } from '../src/abi'

/** Ground-truth receipt amounts, used instead of pre-transaction estimates. */
export function receiptLiquidityFlows(receipt: TransactionReceipt, positionManager: Address, tokenId: bigint) {
  const logs = parseEventLogs({ abi: clPmAbi, logs: receipt.logs, strict: false })
  let principal0 = 0n
  let principal1 = 0n
  let collected0 = 0n
  let collected1 = 0n
  let mintedTokenId: bigint | undefined
  let minted0 = 0n
  let minted1 = 0n
  for (const log of logs) {
    if (log.address.toLowerCase() !== positionManager.toLowerCase()) continue
    if (log.eventName === 'DecreaseLiquidity' && log.args.tokenId === tokenId) {
      principal0 += log.args.amount0 ?? 0n
      principal1 += log.args.amount1 ?? 0n
    }
    if (log.eventName === 'Collect' && log.args.tokenId === tokenId) {
      collected0 += log.args.amount0 ?? 0n
      collected1 += log.args.amount1 ?? 0n
    }
    if (log.eventName === 'IncreaseLiquidity' && log.args.tokenId !== undefined && (tokenId === 0n || log.args.tokenId === tokenId)) {
      mintedTokenId = log.args.tokenId
      minted0 += log.args.amount0 ?? 0n
      minted1 += log.args.amount1 ?? 0n
    }
  }
  return { principal0, principal1, collected0, collected1, mintedTokenId, minted0, minted1 }
}

/** Net ERC-20 wallet delta reconstructed from receipt logs. */
export function receiptTokenDelta(receipt: TransactionReceipt, token: Address, owner: Address): bigint {
  const logs = parseEventLogs({ abi: erc20Abi, logs: receipt.logs, strict: false })
  let delta = 0n
  for (const log of logs) {
    if (log.address.toLowerCase() !== token.toLowerCase() || log.eventName !== 'Transfer') continue
    if (log.args.from?.toLowerCase() === owner.toLowerCase()) delta -= log.args.value ?? 0n
    if (log.args.to?.toLowerCase() === owner.toLowerCase()) delta += log.args.value ?? 0n
  }
  return delta
}
