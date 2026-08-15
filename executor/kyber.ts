import { encodeFunctionData, getAddress, zeroAddress, type Address, type Hex } from 'viem'
import { clFactoryAbi, clSwapRouterAbi, quoterAbi, uniSwapRouterAbi, uniV3FactoryAbi, uniV3QuoterAbi } from '../src/abi'
import { ADDR, UNI } from '../src/config/addresses'
import { applySlippage } from '../src/lib/clmath'
import { publicClient } from './chain'
import { EXECUTOR } from './config'
import { buildSolverTx, quoteSolver, type SolverRouteSummary } from './solver'

const HEADERS = { 'x-client-id': 'lp-terminal-executor', 'content-type': 'application/json' }
export type RouteSource = 'kyber' | 'solver' | 'up33_cl' | 'univ3'
export type KyberRouteSummary = { tokenIn: string; tokenOut: string; amountIn: string; amountOut: string; route: unknown[][]; executorSource?: Exclude<RouteSource, 'kyber'>; tickSpacing?: number; feePpm?: number; [key: string]: unknown }
export type KyberRoute = { routeSummary: KyberRouteSummary; routerAddress: Address }
export type GatedSwapTx = { to: Address; approvalTarget: Address; exactApproval: boolean; data: Hex; value: bigint; minOut: bigint }
type Build = { data: Hex; routerAddress: Address; amountIn: string; amountOut: string; transactionValue?: string }
const api = () => `${EXECUTOR.kyberBase}/${EXECUTOR.kyberChain}/api/v1`
let aggregatorUnavailableUntil = 0
const UNI_V3_FEES = [100, 500, 3000, 10000] as const
const nativeRouteCache = new Map<string, { expiresAt: number; routes: NativeRoute[] }>()
const NATIVE_ROUTE_TTL_MS = 5 * 60_000

type NativeRoute =
  | { protocol: 'up33'; tickSpacing: number }
  | { protocol: 'univ3'; feePpm: number }

const pairKey = (tokenIn: Address, tokenOut: Address) =>
  [tokenIn.toLowerCase(), tokenOut.toLowerCase()].sort().join(':')

export function validateKyberRoute(route: KyberRoute, tokenIn: Address, tokenOut: Address, amountIn: bigint): KyberRoute {
  try {
    if (getAddress(route.routerAddress) !== EXECUTOR.kyberRouter) throw new Error('router')
    if (getAddress(route.routeSummary.tokenIn) !== getAddress(tokenIn) || getAddress(route.routeSummary.tokenOut) !== getAddress(tokenOut)) throw new Error('tokens')
    if (BigInt(route.routeSummary.amountIn) !== amountIn || BigInt(route.routeSummary.amountOut) <= 0n) throw new Error('amounts')
  } catch {
    throw new Error('E_KYBER_QUOTE_IDENTITY')
  }
  return route
}

async function quoteUp33Cl(tokenIn: Address, tokenOut: Address, amountIn: bigint, tickSpacing: number): Promise<KyberRoute> {
  const result = await publicClient.readContract({
    address: ADDR.CL_QUOTER,
    abi: quoterAbi,
    functionName: 'quoteExactInputSingle',
    args: [{ tokenIn, tokenOut, amountIn, tickSpacing, sqrtPriceLimitX96: 0n }],
  }) as readonly [bigint, bigint, number, bigint]
  if (result[0] <= 0n) throw new Error('E_NATIVE_QUOTE')
  return {
    routerAddress: ADDR.CL_SWAP_ROUTER,
    routeSummary: { tokenIn, tokenOut, amountIn: amountIn.toString(), amountOut: result[0].toString(), route: [], executorSource: 'up33_cl', tickSpacing },
  }
}

async function quoteUniv3(tokenIn: Address, tokenOut: Address, amountIn: bigint, feePpm: number): Promise<KyberRoute> {
  if (!Number.isInteger(feePpm) || feePpm <= 0 || feePpm > 1_000_000) throw new Error('E_NATIVE_QUOTE_IDENTITY')
  const result = await publicClient.readContract({
    address: UNI.V3_QUOTER,
    abi: uniV3QuoterAbi,
    functionName: 'quoteExactInputSingle',
    args: [{ tokenIn, tokenOut, amountIn, fee: feePpm, sqrtPriceLimitX96: 0n }],
  }) as readonly [bigint, bigint, number, bigint]
  if (result[0] <= 0n) throw new Error('E_NATIVE_QUOTE')
  return {
    routerAddress: UNI.V3_SWAP_ROUTER,
    routeSummary: { tokenIn, tokenOut, amountIn: amountIn.toString(), amountOut: result[0].toString(), route: [], executorSource: 'univ3', feePpm },
  }
}

async function nativeRoutes(tokenIn: Address, tokenOut: Address): Promise<NativeRoute[]> {
  const key = pairKey(tokenIn, tokenOut)
  const cached = nativeRouteCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.routes

  const spacingRead = await Promise.allSettled([
    publicClient.readContract({ address: ADDR.CL_FACTORY, abi: clFactoryAbi, functionName: 'tickSpacings' }),
  ])
  const spacings = spacingRead[0].status === 'fulfilled' ? spacingRead[0].value : []
  const [up33Pools, univ3Pools] = await Promise.all([
    Promise.allSettled(spacings.map(async (spacing) => ({
      spacing: Number(spacing),
      pool: await publicClient.readContract({ address: ADDR.CL_FACTORY, abi: clFactoryAbi, functionName: 'getPool', args: [tokenIn, tokenOut, spacing] }),
    }))),
    Promise.allSettled(UNI_V3_FEES.map(async (feePpm) => ({
      feePpm,
      pool: await publicClient.readContract({ address: UNI.V3_FACTORY, abi: uniV3FactoryAbi, functionName: 'getPool', args: [tokenIn, tokenOut, feePpm] }),
    }))),
  ])
  const routes: NativeRoute[] = [
    ...up33Pools.flatMap((result) => result.status === 'fulfilled' && result.value.pool.toLowerCase() !== zeroAddress
      ? [{ protocol: 'up33' as const, tickSpacing: result.value.spacing }]
      : []),
    ...univ3Pools.flatMap((result) => result.status === 'fulfilled' && result.value.pool.toLowerCase() !== zeroAddress
      ? [{ protocol: 'univ3' as const, feePpm: result.value.feePpm }]
      : []),
  ]
  nativeRouteCache.set(key, { expiresAt: Date.now() + NATIVE_ROUTE_TTL_MS, routes })
  return routes
}

/** Compare every executable source and return the best live output. */
export async function quoteWithNativeFallback(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<KyberRoute> {
  return quoteKyber(tokenIn, tokenOut, amountIn)
}

async function quoteKyberOnly(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<KyberRoute> {
  const url = new URL(`${api()}/routes`)
  url.searchParams.set('tokenIn', tokenIn)
  url.searchParams.set('tokenOut', tokenOut)
  url.searchParams.set('amountIn', amountIn.toString())
  url.searchParams.set('gasInclude', 'true')
  let response: Response | undefined
  let body: any
  if (Date.now() >= aggregatorUnavailableUntil) {
    try {
      response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(4_000) })
      body = await response.json().catch(() => null)
    } catch {
      // Avoid paying the same network timeout repeatedly during the numerical
      // balance solver. The circuit re-opens automatically after 30 seconds.
      aggregatorUnavailableUntil = Date.now() + 60_000
    }
  }
  if (response?.ok && body?.code === 0 && body?.data?.routeSummary && body?.data?.routerAddress)
    return validateKyberRoute(body.data as KyberRoute, tokenIn, tokenOut, amountIn)
  throw new Error('E_KYBER_QUOTE')
}

export async function quoteKyber(tokenIn: Address, tokenOut: Address, amountIn: bigint, fallback?: { protocol: 'up33' | 'univ3'; tickSpacing: number; feePpm?: number }): Promise<KyberRoute> {
  if (amountIn <= 0n) throw new Error('E_KYBER_QUOTE')
  const routes = await nativeRoutes(tokenIn, tokenOut).catch(() => [] as NativeRoute[])
  if (fallback?.protocol === 'up33' && !routes.some((route) => route.protocol === 'up33' && route.tickSpacing === fallback.tickSpacing))
    routes.push({ protocol: 'up33', tickSpacing: fallback.tickSpacing })
  if (fallback?.protocol === 'univ3' && fallback.feePpm !== undefined && !routes.some((route) => route.protocol === 'univ3' && route.feePpm === fallback.feePpm))
    routes.push({ protocol: 'univ3', feePpm: fallback.feePpm })
  const candidates = await Promise.allSettled([
    quoteKyberOnly(tokenIn, tokenOut, amountIn),
    quoteSolver(tokenIn, tokenOut, amountIn).then((routeSummary) => ({ routeSummary, routerAddress: zeroAddress })),
    ...routes.map((route) => route.protocol === 'up33'
      ? quoteUp33Cl(tokenIn, tokenOut, amountIn, route.tickSpacing)
      : quoteUniv3(tokenIn, tokenOut, amountIn, route.feePpm)),
  ])
  let best: KyberRoute | undefined
  for (const candidate of candidates) {
    if (candidate.status !== 'fulfilled') continue
    const value = candidate.value as KyberRoute
    if (!best || BigInt(value.routeSummary.amountOut) > BigInt(best.routeSummary.amountOut)) best = value
  }
  if (!best) throw new Error('E_KYBER_QUOTE')
  return best
}

export function routeAudit(routeSummary: KyberRouteSummary, gated?: Pick<GatedSwapTx, 'to' | 'approvalTarget' | 'minOut'>) {
  return {
    source: routeSummary.executorSource ?? 'kyber',
    amountOut: routeSummary.amountOut,
    router: gated?.to,
    approvalTarget: gated?.approvalTarget,
    minOut: gated?.minOut.toString(),
    tickSpacing: routeSummary.tickSpacing,
    feePpm: routeSummary.feePpm,
    route: routeSummary.route,
  }
}

/** Build and validate opaque aggregator calldata immediately before signing. */
export async function gatedKyberTx(args: { routeSummary: KyberRouteSummary; tokenIn: Address; tokenOut: Address; sender: Address; recipient: Address; amountIn: bigint; slippageBps: number; nativeIn: boolean }): Promise<GatedSwapTx> {
  if (args.routeSummary.executorSource === 'solver') {
    if (args.nativeIn) throw new Error('E_SOLVER_VALUE')
    const built = await buildSolverTx({ ...args, routeSummary: args.routeSummary as SolverRouteSummary })
    return { ...built, exactApproval: true }
  }
  if (args.routeSummary.executorSource === 'up33_cl') {
    if (args.nativeIn || getAddress(args.routeSummary.tokenIn) !== getAddress(args.tokenIn) || getAddress(args.routeSummary.tokenOut) !== getAddress(args.tokenOut) || BigInt(args.routeSummary.amountIn) !== args.amountIn || BigInt(args.routeSummary.amountOut) <= 0n)
      throw new Error('E_NATIVE_QUOTE_IDENTITY')
    const tickSpacing = Number(args.routeSummary.tickSpacing)
    if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) throw new Error('E_NATIVE_QUOTE_IDENTITY')
    const minOut = applySlippage(BigInt(args.routeSummary.amountOut), args.slippageBps)
    return {
      to: ADDR.CL_SWAP_ROUTER,
      data: encodeFunctionData({
        abi: clSwapRouterAbi,
        functionName: 'exactInputSingle',
        args: [{ tokenIn: args.tokenIn, tokenOut: args.tokenOut, tickSpacing, recipient: args.recipient, deadline: BigInt(Math.floor(Date.now() / 1000) + 20 * 60), amountIn: args.amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
      }),
      value: 0n,
      minOut,
      approvalTarget: ADDR.CL_SWAP_ROUTER,
      exactApproval: false,
    }
  }
  if (args.routeSummary.executorSource === 'univ3') {
    if (args.nativeIn || getAddress(args.routeSummary.tokenIn) !== getAddress(args.tokenIn) || getAddress(args.routeSummary.tokenOut) !== getAddress(args.tokenOut) || BigInt(args.routeSummary.amountIn) !== args.amountIn || BigInt(args.routeSummary.amountOut) <= 0n)
      throw new Error('E_NATIVE_QUOTE_IDENTITY')
    const feePpm = Number(args.routeSummary.feePpm)
    if (!Number.isInteger(feePpm) || feePpm <= 0 || feePpm > 1_000_000) throw new Error('E_NATIVE_QUOTE_IDENTITY')
    const minOut = applySlippage(BigInt(args.routeSummary.amountOut), args.slippageBps)
    return {
      to: UNI.V3_SWAP_ROUTER,
      data: encodeFunctionData({
        abi: uniSwapRouterAbi,
        functionName: 'exactInputSingle',
        args: [{ tokenIn: args.tokenIn, tokenOut: args.tokenOut, fee: feePpm, recipient: args.recipient, amountIn: args.amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
      }),
      value: 0n,
      minOut,
      approvalTarget: UNI.V3_SWAP_ROUTER,
      exactApproval: false,
    }
  }
  validateKyberRoute({ routeSummary: args.routeSummary, routerAddress: EXECUTOR.kyberRouter }, args.tokenIn, args.tokenOut, args.amountIn)
  const response = await fetch(`${api()}/route/build`, {
    method: 'POST', headers: HEADERS, signal: AbortSignal.timeout(6_000),
    body: JSON.stringify({ routeSummary: args.routeSummary, sender: args.sender, recipient: args.recipient, slippageTolerance: args.slippageBps, source: 'lp-terminal-executor', enableGasEstimation: false }),
  })
  const body = await response.json().catch(() => null) as any
  const built = body?.data as Build | undefined
  if (!response.ok || body?.code !== 0 || !built?.data) throw new Error('E_KYBER_BUILD')
  if (getAddress(built.routerAddress) !== EXECUTOR.kyberRouter) throw new Error('E_KYBER_ROUTER')
  const value = BigInt(built.transactionValue ?? '0')
  if (value !== (args.nativeIn ? args.amountIn : 0n)) throw new Error('E_KYBER_VALUE')
  const minOut = applySlippage(BigInt(args.routeSummary.amountOut), args.slippageBps)
  if (BigInt(built.amountIn) !== args.amountIn || BigInt(built.amountOut) < minOut) throw new Error('E_KYBER_DRIFT')
  return { to: EXECUTOR.kyberRouter, approvalTarget: EXECUTOR.kyberRouter, exactApproval: false, data: built.data, value, minOut }
}
