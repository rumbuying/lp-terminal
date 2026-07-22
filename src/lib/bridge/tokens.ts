// Which tokens can bridge between Robinhood and a given remote — discovered
// from each engine's own support surface, never hardcoded, and SAME-TOKEN
// routes only (USDC→USDG cross-token legs were removed by product decision
// 2026-07-18; a route must pay out the symbol it took in).
// Sources per remote:
//   Relay:  GET /chains        → Robinhood-side bridgeable set (currency +
//                                erc20Currencies with supportsBridging) and
//                                the remote's native-ETH support
//           POST /currencies/v2 → remote-side ERC-20 membership + decimals
//   Across: GET /available-routes → same-symbol pairs with BOTH addresses.
//           The Swap API composes same-token exits even where no native route
//           exists (probed 2026-07-18: USDG/ETH/WETH out all quote), so
//           across is attempted whenever the symbol exists on both sides.
//   Portal: canonical depositEth — native ETH, Ethereum→Robinhood only.
// Scam-token guard: a relay currencies/v2 match is only trusted when relay
// marks it verified OR its address is confirmed by an across route (term
// search returns fake same-symbol tokens — observed live for WETH).
import type { Address } from 'viem'
import { CHAIN_ID } from '../../config/addresses'
import {
  PORTAL_INBOX,
  PORTAL_PARENT_CHAIN_ID,
  NATIVE_SENTINEL,
  type BridgeDir,
  type BridgeTokenOption,
  type RemoteChain,
} from '../../config/bridge'
import type { BridgeProviderId } from './types'

const RELAY_API = 'https://api.relay.link'
const ACROSS_API = 'https://app.across.to/api'

export type RelayChainCurrency = {
  symbol?: string
  address?: Address
  decimals?: number
  supportsBridging?: boolean
}
export type RelayChainsJson = {
  chains?: { id: number; currency?: RelayChainCurrency; erc20Currencies?: RelayChainCurrency[] }[]
}
export type RelayCurrencyV2 = {
  chainId: number
  address: Address
  symbol: string
  decimals: number
  metadata?: { verified?: boolean }
}
export type AcrossRouteJson = {
  originChainId: number
  originToken: Address
  destinationChainId: number
  destinationToken: Address
  originTokenSymbol: string
  destinationTokenSymbol: string
  isNative?: boolean
}

/** direction-agnostic support facts for one same-token route */
export type BridgeTokenSupport = {
  symbol: string
  decimals: number
  robinhoodToken: Address
  remoteToken: Address
  relay: boolean
  across: boolean
  portal: boolean
}

/** provider order here is only the pre-quote render order — the UI re-sorts by price */
export function providersFor(s: BridgeTokenSupport, dir: BridgeDir): BridgeProviderId[] {
  const out: BridgeProviderId[] = []
  if (s.portal && dir === 'in') out.push('portal')
  if (s.relay) out.push('relay')
  if (s.across) out.push('across')
  return out
}

export function toTokenOption(s: BridgeTokenSupport, dir: BridgeDir): BridgeTokenOption {
  return {
    symbol: s.symbol,
    decimals: s.decimals,
    robinhoodToken: s.robinhoodToken,
    remoteToken: s.remoteToken,
    providers: providersFor(s, dir),
  }
}

const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

/** same-token symbol guard for across route labels: across suffixes chain
 *  variants ("USDG-MAINNET" is mainnet USDG), so accept exact or dash-suffixed
 *  forms while still rejecting different assets (USDC vs USDG) */
export const sameSymbolLoose = (a: string, b: string) => a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`)

/** pure merge over the raw source payloads — unit-tested against live captures */
export function mergeTokenSupports(args: {
  remoteChainId: number
  relayChains: RelayChainsJson | null
  /** currencies/v2 lookups (queried with both chain ids), keyed by symbol */
  relayCurrencies: Record<string, RelayCurrencyV2[]>
  acrossRoutes: AcrossRouteJson[] | null
  /** live Inbox-bytecode verification result; defaults to the parent-chain predicate */
  portalOk?: boolean
}): BridgeTokenSupport[] {
  const { remoteChainId, relayChains, relayCurrencies, acrossRoutes } = args
  const relayHome = relayChains?.chains?.find((c) => c.id === CHAIN_ID)
  const relayRemote = relayChains?.chains?.find((c) => c.id === remoteChainId)

  // across: rows for this pair, either direction (same-token filtering happens
  // per candidate by ADDRESS, with a loose-symbol guard against cross-token rows)
  const pairRoutes = (acrossRoutes ?? []).filter(
    (r) =>
      (r.originChainId === remoteChainId && r.destinationChainId === CHAIN_ID) ||
      (r.originChainId === CHAIN_ID && r.destinationChainId === remoteChainId),
  )

  const out: BridgeTokenSupport[] = []

  // ---- native ETH ----
  const acrossEth = pairRoutes.some((r) => r.isNative && sameSymbolLoose(r.originTokenSymbol, r.destinationTokenSymbol))
  const relayEth =
    relayHome?.currency?.symbol === 'ETH' &&
    relayHome.currency.supportsBridging === true &&
    relayRemote?.currency?.symbol === 'ETH' &&
    relayRemote.currency.supportsBridging === true
  const portalEth = args.portalOk ?? remoteChainId === PORTAL_PARENT_CHAIN_ID
  if (acrossEth || relayEth || portalEth) {
    out.push({
      symbol: 'ETH',
      decimals: 18, // native-currency constant on every leg we pair
      robinhoodToken: NATIVE_SENTINEL,
      remoteToken: NATIVE_SENTINEL,
      relay: !!relayEth,
      across: acrossEth,
      portal: portalEth,
    })
  }

  // ---- ERC-20 candidates: relay's bridgeable home set ∪ across's 4663-side
  // tokens. Identity is ADDRESS-first: the candidate's Robinhood-side address
  // anchors both engines' data, and route symbols only act as a cross-token
  // guard (rejects USDC→USDG while keeping USDG-MAINNET→USDG).
  const relayHomeErc20 = (relayHome?.erc20Currencies ?? []).filter(
    (c) => c.symbol && c.address && c.supportsBridging !== false,
  )
  type Candidate = { symbol: string; homeAddr: Address; relayHomeDec?: number; relayHome: boolean }
  const cands = new Map<string, Candidate>()
  for (const c of relayHomeErc20) {
    cands.set((c.address as Address).toLowerCase(), {
      symbol: c.symbol as string,
      homeAddr: c.address as Address,
      relayHomeDec: c.decimals,
      relayHome: true,
    })
  }
  for (const r of pairRoutes) {
    if (r.isNative) continue
    const side =
      r.destinationChainId === CHAIN_ID
        ? { addr: r.destinationToken, symbol: r.destinationTokenSymbol }
        : { addr: r.originToken, symbol: r.originTokenSymbol }
    if (side.symbol === 'ETH') continue
    const k = side.addr.toLowerCase()
    if (!cands.has(k)) cands.set(k, { symbol: side.symbol, homeAddr: side.addr, relayHome: false })
  }

  for (const cand of cands.values()) {
    const inRow = pairRoutes.find(
      (r) =>
        !r.isNative &&
        r.destinationChainId === CHAIN_ID &&
        eq(r.destinationToken, cand.homeAddr) &&
        sameSymbolLoose(r.originTokenSymbol, cand.symbol),
    )
    const outRow = pairRoutes.find(
      (r) =>
        !r.isNative &&
        r.originChainId === CHAIN_ID &&
        eq(r.originToken, cand.homeAddr) &&
        sameSymbolLoose(r.destinationTokenSymbol, cand.symbol),
    )
    const acrossRemoteAddr = inRow?.originToken ?? outRow?.destinationToken

    const lookup = relayCurrencies[cand.symbol] ?? []
    const exact = lookup.filter((c) => c.symbol === cand.symbol)
    const trusted = (c: RelayCurrencyV2, confirmAddr?: Address) =>
      c.metadata?.verified === true || (confirmAddr !== undefined && eq(c.address, confirmAddr))
    // remote-side identity: across route wins; else a unique trusted relay match
    const remoteTrusted = exact.filter((c) => c.chainId === remoteChainId && trusted(c, acrossRemoteAddr))
    const remoteAddr = acrossRemoteAddr ?? (remoteTrusted.length === 1 ? remoteTrusted[0].address : undefined)
    if (!remoteAddr) continue

    // decimals must be discoverable on both sides and equal — never guessed
    const homeDec =
      cand.relayHomeDec ?? exact.find((c) => c.chainId === CHAIN_ID && eq(c.address, cand.homeAddr))?.decimals
    const remoteDec = exact.find((c) => c.chainId === remoteChainId && eq(c.address, remoteAddr))?.decimals
    if (homeDec === undefined || remoteDec === undefined || homeDec !== remoteDec) continue

    const relaySupported =
      cand.relayHome &&
      exact.some((c) => c.chainId === remoteChainId && eq(c.address, remoteAddr) && trusted(c, acrossRemoteAddr))
    const acrossSupported = acrossRemoteAddr !== undefined
    if (!relaySupported && !acrossSupported) continue

    out.push({
      symbol: cand.symbol,
      decimals: homeDec,
      robinhoodToken: cand.homeAddr,
      remoteToken: remoteAddr,
      relay: relaySupported,
      across: acrossSupported,
      portal: false,
    })
  }

  // stable order for the dropdown: native first, then alphabetical
  return out.sort((a, b) => (a.symbol === 'ETH' ? -1 : b.symbol === 'ETH' ? 1 : a.symbol.localeCompare(b.symbol)))
}

// ---- fetch layer (shared payloads memoized for the session) ----

let chainsMemo: Promise<RelayChainsJson> | null = null
let routesMemo: Promise<AcrossRouteJson[]> | null = null

function fetchRelayChains(): Promise<RelayChainsJson> {
  chainsMemo ??= fetch(`${RELAY_API}/chains`)
    .then((r) => {
      if (!r.ok) throw new Error(`relay chains ${r.status}`)
      return r.json() as Promise<RelayChainsJson>
    })
    .catch((e) => {
      chainsMemo = null // do not cache failures
      throw e
    })
  return chainsMemo
}

function fetchAcrossRoutes(): Promise<AcrossRouteJson[]> {
  routesMemo ??= fetch(`${ACROSS_API}/available-routes`)
    .then((r) => {
      if (!r.ok) throw new Error(`across routes ${r.status}`)
      return r.json() as Promise<AcrossRouteJson[]>
    })
    .catch((e) => {
      routesMemo = null
      throw e
    })
  return routesMemo
}

/** the canonical bridge has no support API — its availability claim is checked
 *  against the chain itself (Inbox bytecode on the parent chain's default
 *  public RPC). Fail-open on RPC trouble: a transient outage must not hide the
 *  route; only a positive "no code at that address" demotes it. */
async function verifyPortalInbox(remote: RemoteChain, signal?: AbortSignal): Promise<boolean> {
  if (remote.chain.id !== PORTAL_PARENT_CHAIN_ID) return false
  const rpc = remote.chain.rpcUrls.default.http[0]
  if (!rpc) return true
  try {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: signal ?? null,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [PORTAL_INBOX, 'latest'] }),
    })
    const json = (await res.json()) as { result?: unknown }
    if (typeof json.result !== 'string') return true
    return json.result.length > 2 // '0x' = genuinely no contract there
  } catch {
    return true
  }
}

async function fetchRelayCurrencies(chainIds: number[], term: string, signal?: AbortSignal): Promise<RelayCurrencyV2[]> {
  const res = await fetch(`${RELAY_API}/currencies/v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: signal ?? null,
    body: JSON.stringify({ chainIds, term, limit: 30 }),
  })
  if (!res.ok) throw new Error(`relay currencies ${res.status}`)
  return (await res.json()) as RelayCurrencyV2[]
}

/** discovery entrypoint — degrades per-source (one engine down only narrows
 *  the list; both sources down throws so the UI can offer a retry) */
export async function fetchBridgeTokens(remote: RemoteChain, signal?: AbortSignal): Promise<BridgeTokenSupport[]> {
  const [chainsR, routesR] = await Promise.allSettled([fetchRelayChains(), fetchAcrossRoutes()])
  const relayChains = chainsR.status === 'fulfilled' ? chainsR.value : null
  const acrossRoutes = routesR.status === 'fulfilled' ? routesR.value : null
  if (!relayChains && !acrossRoutes) throw new Error('bridge token discovery failed — both engines unreachable')

  const remoteChainId = remote.chain.id
  const relayHome = relayChains?.chains?.find((c) => c.id === CHAIN_ID)
  // symbols needing a currencies/v2 lookup = every 4663-side ERC-20 candidate
  const symbols = new Set<string>(
    (relayHome?.erc20Currencies ?? [])
      .filter((c) => c.symbol && c.supportsBridging !== false)
      .map((c) => c.symbol as string),
  )
  for (const r of acrossRoutes ?? []) {
    if (r.isNative) continue
    if (r.originChainId === remoteChainId && r.destinationChainId === CHAIN_ID && r.destinationTokenSymbol !== 'ETH')
      symbols.add(r.destinationTokenSymbol)
    if (r.originChainId === CHAIN_ID && r.destinationChainId === remoteChainId && r.originTokenSymbol !== 'ETH')
      symbols.add(r.originTokenSymbol)
  }

  const relayCurrencies: Record<string, RelayCurrencyV2[]> = {}
  const [portalOk] = await Promise.all([
    verifyPortalInbox(remote, signal),
    ...[...symbols].map(async (sym) => {
      relayCurrencies[sym] = await fetchRelayCurrencies([CHAIN_ID, remoteChainId], sym, signal).catch(() => [])
    }),
  ])

  return mergeTokenSupports({ remoteChainId, relayChains, relayCurrencies, acrossRoutes, portalOk })
}
