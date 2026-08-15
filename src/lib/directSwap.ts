import {
  encodePacked,
  encodeFunctionData,
  getAddress,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import {
  clSwapRouterAbi,
  clSwapRouterFeeAbi,
  quoterAbi,
  uniSwapRouterAbi,
  uniV2FactoryAbi,
  uniV2RouterAbi,
  uniV3FactoryAbi,
  uniV3QuoterAbi,
} from '../abi'
import { ADDR, CONNECTORS, NATIVE, UNI } from '../config/addresses'
import { CHAIN } from '../config/chains'
import { HOME_CL_FEES, HOME_CL_FEE_KEYED } from './homeCl'
import {
  UNI_V4,
  UNI_V4_RUNGS,
  encodeV4Swap,
  universalRouterAbi,
  v4Currency,
  v4PoolId,
  v4PoolKey,
  v4QuoterAbi,
  v4StateViewAbi,
  v4ZeroForOne,
} from './uniV4'
import type { Pool } from '../types'

/**
 * Which venue slot a route belongs to. This is the DEX brand, not the pool
 * family: each slot holds every `kind` that venue offers, and the best of them
 * is what the swap tab shows on that venue's row. Adding a pool family to a
 * venue therefore widens `kind`, never this.
 */
export type DirectProtocol = 'uniswap' | 'home'
/**
 * A vanilla Uniswap-v2 pair, on either venue slot.
 *
 * The fee is not a constant across venues — Pancake's pairs charge 25 bps where
 * Uniswap's charge 30 — so it travels with the route and assertRoute checks it
 * against the venue that route claims to be on.
 */
type V2Route = {
  protocol: DirectProtocol
  kind: 'v2'
  feePpm: number
  connector?: Address
}
type UniV3Route = {
  protocol: 'uniswap'
  kind: 'v3'
  // the ladder is per-chain (CHAIN.uniV3Fees), so this cannot be a literal
  // union — assertRoute checks membership against the active chain's rungs.
  feePpm: number
  connector?: Address
  secondFeePpm?: number
}
/**
 * The home DEX's CL leg. The two shapes are NOT interchangeable — encoding a
 * tick-spacing route against a fee-keyed router would put a tick spacing where
 * a fee tier belongs and hit the wrong pool, or none — so each route carries
 * the shape it was discovered under, and assertRoute refuses a mismatch.
 */
type HomeClRouteTickSpacing = {
  protocol: 'home'
  kind: 'cl'
  keyedBy: 'tickSpacing'
  tickSpacing: number
  feePpm: number
}
type HomeClRouteFee = {
  protocol: 'home'
  kind: 'cl'
  keyedBy: 'fee'
  feePpm: number
}
export type HomeClRoute = HomeClRouteTickSpacing | HomeClRouteFee
/**
 * A Uniswap v4 pool.
 *
 * Unlike every other kind, the pool is not addressed — it is named by the hash
 * of its key, so the key travels whole. `tickSpacing` is an independent field
 * here rather than a consequence of the fee, and both are needed to reproduce
 * the id, so neither can be dropped.
 */
type UniV4Route = {
  protocol: 'uniswap'
  kind: 'v4'
  feePpm: number
  tickSpacing: number
}
export type DirectRoute = V2Route | UniV3Route | HomeClRoute | UniV4Route

export type DirectCandidate = {
  route: DirectRoute
  amountOut: bigint
  impactBps: number | null
}

export type DirectQuotes = {
  best: DirectCandidate | null
  byProtocol: Record<DirectProtocol, DirectCandidate | null>
  status: Record<DirectProtocol, 'quoted' | 'absent' | 'failed'>
  /** Fee-free fallback denominator. Direct Quoters do not expose enough pool
   * state for an exact counterfactual, so this is currently always null. */
  midOut: bigint | null
}

type DirectTransaction = {
  to: Address
  data: Hex
  value: bigint
  /** who to approve `inputToken` to — for a v4 route this is Permit2, not the router */
  spender: Address | null
  inputToken: Address | null
  outputToken: Address | null
  /**
   * The operator that must additionally hold a PERMIT2 allowance before the
   * swap can pull the input, or null when approving `spender` is the whole
   * story. UniversalRouter never reads a plain ERC-20 allowance — it pulls
   * through Permit2 — so a v4 route needs both legs: the token approved to
   * Permit2, and Permit2 approved to the router.
   */
  permit2Operator: Address | null
}

const UNI_V3_FEES = CHAIN.uniV3Fees
const UNI_CONNECTORS = CONNECTORS
/**
 * Uniswap v2's LP fee is 0.30% at every deployment — it is compiled into the
 * pair, not configured — so it is a constant here rather than a chain field
 * that could only ever hold one value. chain-check re-measures it from the
 * router on each chain so the claim keeps being tested rather than trusted.
 */
const UNI_V2_FEE_PPM = 3000
/** the home DEX's v2 leg, or null on a chain whose v2 we cannot encode */
const HOME_V2 = CHAIN.homeV2

/** the LP fee a venue's v2 pairs charge, or null where it has no v2 leg */
function v2FeePpm(protocol: DirectProtocol): number | null {
  return protocol === 'uniswap' ? UNI_V2_FEE_PPM : HOME_V2?.feePpm ?? null
}

/** where a v2 leg is quoted (getAmountsOut) and where it is executed */
function v2Routers(protocol: DirectProtocol): { quoter: Address; swap: Address } | null {
  if (protocol === 'uniswap') return { quoter: UNI.V2_ROUTER, swap: UNI.V3_SWAP_ROUTER }
  return HOME_V2 ? { quoter: ADDR.V2_ROUTER, swap: HOME_V2.SWAP_ROUTER } : null
}

export function isNative(address?: Address): boolean {
  return !!address && address.toLowerCase() === NATIVE.toLowerCase()
}

export function erc20Of(address: Address): Address {
  return isNative(address) ? ADDR.WNATIVE : getAddress(address)
}

function assertFeeBps(feeBps: number): void {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= 10_000) {
    throw new Error(`Invalid fee bps: ${feeBps}`)
  }
}

export function netAfterFee(grossAmount: bigint, feeBps: number): bigint {
  if (grossAmount < 0n) throw new Error('Gross amount cannot be negative')
  assertFeeBps(feeBps)
  return grossAmount - (grossAmount * BigInt(feeBps)) / 10_000n
}

export function grossMinimumForNet(netAmount: bigint, feeBps: number): bigint {
  if (netAmount < 0n) throw new Error('Net amount cannot be negative')
  assertFeeBps(feeBps)
  if (netAmount === 0n) return 0n
  return ((netAmount - 1n) * 10_000n) / BigInt(10_000 - feeBps) + 1n
}

function isUniConnector(address: Address): boolean {
  return UNI_CONNECTORS.some((connector) => connector.toLowerCase() === address.toLowerCase())
}

function assertRoute(route: DirectRoute): void {
  // A v2 route must carry the fee of the venue it claims to be on. A Pancake
  // route bearing Uniswap's 3000 would net out the wrong minimum, and on a
  // chain whose home v2 we cannot encode, v2FeePpm is null and no home-v2 route
  // can validate at all.
  if (
    route.kind === 'v2' &&
    route.feePpm === v2FeePpm(route.protocol) &&
    (!route.connector || isUniConnector(route.connector))
  ) {
    return
  }
  // A v4 route must name a rung this chain probes. The pair (fee, tickSpacing)
  // is part of the pool's identity, so a route carrying a spacing the ladder
  // does not pair with that fee would hash to a pool nobody created.
  if (
    route.kind === 'v4' &&
    UNI_V4 !== null &&
    UNI_V4_RUNGS.some(
      ({ fee, tickSpacing }) => fee === route.feePpm && tickSpacing === route.tickSpacing,
    )
  ) {
    return
  }
  if (
    route.protocol === 'uniswap' &&
    route.kind === 'v3' &&
    UNI_V3_FEES.includes(route.feePpm) &&
    (
      (!route.connector && route.secondFeePpm === undefined) ||
      (
        !!route.connector &&
        isUniConnector(route.connector) &&
        route.secondFeePpm !== undefined &&
        UNI_V3_FEES.includes(route.secondFeePpm)
      )
    )
  ) {
    return
  }
  if (
    route.protocol === 'home' &&
    route.kind === 'cl' &&
    // a route discovered under the other shape cannot be encoded here
    route.keyedBy === CHAIN.homeCl.keyedBy &&
    Number.isInteger(route.feePpm) &&
    route.feePpm > 0 &&
    // A route cannot execute at a 100% LP fee. Discovery filters these out;
    // this also covers routes handed in directly.
    route.feePpm < 1_000_000 &&
    (route.keyedBy === 'fee'
      ? HOME_CL_FEES.includes(route.feePpm)
      : Number.isInteger(route.tickSpacing) && route.tickSpacing !== 0)
  ) {
    return
  }
  throw new Error('Unsupported direct route')
}

export function directRouteFeePpm(route: DirectRoute): number {
  assertRoute(route)
  // a two-hop v2 route pays its venue's fee once per pair, whatever that fee is
  if (route.kind === 'v2') return route.connector ? route.feePpm * 2 : route.feePpm
  if (route.kind === 'cl' || route.kind === 'v4') return route.feePpm
  return route.feePpm + (route.secondFeePpm ?? 0)
}

function swapPath(
  route: V2Route | UniV3Route,
  tokenIn: Address,
  tokenOut: Address,
): readonly [Address, Address] | readonly [Address, Address, Address] {
  const input = erc20Of(tokenIn)
  const output = erc20Of(tokenOut)
  if (!route.connector) return [input, output]
  const connector = getAddress(route.connector)
  if (
    connector.toLowerCase() === input.toLowerCase() ||
    connector.toLowerCase() === output.toLowerCase()
  ) {
    throw new Error('Route connector must differ from both swap endpoints')
  }
  return [input, connector, output]
}

function v3Path(route: UniV3Route, tokenIn: Address, tokenOut: Address): Hex {
  const path = swapPath(route, tokenIn, tokenOut)
  if (path.length !== 3 || route.secondFeePpm === undefined) {
    throw new Error('Uniswap V3 multihop route is incomplete')
  }
  return encodePacked(
    ['address', 'uint24', 'address', 'uint24', 'address'],
    [path[0], route.feePpm, path[1], route.secondFeePpm, path[2]],
  )
}

function matchesPair(pool: Pool, tokenIn: Address, tokenOut: Address): boolean {
  const input = erc20Of(tokenIn).toLowerCase()
  const output = erc20Of(tokenOut).toLowerCase()
  const token0 = pool.token0.toLowerCase()
  const token1 = pool.token1.toLowerCase()
  return (token0 === input && token1 === output) || (token0 === output && token1 === input)
}

/**
 * Tick-spacing-keyed home CL (Slipstream): the spacings in use are not a fixed
 * ladder, so routes come from the enumerated pool list rather than from probing
 * a factory. A fee-keyed home CL is discovered on-chain instead — see
 * directRoutes.
 */
function homeClRoutes(pools: readonly Pool[], tokenIn: Address, tokenOut: Address): DirectRoute[] {
  const seen = new Set<string>()
  const routes: HomeClRouteTickSpacing[] = []

  for (const pool of pools) {
    if (
      pool.kind !== 'cl' ||
      pool.protocol !== 'home' ||
      !matchesPair(pool, tokenIn, tokenOut) ||
      !Number.isInteger(pool.tickSpacing) ||
      pool.tickSpacing === 0 ||
      // Drop unusable permissionless pools before one can poison the batch.
      pool.feePpm <= 0 ||
      pool.feePpm >= 1_000_000
    ) {
      continue
    }
    const key = `${pool.tickSpacing}:${pool.feePpm}`
    if (seen.has(key)) continue
    seen.add(key)
    routes.push({
      protocol: 'home',
      kind: 'cl',
      keyedBy: 'tickSpacing',
      tickSpacing: pool.tickSpacing,
      feePpm: pool.feePpm,
    })
  }
  return routes
}

type RouteDiscovery = {
  routes: DirectRoute[]
  failedProtocols: Set<DirectProtocol>
}

type RouteCandidate = {
  route: DirectRoute
  poolIndexes: readonly number[]
}

async function directRoutes(
  client: PublicClient,
  pools: readonly Pool[] | null,
  tokenIn: Address,
  tokenOut: Address,
): Promise<RouteDiscovery> {
  const input = erc20Of(tokenIn)
  const output = erc20Of(tokenOut)
  const contracts: unknown[] = []
  const poolIndexes = new Map<string, number>()
  const canonicalEdge = (a: Address, b: Address): string => {
    const left = a.toLowerCase()
    const right = b.toLowerCase()
    return left < right ? `${left}:${right}` : `${right}:${left}`
  }
  // Home probes ride the same multicall but are tracked separately: one
  // venue's RPC failure must not mark the other's routes unavailable.
  const homeIndexes = new Set<number>()
  const v2PoolIndex = (protocol: DirectProtocol, a: Address, b: Address): number => {
    const key = `v2:${protocol}:${canonicalEdge(a, b)}`
    const existing = poolIndexes.get(key)
    if (existing !== undefined) return existing
    const index = contracts.length
    contracts.push({
      abi: uniV2FactoryAbi,
      address: protocol === 'uniswap' ? UNI.V2_FACTORY : ADDR.V2_FACTORY,
      functionName: 'getPair',
      args: [a, b],
    })
    poolIndexes.set(key, index)
    if (protocol === 'home') homeIndexes.add(index)
    return index
  }
  const homeClPoolIndex = (a: Address, b: Address, fee: number): number => {
    const key = `home:${canonicalEdge(a, b)}:${fee}`
    const existing = poolIndexes.get(key)
    if (existing !== undefined) return existing
    const index = contracts.length
    contracts.push({
      abi: uniV3FactoryAbi,
      address: ADDR.CL_FACTORY,
      functionName: 'getPool',
      args: [a, b, fee],
    })
    poolIndexes.set(key, index)
    homeIndexes.add(index)
    return index
  }
  // v4 has no factory to ask, so the pool's name is computed here and the
  // singleton is asked whether that name is initialised. Note the currencies
  // are the v4 ones — the native coin stays address(0) rather than being
  // folded onto its wrapper, because those are different pools.
  const v4CurrencyIn = v4Currency(tokenIn)
  const v4CurrencyOut = v4Currency(tokenOut)
  const v4PoolIndex = (fee: number, tickSpacing: number): number => {
    const key = `v4:${canonicalEdge(v4CurrencyIn, v4CurrencyOut)}:${fee}:${tickSpacing}`
    const existing = poolIndexes.get(key)
    if (existing !== undefined) return existing
    const index = contracts.length
    contracts.push({
      abi: v4StateViewAbi,
      address: UNI_V4!.STATE_VIEW,
      functionName: 'getSlot0',
      args: [v4PoolId(v4PoolKey(v4CurrencyIn, v4CurrencyOut, fee, tickSpacing))],
    })
    poolIndexes.set(key, index)
    v4Indexes.add(index)
    return index
  }
  const v4Indexes = new Set<number>()
  const v3PoolIndex = (a: Address, b: Address, fee: (typeof UNI_V3_FEES)[number]): number => {
    const key = `v3:${canonicalEdge(a, b)}:${fee}`
    const existing = poolIndexes.get(key)
    if (existing !== undefined) return existing
    const index = contracts.length
    contracts.push({
      abi: uniV3FactoryAbi,
      address: UNI.V3_FACTORY,
      functionName: 'getPool',
      args: [a, b, fee],
    })
    poolIndexes.set(key, index)
    return index
  }

  const candidates: RouteCandidate[] = [
    {
      route: { protocol: 'uniswap', kind: 'v2', feePpm: UNI_V2_FEE_PPM },
      poolIndexes: [v2PoolIndex('uniswap', input, output)],
    },
    ...UNI_V3_FEES.map((feePpm): RouteCandidate => ({
      route: { protocol: 'uniswap', kind: 'v3', feePpm },
      poolIndexes: [v3PoolIndex(input, output, feePpm)],
    })),
    // v4 sits on the Uniswap slot beside v3, direct pairs only: a multi-hop v4
    // route is a PathKey list rather than a second pool probe, so connectors
    // are left to the v2/v3 legs until that encoding exists.
    ...(UNI_V4
      ? UNI_V4_RUNGS.map(({ fee, tickSpacing }): RouteCandidate => ({
          route: { protocol: 'uniswap', kind: 'v4', feePpm: fee, tickSpacing },
          poolIndexes: [v4PoolIndex(fee, tickSpacing)],
        }))
      : []),
  ]
  const connectors = UNI_CONNECTORS.filter(
    (connector) =>
      connector.toLowerCase() !== input.toLowerCase() &&
      connector.toLowerCase() !== output.toLowerCase(),
  )
  for (const connector of connectors) {
    candidates.push({
      route: { protocol: 'uniswap', kind: 'v2', feePpm: UNI_V2_FEE_PPM, connector },
      poolIndexes: [v2PoolIndex('uniswap', input, connector), v2PoolIndex('uniswap', connector, output)],
    })
    for (const feePpm of UNI_V3_FEES) {
      const firstPool = v3PoolIndex(input, connector, feePpm)
      for (const secondFeePpm of UNI_V3_FEES) {
        candidates.push({
          route: {
            protocol: 'uniswap',
            kind: 'v3',
            feePpm,
            connector,
            secondFeePpm,
          },
          poolIndexes: [
            firstPool,
            v3PoolIndex(connector, output, secondFeePpm),
          ],
        })
      }
    }
  }

  // A fee-keyed home CL has a fixed fee ladder, so its pools are found the same
  // way Uniswap's are — by asking the factory — and need no pool list. Direct
  // pairs only, matching what the tick-spacing path builds.
  const homeCandidates: RouteCandidate[] = HOME_CL_FEE_KEYED
    ? HOME_CL_FEES.map((feePpm): RouteCandidate => ({
        route: { protocol: 'home', kind: 'cl', keyedBy: 'fee', feePpm },
        poolIndexes: [homeClPoolIndex(input, output, feePpm)],
      }))
    : []
  // The home v2 leg, where the chain has one we can encode. It is probed like
  // Uniswap's — same factory call, its own factory — and carries connectors for
  // the same reason: on BSC the deepest bStock markets are paired against the
  // stable, not against whatever the user happens to be selling.
  if (HOME_V2) {
    homeCandidates.push({
      route: { protocol: 'home', kind: 'v2', feePpm: HOME_V2.feePpm },
      poolIndexes: [v2PoolIndex('home', input, output)],
    })
    for (const connector of connectors) {
      homeCandidates.push({
        route: { protocol: 'home', kind: 'v2', feePpm: HOME_V2.feePpm, connector },
        poolIndexes: [v2PoolIndex('home', input, connector), v2PoolIndex('home', connector, output)],
      })
    }
  }

  const discovery = (await client.multicall({
    contracts: contracts as never,
  })) as MulticallResult[]
  const failedProtocols = new Set<DirectProtocol>()
  const uniswapDiscoveryFailed = discovery.some(
    ({ status }, i) => status === 'failure' && !homeIndexes.has(i),
  )
  if (uniswapDiscoveryFailed) failedProtocols.add('uniswap')
  // A failed home probe is a home failure whatever it was probing for; a
  // missing pool list only fails the shape that needs one (tick-spacing CL).
  if ([...homeIndexes].some((i) => discovery[i]?.status === 'failure')) failedProtocols.add('home')
  if (!HOME_CL_FEE_KEYED && pools === null) failedProtocols.add('home')

  const hasPool = (index: number): boolean => {
    const result = discovery[index]
    if (result.status !== 'success') return false
    // v4 answers with slot0, not an address — an uninitialised pool reports a
    // zero sqrt price, and there is no pool contract to point at. The shape is
    // checked rather than assumed: destructuring a non-tuple result would read
    // its first CHARACTER, and any non-zero character reads as "pool exists".
    if (v4Indexes.has(index)) {
      const slot0 = result.result
      if (!Array.isArray(slot0)) return false
      return (slot0[0] as bigint) !== 0n
    }
    return (result.result as Address).toLowerCase() !== zeroAddress
  }
  const survived = ({ poolIndexes: indexes }: RouteCandidate) => indexes.every(hasPool)
  const uniswap = candidates.filter(survived).map(({ route }) => route)
  // Probed home routes (fee-keyed CL, and v2 wherever we can encode it) plus,
  // on a tick-spacing chain, the CL routes that can only come from a pool list.
  const home: DirectRoute[] = [
    ...homeCandidates.filter(survived).map(({ route }) => route),
    ...(HOME_CL_FEE_KEYED || pools === null ? [] : homeClRoutes(pools, tokenIn, tokenOut)),
  ]
  return { routes: [...uniswap, ...home], failedProtocols }
}

function quoteContract(
  route: DirectRoute,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
) {
  const input = erc20Of(tokenIn)
  const output = erc20Of(tokenOut)
  if (route.kind === 'v2') {
    // getAmountsOut lives on the plain v2 router, on both venues — the
    // SwapRouter02-shaped router that EXECUTES the leg does not carry it.
    const routers = v2Routers(route.protocol)
    if (!routers) throw new Error('Unsupported direct route')
    return {
      abi: uniV2RouterAbi,
      address: routers.quoter,
      functionName: 'getAmountsOut',
      args: [amountIn, swapPath(route, tokenIn, tokenOut)],
    } as const
  }
  if (route.kind === 'v4') {
    // the quoter takes the whole pool key, because that IS the pool's identity
    const currencyIn = v4Currency(tokenIn)
    const key = v4PoolKey(currencyIn, v4Currency(tokenOut), route.feePpm, route.tickSpacing)
    return {
      abi: v4QuoterAbi,
      address: UNI_V4!.QUOTER,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          poolKey: key,
          zeroForOne: v4ZeroForOne(key, currencyIn),
          exactAmount: amountIn,
          hookData: '0x',
        },
      ],
    } as const
  }
  if (route.protocol === 'uniswap') {
    if (route.connector) {
      return {
        abi: uniV3QuoterAbi,
        address: UNI.V3_QUOTER,
        functionName: 'quoteExactInput',
        args: [v3Path(route, tokenIn, tokenOut), amountIn],
      } as const
    }
    return {
      abi: uniV3QuoterAbi,
      address: UNI.V3_QUOTER,
      functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: input, tokenOut: output, amountIn, fee: route.feePpm, sqrtPriceLimitX96: 0n }],
    } as const
  }
  // The home CL's quoter takes the pool key in whichever unit this chain's
  // protocol uses; the two structs are otherwise identical.
  if (route.keyedBy === 'fee') {
    return {
      abi: uniV3QuoterAbi,
      address: ADDR.CL_QUOTER,
      functionName: 'quoteExactInputSingle',
      args: [
        { tokenIn: input, tokenOut: output, amountIn, fee: route.feePpm, sqrtPriceLimitX96: 0n },
      ],
    } as const
  }
  return {
    abi: quoterAbi,
    address: ADDR.CL_QUOTER,
    functionName: 'quoteExactInputSingle',
    args: [
      {
        tokenIn: input,
        tokenOut: output,
        amountIn,
        tickSpacing: route.tickSpacing,
        sqrtPriceLimitX96: 0n,
      },
    ],
  } as const
}

type MulticallResult = { status: 'success' | 'failure'; result?: unknown }
type DirectQuoteStatus = DirectQuotes['status'][DirectProtocol]

function quoteStatus(
  protocol: DirectProtocol,
  candidates: readonly DirectCandidate[],
  failedProtocols: ReadonlySet<DirectProtocol>,
): DirectQuoteStatus {
  // an executable tier wins: a protocol that produced at least one quote is
  // 'quoted' even when another of its fee tiers reverted. A created-but-illiquid
  // pool (whose quote reverts) must not poison the protocol's working routes —
  // it can't fill the swap anyway, so the best EXECUTABLE quote is the max over
  // the tiers that did respond.
  if (candidates.some(({ route }) => route.protocol === protocol)) return 'quoted'
  if (failedProtocols.has(protocol)) return 'failed'
  return 'absent'
}

function quotedAmount(route: DirectRoute, result: MulticallResult): bigint | null {
  if (result.status !== 'success') return null
  if (route.kind === 'v2') {
    const amounts = result.result as readonly bigint[]
    return amounts.at(-1) ?? null
  }
  // every remaining quoter reports the output amount first, whatever trails it
  const [amountOut] = result.result as readonly [bigint, ...unknown[]]
  return amountOut
}

export function impactBps(amountIn: bigint, amountOut: bigint, probeIn: bigint, probeOut: bigint): number {
  const probeRate = probeOut * amountIn
  const fullRate = amountOut * probeIn
  if (fullRate >= probeRate) return 0
  return Number(((probeRate - fullRate) * 10_000n + probeRate - 1n) / probeRate)
}

async function quoteRoutes(
  client: PublicClient,
  routes: readonly DirectRoute[],
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  feeBps: number,
): Promise<{ candidates: DirectCandidate[]; midOut: bigint | null; failedProtocols: Set<DirectProtocol> }> {
  if (amountIn <= 0n) throw new Error('Swap amount must be positive')
  if (erc20Of(tokenIn).toLowerCase() === erc20Of(tokenOut).toLowerCase()) {
    throw new Error('Swap tokens must differ')
  }
  assertFeeBps(feeBps)
  routes.forEach(assertRoute)
  if (routes.length === 0) return { candidates: [], midOut: null, failedProtocols: new Set() }

  const probeIn = amountIn / 100n
  const hasProbe = probeIn > 0n
  const contracts = routes.flatMap((route) => [
    quoteContract(route, tokenIn, tokenOut, amountIn),
    ...(hasProbe ? [quoteContract(route, tokenIn, tokenOut, probeIn)] : []),
  ])
  const results = (await client.multicall({ contracts: contracts as never })) as MulticallResult[]
  const candidates: DirectCandidate[] = []
  const failedProtocols = new Set<DirectProtocol>()
  const stride = hasProbe ? 2 : 1

  routes.forEach((route, index) => {
    const grossAmountOut = quotedAmount(route, results[index * stride])
    if (!grossAmountOut) {
      failedProtocols.add(route.protocol)
      return
    }
    const probeAmountOut = hasProbe ? quotedAmount(route, results[index * stride + 1]) : null
    candidates.push({
      route,
      amountOut: netAfterFee(grossAmountOut, feeBps),
      impactBps: probeAmountOut ? impactBps(amountIn, grossAmountOut, probeIn, probeAmountOut) : null,
    })
  })

  candidates.sort((a, b) => {
    if (a.amountOut !== b.amountOut) return a.amountOut > b.amountOut ? -1 : 1
    if (a.impactBps === null) return b.impactBps === null ? 0 : 1
    if (b.impactBps === null) return -1
    return a.impactBps - b.impactBps
  })
  // A fee-bearing Quoter result is not enough to reconstruct the fee-free
  // input to a nonlinear AMM. Keep the raw probe for per-route size impact,
  // but do not manufacture the shared fee-free denominator by dividing by
  // (1-fee). The solver path can provide one because it owns snapshot state
  // and replays the exact executable route counterfactually.
  return {
    candidates,
    midOut: null,
    failedProtocols,
  }
}

export async function quoteDirectCandidates(
  client: PublicClient,
  pools: readonly Pool[] | null,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  feeBps: number,
): Promise<DirectQuotes> {
  const discovery = await directRoutes(client, pools, tokenIn, tokenOut)
  const quoted = await quoteRoutes(
    client,
    discovery.routes,
    tokenIn,
    tokenOut,
    amountIn,
    feeBps,
  )
  const failedProtocols = new Set([
    ...discovery.failedProtocols,
    ...quoted.failedProtocols,
  ])
  const status = {
    uniswap: quoteStatus('uniswap', quoted.candidates, failedProtocols),
    home: quoteStatus('home', quoted.candidates, failedProtocols),
  }
  const candidates = quoted.candidates.filter(({ route }) => status[route.protocol] === 'quoted')
  return {
    best: candidates[0] ?? null,
    byProtocol: {
      uniswap: candidates.find(({ route }) => route.protocol === 'uniswap') ?? null,
      home: candidates.find(({ route }) => route.protocol === 'home') ?? null,
    },
    status,
    midOut: quoted.midOut,
  }
}

export async function quoteDirectRoute(
  client: PublicClient,
  route: DirectRoute,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  feeBps: number,
): Promise<DirectCandidate> {
  const { candidates: [candidate] } = await quoteRoutes(client, [route], tokenIn, tokenOut, amountIn, feeBps)
  if (!candidate) throw new Error(`${directRouteLabel(route)} route is no longer quotable`)
  return candidate
}

function feeSettlement(
  abi: typeof uniSwapRouterAbi | typeof clSwapRouterAbi | typeof clSwapRouterFeeAbi,
  tokenOut: Address,
  grossMinimum: bigint,
  recipient: Address,
  fee: { bps: number; receiver: Address },
): Hex {
  // the *WithFee periphery functions require feeBips in [1, 100] — a zero
  // fee must settle through the plain sweep/unwrap variants
  if (fee.bps === 0) {
    return isNative(tokenOut)
      ? encodeFunctionData({ abi, functionName: 'unwrapWETH9', args: [grossMinimum, recipient] })
      : encodeFunctionData({
          abi,
          functionName: 'sweepToken',
          args: [erc20Of(tokenOut), grossMinimum, recipient],
        })
  }
  return isNative(tokenOut)
    ? encodeFunctionData({
        abi,
        functionName: 'unwrapWETH9WithFee',
        args: [grossMinimum, recipient, BigInt(fee.bps), fee.receiver],
      })
    : encodeFunctionData({
        abi,
        functionName: 'sweepTokenWithFee',
        args: [erc20Of(tokenOut), grossMinimum, recipient, BigInt(fee.bps), fee.receiver],
      })
}

export function buildDirectTransaction(args: {
  tokenIn: Address
  tokenOut: Address
  amountIn: bigint
  minimumAmountOut: bigint
  recipient: Address
  deadline: bigint
  route: DirectRoute
  fee: { bps: number; receiver: Address }
}): DirectTransaction {
  assertRoute(args.route)
  if (args.amountIn <= 0n || args.minimumAmountOut <= 0n) throw new Error('Swap amounts must be positive')
  // 0 is valid: a zero fee settles through the plain sweep/unwrap variants
  // (see feeSettlement). 1..100 use the *WithFee periphery functions.
  if (!Number.isInteger(args.fee.bps) || args.fee.bps < 0 || args.fee.bps > 100) {
    throw new Error(`Invalid router fee bps: ${args.fee.bps}`)
  }
  if (args.deadline <= 0n) throw new Error('Swap deadline must be positive')
  if (args.recipient.toLowerCase() === zeroAddress || args.fee.receiver.toLowerCase() === zeroAddress) {
    throw new Error('Swap and fee recipients must be nonzero')
  }

  const tokenIn = erc20Of(args.tokenIn)
  const tokenOut = erc20Of(args.tokenOut)
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) throw new Error('Swap tokens must differ')
  const grossMinimum = grossMinimumForNet(args.minimumAmountOut, args.fee.bps)
  const nativeInput = isNative(args.tokenIn)

  // v4: no router-custody hop and no sweep. The pool key IS the pool, the
  // terminal fee comes off the output delta with TAKE_PORTION, and ERC-20
  // input is pulled through Permit2 rather than a plain allowance.
  if (args.route.kind === 'v4') {
    const currencyIn = v4Currency(args.tokenIn)
    const currencyOut = v4Currency(args.tokenOut)
    const key = v4PoolKey(currencyIn, currencyOut, args.route.feePpm, args.route.tickSpacing)
    const { commands, inputs } = encodeV4Swap({
      key,
      zeroForOne: v4ZeroForOne(key, currencyIn),
      amountIn: args.amountIn,
      grossMinimumOut: grossMinimum,
      recipient: args.recipient,
      fee: args.fee,
    })
    return {
      to: UNI_V4!.UNIVERSAL_ROUTER,
      data: encodeFunctionData({
        abi: universalRouterAbi,
        functionName: 'execute',
        args: [commands, inputs as Hex[], args.deadline],
      }),
      value: nativeInput ? args.amountIn : 0n,
      spender: nativeInput ? null : UNI_V4!.PERMIT2,
      inputToken: nativeInput ? null : tokenIn,
      outputToken: isNative(args.tokenOut) ? null : tokenOut,
      permit2Operator: nativeInput ? null : UNI_V4!.UNIVERSAL_ROUTER,
    }
  }

  // A v2 leg executes on whichever SwapRouter02-shaped router the venue owns —
  // Uniswap's own on one slot, Pancake's SmartRouter on the other. Both carry
  // the identical surface, so one ABI encodes the swap and its settlement for
  // either. The plain v2 router is deliberately not used: it has no sweep
  // fragment, so the terminal fee could not settle in the same transaction.
  if (args.route.kind === 'v2') {
    const routers = v2Routers(args.route.protocol)
    if (!routers) throw new Error('Unsupported direct route')
    const router = routers.swap
    const swap = encodeFunctionData({
      abi: uniSwapRouterAbi,
      functionName: 'swapExactTokensForTokens',
      args: [
        args.amountIn,
        grossMinimum,
        swapPath(args.route, args.tokenIn, args.tokenOut),
        router,
      ],
    })
    const settle = feeSettlement(uniSwapRouterAbi, args.tokenOut, grossMinimum, args.recipient, args.fee)
    return {
      to: router,
      data: encodeFunctionData({
        abi: uniSwapRouterAbi,
        functionName: 'multicall',
        args: [args.deadline, [swap, settle]],
      }),
      value: nativeInput ? args.amountIn : 0n,
      spender: nativeInput ? null : router,
      inputToken: nativeInput ? null : tokenIn,
      outputToken: isNative(args.tokenOut) ? null : tokenOut,
      // SwapRouter02 pulls with a plain transferFrom
      permit2Operator: null,
    }
  }

  if (args.route.protocol === 'uniswap') {
    const swap = args.route.connector
      ? encodeFunctionData({
          abi: uniSwapRouterAbi,
          functionName: 'exactInput',
          args: [
            {
              path: v3Path(args.route, args.tokenIn, args.tokenOut),
              recipient: UNI.V3_SWAP_ROUTER,
              amountIn: args.amountIn,
              amountOutMinimum: grossMinimum,
            },
          ],
        })
      : encodeFunctionData({
          abi: uniSwapRouterAbi,
          functionName: 'exactInputSingle',
          args: [
            {
              tokenIn,
              tokenOut,
              fee: args.route.feePpm,
              recipient: UNI.V3_SWAP_ROUTER,
              amountIn: args.amountIn,
              amountOutMinimum: grossMinimum,
              sqrtPriceLimitX96: 0n,
            },
          ],
        })
    const settle = feeSettlement(
      uniSwapRouterAbi,
      args.tokenOut,
      grossMinimum,
      args.recipient,
      args.fee,
    )
    return {
      to: UNI.V3_SWAP_ROUTER,
      data: encodeFunctionData({
        abi: uniSwapRouterAbi,
        functionName: 'multicall',
        args: [args.deadline, [swap, settle]],
      }),
      value: nativeInput ? args.amountIn : 0n,
      spender: nativeInput ? null : UNI.V3_SWAP_ROUTER,
      inputToken: nativeInput ? null : tokenIn,
      outputToken: isNative(args.tokenOut) ? null : tokenOut,
      permit2Operator: null,
    }
  }

  // Both home-CL routers are the SwapRouter-v1 shape — deadline inside the
  // struct, multicall(bytes[]) — and differ only in the pool-key field, so the
  // ABI is picked once here and used for the swap AND its settlement.
  const routerAbi = args.route.keyedBy === 'fee' ? clSwapRouterFeeAbi : clSwapRouterAbi
  const common = {
    tokenIn,
    tokenOut,
    recipient: zeroAddress,
    deadline: args.deadline,
    amountIn: args.amountIn,
    amountOutMinimum: grossMinimum,
    sqrtPriceLimitX96: 0n,
  }
  const swap =
    args.route.keyedBy === 'fee'
      ? encodeFunctionData({
          abi: clSwapRouterFeeAbi,
          functionName: 'exactInputSingle',
          args: [{ ...common, fee: args.route.feePpm }],
        })
      : encodeFunctionData({
          abi: clSwapRouterAbi,
          functionName: 'exactInputSingle',
          args: [{ ...common, tickSpacing: args.route.tickSpacing }],
        })
  const settle = feeSettlement(routerAbi, args.tokenOut, grossMinimum, args.recipient, args.fee)
  return {
    to: ADDR.CL_SWAP_ROUTER,
    data: encodeFunctionData({ abi: routerAbi, functionName: 'multicall', args: [[swap, settle]] }),
    value: nativeInput ? args.amountIn : 0n,
    spender: nativeInput ? null : ADDR.CL_SWAP_ROUTER,
    inputToken: nativeInput ? null : tokenIn,
    outputToken: isNative(args.tokenOut) ? null : tokenOut,
    permit2Operator: null,
  }
}

export function directRouteLabel(route: DirectRoute): string {
  assertRoute(route)
  const fee = `${directRouteFeePpm(route) / 10_000}%`
  if (route.kind === 'cl') return `${CHAIN.labels.homeCl} ${fee}`
  // v4 carries the spacing because the fee alone does not name the pool
  if (route.kind === 'v4') return `Uniswap V4 ${fee} · ts${route.tickSpacing}`
  const hops = route.connector ? ' · 2 hops' : ''
  // a venue's v2 leg is named after that venue, and carries its own fee — the
  // two v2 venues on a chain do not charge the same rate
  if (route.kind === 'v2') {
    const venue = route.protocol === 'uniswap' ? 'Uniswap V2' : CHAIN.labels.homeV2
    return `${venue} ${fee}${hops}`
  }
  return `Uniswap V3 ${fee}${hops}`
}
