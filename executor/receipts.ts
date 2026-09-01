import { parseEventLogs, zeroAddress, type Address, type TransactionReceipt } from 'viem'
import { clPmAbi, erc20Abi } from '../src/abi'
import { v4PositionManagerAbi } from '../src/lib/uniV4'

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

export function receiptV4MintedTokenId(receipt: TransactionReceipt, positionManager: Address, owner: Address): bigint | undefined {
  const logs = parseEventLogs({ abi: v4PositionManagerAbi, logs: receipt.logs, strict: false })
  for (const log of logs) {
    if (log.address.toLowerCase() !== positionManager.toLowerCase() || log.eventName !== 'Transfer') continue
    if (log.args.from === '0x0000000000000000000000000000000000000000' && log.args.to?.toLowerCase() === owner.toLowerCase())
      return log.args.tokenId
  }
  return undefined
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

/**
 * The per-currency net wallet flows of a v4 `modifyLiquidities` receipt, for the
 * two sides of its pool.
 *
 * v4 emits no amount event: an exit's principal and fees settle in one opaque
 * delta, and a mint is just the position manager pulling through Permit2. What
 * the receipt CAN prove exactly is each ERC-20 side — the manager settles it
 * through the token's own `Transfer`, so `receiptTokenDelta` nets the owner's
 * real movement (positive = received, negative = paid), immune to any outside
 * wallet activity in between.
 *
 * What it CANNOT prove is the native (`address(0)`) side: a native deposit rides
 * in as `msg.value` (part of which `SWEEP` may refund), and a native payout is
 * an unwrap that leaves no log. A `null` flow is therefore not "zero" — it is
 * "unprovable from this receipt", and the caller must reconstruct it from the
 * persisted pre-action balance (the runner's `receivedByWallet` model) or, for a
 * pure mint, the transaction's own value.
 */
export function receiptV4TokenFlows(
  receipt: TransactionReceipt,
  owner: Address,
  token0: Address,
  token1: Address,
): { flow0: bigint | null; flow1: bigint | null } {
  const delta = (token: Address): bigint | null =>
    token.toLowerCase() === zeroAddress ? null : receiptTokenDelta(receipt, token, owner)
  return { flow0: delta(token0), flow1: delta(token1) }
}
