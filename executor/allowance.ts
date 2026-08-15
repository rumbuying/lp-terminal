import type { Address, Hex, TransactionReceipt } from 'viem'
import type { StrategyConfig } from '../shared/strategy/types'
import { readAllowance } from './chain'
import { sendTracked } from './signer'
import { exactApprovalCall } from './steps'
import { markStep } from './store'

const MAX_UINT256 = (1n << 256n) - 1n

type AllowanceArgs = {
  config: StrategyConfig
  jobId: string
  stepIndex: number
  txIndexStart?: number
  privateKey: Hex
  token: Address
  spender: Address
  amount: bigint
}

export async function exactAllowance(args: AllowanceArgs) {
  let txIndex = args.txIndexStart ?? 0
  const current = await readAllowance(args.token, args.config.owner, args.spender)
  if (current === args.amount) {
    markStep({ jobId: args.jobId, index: args.stepIndex, state: 'confirmed', result: { skipped: true, allowance: current.toString() } })
    return [] as TransactionReceipt[]
  }
  const receipts: TransactionReceipt[] = []
  if (current !== 0n && args.amount !== 0n) {
    receipts.push(await sendTracked({ ...args, txIndex: txIndex++, tx: exactApprovalCall(args.token, args.spender, 0n) }))
  }
  receipts.push(await sendTracked({ ...args, txIndex, tx: exactApprovalCall(args.token, args.spender, args.amount) }))
  markStep({ jobId: args.jobId, index: args.stepIndex, state: 'confirmed', result: { allowance: args.amount.toString() } })
  return receipts
}

/** Grant either the exact cycle amount or a persistent maximum allowance. */
export async function grantStrategyAllowance(args: AllowanceArgs) {
  if (!args.config.execution.lowTransactionMode) return exactAllowance(args)
  let txIndex = args.txIndexStart ?? 0
  const current = await readAllowance(args.token, args.config.owner, args.spender)
  if (current >= args.amount) {
    markStep({ jobId: args.jobId, index: args.stepIndex, state: 'confirmed', result: { skipped: true, persistent: true, allowance: current.toString() } })
    return [] as TransactionReceipt[]
  }
  const receipts: TransactionReceipt[] = []
  if (current !== 0n) receipts.push(await sendTracked({ ...args, txIndex: txIndex++, tx: exactApprovalCall(args.token, args.spender, 0n) }))
  receipts.push(await sendTracked({ ...args, txIndex, tx: exactApprovalCall(args.token, args.spender, MAX_UINT256) }))
  markStep({ jobId: args.jobId, index: args.stepIndex, state: 'confirmed', result: { persistent: true, allowance: MAX_UINT256.toString() } })
  return receipts
}

/** Exact mode revokes after use; low-transaction mode deliberately retains it. */
export async function revokeStrategyAllowance(args: Omit<AllowanceArgs, 'amount'>) {
  if (args.config.execution.lowTransactionMode) {
    const current = await readAllowance(args.token, args.config.owner, args.spender)
    markStep({ jobId: args.jobId, index: args.stepIndex, state: 'confirmed', result: { skipped: true, persistent: true, allowance: current.toString() } })
    return [] as TransactionReceipt[]
  }
  return exactAllowance({ ...args, amount: 0n })
}
