import type { Address, TransactionReceipt } from 'viem'
import { attributeCollect } from '../shared/strategy/accounting'
import type { LedgerEntry } from '../shared/strategy/types'
import { receiptLiquidityFlows } from './receipts'

/** Convert one successful decrease/collect receipt into replayable ledger entries. */
export function accountCollectReceipt(args: {
  receipt: TransactionReceipt
  positionManager: Address
  tokenId: bigint
  strategyId: string
  cycleId?: string
  token0: Address
  token1: Address
  unstakedLevyPpm?: number
}): LedgerEntry[] {
  const flows = receiptLiquidityFlows(args.receipt, args.positionManager, args.tokenId)
  const entries = attributeCollect({
    strategyId: args.strategyId,
    cycleId: args.cycleId,
    ts: Math.floor(Date.now() / 1000),
    token0: args.token0,
    token1: args.token1,
    principal0: flows.principal0.toString(), principal1: flows.principal1.toString(),
    collected0: flows.collected0.toString(), collected1: flows.collected1.toString(),
    unstakedLevyPpm: args.unstakedLevyPpm,
    txHash: args.receipt.transactionHash,
    blockNumber: args.receipt.blockNumber.toString(),
  })
  return entries.map((entry, index) => ({ ...entry, id: `${args.receipt.transactionHash}-${index}` }))
}
