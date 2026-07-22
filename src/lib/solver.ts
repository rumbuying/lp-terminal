// Solver-backed swap quotes. The deployed router (ENV.solverUrl →
// solver.lp-terminal.xyz) quotes across every venue it routes — Uniswap
// v2/v3/v4, UP33 CL + Solidly, and supported V3 forks — with split
// allocation, and returns a ready-to-sign 0x-Settler transaction.
// Two rules are load-bearing: the tx is signed AS-IS, and allowanceTarget
// (the AllowanceHolder) is the ONLY approval target — never the settler
// address.
import { getAddress, type Address, type Hex } from 'viem'
import { ENV } from '../config/env'
import { parseSolverMidAmountOut, parseSolverPriceImpactBps } from './solverResponse'

export type SolverHop = {
  protocol: string
  /** CL-family hops carry feePpm; v2-family hops carry feeBps */
  feePpm?: number
  feeBps?: number
}
export type SolverLeg = { shareBps: number; hops: SolverHop[] }

export type SolverQuote = {
  block: number
  amountIn: bigint
  amountOutGross: bigint
  /** full-size executable rate versus the solver's same-block 1% executable
   *  fair-price quote. The fee both sides paid cancels: this is the SIZE
   *  penalty, not the all-in cost — that comes from midAmountOut. */
  priceImpactBps: number | null
  /** what amountIn fetches at the fee-free price — the one denominator every
   *  quote card's cost is measured against. Null when the probe cannot run. */
  midAmountOut: bigint | null
  /** after the solver-side terminal fee — comparable to DirectCandidate.amountOut */
  amountOutNet: bigint
  /** the floor embedded in tx (net of fee, at the requested slippageBps) */
  minAmountOutNet: bigint
  feeBps: number
  deadline: number
  route: SolverLeg[]
  tx: { to: Address; value: bigint; data: Hex } | null
  /** AllowanceHolder; null for native input, absent on quote-only requests */
  allowanceTarget: Address | null
}

type WireHop = { protocol: string; feePpm?: number; feeBps?: number }
type WireQuote = {
  block: number
  amountIn: string
  amountOutGross: string
  priceImpactBps?: unknown
  midAmountOut: unknown
  amountOutNet: string
  minAmountOutNet: string
  feeBps: number
  deadline: number
  route: { shareBps: number; hops: WireHop[] }[]
  tx?: { to: string; value: string; data: string }
  allowanceTarget?: string | null
  error?: string
}

// A cold three-hop topology miss probes up to ten unique token pairs. Leave
// enough client-side margin for public-RPC jitter; the server retains its
// separate 120s hard ceiling.
const SOLVER_TIMEOUT_MS = 20_000

export async function fetchSolverQuote(args: {
  tokenIn: Address
  tokenOut: Address
  amountIn: bigint
  slippageBps: number
  recipient?: Address
  /** submitting account; defaults server-side to recipient */
  sender?: Address
  /** per-request terminal-fee override (zap's rate); omitted = server default */
  feeBps?: number
}): Promise<SolverQuote> {
  const res = await fetch(`${ENV.solverUrl}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(SOLVER_TIMEOUT_MS),
    body: JSON.stringify({
      tokenIn: args.tokenIn,
      tokenOut: args.tokenOut,
      amountIn: args.amountIn.toString(),
      slippageBps: args.slippageBps,
      deadlineSeconds: 600,
      ...(args.recipient ? { recipient: args.recipient } : {}),
      ...(args.sender ? { sender: args.sender } : {}),
      ...(args.feeBps !== undefined ? { feeBps: args.feeBps } : {}),
    }),
  })
  const body = (await res.json()) as WireQuote
  if (!res.ok) throw new Error(body.error ?? `solver HTTP ${res.status}`)
  return {
    block: body.block,
    amountIn: BigInt(body.amountIn),
    amountOutGross: BigInt(body.amountOutGross),
    priceImpactBps: parseSolverPriceImpactBps(body.priceImpactBps),
    midAmountOut: parseSolverMidAmountOut(body.midAmountOut),
    amountOutNet: BigInt(body.amountOutNet),
    minAmountOutNet: BigInt(body.minAmountOutNet),
    feeBps: body.feeBps,
    deadline: body.deadline,
    route: body.route.map((leg) => ({
      shareBps: leg.shareBps,
      hops: leg.hops.map(({ protocol, feePpm, feeBps }) => ({ protocol, feePpm, feeBps })),
    })),
    tx: body.tx
      ? { to: getAddress(body.tx.to), value: BigInt(body.tx.value), data: body.tx.data as Hex }
      : null,
    allowanceTarget: body.allowanceTarget ? getAddress(body.allowanceTarget) : null,
  }
}

/** share-weighted venue fee across the route in bps — the volatility prior
 *  autoSlippage expects (a multihop leg's fee is the sum of its hops') */
export function solverVenueFeeBps(quote: SolverQuote): number {
  let acc = 0
  for (const leg of quote.route) {
    acc += leg.shareBps * leg.hops.reduce((sum, hop) => sum + (hop.feePpm ?? (hop.feeBps ?? 0) * 100), 0)
  }
  return acc / 10_000 / 100
}

const VENUES: Record<string, string> = {
  univ2: 'UNI V2',
  univ3: 'UNI V3',
  univ4: 'UNI V4',
  up33cl: 'UP33 CL',
  up33v2: 'UP33 V2',
  pancakev3: 'PANCAKE V3',
  swaphoodv3: 'SWAPHOOD V3',
  gigadexv3: 'GIGADEX CL',
  sushiv3: 'SUSHI V3',
  robinswapv3: 'ROBINSWAP V3',
  sheriff: 'SHERIFF',
}

/** display name for a solver hop protocol (falls back to the raw id) */
export function venueLabel(protocol: string): string {
  return VENUES[protocol] ?? protocol.toUpperCase()
}

/** a leg's share for display — sub-0.5% legs read "<1" rather than "0" */
export function legSharePct(shareBps: number): string {
  return shareBps < 50 ? '<1' : String(Math.round(shareBps / 100))
}

/** compact route summary: "68% UNI V3 + 23% UNI V4 + 9% UP33 CL→UNI V3" */
export function solverRouteLabel(quote: SolverQuote): string {
  return quote.route
    .map((leg) => `${legSharePct(leg.shareBps)}% ${leg.hops.map((hop) => venueLabel(hop.protocol)).join('→')}`)
    .join(' + ')
}
