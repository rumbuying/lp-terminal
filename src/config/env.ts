import { getAddress, type Address } from 'viem'
import { CHAIN, CHAIN_GATEWAY } from './chains'

/**
 * Vite replaces `import.meta.env` wholesale at build time, so reading the
 * values off a guarded reference keeps them baked into the bundle while
 * letting this module ALSO load under node — where that object does not exist
 * and a direct `import.meta.env.RPC` throws. That matters because scripts and
 * tests want the real module: the alternative is mirroring its logic in a
 * second file, which drifts.
 */
const BUILD_ENV: Record<string, string | undefined> =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {}

/** chain-official public RPC — wallet-safe, key-free. Used for chain metadata
 *  (what gets suggested to wallets) and as the last-resort read transport. */
export const PUBLIC_RPC = CHAIN.publicRpc

// Values come from the repo-root .env via vite envDir/envPrefix (see vite.config.ts).
export const ENV = {
  // Private RPC override (e.g. an Alchemy URL). SECRET when set — it is baked
  // into the bundle, so only use it for personal/local builds. Public server
  // builds must leave it unset: public servers keep their key private behind a
  // same-origin RPC path selected by the gateway capability below.
  rpcUrl: (BUILD_ENV.RPC ?? '').trim(),
  // Only the configured canonical host can serve every chain namespace. The
  // exact runtime-host check lets aliases reuse this bundle while retaining
  // their single-chain proxy contract. Decided in config/chains, which needs
  // the same answer to reject a remembered chain it cannot serve.
  chainGateway: CHAIN_GATEWAY,
  // absolute URL (browser calls kyber direct) or a path like /kyber (same-origin
  // reverse proxy — see README "Deploy"): both work, fetch resolves relative URLs.
  kyberBase: ((BUILD_ENV.KYBERSWAP_AGGREGATOR_API_BASE_URL ?? '').trim() ||
    'https://aggregator-api.kyberswap.com').replace(/\/+$/, ''),
  // same-origin proxy mode: when the kyber base is a path, third-party data
  // APIs (Kyber, DexScreener, Goldsky) route through the site's own
  // proxies too — users behind restrictive networks keep every feature, and the
  // browser only ever talks to our origin + the chain RPC + wallet relays.
  // Server deploys build WITH this (set the kyber base to /kyber; the matching
  // blocks live in whatever reverse proxy fronts the site) — browser-direct calls to these
  // hosts are TLS-reset on restricted networks, which blanks every USD mark.
  get proxied() {
    return this.kyberBase.startsWith('/')
  },
  // A single production bundle serves every home chain. This must therefore
  // follow the runtime-selected chain, never a build-time KYBERSWAP_CHAIN.
  kyberChain: CHAIN.slugs.kyber,
  // Swap-solver API: cross-venue split routing + ready-to-sign Settler txs
  // Public URL, CORS-open — the browser calls it directly. Point this at your
  // own instance via VITE_SOLVER_URL.
  // Empty when the active chain has no solver deployed: the swap tab then
  // quotes direct routes only (FEATURES.solver).
  solverUrl: ((BUILD_ENV.VITE_SOLVER_URL ?? '').trim() || CHAIN.solverUrl || '').replace(
    /\/+$/,
    '',
  ),
  // Optional. Injected wallets (MetaMask/Rabby/OKX…) work without it; only
  // WalletConnect QR pairing needs a real project id.
  wcProjectId: (BUILD_ENV.VITE_WALLETCONNECT_PROJECT_ID ?? '').trim() || 'up33-terminal-local',
  // Swap terminal fee — dropped to 0 (2026-07-19). The UI keeps the fee row
  // and shows 0.00%; direct routes then settle through the routers' no-fee
  // sweep variants (the *WithFee functions revert on feeBips = 0), and the
  // solver charges its own server-side rate (response feeBps is the truth).
  swapFeeBps: 0,
  // Zap's embedded swap leg — dropped to 0 (2026-08-02), same zero-fee
  // machinery as the swap fee above: no-fee sweep variants on direct routes,
  // and the solver treats an explicit feeBps: 0 as a free override.
  zapFeeBps: 0,
  // Bridge fee. Non-zero rides the providers' native integrator-fee params
  // (Relay appFees takes bps as a string, Across appFee a decimal fraction);
  // 0 = free — the quote requests then omit the fee params entirely.
  bridgeFeeBps: 0,
  terminalFeeReceiver: (BUILD_ENV.KYBERSWAP_FEE_RECEIVER ?? '').trim(),
}

export function swapFee(): { bps: number; receiver: Address } {
  if (!ENV.terminalFeeReceiver) throw new Error('terminal fee receiver is not configured')
  return { bps: ENV.swapFeeBps, receiver: getAddress(ENV.terminalFeeReceiver) }
}

/** zap's embedded swap leg; same receiver, separate rate. Fail-closed like swapFee. */
export function zapFee(): { bps: number; receiver: Address } {
  if (!ENV.terminalFeeReceiver) throw new Error('terminal fee receiver is not configured')
  return { bps: ENV.zapFeeBps, receiver: getAddress(ENV.terminalFeeReceiver) }
}

/** same receiver as the swap fee; separate rate. Fail-closed like swapFee. */
export function bridgeFee(): { bps: number; receiver: Address } {
  if (!ENV.terminalFeeReceiver) throw new Error('terminal fee receiver is not configured')
  return { bps: ENV.bridgeFeeBps, receiver: getAddress(ENV.terminalFeeReceiver) }
}

/** Alchemy app key extracted from an Alchemy RPC url (any network subdomain),
 *  null for other providers. One key serves every network via per-network
 *  subdomains, so the bridge-chain transports can derive theirs from the same
 *  secret the robinhood transport already uses. */
export function alchemyKeyOf(url: string): string | null {
  const m = /^https:\/\/[a-z0-9-]+\.g\.alchemy\.com\/v2\/([^/?#]+)/i.exec(url)
  return m ? m[1] : null
}
