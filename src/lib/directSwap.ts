import {
  encodeFunctionData,
  getAddress,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import {
  clSwapRouterAbi,
  quoterAbi,
  uniSwapRouterAbi,
  uniV2FactoryAbi,
  uniV2RouterAbi,
  uniV3FactoryAbi,
  uniV3QuoterAbi,
} from '../abi'
import { ADDR, NATIVE, UNI } from '../config/addresses'
import type { Pool } from '../types'

export type DirectProtocol = 'uniswap' | 'up33'
type UniV2Route = { protocol: 'uniswap'; kind: 'v2'; feePpm: 3000 }
type UniV3Route = {
  protocol: 'uniswap'
  kind: 'v3'
  feePpm: 100 | 500 | 3000 | 10000
}
type Up33ClRoute = {
  protocol: 'up33'
  kind: 'cl'
  tickSpacing: number
  feePpm: number
}
export type DirectRoute = UniV2Route | UniV3Route | Up33ClRoute

export type DirectCandidate = {
  route: DirectRoute
  amountOut: bigint
  impactBps: number | null
}

export type DirectQuotes = {
  best: DirectCandidate | null
  byProtocol: Record<DirectProtocol, DirectCandidate | null>
  status: Record<DirectProtocol, 'quoted' | 'absent' | 'failed'>
  /** probe-derived fee-free V2 price when resolution permits — the fallback cost denominator */
  midOut: bigint | null
}

type DirectTransaction = {
  to: Address
  data: Hex
  value: bigint
  spender: Address | null
  inputToken: Address | null
  outputToken: Address | null
}

const UNI_V3_FEES = [100, 500, 3000, 10000] as const
const UNI_ROUTES: readonly DirectRoute[] = [
  { protocol: 'uniswap', kind: 'v2', feePpm: 3000 },
  ...UNI_V3_FEES.map((feePpm) => ({ protocol: 'uniswap' as const, kind: 'v3' as const, feePpm })),
]

export function isNative(address?: Address): boolean {
  return !!address && address.toLowerCase() === NATIVE.toLowerCase()
}

export function erc20Of(address: Address): Address {
  return isNative(address) ? ADDR.WETH : getAddress(address)
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

function assertRoute(route: DirectRoute): void {
  if (route.protocol === 'uniswap' && route.kind === 'v2' && route.feePpm === 3000) return
  if (
    route.protocol === 'uniswap' &&
    route.kind === 'v3' &&
    UNI_V3_FEES.includes(route.feePpm)
  ) {
    return
  }
  if (
    route.protocol === 'up33' &&
    route.kind === 'cl' &&
    Number.isInteger(route.tickSpacing) &&
    route.tickSpacing !== 0 &&
    Number.isInteger(route.feePpm) &&
    route.feePpm > 0 &&
    // A route cannot execute at a 100% LP fee. Discovery filters these out;
    // this also covers routes handed in directly.
    route.feePpm < 1_000_000
  ) {
    return
  }
  throw new Error('Unsupported direct route')
}

function matchesPair(pool: Pool, tokenIn: Address, tokenOut: Address): boolean {
  const input = erc20Of(tokenIn).toLowerCase()
  const output = erc20Of(tokenOut).toLowerCase()
  const token0 = pool.token0.toLowerCase()
  const token1 = pool.token1.toLowerCase()
  return (token0 === input && token1 === output) || (token0 === output && token1 === input)
}

function up33Routes(pools: readonly Pool[], tokenIn: Address, tokenOut: Address): DirectRoute[] {
  const seen = new Set<string>()
  const routes: Up33ClRoute[] = []

  for (const pool of pools) {
    if (
      pool.kind !== 'cl' ||
      pool.protocol !== 'up33' ||
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
      protocol: 'up33',
      kind: 'cl',
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

async function directRoutes(
  client: PublicClient,
  pools: readonly Pool[] | null,
  tokenIn: Address,
  tokenOut: Address,
): Promise<RouteDiscovery> {
  const input = erc20Of(tokenIn)
  const output = erc20Of(tokenOut)
  const contracts = [
    {
      abi: uniV2FactoryAbi,
      address: UNI.V2_FACTORY,
      functionName: 'getPair',
      args: [input, output],
    },
    ...UNI_V3_FEES.map((fee) => ({
      abi: uniV3FactoryAbi,
      address: UNI.V3_FACTORY,
      functionName: 'getPool' as const,
      args: [input, output, fee],
    })),
  ]
  const discovery = (await client.multicall({
    contracts: contracts as never,
  })) as MulticallResult[]
  const failedProtocols = new Set<DirectProtocol>()
  const uniswapDiscoveryFailed = discovery.some(({ status }) => status === 'failure')
  if (uniswapDiscoveryFailed) failedProtocols.add('uniswap')
  if (pools === null) failedProtocols.add('up33')

  const uniswap = uniswapDiscoveryFailed
    ? []
    : UNI_ROUTES.filter((_, index) => {
        const address = discovery[index].result as Address
        return address.toLowerCase() !== zeroAddress
      })
  const up33 = pools === null ? [] : up33Routes(pools, tokenIn, tokenOut)
  return { routes: [...uniswap, ...up33], failedProtocols }
}

function quoteContract(
  route: DirectRoute,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
) {
  const input = erc20Of(tokenIn)
  const output = erc20Of(tokenOut)
  if (route.protocol === 'uniswap' && route.kind === 'v2') {
    return {
      abi: uniV2RouterAbi,
      address: UNI.V2_ROUTER,
      functionName: 'getAmountsOut',
      args: [amountIn, [input, output]],
    } as const
  }
  if (route.protocol === 'uniswap') {
    return {
      abi: uniV3QuoterAbi,
      address: UNI.V3_QUOTER,
      functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: input, tokenOut: output, amountIn, fee: route.feePpm, sqrtPriceLimitX96: 0n }],
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
  if (route.protocol === 'uniswap' && route.kind === 'v2') {
    const amounts = result.result as readonly bigint[]
    return amounts.at(-1) ?? null
  }
  const [amountOut] = result.result as readonly [bigint, bigint, number, bigint]
  return amountOut
}

export function impactBps(amountIn: bigint, amountOut: bigint, probeIn: bigint, probeOut: bigint): number {
  const probeRate = probeOut * amountIn
  const fullRate = amountOut * probeIn
  if (fullRate >= probeRate) return 0
  return Number(((probeRate - fullRate) * 10_000n + probeRate - 1n) / probeRate)
}

/** `amountIn` at a V2 probe's fee-free price. Reject probe rounding that cannot
 * place the baseline at or above every full-size gross output.
 * V3/CL Quoters do not expose enough fee information to reconstruct one. */
function midAmountOut(
  probe: { out: bigint; feePpm: number },
  probeIn: bigint,
  amountIn: bigint,
  maxGrossAmountOut: bigint,
): bigint | null {
  const midOut = (probe.out * 1_000_000n * amountIn) / (BigInt(1_000_000 - probe.feePpm) * probeIn)
  return midOut >= maxGrossAmountOut ? midOut : null
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
  const probes: { out: bigint; route: DirectRoute }[] = []
  let maxGrossAmountOut = 0n

  routes.forEach((route, index) => {
    const grossAmountOut = quotedAmount(route, results[index * stride])
    if (!grossAmountOut) {
      failedProtocols.add(route.protocol)
      return
    }
    if (grossAmountOut > maxGrossAmountOut) maxGrossAmountOut = grossAmountOut
    const probeAmountOut = hasProbe ? quotedAmount(route, results[index * stride + 1]) : null
    if (probeAmountOut) probes.push({ out: probeAmountOut, route })
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
  // Every route probed the same probeIn, so the outputs rank directly. Only V2
  // exposes enough information to undo its fee exactly on the direct path.
  const winner = probes.length ? probes.reduce((a, b) => (b.out > a.out ? b : a)) : null
  return {
    candidates,
    midOut:
      winner?.route.kind === 'v2'
        ? midAmountOut({ out: winner.out, feePpm: winner.route.feePpm }, probeIn, amountIn, maxGrossAmountOut)
        : null,
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
    up33: quoteStatus('up33', quoted.candidates, failedProtocols),
  }
  const candidates = quoted.candidates.filter(({ route }) => status[route.protocol] === 'quoted')
  return {
    best: candidates[0] ?? null,
    byProtocol: {
      uniswap: candidates.find(({ route }) => route.protocol === 'uniswap') ?? null,
      up33: candidates.find(({ route }) => route.protocol === 'up33') ?? null,
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
  abi: typeof uniSwapRouterAbi | typeof clSwapRouterAbi,
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

  if (args.route.protocol === 'uniswap') {
    const swap =
      args.route.kind === 'v2'
        ? encodeFunctionData({
            abi: uniSwapRouterAbi,
            functionName: 'swapExactTokensForTokens',
            args: [args.amountIn, grossMinimum, [tokenIn, tokenOut], UNI.V3_SWAP_ROUTER],
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
    }
  }

  const swap = encodeFunctionData({
    abi: clSwapRouterAbi,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn,
        tokenOut,
        tickSpacing: args.route.tickSpacing,
        recipient: zeroAddress,
        deadline: args.deadline,
        amountIn: args.amountIn,
        amountOutMinimum: grossMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ],
  })
  const settle = feeSettlement(
    clSwapRouterAbi,
    args.tokenOut,
    grossMinimum,
    args.recipient,
    args.fee,
  )
  return {
    to: ADDR.CL_SWAP_ROUTER,
    data: encodeFunctionData({ abi: clSwapRouterAbi, functionName: 'multicall', args: [[swap, settle]] }),
    value: nativeInput ? args.amountIn : 0n,
    spender: nativeInput ? null : ADDR.CL_SWAP_ROUTER,
    inputToken: nativeInput ? null : tokenIn,
    outputToken: isNative(args.tokenOut) ? null : tokenOut,
  }
}

export function directRouteLabel(route: DirectRoute): string {
  assertRoute(route)
  const fee = `${route.feePpm / 10_000}%`
  if (route.protocol === 'up33') return `UP33 CL ${fee}`
  return route.kind === 'v2' ? 'Uniswap V2' : `Uniswap V3 ${fee}`
}
