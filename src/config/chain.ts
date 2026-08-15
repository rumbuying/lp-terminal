import { defineChain } from 'viem'
import { CHAIN, CHAINS, type ChainConfig } from './chains'

/**
 * A configured chain as viem describes one.
 *
 * Multicall3 sits at the canonical CREATE2 address on every chain the terminal
 * supports, so it is asserted here rather than carried per-chain — a chain
 * without it would break batched reads loudly on the first render.
 */
function viemChainOf(c: ChainConfig) {
  return defineChain({
    id: c.id,
    name: c.name,
    nativeCurrency: c.nativeCurrency,
    // chain METADATA always carries the key-free public RPC — this is what a
    // wallet_addEthereumChain suggestion hands to users' wallets. The app's own
    // reads go through the wagmi transport (see wagmi.ts), never this URL.
    rpcUrls: { default: { http: [c.publicRpc] } },
    blockExplorers: {
      default: { name: c.explorer.name, url: c.explorer.url },
    },
    contracts: {
      multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
    },
  })
}

export type HomeChain = ReturnType<typeof viemChainOf>

/** the viem chain object for whichever chain the user is looking at */
export const activeChain: HomeChain = viemChainOf(CHAIN)

/**
 * Every chain the terminal can show, the active one first.
 *
 * All of them, not just the active one: a wallet parked on the other home chain
 * is a normal state — the user just switched, or the wallet remembers where it
 * was last — and wagmi calls any chain it was not given "unsupported". That
 * turns the account chip red and hides the address, which reads as breakage
 * rather than as "your wallet is one click behind the page".
 *
 * Active first because wagmi treats `chains[0]` as the default, and because it
 * makes this a non-empty tuple: `ConfiguredChainId` is derived from
 * `chains[number]['id']`, and an array of plain `Chain` would widen it to
 * `number` — which makes `usePublicClient({ chainId })` possibly-undefined at
 * some forty call sites.
 */
export const homeChains: [HomeChain, ...HomeChain[]] = [
  activeChain,
  ...Object.values(CHAINS)
    .filter((c) => c.id !== CHAIN.id)
    .map(viemChainOf),
]
