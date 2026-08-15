import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { base as baseWallet, injectedWallet, safeWallet } from '@rainbow-me/rainbowkit/wallets'
import { fallback, http, type Transport } from 'wagmi'
import { arbitrum, base, mainnet, optimism } from 'wagmi/chains'
import { customRpc } from '../lib/rpcPref'
import { isWalletConnectProjectId } from '../lib/walletconnect'
import { activeChain, homeChains } from './chain'
import { ACTIVE_IS_BUILD, CHAIN, type ChainConfig } from './chains'
import { activeRpcUrls, bridgeRpcPath } from './chains/routes'
import { alchemyKeyOf, ENV, PUBLIC_RPC } from './env'
import { FEATURES } from './features'

// Read-transport resolution (one build works for every selected home chain):
//  - user-set custom RPC (footer control, localStorage) -> always wins
//  - RPC set in .env (personal/local build) -> use it only for the build chain
//  - canonical gateway -> same-origin /_chain/<key>/rpc
//  - ordinary production host -> /rpc for its build chain, public RPC otherwise
//  - dev without RPC                          -> public RPC
const userRpc = customRpc()
const activeUrls = activeRpcUrls({
  chainKey: CHAIN.key,
  publicRpc: PUBLIC_RPC,
  customRpc: userRpc,
  envRpc: ENV.rpcUrl,
  production: import.meta.env.PROD,
  gatewayEnabled: ENV.chainGateway,
  activeIsBuild: ACTIVE_IS_BUILD,
})
const transport =
  activeUrls.length === 1
    ? http(activeUrls[0], { batch: true })
    : fallback(activeUrls.map((url) => http(url, { batch: true })))

// The home chain the user is NOT looking at gets its own public node and
// nothing more. It is configured so a wallet parked there is a recognised
// state rather than an "unsupported chain" — the app reads and writes on the
// active chain alone, so this transport exists to answer wagmi, not to serve
// the terminal.
const homeTransports = Object.fromEntries(
  homeChains.map((c) => [
    c.id,
    c.id === activeChain.id ? transport : http(c.rpcUrls.default.http[0], { batch: true }),
  ]),
) as Record<ChainConfig['id'], Transport>

// Mainnet, Arbitrum, Base and Optimism exist only as BRIDGE counterparties
// (origin-side sends + balance reads), and the bridge's route model is written
// for Robinhood alone — so on any other home chain these four are configured
// and never asked anything (FEATURES.bridge hides the tab). Each mirrors the
// home transport's three-tier resolution, per network:
//  - personal build whose RPC override is an Alchemy url -> the SAME key's
//    per-network subdomain leads (one commercial quota for every chain)
//  - canonical gateway -> /_chain/<home>/rpc/<net>; an ordinary production
//    host retains its legacy /rpc/<net> proxy (keys stay server-side)
//  - key-free CORS-open public nodes always bring up the rear (each endpoint
//    reachability-tested — a lone default RPC proved blocked from some
//    networks and silently blanked origin balances)
const alchemyKey = alchemyKeyOf(ENV.rpcUrl)
const remoteTransport = (alchemyNet: string, network: string, publics: string[]) => {
  const urls = alchemyKey
    ? [`https://${alchemyNet}.g.alchemy.com/v2/${alchemyKey}`, ...publics]
    : import.meta.env.PROD
      ? [bridgeRpcPath(CHAIN.key, network, ENV.chainGateway), ...publics]
      : publics
  return fallback(urls.map((u) => http(u, { batch: true })))
}

// How this app introduces itself to a wallet. These four fields ARE the
// approval screen: scan the QR and the phone shows this name, this icon and
// this url, with nothing else to go on. They must match what the browser tab
// says — a name the user has never seen, next to a url they are looking at,
// reads exactly like a phishing prompt. (rainbowkit folds them into the
// WalletConnect session metadata; an unset appIcon ships `icons: []`, which
// wallets render as a blank placeholder.)
const SITE = 'https://lp-terminal.xyz'
// origin, not a constant: a LAN/preview/fork deployment must advertise ITSELF,
// or the icon 404s and the url points at someone else's site
const origin = typeof window !== 'undefined' ? window.location.origin : SITE

// When the project id cannot work, do not OFFER the wallets that depend on it
// — a WalletConnect entry with a bad id is a button that does nothing at all,
// forever, with no error (see lib/walletconnect.ts for the full failure mode).
const hasWalletConnect = isWalletConnectProjectId(ENV.wcProjectId)

// ...and rainbowkit's injectedWallet does NOT self-hide when nothing injected
// itself: it renders "Browser Wallet" and, on click, sits on "confirm in the
// extension" forever. Offering that would just trade one dead button for
// another, so gate it on a provider actually being there. Extensions inject at
// document_start, so this is already settled by the time this module loads.
const hasInjected = typeof window !== 'undefined' && !!(window as { ethereum?: unknown }).ethereum

export const wagmiConfig = getDefaultConfig({
  appName: 'LP Terminal',
  // Names the chain the user is actually on, and only the surfaces that chain
  // actually has. This text reaches a wallet's approval screen, where
  // "Robinhood Chain" beside a BSC request reads wrong — and so does an offer
  // to bridge from a chain whose BRIDGE tab is hidden.
  appDescription: `Terminal for LPs on ${CHAIN.name} — pools, positions, swaps${
    FEATURES.bridge ? ' and bridging' : ''
  }.`,
  appUrl: origin,
  appIcon: `${origin}/wallet-icon.png`,
  projectId: ENV.wcProjectId,
  // undefined = rainbowkit's own list (Rainbow / Base / MetaMask /
  // WalletConnect), all but Base reaching wallets over WalletConnect
  wallets: hasWalletConnect
    ? undefined
    : [
        {
          groupName: 'Installed',
          // safe + base never need the relay; safeWallet hides itself outside a
          // Safe iframe, so this group is never empty (which would throw)
          wallets: [safeWallet, baseWallet, ...(hasInjected ? [injectedWallet] : [])],
        },
      ],
  chains: [...homeChains, mainnet, arbitrum, base, optimism],
  transports: {
    ...homeTransports,
    [mainnet.id]: remoteTransport('eth-mainnet', 'eth', [
      'https://ethereum-rpc.publicnode.com',
      'https://eth.drpc.org',
      'https://eth.merkle.io',
    ]),
    [arbitrum.id]: remoteTransport('arb-mainnet', 'arb', [
      'https://arb1.arbitrum.io/rpc',
      'https://arbitrum-one-rpc.publicnode.com',
    ]),
    [base.id]: remoteTransport('base-mainnet', 'base', [
      'https://mainnet.base.org',
      'https://base-rpc.publicnode.com',
    ]),
    [optimism.id]: remoteTransport('opt-mainnet', 'op', [
      'https://mainnet.optimism.io',
      'https://optimism-rpc.publicnode.com',
    ]),
  },
  ssr: false,
})

/** a chain id this wagmi config can actually serve (bridge steps come from
 *  provider APIs as plain numbers — validate before handing them to wagmi) */
export type ConfiguredChainId = (typeof wagmiConfig)['chains'][number]['id']

export function asConfiguredChain(id: number): ConfiguredChainId {
  const known = wagmiConfig.chains.find((c) => c.id === id)
  if (!known) throw new Error(`chain ${id} is not configured in this terminal`)
  return known.id
}
