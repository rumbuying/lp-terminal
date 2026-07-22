// Direct quote-to-confirmed swap execution shared by MARKET and ZAP.
import { getPublicClient, sendTransaction } from 'wagmi/actions'
import { getAddress, type Address, type Hex, type ReplacementReason, type TransactionReceipt } from 'viem'
import { CHAIN_ID } from '../config/addresses'
import { swapFee } from '../config/env'
import { wagmiConfig } from '../config/wagmi'
import { t } from '../i18n'
import { buildDirectTransaction, erc20Of, isNative, quoteDirectRoute, type DirectRoute } from './directSwap'
import { fetchSolverQuote } from './solver'
import { preflightSolverTransaction } from './solverPreflight'
import { deadline, ensureAllowance, receivedOf, step, type StepFailWhy } from './tx'

/** a failure a bigger slippage tolerance could have absorbed (pre-flight
 *  re-quote fell below the caller's minimum) — callers key retry advice on it */
export class SlippageError extends Error {}

export type SwapExecutionIntent = {
  route: DirectRoute
  tokenIn: Address
  tokenOut: Address
  amountIn: bigint
  minimumAmountOut: bigint
  sender: Address
  recipient: Address
  inputSymbol: string
  label: string
  /** terminal fee for this execution; defaults to swapFee() — zap passes zapFee() */
  fee?: { bps: number; receiver: Address }
  /** fires when the swap tx is broadcast (hash in hand) — before it confirms */
  onSubmitted?: (hash: Hex) => void
  onReplaced?: (oldHash: Hex, newHash: Hex, reason: ReplacementReason) => void
  /** hears WHY the send step returned null (rejection vs on-chain revert) */
  onStepFail?: (why: StepFailWhy) => void
}

type ConfirmedSwap = {
  receipt: TransactionReceipt
  output: { kind: 'erc20'; token: Address; amount: bigint } | { kind: 'native' }
}

type PreparedSwap = {
  to: Address
  data: Hex
  value: bigint
  spender: Address | null
  inputToken: Address | null
  outputToken: Address | null
}

async function prepareSwap(args: SwapExecutionIntent): Promise<PreparedSwap> {
  const fee = args.fee ?? swapFee()
  const client = getPublicClient(wagmiConfig, { chainId: CHAIN_ID })
  const quote = await quoteDirectRoute(
    client,
    args.route,
    args.tokenIn,
    args.tokenOut,
    args.amountIn,
    fee.bps,
  )
  if (quote.amountOut < args.minimumAmountOut) throw new SlippageError(t('swap.errQuoteMoved'))
  return buildDirectTransaction({
    tokenIn: args.tokenIn,
    tokenOut: args.tokenOut,
    amountIn: args.amountIn,
    minimumAmountOut: args.minimumAmountOut,
    recipient: args.recipient,
    route: args.route,
    deadline: deadline(),
    fee,
  })
}

export async function executeSwap(args: SwapExecutionIntent): Promise<ConfirmedSwap | null> {
  let prepared = await prepareSwap(args)

  if (prepared.spender !== null) {
    if (prepared.inputToken === null) throw new Error('ERC-20 swap is missing its approval token')
    const allowance = await ensureAllowance(
      prepared.inputToken,
      args.sender,
      prepared.spender,
      args.amountIn,
      args.inputSymbol,
    )
    if (!allowance) return null
    if (allowance === 'approved') {
      const approvedSpender = prepared.spender
      const approvedToken = prepared.inputToken
      prepared = await prepareSwap(args)
      if (
        prepared.spender === null ||
        prepared.inputToken === null ||
        getAddress(prepared.spender) !== getAddress(approvedSpender) ||
        getAddress(prepared.inputToken) !== getAddress(approvedToken)
      ) {
        throw new Error('direct allowance target changed after approval')
      }
    }
  }

  const receipt = await step(
    args.label,
    () =>
      sendTransaction(wagmiConfig, {
        account: args.sender,
        to: prepared.to,
        data: prepared.data,
        value: prepared.value,
        chainId: CHAIN_ID,
      }),
    { onSubmitted: args.onSubmitted, onReplaced: args.onReplaced, onFail: args.onStepFail },
  )
  if (!receipt) return null
  if (prepared.outputToken === null) return { receipt, output: { kind: 'native' } }

  const amount = receivedOf(receipt, prepared.outputToken, args.recipient)
  if (amount < args.minimumAmountOut) {
    throw new Error(
      t('swap.receivedBelowMinimum', {
        got: amount.toString(),
        min: args.minimumAmountOut.toString(),
      }),
    )
  }
  return { receipt, output: { kind: 'erc20', token: prepared.outputToken, amount } }
}

export type SolverSwapIntent = {
  tokenIn: Address
  tokenOut: Address
  amountIn: bigint
  /** tolerance the execution-time quote embeds into the Settler tx */
  slippageBps: number
  /** the floor the user was shown; execution re-quotes and refuses below it */
  minimumAmountOut: bigint
  sender: Address
  recipient: Address
  inputSymbol: string
  label: string
  /** terminal-fee override the solver charges server-side (zap's 9); absent = server default */
  feeBps?: number
  /** fires when the swap tx is broadcast (hash in hand) — before it confirms */
  onSubmitted?: (hash: Hex) => void
  onReplaced?: (oldHash: Hex, newHash: Hex, reason: ReplacementReason) => void
  onStepFail?: (why: StepFailWhy) => void
}

/** Solver-routed swap: fetch a fresh quote WITH a tx, approve the
 *  AllowanceHolder for exactly amountIn, send the tx as-is. Mirrors
 *  executeSwap's shape — pre-flight re-quote, post-approval re-prepare with
 *  a spender-consistency check, Transfer-log delivery verification. */
export async function executeSolverSwap(args: SolverSwapIntent): Promise<ConfirmedSwap | null> {
  const fresh = () =>
    fetchSolverQuote({
      tokenIn: args.tokenIn,
      tokenOut: args.tokenOut,
      amountIn: args.amountIn,
      slippageBps: args.slippageBps,
      recipient: args.recipient,
      sender: args.sender,
      feeBps: args.feeBps,
    })
  let quote = await fresh()
  if (quote.amountOutNet < args.minimumAmountOut) throw new SlippageError(t('swap.errQuoteMoved'))

  if (quote.allowanceTarget !== null) {
    const allowance = await ensureAllowance(
      erc20Of(args.tokenIn),
      args.sender,
      quote.allowanceTarget,
      args.amountIn,
      args.inputSymbol,
    )
    if (!allowance) return null
    if (allowance === 'approved') {
      const approvedSpender = quote.allowanceTarget
      quote = await fresh()
      if (quote.amountOutNet < args.minimumAmountOut) throw new SlippageError(t('swap.errQuoteMoved'))
      if (quote.allowanceTarget === null || getAddress(quote.allowanceTarget) !== getAddress(approvedSpender)) {
        throw new Error('solver allowance target changed after approval')
      }
    }
  }

  const tx = quote.tx
  if (!tx) throw new Error('solver quote carried no transaction')
  const client = getPublicClient(wagmiConfig, { chainId: CHAIN_ID })
  const receipt = await step(
    args.label,
    async () => {
      const gas = await preflightSolverTransaction(client, args.sender, tx)
      return sendTransaction(wagmiConfig, {
        account: args.sender,
        to: tx.to,
        data: tx.data,
        value: tx.value,
        gas,
        chainId: CHAIN_ID,
      })
    },
    { onSubmitted: args.onSubmitted, onReplaced: args.onReplaced, onFail: args.onStepFail },
  )
  if (!receipt) return null
  if (isNative(args.tokenOut)) return { receipt, output: { kind: 'native' } }

  const token = erc20Of(args.tokenOut)
  const amount = receivedOf(receipt, token, args.recipient)
  if (amount < quote.minAmountOutNet) {
    throw new Error(
      t('swap.receivedBelowMinimum', {
        got: amount.toString(),
        min: quote.minAmountOutNet.toString(),
      }),
    )
  }
  return { receipt, output: { kind: 'erc20', token, amount } }
}
