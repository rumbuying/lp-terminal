import { zeroAddress, type Address, type Hex, type TransactionReceipt } from 'viem'
import type { StrategyConfig } from '../shared/strategy/types'
import { readAllowance, readPermit2Allowance } from './chain'
import { sendTracked } from './signer'
import { exactApprovalCall, permit2ApprovalCall } from './steps'
import { v4Deployment } from '../src/config/networks'
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
  /** Opaque solver spenders never receive a persistent allowance. */
  forceExact?: boolean
}

export async function exactAllowance(args: AllowanceArgs) {
  if (args.token.toLowerCase() === zeroAddress) {
    markStep({ jobId: args.jobId, index: args.stepIndex, state: 'confirmed', result: { skipped: true, native: true } })
    return [] as TransactionReceipt[]
  }
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
  if (args.forceExact || !args.config.execution.lowTransactionMode) return exactAllowance(args)
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
  if (!args.forceExact && args.config.execution.lowTransactionMode) {
    const current = await readAllowance(args.token, args.config.owner, args.spender)
    markStep({ jobId: args.jobId, index: args.stepIndex, state: 'confirmed', result: { skipped: true, persistent: true, allowance: current.toString() } })
    return [] as TransactionReceipt[]
  }
  return exactAllowance({ ...args, amount: 0n })
}

const MAX_UINT160 = (1n << 160n) - 1n
const MAX_UINT48 = Number((1n << 48n) - 1n)

/** v4 ERC-20 pull path: token -> Permit2 -> PositionManager. Native currency
 * needs neither leg and is settled as msg.value by the mint call. */
export async function grantV4CurrencyAllowance(args: Omit<AllowanceArgs, 'spender'>) {
  if (args.token === zeroAddress || args.amount === 0n) {
    markStep({ jobId: args.jobId, index: args.stepIndex, state: 'confirmed', result: { skipped: true, native: args.token === zeroAddress } })
    return [] as TransactionReceipt[]
  }
  const deployment = v4Deployment(args.config.chainId)
  const receipts = await grantStrategyAllowance({ ...args, spender: deployment.PERMIT2 })
  const current = await readPermit2Allowance(deployment.PERMIT2, args.config.owner, args.token, deployment.POSITION_MANAGER)
  const desired = args.config.execution.lowTransactionMode ? MAX_UINT160 : args.amount
  if (current < args.amount || (!args.config.execution.lowTransactionMode && current !== desired)) {
    receipts.push(await sendTracked({
      ...args,
      txIndex: (args.txIndexStart ?? 0) + receipts.length,
      tx: permit2ApprovalCall(deployment.PERMIT2, args.token, deployment.POSITION_MANAGER, desired, args.config.execution.lowTransactionMode ? MAX_UINT48 : Math.floor(Date.now() / 1000) + 3600),
    }))
  }
  markStep({ jobId: args.jobId, index: args.stepIndex, state: 'confirmed', result: { permit2: desired.toString(), persistent: args.config.execution.lowTransactionMode } })
  return receipts
}

export async function revokeV4CurrencyAllowance(args: Omit<AllowanceArgs, 'amount' | 'spender'>) {
  if (args.token === zeroAddress) {
    markStep({ jobId: args.jobId, index: args.stepIndex, state: 'confirmed', result: { skipped: true, native: true } })
    return [] as TransactionReceipt[]
  }
  const deployment = v4Deployment(args.config.chainId)
  if (args.config.execution.lowTransactionMode) {
    const current = await readPermit2Allowance(deployment.PERMIT2, args.config.owner, args.token, deployment.POSITION_MANAGER)
    markStep({ jobId: args.jobId, index: args.stepIndex, state: 'confirmed', result: { skipped: true, persistent: true, permit2: current.toString() } })
    return [] as TransactionReceipt[]
  }
  const receipts: TransactionReceipt[] = []
  const permit2 = await readPermit2Allowance(deployment.PERMIT2, args.config.owner, args.token, deployment.POSITION_MANAGER)
  if (permit2 !== 0n) receipts.push(await sendTracked({ ...args, txIndex: args.txIndexStart ?? 0, tx: permit2ApprovalCall(deployment.PERMIT2, args.token, deployment.POSITION_MANAGER, 0n, 0) }))
  receipts.push(...await revokeStrategyAllowance({ ...args, txIndexStart: (args.txIndexStart ?? 0) + receipts.length, spender: deployment.PERMIT2 }))
  markStep({ jobId: args.jobId, index: args.stepIndex, state: 'confirmed', result: { permit2: '0', allowance: '0' } })
  return receipts
}
