// Bridge domain config: which remote chains the BRIDGE tab offers. Robinhood
// Chain is always one side of every transfer; a "remote" is the other. WHICH
// tokens can travel is NOT configured here — it is discovered live from each
// engine's own support surface (lib/bridge/tokens.ts), same-token routes only.
// Facts (routes, costs, provider behavior) are documented in docs/bridge-research.md.
import type { Address, Chain } from 'viem'
import { arbitrum, base, mainnet, optimism } from 'wagmi/chains'
import { CHAIN_ID, EXPLORER } from './addresses'
import type { BridgeProviderId } from '../lib/bridge/types'

/** zero address = native-currency sentinel understood by Relay, Across and the canonical bridge */
export const NATIVE_SENTINEL = '0x0000000000000000000000000000000000000000' as Address

export type RemoteChain = {
  chain: Chain
  label: string
}

export const REMOTE_CHAINS: RemoteChain[] = [
  { chain: mainnet, label: 'ETHEREUM' },
  { chain: arbitrum, label: 'ARBITRUM' },
  { chain: base, label: 'BASE' },
  { chain: optimism, label: 'OPTIMISM' },
]

export function remoteById(id: number): RemoteChain | null {
  return REMOTE_CHAINS.find((r) => r.chain.id === id) ?? null
}

export function explorerOf(chainId: number): string {
  if (chainId === CHAIN_ID) return EXPLORER
  return remoteById(chainId)?.chain.blockExplorers?.default.url ?? EXPLORER
}

/** 'in' = deposit onto Robinhood, 'out' = withdraw from Robinhood */
export type BridgeDir = 'in' | 'out'

/** one discovered same-token route between Robinhood and the selected remote.
 *  `providers` is already resolved for the direction the UI is showing. */
export type BridgeTokenOption = {
  symbol: string
  /** identical on both sides — discovery drops mismatched-decimals pairs */
  decimals: number
  /** address on the Robinhood side (NATIVE_SENTINEL = native ETH) */
  robinhoodToken: Address
  /** address on the remote side (NATIVE_SENTINEL = native ETH) */
  remoteToken: Address
  providers: BridgeProviderId[]
}

export type BridgeIntent = {
  dir: BridgeDir
  token: BridgeTokenOption
  remote: RemoteChain
  /** origin-side amount in origin token units */
  amount: bigint
}

export type ResolvedIntent = {
  originChainId: number
  destChainId: number
  inputToken: Address // NATIVE_SENTINEL for native ETH
  outputToken: Address
  inputSymbol: string
  outputSymbol: string
  inputDecimals: number
  outputDecimals: number
}

/** map a user intent onto the provider-facing origin/destination legs
 *  (same-token model: both legs share symbol and decimals) */
export function resolveIntent(i: BridgeIntent): ResolvedIntent {
  const remoteId = i.remote.chain.id
  return {
    originChainId: i.dir === 'in' ? remoteId : CHAIN_ID,
    destChainId: i.dir === 'in' ? CHAIN_ID : remoteId,
    inputToken: i.dir === 'in' ? i.token.remoteToken : i.token.robinhoodToken,
    outputToken: i.dir === 'in' ? i.token.robinhoodToken : i.token.remoteToken,
    inputSymbol: i.token.symbol,
    outputSymbol: i.token.symbol,
    inputDecimals: i.token.decimals,
    outputDecimals: i.token.decimals,
  }
}

/** Robinhood Chain's canonical (Arbitrum) bridge Inbox on Ethereum L1.
 *  Source: l2beat discovery, cross-checked on-chain 2026-07-18:
 *  Inbox.bridge() == 0xDf8755334ce7A73cCF6b581C02eA649AE3E864b3 (the chain's
 *  Bridge, which emitted every verified real deposit's MessageDelivered). */
export const PORTAL_INBOX = '0x1A07cc4BD17E0118BdB54D70990D2158AbAD7a2D' as Address
export const PORTAL_PARENT_CHAIN_ID: number = mainnet.id

/** measured delivery latency of real depositEth transfers (484–689s over 3
 *  samples, 2026-07-18) — quote ~10 min, not the nominal "5 min" */
export const PORTAL_ETA_SEC = 600

