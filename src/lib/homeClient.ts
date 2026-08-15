import { getPublicClient } from 'wagmi/actions'
import type { PublicClient } from 'viem'
import { CHAIN_ID } from '../config/addresses'
import { wagmiConfig } from '../config/wagmi'

/**
 * A read client for the chain the user is looking at, outside React.
 *
 * The cast is the price of a config that can name more than one chain.
 * `CHAIN_ID` is a union of every supported chain id, so viem infers a client
 * whose `chain` is a union too — and a union of Chain types collapses each
 * action's parameters to `never`, which no real argument can satisfy. Only one
 * member of that union is ever constructed (the active chain is settled at
 * startup and a switch is a page load), so widening back to a plain
 * PublicClient describes what actually exists at runtime.
 *
 * Throws rather than returning undefined: every caller needs a client, and a
 * missing one means the wagmi config lost its home chain — a bug, not a state
 * to render around.
 */
export function homeClient(): PublicClient {
  const client = getPublicClient(wagmiConfig, { chainId: CHAIN_ID })
  if (!client) throw new Error(`no public client configured for chain ${CHAIN_ID}`)
  return client as unknown as PublicClient
}
