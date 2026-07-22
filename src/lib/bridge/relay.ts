// Relay (relay.link) quote + status. Keyless, CORS-open; quotes are POSTed and
// return ready-to-send origin-chain txs. Fee note: appFees takes BPS AS A
// STRING ("10" = 0.1%) and accrues off-chain as USDC (claim on Base is free) —
// see docs/bridge-research.md.
import type { Address } from 'viem'
import type { ResolvedIntent } from '../../config/bridge'
import { BridgeQuoteError, type BridgeFee, type BridgeQuote, type BridgeStep } from './types'

const RELAY_API = 'https://api.relay.link'
/** placeholder payer for pre-connect display quotes (Relay requires a user) */
export const QUOTE_PLACEHOLDER = '0x000000000000000000000000000000000000dEaD' as Address

/** Relay's appFees unit is BPS as a string: 10 bps -> "10" */
export const relayAppFee = (bps: number): string => String(bps)

type RelayTxData = {
  to: Address
  data: `0x${string}`
  value?: string | null
  chainId: number
}
type RelayStep = {
  id: string
  kind: string
  requestId?: string
  items?: { data?: RelayTxData; check?: { endpoint?: string } | null }[]
}
export type RelayQuoteJson = {
  steps?: RelayStep[]
  details?: {
    currencyOut?: { amount?: string; minimumAmount?: string }
    timeEstimate?: number
  }
  message?: string
  code?: string
}

/** pure mapper — throws BridgeQuoteError on shapes we refuse to execute */
export function mapRelayQuote(json: RelayQuoteJson): BridgeQuote {
  const steps: BridgeStep[] = []
  let requestId: string | null = null
  for (const s of json.steps ?? []) {
    if (s.kind !== 'transaction') {
      throw new BridgeQuoteError(`relay quote needs unsupported step kind "${s.kind}"`)
    }
    requestId ??= s.requestId ?? null
    for (const item of s.items ?? []) {
      const d = item.data
      if (!d) continue
      steps.push({
        kind: s.id === 'approve' ? 'approve' : 'deposit',
        chainId: d.chainId,
        to: d.to,
        data: d.data,
        value: BigInt(d.value ?? '0'),
      })
    }
  }
  const out = json.details?.currencyOut
  if (!steps.length || !requestId || !out?.amount) {
    throw new BridgeQuoteError('relay quote response is missing steps/output')
  }
  return {
    provider: 'relay',
    outputAmount: BigInt(out.amount),
    minOutput: BigInt(out.minimumAmount ?? out.amount),
    etaSec: json.details?.timeEstimate ?? 0,
    steps,
    tracker: { provider: 'relay', requestId },
    expiresAt: null, // relay re-validates at execution; minOutput guards the fill
  }
}

export async function quoteRelay(
  leg: ResolvedIntent,
  amount: bigint,
  fee: BridgeFee,
  user: Address | null,
  signal?: AbortSignal,
): Promise<BridgeQuote> {
  const payer = user ?? QUOTE_PLACEHOLDER
  const res = await fetch(`${RELAY_API}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: signal ?? null,
    body: JSON.stringify({
      user: payer,
      recipient: payer,
      // research: refunds are NOT automatic unless refundTo is explicit
      refundTo: payer,
      originChainId: leg.originChainId,
      destinationChainId: leg.destChainId,
      originCurrency: leg.inputToken,
      destinationCurrency: leg.outputToken,
      amount: amount.toString(),
      tradeType: 'EXACT_INPUT',
      referrer: 'lp-terminal',
      // zero-fee mode omits appFees — don't bet on providers accepting "0"
      ...(fee.bps > 0 ? { appFees: [{ recipient: fee.receiver, fee: relayAppFee(fee.bps) }] } : {}),
    }),
  })
  const json = (await res.json()) as RelayQuoteJson
  if (!res.ok) {
    throw new BridgeQuoteError(json.message ?? `relay quote failed (${res.status})`, json.code ?? null)
  }
  return mapRelayQuote(json)
}

// ---- fill tracking ----

export type RelayStatus =
  | 'waiting'
  | 'pending'
  | 'delayed'
  | 'success'
  | 'failure'
  | 'refund'
  | 'unknown'

export async function fetchRelayStatus(requestId: string): Promise<{ status: RelayStatus; txHashes?: string[] }> {
  const res = await fetch(`${RELAY_API}/intents/status?requestId=${requestId}`)
  if (!res.ok) return { status: 'unknown' }
  const json = (await res.json()) as { status?: string; txHashes?: string[] }
  return { status: (json.status as RelayStatus) ?? 'unknown', txHashes: json.txHashes }
}
