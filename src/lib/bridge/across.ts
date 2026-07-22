// Across quote + status via the Swap API (works for plain bridges AND
// composed any-to-any routes — e.g. ETH out of Robinhood becomes
// ETH→USDG→bridge→ETH in ONE origin tx, ~5x cheaper than a direct ETH exit).
// Keyless, CORS-open. Fee note: appFee is a DECIMAL FRACTION (0.001 = 0.1%)
// and settles instantly in the destination-side output token — see
// docs/bridge-research.md.
import { encodeFunctionData, erc20Abi, type Address } from 'viem'
import { NATIVE_SENTINEL, type ResolvedIntent } from '../../config/bridge'
import { BridgeQuoteError, type BridgeFee, type BridgeQuote, type BridgeStep } from './types'
import { QUOTE_PLACEHOLDER } from './relay'

const ACROSS_API = 'https://app.across.to/api'

/** Across's appFee unit is a decimal fraction: 10 bps -> "0.001" */
export const acrossAppFee = (bps: number): string => (bps / 10_000).toString()

export type AcrossQuoteJson = {
  checks?: {
    allowance?: { token?: Address; spender?: Address; actual?: string; expected?: string }
  }
  swapTx?: { chainId: number; to: Address; data: `0x${string}`; value?: string | null }
  expectedOutputAmount?: string
  minOutputAmount?: string
  expectedFillTime?: number
  quoteExpiryTimestamp?: number
  message?: string
  code?: string
}

/** pure mapper. Across's own approvalTxns use infinite allowances — this
 *  terminal's invariant is exact approvals, so the approve step is rebuilt
 *  from checks.allowance for exactly the required amount. */
export function mapAcrossQuote(json: AcrossQuoteJson): BridgeQuote {
  const tx = json.swapTx
  if (!tx || !json.expectedOutputAmount) {
    throw new BridgeQuoteError(json.message ?? 'across quote response is missing swapTx', json.code ?? null)
  }
  const steps: BridgeStep[] = []
  const allowance = json.checks?.allowance
  if (
    allowance?.token &&
    allowance.spender &&
    allowance.token.toLowerCase() !== NATIVE_SENTINEL.toLowerCase() &&
    BigInt(allowance.actual ?? '0') < BigInt(allowance.expected ?? '0')
  ) {
    steps.push({
      kind: 'approve',
      chainId: tx.chainId,
      to: allowance.token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [allowance.spender, BigInt(allowance.expected ?? '0')],
      }),
      value: 0n,
    })
  }
  steps.push({
    kind: 'deposit',
    chainId: tx.chainId,
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value ?? '0'),
  })
  return {
    provider: 'across',
    outputAmount: BigInt(json.expectedOutputAmount),
    minOutput: BigInt(json.minOutputAmount ?? json.expectedOutputAmount),
    etaSec: json.expectedFillTime ?? 0,
    steps,
    tracker: { provider: 'across', originChainId: tx.chainId },
    expiresAt: json.quoteExpiryTimestamp ?? null,
  }
}

export async function quoteAcross(
  leg: ResolvedIntent,
  amount: bigint,
  fee: BridgeFee,
  user: Address | null,
  signal?: AbortSignal,
): Promise<BridgeQuote> {
  const payer = user ?? QUOTE_PLACEHOLDER
  const params = new URLSearchParams({
    amount: amount.toString(),
    inputToken: leg.inputToken,
    outputToken: leg.outputToken,
    originChainId: String(leg.originChainId),
    destinationChainId: String(leg.destChainId),
    depositor: payer,
    refundAddress: payer,
  })
  // zero-fee mode omits appFee — don't bet on providers accepting "0"
  if (fee.bps > 0) {
    params.set('appFee', acrossAppFee(fee.bps))
    params.set('appFeeRecipient', fee.receiver)
  }
  const res = await fetch(`${ACROSS_API}/swap/approval?${params}`, { signal: signal ?? null })
  const json = (await res.json()) as AcrossQuoteJson
  if (!res.ok) {
    throw new BridgeQuoteError(json.message ?? `across quote failed (${res.status})`, json.code ?? null)
  }
  return mapAcrossQuote(json)
}

// ---- fill tracking ----

export type AcrossStatus = 'pending' | 'filled' | 'expired' | 'refunded'

export async function fetchAcrossStatus(
  originChainId: number,
  depositTxHash: string,
): Promise<{ status: AcrossStatus; fillTx?: string; destinationChainId?: number }> {
  const res = await fetch(
    `${ACROSS_API}/deposit/status?originChainId=${originChainId}&depositTxnRef=${depositTxHash}`,
  )
  // the indexer lags the deposit tx by a few seconds — treat not-found as pending
  if (!res.ok) return { status: 'pending' }
  const json = (await res.json()) as { status?: string; fillTx?: string; destinationChainId?: number }
  const status = (json.status === 'unfilled' ? 'pending' : json.status) as AcrossStatus | undefined
  return { status: status ?? 'pending', fillTx: json.fillTx, destinationChainId: json.destinationChainId }
}
