import { getAddress, type Address } from 'viem'

/** chain-official public RPC — wallet-safe, key-free. Used for chain metadata
 *  (what gets suggested to wallets) and as the last-resort read transport. */
export const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com'

// Values come from the repo-root .env via vite envDir/envPrefix (see vite.config.ts).
export const ENV = {
  // Private RPC override (e.g. an Alchemy URL). SECRET when set — it is baked
  // into the bundle, so only use it for personal/local builds. Public server
  // builds must leave it unset: the app then reads through same-origin /rpc
  // (the reverse proxy keeps the key server-side) with PUBLIC_RPC as fallback.
  rpcUrl: (import.meta.env.RPC ?? '').trim(),
  // absolute URL (browser calls kyber direct) or a path like /kyber (same-origin
  // reverse proxy — see README "Deploy"): both work, fetch resolves relative URLs.
  kyberBase: ((import.meta.env.KYBERSWAP_AGGREGATOR_API_BASE_URL ?? '').trim() ||
    'https://aggregator-api.kyberswap.com').replace(/\/+$/, ''),
  // same-origin proxy mode: when the kyber base is a path, third-party data
  // APIs (Kyber, DexScreener, Goldsky) route through the site's own
  // proxies too — users behind restrictive networks keep every feature, and the
  // browser only ever talks to our origin + the chain RPC + wallet relays.
  // Default deploys build WITHOUT this (browser-direct, per-user IPs & rate
  // limits); enabling it also requires matching data-proxy blocks in whatever
  // reverse proxy fronts the site.
  get proxied() {
    return this.kyberBase.startsWith('/')
  },
  kyberChain: (import.meta.env.KYBERSWAP_CHAIN ?? 'robinhood').trim(),
  // Swap-solver API: cross-venue split routing + ready-to-sign Settler txs
  // Public URL, CORS-open — the browser calls it directly. Point this at your
  // own instance via VITE_SOLVER_URL.
  solverUrl: ((import.meta.env.VITE_SOLVER_URL ?? '').trim() || 'https://solver.lp-terminal.xyz').replace(/\/+$/, ''),
  // Optional. Injected wallets (MetaMask/Rabby/OKX…) work without it; only
  // WalletConnect QR pairing needs a real project id.
  wcProjectId: (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? '').trim() || 'up33-terminal-local',
  // Swap terminal fee — dropped to 0 (2026-07-19). The UI keeps the fee row
  // and shows 0.00%; direct routes then settle through the routers' no-fee
  // sweep variants (the *WithFee functions revert on feeBips = 0), and the
  // solver charges its own server-side rate (response feeBps is the truth).
  swapFeeBps: 0,
  // Zap keeps the 9 bps output fee on its embedded swap leg.
  zapFeeBps: 9,
  // Bridge fee. Non-zero rides the providers' native integrator-fee params
  // (Relay appFees takes bps as a string, Across appFee a decimal fraction);
  // 0 = free — the quote requests then omit the fee params entirely.
  bridgeFeeBps: 0,
  terminalFeeReceiver: (import.meta.env.KYBERSWAP_FEE_RECEIVER ?? '').trim(),
}

export function swapFee(): { bps: number; receiver: Address } {
  if (!ENV.terminalFeeReceiver) throw new Error('terminal fee receiver is not configured')
  return { bps: ENV.swapFeeBps, receiver: getAddress(ENV.terminalFeeReceiver) }
}

/** zap's embedded swap leg keeps charging; same receiver, separate rate */
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
