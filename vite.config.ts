import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// envDir points at the parent workspace so its shared .env is picked up.
// envPrefix exposes public/runtime client config.
//
// SECRET RULE: `RPC` (private key-bearing URL) is for personal/local builds only —
// a build meant for public serving must NOT have it set (see README "Deploy").
// The deployed app reads the chain through same-origin `/rpc` instead; the dev and
// preview servers below emulate that nginx proxy so the mode is testable locally.
export default defineConfig(({ mode }) => {
  const envDir = fileURLToPath(new URL('..', import.meta.url))
  // THEGRAPH_ is loaded here but deliberately absent from `envPrefix` below:
  // this process needs the key to build the proxy header, and the bundle must
  // never see it. Adding it there would ship a metered credential to every
  // visitor.
  const env = loadEnv(mode, envDir, ['RPC', 'KYBERSWAP_', 'CHAIN', 'THEGRAPH_', 'LP_EXECUTOR_'])
  const feeReceiver = (process.env.KYBERSWAP_FEE_RECEIVER ?? env.KYBERSWAP_FEE_RECEIVER ?? '').trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(feeReceiver)) {
    throw new Error('KYBERSWAP_FEE_RECEIVER must be a valid address')
  }
  // local emulation of the reverse proxy a server deploy fronts the app with,
  // so that deployment mode
  // is fully testable via `RPC="" npm run build && npm run preview`:
  //  - /rpc   -> the .env RPC (or RPC_PROXY_TARGET override); key stays in node
  //  - /kyber -> read-only Kyber valuation endpoint
  const upstream = (process.env.RPC_PROXY_TARGET ?? env.RPC ?? '').trim()
  const passthru = (prefix: string, target: string) => ({
    target,
    changeOrigin: true,
    rewrite: (p: string) => p.replace(new RegExp(`^${prefix}`), ''),
  })
  const graphKey = (process.env.THEGRAPH_API_KEY ?? env.THEGRAPH_API_KEY ?? '').trim()
  const buildChain = (process.env.CHAIN ?? env.CHAIN ?? 'bsc').trim()
  const executorPort = Number((process.env.LP_EXECUTOR_PORT ?? env.LP_EXECUTOR_PORT ?? (buildChain === 'robinhood' ? '8790' : '8791')).trim())
  if (!Number.isInteger(executorPort) || executorPort < 1 || executorPort > 65_535)
    throw new Error('LP_EXECUTOR_PORT must be a TCP port')
  const proxy: Record<string, object> = {
    '/kyber': passthru('/kyber', 'https://aggregator-api.kyberswap.com'),
    '/dexscreener': passthru('/dexscreener', 'https://api.dexscreener.com'),
    '/goldsky': passthru('/goldsky', 'https://api.goldsky.com'),
    // The Graph is the one AUTHENTICATED upstream here, so this proxy exists to
    // hold a credential rather than to dodge a blocked host. The key is
    // attached in node and never reaches the browser — same contract nginx
    // keeps in production, emulated so the path works in `npm run dev` too.
    // With no key configured the gateway answers 401 and callers degrade.
    '/thegraph': {
      ...passthru('/thegraph', 'https://gateway.thegraph.com'),
      headers: graphKey ? { Authorization: `Bearer ${graphKey}` } : {},
    },
    // local pool indexer (`npm run indexer`) — same-origin /api like the
    // production nginx route; the frontend falls back to client-side
    // dexscreener discovery when it isn't running
    '/api': { target: `http://localhost:${process.env.INDEXER_PORT || 8787}`, changeOrigin: true },
    // Chain-bound unattended strategy service. The canonical production
    // gateway exposes one instance under each /_chain/<chain>/executor path;
    // dev/preview has exactly one build-chain instance behind this legacy path.
    '/executor': {
      target: `http://127.0.0.1:${executorPort}`,
      changeOrigin: true,
      rewrite: (p: string) => p.replace(/^\/executor/, ''),
    },
  }
  if (/^https?:\/\//.test(upstream)) proxy['/rpc'] = passthru('/rpc', upstream)

  return {
    plugins: [react()],
    envDir,
    // CHAIN selects the build/local default. Both configured home chains ship
    // in the production bundle; the URL selects one at page load.
    envPrefix: ['VITE_', 'RPC', 'KYBERSWAP_', 'CHAIN'],
    server: { port: 5173, proxy },
    preview: { port: 4173, proxy },
    build: {
      rollupOptions: {
        output: {
          // pin ONLY react into a stable vendor chunk: it is 100% eager and its
          // hash survives app deploys (cache win, zero size cost). Everything
          // else — incl. viem/wagmi/rainbowkit — stays on rollup's automatic
          // split: forcing them together was measured to hoist lazy-only wallet
          // SDK modules into the eager bundle (957kB -> 1.7MB). Don't.
          manualChunks(id: string) {
            if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'vendor-react'
            return undefined
          },
        },
      },
    },
  }
})
