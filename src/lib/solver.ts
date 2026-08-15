// Solver-backed swap quotes. The deployed router (ENV.solverUrl → the selected
// canonical chain namespace) quotes across every venue it routes — Uniswap
// v2/v3/v4, Ekubo V3, UP33 CL + Solidly, and supported V3 forks — with split
// allocation, and returns a ready-to-sign 0x-Settler transaction.
// Two rules are load-bearing: the tx is signed AS-IS, and allowanceTarget
// (the AllowanceHolder) is the ONLY approval target — never the settler
// address.
import { decodeFunctionData, getAddress, isHex, parseAbi, type Address, type Hex } from 'viem'
import { CHAIN_ID, NATIVE } from '../config/addresses'
import { CHAIN } from '../config/chains'
import { ENV } from '../config/env'
import { FEATURES } from '../config/features'
import { parseSolverMidAmountOut, parseSolverPriceImpactBps } from './solverResponse'

export type SolverHop = {
  protocol: string
  /** the pool this hop trades through, and the two tokens it moves between.
   *  Lowercase, never checksummed: these drive the route MAP, which is
   *  decorative — a malformed address from a mismatched solver must not throw
   *  where the transaction beside it is perfectly good. */
  pool: string
  tokenIn: string
  tokenOut: string
  /** CL-family hops carry feePpm; v2-family hops carry feeBps */
  feePpm?: number
  /** Ekubo-specific identity retained for route details and diagnostics. */
  extension?: string
  poolType?: string
  feeX64?: string
  tickSpacing?: number | null
  /** set on the synthetic hops of a collective band (see routeMap
   *  condenseWaypoints): how many pools it stands for. Never on the wire. */
  folded?: number
  feeBps?: number
}
export type SolverLeg = {
  shareBps: number
  /** raw units this leg spends and delivers (0n if an older solver omits them) */
  amountIn: bigint
  amountOut: bigint
  hops: SolverHop[]
}
export type SolverSearchTier = 'baseline' | 'all_routes'
export type SolverSearchTruncation =
  | 'oracle_pass_exceeds_budget'
  | 'allocation_grid_coarsened'
  | 'model_unsupported'
  | 'evaluation_aborted'
  | 'execution_fallback'
export type SolverTierDiagnostics = {
  tier: SolverSearchTier
  tokenSkeletons: number
  oracleWorkPerPass: number
  requestedChunks: number
  completedChunks: number
  allocationWorkUpperBound: number
  fullSizeWorkUpperBound: number
  reallocationWorkUpperBound: number
  replayWorkUpperBound: number
  quantizationWorkUpperBound: number
  polishWorkUpperBound: number
  totalWorkUpperBound: number
  budget: number
  unsupportedHopExclusions: number
  truncation?: SolverSearchTruncation
}
export type SolverHopCoverage = {
  hopCount: number
  tokenSkeletons: number
  distinctPoolsByPosition: number[]
}
export type SolverObservationMode = 'off' | 'shadow' | 'active'
export type SolverObservationStatus = 'off' | 'unavailable' | 'bounded_gap' | 'closed'
export type SolverObservationAcceptance = 'amount_complete_directional_coverage'
export type SolverObservationFallbackReason =
  | 'unsupported'
  | 'unavailable'
  | 'no_executable_incumbent'
  | 'topology_incomplete'
  | 'integrity_truncated'
  | 'legacy_membership_unproven'
  | 'upper_bound_violation'
  | 'round_budget_exhausted'
  | 'depth_budget_exhausted'
export type SolverObservationUnavailableReason =
  | 'empty_candidate_universe'
  | 'empty_skeleton_edge'
  | 'unsupported_hop_count'
  | 'inconsistent_skeleton_endpoints'
  | 'invalid_hop_index'
  | 'invalid_hop_direction'
  | 'invalid_pool_state'
  | 'invalid_pool_fee'
  | 'unknown_transfer'
  | 'unobserved_transfer_endpoint'
  | 'transfer_side_effect'
  | 'dynamic_fee'
  | 'v4_exact_only'
  | 'bidirectional_physical_pool'
  | 'non_simple_skeleton'
  | 'no_executable_incumbent'
  | 'arithmetic_overflow'
type SolverObservationCommon = {
  scope: 'supported_enhanced_route_graph'
  objective: 'amount_out_gross'
  certifiedSkeletons: number
  certifiedHops: number
  candidatePoolDirections: number
  scalarPoolDirections: number
  directionalPrefixPoolDirections: number
  exactPoolDirections: number
  /** Added with executable-floor dominance pruning; absent on older solvers. */
  strictlyDominatedPoolDirections?: number
  fallbackDetail?: SolverObservationUnavailableReason
  networkRounds: number
  scheduledPoolExpansions: number
  materializedClTicks: number
}
type SolverActiveObservationTermination =
  | {
      acceptance: SolverObservationAcceptance
      fallbackReason?: never
    }
  | {
      acceptance?: never
      fallbackReason: SolverObservationFallbackReason
    }
export type SolverObservationDiagnostics = SolverObservationCommon & (
  | {
      mode: 'off'
      status: 'off'
      lowerBoundWei: string | null
      upperBoundWei: null
      gapWei: null
      gapBps: null
      unavailableReason?: never
    }
  | {
      mode: 'shadow'
      status: 'unavailable'
      lowerBoundWei: string | null
      upperBoundWei: null
      gapWei: null
      gapBps: null
      unavailableReason: SolverObservationUnavailableReason
    }
  | {
      mode: 'shadow'
      status: 'bounded_gap' | 'closed'
      lowerBoundWei: string
      upperBoundWei: string
      gapWei: string
      gapBps: string | null
      unavailableReason?: never
    }
  | (SolverActiveObservationTermination & {
      mode: 'active'
      status: 'unavailable'
      lowerBoundWei: string | null
      upperBoundWei: null
      gapWei: null
      gapBps: null
      unavailableReason: SolverObservationUnavailableReason
      acceptance?: never
      fallbackReason: SolverObservationFallbackReason
    })
  | (SolverActiveObservationTermination & {
      mode: 'active'
      status: 'bounded_gap' | 'closed'
      lowerBoundWei: string
      upperBoundWei: string
      gapWei: string
      gapBps: string | null
      unavailableReason?: never
    })
)
export type SolverCatalogFences = {
  v23: { seq: string; generation: string }
  v4: { block: number; generation: Hex } | null
}
export type SolverRouteUniverseSource =
  | 'profile_only'
  | 'adjacency_complete'
  | 'adjacency_fallback'
  | 'adjacency_shadow'
  | 'adjacency_shadow_fallback'
export type SolverRouteUniverseScope = 'profile' | 'common_neighbor_two_hop'
export type SolverRouteUniverseFallbackReason =
  | 'transport'
  | 'conflict'
  | 'capacity'
  | 'invalid_response'
export type SolverRouteUniverse = {
  version: 1
  chainId: number
  canonicalBlock: { number: number; hash: Hex }
  source: SolverRouteUniverseSource
  fallbackStage: 'adjacency' | null
  fallbackReason: SolverRouteUniverseFallbackReason | null
  /** Exact token-path domain materialized into the certified snapshot. */
  scope: SolverRouteUniverseScope
  /** Candidate-selection domain; shadow mode may observe more than `scope`. */
  selectionScope: SolverRouteUniverseScope
  protocolMask: number
  eligibleCount: number
  connectorCount: number
  shortlistTruncated: boolean
  fingerprint: Hex
  adjacencyFences: SolverCatalogFences | null
  topologyFences: SolverCatalogFences | null
}
export type SolverNoRouteMetadata = {
  schemaVersion: 1
  chain: string
  chainId: number
  requestedChainId: number
  routeUniverse: SolverRouteUniverse
  observation?: SolverObservationDiagnostics
}

/** Typed HTTP failure that remains compatible with every existing `Error`
 * caller while retaining the structured evidence carried by a no-route 422. */
export class SolverQuoteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly noRoute: SolverNoRouteMetadata | null = null,
  ) {
    super(message)
    this.name = 'SolverQuoteError'
  }
}

/** A checkable upper bound inside `quote.routeUniverse.scope` at its canonical
 *  block. Omitted catalog edges and routes outside that materialized universe
 *  are not covered. The UI treats this artifact as display-only; the server may
 *  already have used a certified gap for its explicit allocator escalation. */
export type SolverCertificate = {
  scope: 'materialized_route_universe'
  /** "certified" is the only state display trusts; others render nothing */
  status: string
  /** certified allocation-regret ceiling in bps; null when unparseable */
  gapBps: number | null
  unroutedPools: number | null
  scannedPools: number | null
}

export type SolverQuote = {
  /** Chain identity verified against the active build before this quote is accepted. */
  chainId: number
  block: number
  /** Execution identity is absent on quote-only chain snapshots. */
  settler: Address | null
  /** Search/catalog evidence is emitted by the in-development solver. The
   *  production solver intentionally remains the compatibility baseline until
   *  that rollout, so successful quotes must also work without these fields. */
  stateBlockNumber?: number
  stateBlockHash?: Hex
  indexGeneration?: number
  catalogTopologyEpoch?: number
  catalogIntegrityEpoch?: number
  catalogIndexedBlock?: number
  catalogIndexedBlockHash?: Hex
  topologyFingerprint?: Hex
  topologyTruncated?: boolean
  searchComplete?: boolean
  truncatedTiers?: SolverSearchTier[]
  evaluationByTier?: SolverTierDiagnostics[]
  candidateCoverageByHop?: SolverHopCoverage[]
  optimality?: 'heuristic'
  observation?: SolverObservationDiagnostics
  /** Versioned boundary shared by successful and structured no-route replies. */
  routeUniverse?: SolverRouteUniverse
  amountIn: bigint
  amountOutGross: bigint
  /** Full-size executable rate versus the solver's independently optimized,
   *  same-block 1% executable probe. Common fees largely cancel, but this is
   *  not a strict same-route, fee-free size decomposition. */
  priceImpactBps: number | null
  /** The 1% executable probe plan replayed fee-free and scaled to amountIn.
   *  This shared secant baseline retains probe depth; it is not a zero-size
   *  mid. Null when the counterfactual probe cannot run. */
  midAmountOut: bigint | null
  /** after the solver-side terminal fee — comparable to DirectCandidate.amountOut */
  amountOutNet: bigint
  /** the floor embedded in tx (net of fee, at the requested slippageBps) */
  minAmountOutNet: bigint
  feeBps: number
  deadline: number
  route: SolverLeg[]
  tx: { requiredFrom?: Address; to: Address; value: bigint; data: Hex } | null
  /** AllowanceHolder; null for native input, absent on quote-only requests */
  allowanceTarget: Address | null
  /** absent when the server has certificates off or the payload is malformed */
  certificate?: SolverCertificate
}

type WireHop = {
  protocol: string
  pool: string
  tokenIn: string
  tokenOut: string
  feePpm?: number
  feeBps?: number
  extension?: string
  poolType?: string
  feeX64?: string
  tickSpacing?: number | null
}
type WireQuote = {
  chainId: number
  block: number
  settler?: string | null
  tokenIn: string
  tokenOut: string
  slippageBps?: number
  deadlineSeconds?: number
  requestedFeeBps?: number | null
  recipient?: string | null
  sender?: string | null
  stateBlockNumber?: number
  stateBlockHash?: string
  indexGeneration?: number
  catalogTopologyEpoch?: number
  catalogIntegrityEpoch?: number
  catalogIndexedBlock?: number
  catalogIndexedBlockHash?: string
  topologyFingerprint?: string
  topologyTruncated?: boolean
  searchComplete?: boolean
  truncatedTiers?: SolverSearchTier[]
  evaluationByTier?: SolverTierDiagnostics[]
  candidateCoverageByHop?: SolverHopCoverage[]
  optimality?: 'heuristic'
  observation?: unknown
  routeUniverse?: unknown
  amountIn: string
  amountOutGross: string
  priceImpactBps?: unknown
  midAmountOut: unknown
  amountOutNet: string
  minAmountOutNet: string
  feeBps: number
  deadline: number
  route: { shareBps: number; amountIn: string; amountOut: string; hops: WireHop[] }[]
  tx?: { requiredFrom?: string; to: string; value: string; data: string }
  allowanceTarget?: string | null
  certificate?: unknown
  error?: string
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

const isUnsignedInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isHash = (value: unknown): value is Hex =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)

const isUnsignedDecimal = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)

const allowanceHolderAbi = parseAbi([
  'function exec(address operator, address token, uint256 amount, address target, bytes data)',
])

const parseWireAddress = (value: unknown, field: string): Address => {
  if (typeof value !== 'string') {
    throw new SolverQuoteError(`solver response has an invalid ${field}`, 502)
  }
  try {
    const address = getAddress(value)
    if (address === '0x0000000000000000000000000000000000000000') throw new Error('zero address')
    return address
  } catch {
    throw new SolverQuoteError(`solver response has an invalid ${field}`, 502)
  }
}

/** Bind the top-level execution identities to the transaction that callers
 * sign as-is. A quote-only response may omit Settler identity; a transaction
 * may not. ERC-20 execution additionally proves that the AllowanceHolder
 * calldata delegates to this exact Settler for this exact input amount. */
const parseExecutionBinding = (body: WireQuote): {
  settler: Address | null
  allowanceTarget: Address | null
} => {
  const settler = body.settler === undefined || body.settler === null
    ? null
    : parseWireAddress(body.settler, 'settler')
  if (body.tx === undefined || body.tx === null) {
    const allowanceTarget = body.allowanceTarget === undefined || body.allowanceTarget === null
      ? null
      : parseWireAddress(body.allowanceTarget, 'allowanceTarget')
    return { settler, allowanceTarget }
  }
  if (!settler) {
    throw new SolverQuoteError('solver transaction has no Settler binding', 502)
  }

  const tx = asRecord(body.tx)
  const to = parseWireAddress(tx?.to, 'transaction target')
  if (
    !isUnsignedDecimal(tx?.value) ||
    typeof tx?.data !== 'string' ||
    tx.data.length < 10 ||
    !isHex(tx.data, { strict: true })
  ) {
    throw new SolverQuoteError('solver transaction has an invalid value or calldata', 502)
  }
  const transactionValue = BigInt(tx.value)
  const quotedAmount = isUnsignedDecimal(body.amountIn) ? BigInt(body.amountIn) : null
  const nativeInput = typeof body.tokenIn === 'string' && body.tokenIn.toLowerCase() === NATIVE.toLowerCase()
  if (nativeInput) {
    if (
      body.allowanceTarget !== null ||
      to !== settler ||
      quotedAmount === null ||
      transactionValue !== quotedAmount
    ) {
      throw new SolverQuoteError('solver native transaction has an invalid Settler binding', 502)
    }
    return { settler, allowanceTarget: null }
  }

  const allowanceTarget = parseWireAddress(body.allowanceTarget, 'allowanceTarget')
  if (CHAIN.solverAllowanceTarget === null || allowanceTarget !== CHAIN.solverAllowanceTarget) {
    throw new SolverQuoteError('solver ERC-20 transaction has an untrusted allowance target', 502)
  }
  if (to !== allowanceTarget || transactionValue !== 0n) {
    throw new SolverQuoteError('solver ERC-20 transaction has an invalid allowance binding', 502)
  }
  try {
    const decoded = decodeFunctionData({
      abi: allowanceHolderAbi,
      data: tx.data as Hex,
    })
    const [operator, token, amount, target] = decoded.args
    if (
      getAddress(operator) !== settler ||
      getAddress(target) !== settler ||
      typeof body.tokenIn !== 'string' ||
      getAddress(token) !== getAddress(body.tokenIn) ||
      !isUnsignedDecimal(body.amountIn) ||
      amount !== BigInt(body.amountIn)
    ) {
      throw new Error('AllowanceHolder args do not match the quote')
    }
  } catch {
    throw new SolverQuoteError('solver ERC-20 transaction has an invalid Settler binding', 502)
  }
  return { settler, allowanceTarget }
}

const isObservationUnavailableReason = (
  value: unknown,
): value is SolverObservationUnavailableReason =>
  value === 'empty_candidate_universe' ||
  value === 'empty_skeleton_edge' ||
  value === 'unsupported_hop_count' ||
  value === 'inconsistent_skeleton_endpoints' ||
  value === 'invalid_hop_index' ||
  value === 'invalid_hop_direction' ||
  value === 'invalid_pool_state' ||
  value === 'invalid_pool_fee' ||
  value === 'unknown_transfer' ||
  value === 'unobserved_transfer_endpoint' ||
  value === 'transfer_side_effect' ||
  value === 'dynamic_fee' ||
  value === 'v4_exact_only' ||
  value === 'bidirectional_physical_pool' ||
  value === 'non_simple_skeleton' ||
  value === 'no_executable_incumbent' ||
  value === 'arithmetic_overflow'

const isObservationAcceptance = (
  value: unknown,
): value is SolverObservationAcceptance =>
  value === 'amount_complete_directional_coverage'

const isObservationFallbackReason = (
  value: unknown,
): value is SolverObservationFallbackReason =>
  value === 'unsupported' ||
  value === 'unavailable' ||
  value === 'no_executable_incumbent' ||
  value === 'topology_incomplete' ||
  value === 'integrity_truncated' ||
  value === 'legacy_membership_unproven' ||
  value === 'upper_bound_violation' ||
  value === 'round_budget_exhausted' ||
  value === 'depth_budget_exhausted'

/** Observation evidence is an atomic optional extension. Malformed or newer
 * evidence is omitted without discarding an otherwise valid quote or
 * structured no-route response. Active acceptance certifies request-amount
 * state depth only; the route optimizer remains bounded and heuristic. */
const parseObservationDiagnostics = (value: unknown): SolverObservationDiagnostics | null => {
  const item = asRecord(value)
  if (
    item === null ||
    item.scope !== 'supported_enhanced_route_graph' ||
    item.objective !== 'amount_out_gross' ||
    (item.lowerBoundWei !== null && !isUnsignedDecimal(item.lowerBoundWei)) ||
    !isUnsignedInteger(item.certifiedSkeletons) ||
    !isUnsignedInteger(item.certifiedHops) ||
    !isUnsignedInteger(item.candidatePoolDirections) ||
    !isUnsignedInteger(item.scalarPoolDirections) ||
    !isUnsignedInteger(item.directionalPrefixPoolDirections) ||
    !isUnsignedInteger(item.exactPoolDirections) ||
    (
      item.strictlyDominatedPoolDirections !== undefined &&
      !isUnsignedInteger(item.strictlyDominatedPoolDirections)
    ) ||
    !isUnsignedInteger(item.networkRounds) ||
    !isUnsignedInteger(item.scheduledPoolExpansions) ||
    !isUnsignedInteger(item.materializedClTicks)
  ) return null

  const mode = item.mode
  if (
    mode !== 'off' &&
    mode !== 'shadow' &&
    mode !== 'active'
  ) return null
  // Shadow/off counts describe one immutable view. Active counts are stage
  // visits and may exceed the unique candidate count after geometric deepening.
  if (
    mode !== 'active' &&
    (
      item.scalarPoolDirections > item.candidatePoolDirections ||
      item.directionalPrefixPoolDirections > item.candidatePoolDirections ||
      item.exactPoolDirections > item.candidatePoolDirections ||
      (
        item.strictlyDominatedPoolDirections !== undefined &&
        item.strictlyDominatedPoolDirections > item.candidatePoolDirections
      )
    )
  ) return null

  const acceptance = isObservationAcceptance(item.acceptance)
    ? item.acceptance
    : null
  const fallbackReason = isObservationFallbackReason(item.fallbackReason)
    ? item.fallbackReason
    : null
  if (
    (item.acceptance !== undefined && acceptance === null) ||
    (item.fallbackReason !== undefined && fallbackReason === null)
  ) return null

  const common: SolverObservationCommon = {
    scope: item.scope,
    objective: item.objective,
    certifiedSkeletons: item.certifiedSkeletons,
    certifiedHops: item.certifiedHops,
    candidatePoolDirections: item.candidatePoolDirections,
    scalarPoolDirections: item.scalarPoolDirections,
    directionalPrefixPoolDirections: item.directionalPrefixPoolDirections,
    exactPoolDirections: item.exactPoolDirections,
    ...(item.strictlyDominatedPoolDirections === undefined
      ? {}
      : { strictlyDominatedPoolDirections: item.strictlyDominatedPoolDirections }),
    networkRounds: item.networkRounds,
    scheduledPoolExpansions: item.scheduledPoolExpansions,
    materializedClTicks: item.materializedClTicks,
  }

  if (item.mode === 'off' && item.status === 'off') {
    if (
      item.upperBoundWei !== null ||
      item.gapWei !== null ||
      item.gapBps !== null ||
      item.unavailableReason !== undefined ||
      item.acceptance !== undefined ||
      item.fallbackReason !== undefined
    ) return null
    return {
      ...common,
      mode: item.mode,
      status: item.status,
      lowerBoundWei: item.lowerBoundWei,
      upperBoundWei: null,
      gapWei: null,
      gapBps: null,
    }
  }

  if (mode === 'shadow') {
    if (item.acceptance !== undefined || item.fallbackReason !== undefined) return null
  } else if (mode === 'active') {
    if ((acceptance === null) === (fallbackReason === null)) return null
  } else {
    return null
  }

  if (item.status === 'unavailable') {
    if (
      item.upperBoundWei !== null ||
      item.gapWei !== null ||
      item.gapBps !== null ||
      !isObservationUnavailableReason(item.unavailableReason) ||
      (mode === 'active' && fallbackReason === null)
    ) return null
    if (mode === 'active') {
      return {
        ...common,
        mode,
        status: item.status,
        lowerBoundWei: item.lowerBoundWei,
        upperBoundWei: null,
        gapWei: null,
        gapBps: null,
        unavailableReason: item.unavailableReason,
        fallbackReason: fallbackReason!,
      }
    }
    return {
      ...common,
      mode,
      status: item.status,
      lowerBoundWei: item.lowerBoundWei,
      upperBoundWei: null,
      gapWei: null,
      gapBps: null,
      unavailableReason: item.unavailableReason,
    }
  }

  if (
    (item.status !== 'bounded_gap' && item.status !== 'closed') ||
    !isUnsignedDecimal(item.lowerBoundWei) ||
    !isUnsignedDecimal(item.upperBoundWei) ||
    !isUnsignedDecimal(item.gapWei) ||
    (item.gapBps !== null && !isUnsignedDecimal(item.gapBps)) ||
    item.unavailableReason !== undefined
  ) return null

  const lowerBound = BigInt(item.lowerBoundWei)
  const upperBound = BigInt(item.upperBoundWei)
  const gap = BigInt(item.gapWei)
  if (
    upperBound < lowerBound ||
    gap !== upperBound - lowerBound ||
    (item.status === 'closed') !== (gap === 0n)
  ) return null
  if (lowerBound === 0n) {
    if (item.gapBps !== null) return null
  } else {
    const expectedGapBps = ((gap * 10_000n + lowerBound - 1n) / lowerBound).toString()
    if (item.gapBps !== expectedGapBps) return null
  }

  if (mode === 'active') {
    return acceptance !== null
      ? {
          ...common,
          mode,
          status: item.status,
          lowerBoundWei: item.lowerBoundWei,
          upperBoundWei: item.upperBoundWei,
          gapWei: item.gapWei,
          gapBps: item.gapBps,
          acceptance,
        }
      : {
          ...common,
          mode,
          status: item.status,
          lowerBoundWei: item.lowerBoundWei,
          upperBoundWei: item.upperBoundWei,
          gapWei: item.gapWei,
          gapBps: item.gapBps,
          fallbackReason: fallbackReason!,
        }
  }
  return {
    ...common,
    mode,
    status: item.status,
    lowerBoundWei: item.lowerBoundWei,
    upperBoundWei: item.upperBoundWei,
    gapWei: item.gapWei,
    gapBps: item.gapBps,
  }
}

const parseCatalogFences = (value: unknown): SolverCatalogFences | null | undefined => {
  if (value === null) return null
  const fences = asRecord(value)
  const v23 = asRecord(fences?.v23)
  if (
    !fences ||
    !v23 ||
    !isUnsignedDecimal(v23.seq) ||
    !isUnsignedDecimal(v23.generation)
  ) return undefined

  let v4: SolverCatalogFences['v4']
  if (fences.v4 === null) {
    v4 = null
  } else {
    const candidate = asRecord(fences.v4)
    if (!candidate || !isUnsignedInteger(candidate.block) || !isHash(candidate.generation)) {
      return undefined
    }
    v4 = {
      block: candidate.block,
      generation: candidate.generation.toLowerCase() as Hex,
    }
  }
  return { v23: { seq: v23.seq, generation: v23.generation }, v4 }
}

const isRouteUniverseFallbackReason = (
  value: unknown,
): value is SolverRouteUniverseFallbackReason =>
  value === 'transport' ||
  value === 'conflict' ||
  value === 'capacity' ||
  value === 'invalid_response'

/** Strictly validate the certificate/no-route boundary. Source-specific
 * invariants keep shadow selection, fallback, and shortlist truncation from
 * silently widening the materialized proof domain. */
const parseRouteUniverse = (
  value: unknown,
  expectedChainId: number,
  expectedBlock?: number,
): SolverRouteUniverse | null => {
  const item = asRecord(value)
  const canonicalBlock = asRecord(item?.canonicalBlock)
  if (
    !item ||
    item.version !== 1 ||
    item.chainId !== expectedChainId ||
    !canonicalBlock ||
    !isUnsignedInteger(canonicalBlock.number) ||
    (expectedBlock !== undefined && canonicalBlock.number !== expectedBlock) ||
    !isHash(canonicalBlock.hash) ||
    (item.scope !== 'profile' && item.scope !== 'common_neighbor_two_hop') ||
    (item.selectionScope !== 'profile' && item.selectionScope !== 'common_neighbor_two_hop') ||
    !isUnsignedInteger(item.protocolMask) ||
    item.protocolMask > 0xff ||
    !isUnsignedInteger(item.eligibleCount) ||
    !isUnsignedInteger(item.connectorCount) ||
    item.connectorCount > item.eligibleCount ||
    typeof item.shortlistTruncated !== 'boolean' ||
    !isHash(item.fingerprint)
  ) return null

  const adjacencyFences = parseCatalogFences(item.adjacencyFences)
  const topologyFences = parseCatalogFences(item.topologyFences)
  if (adjacencyFences === undefined || topologyFences === undefined) return null

  const commonNoFallback =
    item.fallbackStage === null && item.fallbackReason === null
  const fallback =
    item.fallbackStage === 'adjacency' && isRouteUniverseFallbackReason(item.fallbackReason)
  const emptySelection =
    item.protocolMask === 0 && item.eligibleCount === 0 && item.connectorCount === 0
  const selected = item.protocolMask > 0 && adjacencyFences !== null
  switch (item.source) {
    case 'profile_only':
      if (
        !commonNoFallback || item.scope !== 'profile' || item.selectionScope !== 'profile' ||
        !emptySelection || item.shortlistTruncated || adjacencyFences !== null
      ) return null
      break
    case 'adjacency_complete':
      if (
        !commonNoFallback || item.scope !== 'common_neighbor_two_hop' ||
        item.selectionScope !== 'common_neighbor_two_hop' || !selected
      ) return null
      break
    case 'adjacency_fallback':
      if (
        !fallback || item.scope !== 'profile' || item.selectionScope !== 'profile' ||
        !emptySelection || !item.shortlistTruncated || adjacencyFences !== null
      ) return null
      break
    case 'adjacency_shadow':
      if (
        !commonNoFallback || item.scope !== 'profile' ||
        item.selectionScope !== 'common_neighbor_two_hop' || !selected
      ) return null
      break
    case 'adjacency_shadow_fallback':
      if (
        !fallback || item.scope !== 'profile' ||
        item.selectionScope !== 'common_neighbor_two_hop' || !emptySelection ||
        !item.shortlistTruncated || adjacencyFences !== null
      ) return null
      break
    default:
      return null
  }

  return {
    version: 1,
    chainId: expectedChainId,
    canonicalBlock: {
      number: canonicalBlock.number,
      hash: canonicalBlock.hash.toLowerCase() as Hex,
    },
    source: item.source,
    fallbackStage: item.fallbackStage === 'adjacency' ? 'adjacency' : null,
    fallbackReason: isRouteUniverseFallbackReason(item.fallbackReason)
      ? item.fallbackReason
      : null,
    scope: item.scope,
    selectionScope: item.selectionScope,
    protocolMask: item.protocolMask,
    eligibleCount: item.eligibleCount,
    connectorCount: item.connectorCount,
    shortlistTruncated: item.shortlistTruncated,
    fingerprint: item.fingerprint.toLowerCase() as Hex,
    adjacencyFences,
    topologyFences,
  }
}

const parseNoRouteMetadata = (body: Record<string, unknown>): SolverNoRouteMetadata | null => {
  if (
    body.schemaVersion !== 1 ||
    body.code !== 'no_route' ||
    body.chain !== CHAIN.key ||
    body.chainId !== CHAIN_ID ||
    body.requestedChainId !== CHAIN_ID ||
    typeof body.error !== 'string'
  ) return null
  const routeUniverse = parseRouteUniverse(body.routeUniverse, CHAIN_ID)
  if (!routeUniverse) return null

  const parsedObservation = parseObservationDiagnostics(body.observation)
  // A no-route result has no executable incumbent. Optional diagnostics that
  // claim one are dropped without discarding the versioned base response.
  const observation = parsedObservation?.lowerBoundWei === null ? parsedObservation : null
  return {
    schemaVersion: 1,
    chain: CHAIN.key,
    chainId: CHAIN_ID,
    requestedChainId: CHAIN_ID,
    routeUniverse,
    ...(observation ? { observation } : {}),
  }
}

/** Convert an HTTP status/body pair without requiring a live `fetch`, so both
 * UI callers and tests retain identical error semantics. */
export function parseSolverQuoteError(status: number, body: unknown): SolverQuoteError {
  const record = asRecord(body)
  const message = record && typeof record.error === 'string'
    ? record.error
    : `solver HTTP ${status}`
  const noRoute = status === 422 && record ? parseNoRouteMetadata(record) : null
  return new SolverQuoteError(message, status, noRoute)
}

// Like the route map: the certificate decorates a transaction that is already
// valid, so a malformed payload degrades to "no badge", never to an error.
const parseCertificate = (
  value: unknown,
  routeUniverse: SolverRouteUniverse | null,
): SolverCertificate | null => {
  const record = asRecord(value)
  if (
    !routeUniverse ||
    !record ||
    record.scope !== 'materialized_route_universe' ||
    typeof record.status !== 'string'
  ) return null
  const gap = typeof record.gapBps === 'string' ? Number(record.gapBps) : NaN
  return {
    scope: 'materialized_route_universe',
    status: record.status,
    gapBps: Number.isFinite(gap) && gap >= 0 ? gap : null,
    unroutedPools: isUnsignedInteger(record.unroutedPools) ? record.unroutedPools : null,
    scannedPools: isUnsignedInteger(record.scannedPools) ? record.scannedPools : null,
  }
}

/** Normalize one successful response against the production wire contract.
 *  New solver fields stay optional until that server version is deployed. */
export function parseSolverQuoteResponse(parsedBody: unknown): SolverQuote {
  const chainId = requireActiveChain(parsedBody)
  const body = parsedBody as WireQuote
  const execution = parseExecutionBinding(body)
  const routeUniverse = parseRouteUniverse(body.routeUniverse, chainId, body.block)
  const certificate = parseCertificate(body.certificate, routeUniverse)
  const parsedObservation = parseObservationDiagnostics(body.observation)
  // A successful quote always carries an exact executable plan.
  const observation = parsedObservation?.lowerBoundWei === body.amountOutGross
    ? parsedObservation
    : null
  return {
    chainId,
    block: body.block,
    settler: execution.settler,
    stateBlockNumber: body.stateBlockNumber,
    stateBlockHash: body.stateBlockHash as Hex | undefined,
    indexGeneration: body.indexGeneration,
    catalogTopologyEpoch: body.catalogTopologyEpoch,
    catalogIntegrityEpoch: body.catalogIntegrityEpoch,
    catalogIndexedBlock: body.catalogIndexedBlock,
    catalogIndexedBlockHash: body.catalogIndexedBlockHash as Hex | undefined,
    topologyFingerprint: body.topologyFingerprint as Hex | undefined,
    topologyTruncated: body.topologyTruncated,
    searchComplete: body.searchComplete,
    truncatedTiers: body.truncatedTiers,
    evaluationByTier: body.evaluationByTier,
    candidateCoverageByHop: body.candidateCoverageByHop,
    optimality: body.optimality,
    ...(observation ? { observation } : {}),
    ...(routeUniverse ? { routeUniverse } : {}),
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
      amountIn: safeBig(leg.amountIn),
      amountOut: safeBig(leg.amountOut),
      hops: leg.hops.map(({
        protocol, pool, tokenIn, tokenOut, feePpm, feeBps,
        extension, poolType, feeX64, tickSpacing,
      }) => ({
        protocol,
        pool: lowerHex(pool),
        tokenIn: lowerHex(tokenIn),
        tokenOut: lowerHex(tokenOut),
        feePpm,
        feeBps,
        extension,
        poolType,
        feeX64,
        tickSpacing,
      })),
    })),
    tx: body.tx
      ? {
          ...(body.tx.requiredFrom ? { requiredFrom: getAddress(body.tx.requiredFrom) } : {}),
          to: getAddress(body.tx.to),
          value: BigInt(body.tx.value),
          data: body.tx.data as Hex,
        }
      : null,
    allowanceTarget: execution.allowanceTarget,
    ...(certificate ? { certificate } : {}),
  }
}

// The route breakdown is a PICTURE of a transaction that is already valid.
// Everything it needs is optional in the strict sense — an older solver, or one
// mid-rollout, may not send it — so these two never throw: a missing field
// degrades that corner of the map, it does not cost the user their quote.
const lowerHex = (value: unknown): string => (typeof value === 'string' ? value.toLowerCase() : '')
const safeBig = (value: unknown): bigint => {
  try {
    return BigInt(value as string)
  } catch {
    return 0n
  }
}

// A cold three-hop topology miss probes up to ten unique token pairs. Leave
// enough client-side margin for public-RPC jitter; the server retains its
// separate 120s hard ceiling.
const SOLVER_TIMEOUT_MS = 20_000

/** A quote is executable chain state, not portable API data. Reject missing,
 * malformed, and cross-chain identities before any route or transaction field
 * is parsed or allowed into ranking. */
function requireActiveChain(body: unknown): number {
  const chainId = asRecord(body)?.chainId
  if (!isUnsignedInteger(chainId)) {
    throw new SolverQuoteError('solver response has an invalid chainId', 502)
  }
  if (chainId !== CHAIN_ID) {
    throw new SolverQuoteError(
      `solver chain mismatch: expected ${CHAIN_ID}, received ${chainId}`,
      502,
    )
  }
  return chainId
}

function requireRequestEcho(
  body: unknown,
  args: {
    tokenIn: Address
    tokenOut: Address
    amountIn: bigint
    slippageBps: number
    recipient?: Address
    sender?: Address
    feeBps?: number
  },
): void {
  const record = asRecord(body)
  const tokenIn = typeof record?.tokenIn === 'string' ? record.tokenIn.toLowerCase() : ''
  const tokenOut = typeof record?.tokenOut === 'string' ? record.tokenOut.toLowerCase() : ''
  const amountIn = typeof record?.amountIn === 'string' ? record.amountIn : ''
  const recipient = typeof record?.recipient === 'string' ? record.recipient.toLowerCase() : record?.recipient
  const sender = typeof record?.sender === 'string' ? record.sender.toLowerCase() : record?.sender
  const expectedRecipient = args.recipient?.toLowerCase() ?? null
  const expectedSender = args.sender?.toLowerCase() ?? null
  if (
    tokenIn !== args.tokenIn.toLowerCase() ||
    tokenOut !== args.tokenOut.toLowerCase() ||
    amountIn !== args.amountIn.toString() ||
    record?.slippageBps !== args.slippageBps ||
    record?.deadlineSeconds !== SOLVER_DEADLINE_SECONDS ||
    record?.requestedFeeBps !== (args.feeBps ?? null) ||
    recipient !== expectedRecipient ||
    sender !== expectedSender
  ) {
    throw new SolverQuoteError('solver response does not match the quote request', 502)
  }

  const feeBps = record?.feeBps
  const amountOutGross = record?.amountOutGross
  const amountOutNet = record?.amountOutNet
  const minAmountOutNet = record?.minAmountOutNet
  if (
    !isUnsignedInteger(feeBps) ||
    feeBps > 1_000 ||
    (args.feeBps !== undefined && feeBps !== args.feeBps) ||
    !isUnsignedDecimal(amountOutGross) ||
    !isUnsignedDecimal(amountOutNet) ||
    !isUnsignedDecimal(minAmountOutNet)
  ) {
    throw new SolverQuoteError('solver response has inconsistent output bounds', 502)
  }

  const gross = BigInt(amountOutGross)
  const fee = BigInt(feeBps)
  const netAfterFee = (amount: bigint): bigint => amount - (amount * fee) / 10_000n
  const expectedNet = netAfterFee(gross)
  const grossMinimum = (gross * BigInt(10_000 - args.slippageBps)) / 10_000n
  const expectedMinimum = netAfterFee(grossMinimum)
  if (BigInt(amountOutNet) !== expectedNet || BigInt(minAmountOutNet) !== expectedMinimum) {
    throw new SolverQuoteError('solver response has inconsistent output bounds', 502)
  }

  const tx = asRecord(record.tx)
  if (args.recipient) {
    const expectedFrom = (args.sender ?? args.recipient).toLowerCase()
    const requiredFrom = typeof tx?.requiredFrom === 'string' ? tx.requiredFrom.toLowerCase() : ''
    if (requiredFrom !== expectedFrom) {
      throw new SolverQuoteError('solver response is bound to a different sender', 502)
    }
  } else if (record?.tx !== null && record?.tx !== undefined) {
    throw new SolverQuoteError('display-only solver response carried a transaction', 502)
  }
}

const SOLVER_DEADLINE_SECONDS = 600

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
  if (
    !isUnsignedInteger(args.slippageBps) ||
    args.slippageBps >= 10_000 ||
    (args.feeBps !== undefined && (!isUnsignedInteger(args.feeBps) || args.feeBps > 100))
  ) {
    throw new SolverQuoteError('solver quote request has invalid bps', 400)
  }
  if (!FEATURES.solver || !ENV.solverUrl) {
    throw new SolverQuoteError(`solver is unavailable for chain ${CHAIN_ID}`, 503)
  }
  const res = await fetch(`${ENV.solverUrl}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(SOLVER_TIMEOUT_MS),
    body: JSON.stringify({
      chainId: CHAIN_ID,
      tokenIn: args.tokenIn,
      tokenOut: args.tokenOut,
      amountIn: args.amountIn.toString(),
      slippageBps: args.slippageBps,
      deadlineSeconds: SOLVER_DEADLINE_SECONDS,
      ...(args.recipient ? { recipient: args.recipient } : {}),
      ...(args.sender ? { sender: args.sender } : {}),
      ...(args.feeBps !== undefined ? { feeBps: args.feeBps } : {}),
    }),
  })
  let parsedBody: unknown
  try {
    parsedBody = await res.json()
  } catch (error) {
    if (!res.ok) throw new SolverQuoteError(`solver HTTP ${res.status}`, res.status)
    throw error
  }
  requireActiveChain(parsedBody)
  if (!res.ok) throw parseSolverQuoteError(res.status, parsedBody)
  requireRequestEcho(parsedBody, args)
  return parseSolverQuoteResponse(parsedBody)
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
  pancakev2: 'PANCAKE V2',
  pancakev3: 'PANCAKE V3',
  swaphoodv3: 'SWAPHOOD V3',
  gigadexv3: 'GIGADEX CL',
  sushiv3: 'SUSHI V3',
  robinswapv3: 'ROBINSWAP V3',
  sheriff: 'SHERIFF',
  ekubov3: 'EKUBO V3',
}

/** display name for a solver hop protocol (falls back to the raw id) */
export function venueLabel(protocol: string): string {
  return VENUES[protocol] ?? protocol.toUpperCase()
}

/** a leg's share for display — sub-0.5% legs read "<1" rather than "0" */
export function legSharePct(shareBps: number): string {
  return shareBps < 50 ? '<1' : String(Math.round(shareBps / 100))
}

/** compact route summary: "68% UNI V3 + 23% UNI V4 + 9% UP33 CL→UNI V3".
 *  An escalated quote can carry twenty-odd sliver legs; past five legs the
 *  tail compresses into one term — "+ 4% ×18" — so the line stays a line
 *  while every share stays counted. */
export function solverRouteLabel(quote: SolverQuote): string {
  const legs = [...quote.route].sort((a, b) => b.shareBps - a.shareBps)
  const term = (leg: SolverLeg) =>
    `${legSharePct(leg.shareBps)}% ${leg.hops.map((hop) => venueLabel(hop.protocol)).join('→')}`
  if (legs.length <= 5) return legs.map(term).join(' + ')
  const tail = legs.slice(3)
  const tailShare = tail.reduce((sum, leg) => sum + leg.shareBps, 0)
  return [...legs.slice(0, 3).map(term), `${legSharePct(tailShare)}% ×${tail.length}`].join(' + ')
}

/** Gap ceiling under which the badge makes a PROVEN claim with the number on
 *  it. A looser bound is still mathematically valid, but the number reads as
 *  an indictment of the route when it actually measures the certificate
 *  search stalling — so past this line the chip goes neutral and numberless. */
export const PROVEN_GAP_MAX_BPS = 10

export type SolverCertificateDisplay =
  | { kind: 'proven'; gapBpsLabel: string; scannedPools: number | null }
  | { kind: 'certified'; scannedPools: number | null }

/** What the UI may say about a quote's certificate: a PROVEN ≤x bp claim, a
 *  neutral certified chip, or (null) nothing at all. */
export function certificateDisplay(quote: SolverQuote): SolverCertificateDisplay | null {
  const cert = quote.certificate
  if (!cert || cert.status !== 'certified') return null
  if (cert.gapBps === null || cert.gapBps > PROVEN_GAP_MAX_BPS) {
    return { kind: 'certified', scannedPools: cert.scannedPools }
  }
  // rounded UP: the badge must never claim tighter than the certificate does
  const shown = Math.max(0.01, Math.ceil(cert.gapBps * 100) / 100)
  return { kind: 'proven', gapBpsLabel: shown.toFixed(2), scannedPools: cert.scannedPools }
}
