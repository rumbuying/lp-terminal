import type { Address, Hex } from 'viem'

export type BridgeProviderId = 'relay' | 'across' | 'portal'

/** injected by the caller (config/env bridgeFee) so provider modules stay
 *  env-free and unit-testable outside vite */
export type BridgeFee = { bps: number; receiver: Address }

/** one pre-built origin-chain transaction from a provider quote */
export type BridgeStep = {
  kind: 'approve' | 'deposit'
  chainId: number
  to: Address
  data: Hex
  value: bigint
}

/** how to poll fill status once the deposit tx is confirmed (the portal's
 *  child tx hash only becomes derivable from the deposit receipt) */
export type BridgeTracker =
  | { provider: 'relay'; requestId: string }
  | { provider: 'across'; originChainId: number }
  | { provider: 'portal' }

export type BridgeQuote = {
  provider: BridgeProviderId
  /** destination-side amounts, output-token units (terminal fee, if any, already deducted) */
  outputAmount: bigint
  minOutput: bigint
  etaSec: number
  steps: BridgeStep[]
  tracker: BridgeTracker
  /** epoch seconds after which the quote must not be executed (null = provider
   *  re-validates at fill time) */
  expiresAt: number | null
}

/** provider error with the upstream machine code preserved for UI mapping */
export class BridgeQuoteError extends Error {
  code: string | null
  constructor(message: string, code: string | null = null) {
    super(message)
    this.code = code
  }
}

export type BridgeQuoteState = {
  quote: BridgeQuote | null
  error: BridgeQuoteError | null
}
