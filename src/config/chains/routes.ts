/** Same-origin service routes for the chain currently selected in the URL. */
export function chainRpcPath(chainKey: string, network = ''): string {
  const base = `/_chain/${encodeURIComponent(chainKey)}/rpc`
  const suffix = network.replace(/^\/+/, '')
  return suffix ? `${base}/${suffix}` : base
}

export function chainApiPath(chainKey: string, endpoint: string): string {
  return `/_chain/${encodeURIComponent(chainKey)}/api/${endpoint.replace(/^\/+/, '')}`
}

export function chainExecutorPath(chainKey: string, endpoint = ''): string {
  const base = `/_chain/${encodeURIComponent(chainKey)}/executor`
  const suffix = endpoint.replace(/^\/+/, '')
  return suffix ? `${base}/${suffix}` : base
}

function normalizedHostname(value: string | null | undefined): string | null {
  const host = (value ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (!host || host.length > 253) return null
  return host
    .split('.')
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    ? host
    : null
}

export function chainGatewayEnabled(
  configuredHost: string | null | undefined,
  runtimeHostname: string | null | undefined,
): boolean {
  const configured = normalizedHostname(configuredHost)
  return configured !== null && configured === normalizedHostname(runtimeHostname)
}

/**
 * Vite dev is also a real multi-chain gateway: vite.config.ts exposes the same
 * `/_chain/<key>/...` namespaces as production, backed by one local sidecar per
 * chain. Keeping this explicit prevents the chain switcher from sending a
 * localhost tab to the production origin just because localhost is not the
 * configured production gateway hostname.
 */
export function chainGatewayAvailable(
  configuredHost: string | null | undefined,
  runtimeHostname: string | null | undefined,
  viteDevelopment: boolean,
): boolean {
  return viteDevelopment || chainGatewayEnabled(configuredHost, runtimeHostname)
}

export function bridgeRpcPath(chainKey: string, network: string, gatewayEnabled: boolean): string {
  const suffix = network.replace(/^\/+/, '')
  return gatewayEnabled ? chainRpcPath(chainKey, suffix) : `/rpc/${suffix}`
}

/**
 * Resolve the active chain's read endpoints without letting a build-local RPC
 * bleed into another chain selected with `?chain=`.
 */
export function activeRpcUrls(options: {
  chainKey: string
  publicRpc: string
  customRpc: string | null
  envRpc: string
  production: boolean
  gatewayEnabled: boolean
  activeIsBuild: boolean
}): string[] {
  if (options.customRpc) return [options.customRpc]
  if (options.envRpc && options.activeIsBuild) return [options.envRpc]
  if (options.gatewayEnabled) return [chainRpcPath(options.chainKey), options.publicRpc]
  // Vite dev/preview implements the same build-chain `/rpc` contract as a
  // compatibility production host. When no local proxy target is configured
  // the failed same-origin request simply falls through to the public RPC;
  // when one is configured, private credentials stay in the Vite process.
  if (options.activeIsBuild) return ['/rpc', options.publicRpc]
  return [options.publicRpc]
}

/**
 * The deployment that serves every chain namespace.
 *
 * Hard-coded rather than read from the build env on purpose: the deployments
 * that need this value are exactly the ones whose `VITE_CHAIN_GATEWAY_HOST` is
 * empty, because they are not it.
 */
export const CANONICAL_ORIGIN = 'https://lp-terminal.xyz'

/**
 * Can THIS deployment serve the named chain?
 *
 * The same rule `indexerPoolsPath` applies below, named once so a caller can
 * ask BEFORE offering a chain rather than discovering it from a null path.
 *
 * A deployment that answers no still renders that chain — wallet, RPC and the
 * DexScreener fallback all work — but with no indexer behind it: no catalog, no
 * v4 directory, and a v3-only top-30 where the market table belongs. Offering
 * that as an ordinary same-origin link is what makes landing on the wrong host
 * read as an outage.
 */
export function chainServedHere(
  chainKey: string,
  gatewayEnabled: boolean,
  buildChainKey: string,
): boolean {
  return gatewayEnabled || chainKey === buildChainKey
}

/** The canonical gateway serves every catalog by chain namespace. Other
 * deployments have one `/api` proxy and may use it only for their build chain. */
export function indexerApiPath(
  endpoint: string,
  chainKey: string,
  gatewayEnabled: boolean,
  activeIsBuild: boolean,
): string | null {
  if (gatewayEnabled) return chainApiPath(chainKey, endpoint)
  return activeIsBuild ? `/api/${endpoint.replace(/^\/+/, '')}` : null
}

/** The executor is stateful and chain-bound, so it follows the same fail-closed
 * routing rule as the indexer. A compatibility host must never send a strategy
 * request for its non-build chain to the one executor mounted at `/executor`. */
export function executorApiPath(
  endpoint: string,
  chainKey: string,
  gatewayEnabled: boolean,
  activeIsBuild: boolean,
): string | null {
  if (gatewayEnabled) return chainExecutorPath(chainKey, endpoint)
  const suffix = endpoint.replace(/^\/+/, '')
  return activeIsBuild ? `/executor${suffix ? `/${suffix}` : ''}` : null
}

export function indexerPoolsPath(
  chainKey: string,
  gatewayEnabled: boolean,
  activeIsBuild: boolean,
): string | null {
  return indexerApiPath('pools', chainKey, gatewayEnabled, activeIsBuild)
}

/**
 * One row per origin-proven token, with its pools — the same catalog, asked a
 * different question. It shares `indexerPoolsPath`'s rule exactly, because a
 * deployment that has no catalog for a chain cannot group one either.
 */
export function indexerPoolGroupsPath(
  chainKey: string,
  gatewayEnabled: boolean,
  activeIsBuild: boolean,
): string | null {
  return indexerApiPath('pool-groups', chainKey, gatewayEnabled, activeIsBuild)
}
