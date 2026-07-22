import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { fallback, http } from 'wagmi'
import { arbitrum, base, mainnet, optimism } from 'wagmi/chains'
import { customRpc } from '../lib/rpcPref'
import { robinhood } from './chain'
import { alchemyKeyOf, ENV, PUBLIC_RPC } from './env'

// Read-transport resolution (one build works in every deployment):
//  - user-set custom RPC (footer control, localStorage) -> always wins
//  - RPC set in .env (personal/local build)  -> use it directly (secret stays local)
//  - production build without RPC (server)   -> same-origin /rpc proxy (nginx keeps
//    the key server-side), falling back to the public RPC when no proxy exists
//    (plain static hosting)
//  - dev without RPC                          -> public RPC
const userRpc = customRpc()
const transport = userRpc
  ? http(userRpc, { batch: true })
  : ENV.rpcUrl
    ? http(ENV.rpcUrl, { batch: true })
    : import.meta.env.PROD
      ? fallback([http('/rpc', { batch: true }), http(PUBLIC_RPC, { batch: true })])
      : http(PUBLIC_RPC, { batch: true })

// Robinhood is home; the extra chains exist only as BRIDGE counterparties
// (origin-side sends + balance reads). Each mirrors the robinhood transport's
// three-tier resolution, per network:
//  - personal build whose RPC override is an Alchemy url -> the SAME key's
//    per-network subdomain leads (one commercial quota for every chain)
//  - server build -> same-origin /rpc/<net> nginx proxy (key stays
//    server-side; plain static hosting just fails over to the next tier)
//  - key-free CORS-open public nodes always bring up the rear (each endpoint
//    reachability-tested — a lone default RPC proved blocked from some
//    networks and silently blanked origin balances)
const alchemyKey = alchemyKeyOf(ENV.rpcUrl)
const remoteTransport = (alchemyNet: string, proxyPath: string, publics: string[]) => {
  const urls = alchemyKey
    ? [`https://${alchemyNet}.g.alchemy.com/v2/${alchemyKey}`, ...publics]
    : import.meta.env.PROD
      ? [proxyPath, ...publics]
      : publics
  return fallback(urls.map((u) => http(u, { batch: true })))
}

export const wagmiConfig = getDefaultConfig({
  appName: 'UP33 Terminal',
  projectId: ENV.wcProjectId,
  chains: [robinhood, mainnet, arbitrum, base, optimism],
  transports: {
    [robinhood.id]: transport,
    [mainnet.id]: remoteTransport('eth-mainnet', '/rpc/eth', [
      'https://ethereum-rpc.publicnode.com',
      'https://eth.drpc.org',
      'https://eth.merkle.io',
    ]),
    [arbitrum.id]: remoteTransport('arb-mainnet', '/rpc/arb', [
      'https://arb1.arbitrum.io/rpc',
      'https://arbitrum-one-rpc.publicnode.com',
    ]),
    [base.id]: remoteTransport('base-mainnet', '/rpc/base', [
      'https://mainnet.base.org',
      'https://base-rpc.publicnode.com',
    ]),
    [optimism.id]: remoteTransport('opt-mainnet', '/rpc/op', [
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
