import { getAddress, type Address, type Hex } from 'viem'
import { applySlippage } from '../src/lib/clmath'
import { EXECUTOR } from './config'

type WireQuote = {
  block: number
  amountIn: string
  amountOutGross: string
  amountOutNet: string
  minAmountOutNet: string
  feeBps: number
  deadline: number
  route: unknown[][] | unknown[]
  tx?: { to: string; value: string; data: string }
  allowanceTarget?: string | null
  error?: string
}

export type SolverRouteSummary = {
  tokenIn: string
  tokenOut: string
  amountIn: string
  amountOut: string
  route: unknown[][]
  executorSource: 'solver'
  solverBlock: number
}

let unavailableUntil = 0
const enabled = () => EXECUTOR.solverSettlers.length > 0 && EXECUTOR.solverAllowanceTargets.length > 0
const allowed = (address: Address, values: readonly Address[]) => values.some((value) => value.toLowerCase() === address.toLowerCase())

async function request(args: { tokenIn: Address; tokenOut: Address; amountIn: bigint; slippageBps: number; sender?: Address; recipient?: Address }) {
  const response = await fetch(`${EXECUTOR.solverBase}/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(args.sender ? 20_000 : 6_000),
    body: JSON.stringify({
      chainId: EXECUTOR.chainId,
      tokenIn: args.tokenIn,
      tokenOut: args.tokenOut,
      amountIn: args.amountIn.toString(),
      slippageBps: args.slippageBps,
      deadlineSeconds: 600,
      feeBps: 0,
      ...(args.sender ? { sender: args.sender } : {}),
      ...(args.recipient ? { recipient: args.recipient } : {}),
    }),
  })
  const body = await response.json().catch(() => null) as WireQuote | null
  if (!response.ok || !body) throw new Error(body?.error ?? 'E_SOLVER_QUOTE')
  if (BigInt(body.amountIn) !== args.amountIn || BigInt(body.amountOutNet) <= 0n || body.feeBps !== 0) throw new Error('E_SOLVER_QUOTE_IDENTITY')
  return body
}

export async function quoteSolver(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<SolverRouteSummary> {
  if (!enabled() || Date.now() < unavailableUntil) throw new Error('E_SOLVER_DISABLED')
  try {
    const body = await request({ tokenIn, tokenOut, amountIn, slippageBps: 100 })
    return {
      tokenIn,
      tokenOut,
      amountIn: amountIn.toString(),
      amountOut: body.amountOutNet,
      route: Array.isArray(body.route) ? body.route as unknown[][] : [],
      executorSource: 'solver',
      solverBlock: body.block,
    }
  } catch (error) {
    unavailableUntil = Date.now() + 60_000
    throw error
  }
}

export async function buildSolverTx(args: {
  routeSummary: SolverRouteSummary
  tokenIn: Address
  tokenOut: Address
  sender: Address
  recipient: Address
  amountIn: bigint
  slippageBps: number
}): Promise<{ to: Address; approvalTarget: Address; data: Hex; value: bigint; minOut: bigint }> {
  if (!enabled()) throw new Error('E_SOLVER_DISABLED')
  if (getAddress(args.routeSummary.tokenIn) !== getAddress(args.tokenIn) || getAddress(args.routeSummary.tokenOut) !== getAddress(args.tokenOut) || BigInt(args.routeSummary.amountIn) !== args.amountIn)
    throw new Error('E_SOLVER_QUOTE_IDENTITY')
  const originalMin = applySlippage(BigInt(args.routeSummary.amountOut), args.slippageBps)
  const body = await request({ ...args })
  if (!body.tx || !body.allowanceTarget) throw new Error('E_SOLVER_BUILD')
  const to = getAddress(body.tx.to)
  const approvalTarget = getAddress(body.allowanceTarget)
  if (!allowed(to, EXECUTOR.solverSettlers) || !allowed(approvalTarget, EXECUTOR.solverAllowanceTargets)) throw new Error('E_SOLVER_ALLOWLIST')
  if (BigInt(body.tx.value) !== 0n || !/^0x[0-9a-f]+$/i.test(body.tx.data)) throw new Error('E_SOLVER_VALUE')
  if (BigInt(body.amountOutNet) < originalMin || BigInt(body.minAmountOutNet) < originalMin) throw new Error('E_SOLVER_DRIFT')
  if (!Number.isInteger(body.deadline) || body.deadline <= Math.floor(Date.now() / 1000)) throw new Error('E_SOLVER_DEADLINE')
  return { to, approvalTarget, data: body.tx.data as Hex, value: 0n, minOut: originalMin }
}
