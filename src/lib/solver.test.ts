import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { encodeFunctionData, parseAbi } from 'viem'
import { CHAIN_ID, NATIVE } from '../config/addresses'
import { CHAIN } from '../config/chains'
import { en } from '../i18n/en'
import { zh } from '../i18n/zh'

const testEnv = { solverUrl: 'https://solver.test' }
const testFeatures = { solver: true }
mock.module('../config/env', {
  namedExports: { ENV: testEnv },
})
mock.module('../config/features', {
  namedExports: { FEATURES: testFeatures },
})

const {
  SolverQuoteError,
  certificateDisplay,
  fetchSolverQuote,
  parseSolverQuoteError,
  parseSolverQuoteResponse,
} = await import('./solver')

const stateBlockHash = `0x${'11'.repeat(32)}`
const topologyFingerprint = `0x${'22'.repeat(32)}`

const routeUniverse = {
  version: 1,
  chainId: CHAIN_ID,
  canonicalBlock: { number: 123, hash: stateBlockHash },
  source: 'adjacency_complete',
  fallbackStage: null,
  fallbackReason: null,
  scope: 'common_neighbor_two_hop',
  selectionScope: 'common_neighbor_two_hop',
  protocolMask: 0b1_1111,
  eligibleCount: 7,
  connectorCount: 3,
  shortlistTruncated: false,
  fingerprint: topologyFingerprint,
  adjacencyFences: {
    v23: { seq: '17', generation: '3' },
    v4: null,
  },
  topologyFences: {
    v23: { seq: '19', generation: '4' },
    v4: { block: 120, generation: `0x${'33'.repeat(32)}` },
  },
} as const

const completeNoRoute = {
  schemaVersion: 1,
  error: 'no route can absorb this amount',
  code: 'no_route',
  chain: CHAIN.key,
  chainId: CHAIN_ID,
  requestedChainId: CHAIN_ID,
  routeUniverse,
} as const

const boundedObservation = {
  mode: 'shadow',
  status: 'bounded_gap',
  scope: 'supported_enhanced_route_graph',
  objective: 'amount_out_gross',
  lowerBoundWei: '123456789',
  upperBoundWei: '123456814',
  gapWei: '25',
  gapBps: '1',
  certifiedSkeletons: 3,
  certifiedHops: 7,
  candidatePoolDirections: 8,
  scalarPoolDirections: 7,
  directionalPrefixPoolDirections: 0,
  exactPoolDirections: 8,
  networkRounds: 0,
  scheduledPoolExpansions: 0,
  materializedClTicks: 0,
} as const

const activeAcceptedObservation = {
  ...boundedObservation,
  mode: 'active',
  status: 'closed',
  upperBoundWei: boundedObservation.lowerBoundWei,
  gapWei: '0',
  gapBps: '0',
  scalarPoolDirections: 16,
  directionalPrefixPoolDirections: 12,
  exactPoolDirections: 10,
  networkRounds: 2,
  scheduledPoolExpansions: 4,
  materializedClTicks: 23,
  acceptance: 'amount_complete_directional_coverage',
} as const

const activeFallbackObservation = {
  ...boundedObservation,
  mode: 'active',
  fallbackReason: 'depth_budget_exhausted',
} as const

const productionTokenIn = '0x0000000000000000000000000000000000000011'
const productionAmountIn = '500000000000000000'
const productionSettler = '0x0000000000000000000000000000000000000044'
const productionAllowanceTarget = CHAIN.solverAllowanceTarget
if (!productionAllowanceTarget) throw new Error('solver test chain has no AllowanceHolder')
const productionTxData = encodeFunctionData({
  abi: parseAbi([
    'function exec(address operator, address token, uint256 amount, address target, bytes data)',
  ]),
  functionName: 'exec',
  args: [
    productionSettler,
    productionTokenIn,
    BigInt(productionAmountIn),
    productionSettler,
    '0x1234',
  ],
})

const productionQuote = {
  chainId: CHAIN_ID,
  block: 17065553,
  settler: productionSettler,
  tokenIn: productionTokenIn,
  tokenOut: '0x0000000000000000000000000000000000000022',
  amountIn: productionAmountIn,
  amountOutGross: '123456789',
  priceImpactBps: 12,
  midAmountOut: '124000000',
  feeBps: 0,
  amountOutNet: '123456789',
  minAmountOutNet: '122839505',
  deadline: 1_800_000_000,
  route: [{
    shareBps: 10_000,
    amountIn: '500000000000000000',
    amountOut: '123456789',
    hops: [{
      protocol: 'up33cl',
      pool: '0x0000000000000000000000000000000000000011',
      tokenIn: '0x0000000000000000000000000000000000000022',
      tokenOut: '0x0000000000000000000000000000000000000033',
      feePpm: 10_000,
    }],
  }],
  tx: {
    to: productionAllowanceTarget,
    value: '0',
    data: productionTxData,
  },
  allowanceTarget: productionAllowanceTarget,
} as const

const productionRouteUniverse = {
  version: 1,
  chainId: CHAIN_ID,
  canonicalBlock: { number: productionQuote.block, hash: stateBlockHash },
  source: 'profile_only',
  fallbackStage: null,
  fallbackReason: null,
  scope: 'profile',
  selectionScope: 'profile',
  protocolMask: 0,
  eligibleCount: 0,
  connectorCount: 0,
  shortlistTruncated: false,
  fingerprint: topologyFingerprint,
  adjacencyFences: null,
  topologyFences: null,
} as const

const scopedProductionQuote = {
  ...productionQuote,
  routeUniverse: productionRouteUniverse,
} as const

const netAfterFee = (amount: bigint, feeBps: number): bigint =>
  amount - (amount * BigInt(feeBps)) / 10_000n

function responseForRequest(
  request: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const slippageBps = request.slippageBps as number
  const requestedFeeBps = typeof request.feeBps === 'number' ? request.feeBps : null
  const feeBps = requestedFeeBps ?? productionQuote.feeBps
  const gross = BigInt(productionQuote.amountOutGross)
  const grossMinimum = (gross * BigInt(10_000 - slippageBps)) / 10_000n
  const recipient = typeof request.recipient === 'string' ? request.recipient : null
  const sender = typeof request.sender === 'string' ? request.sender : null
  const tokenIn = request.tokenIn as `0x${string}`
  const requestAmountIn = BigInt(request.amountIn as string)
  const boundTx = {
    ...productionQuote.tx,
    data: encodeFunctionData({
      abi: parseAbi([
        'function exec(address operator, address token, uint256 amount, address target, bytes data)',
      ]),
      functionName: 'exec',
      args: [productionSettler, tokenIn, requestAmountIn, productionSettler, '0x1234'],
    }),
  }
  return {
    ...productionQuote,
    tokenIn: request.tokenIn,
    tokenOut: request.tokenOut,
    amountIn: request.amountIn,
    slippageBps,
    deadlineSeconds: request.deadlineSeconds,
    requestedFeeBps,
    recipient,
    sender,
    feeBps,
    amountOutNet: netAfterFee(gross, feeBps).toString(),
    minAmountOutNet: netAfterFee(grossMinimum, feeBps).toString(),
    tx: recipient
      ? { ...boundTx, requiredFrom: sender ?? recipient }
      : null,
    ...overrides,
  }
}

test('parses the current production quote shape without future solver fields', () => {
  const quote = parseSolverQuoteResponse(productionQuote)
  assert.equal(quote.chainId, CHAIN_ID)
  assert.equal(quote.settler, productionSettler)
  assert.equal(quote.tx?.requiredFrom, undefined)
  assert.equal(quote.tx?.to, productionQuote.tx.to)
  assert.equal(quote.amountOutNet, 123456789n)
  assert.equal(quote.stateBlockNumber, undefined)
  assert.equal(quote.route[0]?.hops[0]?.pool, productionQuote.route[0].hops[0].pool)
  assert.equal('observation' in quote, false)
})

test('allows missing Settler identity only on quote-only responses', () => {
  const { settler: _settler, allowanceTarget: _allowanceTarget, ...withoutSettler } = productionQuote
  const quote = parseSolverQuoteResponse({ ...withoutSettler, tx: null })
  assert.equal(quote.tx, null)
  assert.equal(quote.settler, null)
  assert.equal(quote.allowanceTarget, null)

  assert.throws(
    () => parseSolverQuoteResponse(withoutSettler),
    (error: unknown) =>
      error instanceof SolverQuoteError &&
      error.status === 502 &&
      error.message === 'solver transaction has no Settler binding',
  )
})

test('rejects transaction targets and AllowanceHolder calldata not bound to the Settler', () => {
  assert.throws(
    () => parseSolverQuoteResponse({
      ...productionQuote,
      tx: { ...productionQuote.tx, to: productionSettler },
    }),
    /invalid allowance binding/,
  )

  const otherSettler = '0x0000000000000000000000000000000000000099'
  const wrongBinding = encodeFunctionData({
    abi: parseAbi([
      'function exec(address operator, address token, uint256 amount, address target, bytes data)',
    ]),
    functionName: 'exec',
    args: [
      otherSettler,
      productionTokenIn,
      BigInt(productionAmountIn),
      otherSettler,
      '0x1234',
    ],
  })
  assert.throws(
    () => parseSolverQuoteResponse({
      ...productionQuote,
      tx: { ...productionQuote.tx, data: wrongBinding },
    }),
    /invalid Settler binding/,
  )

  assert.throws(
    () => parseSolverQuoteResponse({
      ...productionQuote,
      tx: { ...productionQuote.tx, value: '1' },
    }),
    /invalid allowance binding/,
  )
})

test('rejects an ERC-20 approval target outside the chain trust anchor', () => {
  const maliciousTarget = '0x0000000000000000000000000000000000000055'
  assert.throws(
    () => parseSolverQuoteResponse({
      ...productionQuote,
      allowanceTarget: maliciousTarget,
      tx: { ...productionQuote.tx, to: maliciousTarget },
    }),
    (error: unknown) =>
      error instanceof SolverQuoteError &&
      error.status === 502 &&
      error.message === 'solver ERC-20 transaction has an untrusted allowance target',
  )
})

test('binds native transactions directly to the Settler without an allowance target', () => {
  const native = parseSolverQuoteResponse({
    ...productionQuote,
    tokenIn: NATIVE,
    allowanceTarget: null,
    tx: {
      ...productionQuote.tx,
      to: productionSettler,
      value: productionAmountIn,
      data: '0x12345678',
    },
  })
  assert.equal(native.settler, productionSettler)
  assert.equal(native.allowanceTarget, null)
  assert.equal(native.tx?.to, productionSettler)

  assert.throws(
    () => parseSolverQuoteResponse({
      ...productionQuote,
      tokenIn: NATIVE,
      allowanceTarget: null,
      tx: {
        ...productionQuote.tx,
        to: productionAllowanceTarget,
        value: productionAmountIn,
      },
    }),
    /invalid Settler binding/,
  )

  assert.throws(
    () => parseSolverQuoteResponse({
      ...productionQuote,
      tokenIn: NATIVE,
      allowanceTarget: null,
      tx: { ...productionQuote.tx, to: productionSettler, value: '0' },
    }),
    /invalid Settler binding/,
  )
})

test('quote requests distinguish display-only browsing from executable selection', async (t) => {
  const bodies: Record<string, unknown>[] = []
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(request)
      return new Response(JSON.stringify(responseForRequest(request)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  )

  const tokenIn = '0x0000000000000000000000000000000000000011'
  const tokenOut = '0x0000000000000000000000000000000000000022'
  const account = '0x0000000000000000000000000000000000000033'
  const base = { tokenIn, tokenOut, amountIn: 1n, slippageBps: 50 } as const

  await fetchSolverQuote(base)
  await fetchSolverQuote({ ...base, recipient: account, sender: account })
  await fetchSolverQuote({ ...base, recipient: account })

  assert.equal('recipient' in bodies[0]!, false)
  assert.equal('sender' in bodies[0]!, false)
  assert.equal(bodies[1]?.recipient, account)
  assert.equal(bodies[1]?.sender, account)
  assert.equal(bodies[2]?.recipient, account)
  assert.equal('sender' in bodies[2]!, false)
  assert.equal(bodies[0]?.chainId, CHAIN_ID)
  assert.equal(bodies[1]?.chainId, CHAIN_ID)
})

test('rejects missing, unsafe, and cross-chain response identities before parsing quotes', () => {
  const { chainId: _chainId, ...missingChain } = productionQuote
  const otherChainId = CHAIN_ID + 1

  assert.throws(
    () => parseSolverQuoteResponse(missingChain),
    (error: unknown) =>
      error instanceof SolverQuoteError &&
      error.status === 502 &&
      error.message === 'solver response has an invalid chainId',
  )
  assert.throws(
    () => parseSolverQuoteResponse({ ...productionQuote, chainId: Number.MAX_SAFE_INTEGER + 1 }),
    /invalid chainId/,
  )
  assert.throws(
    () => parseSolverQuoteResponse({ ...productionQuote, chainId: otherChainId }),
    new RegExp(`expected ${CHAIN_ID}, received ${otherChainId}`),
  )
})

test('rejects a same-chain response substituted from another quote request', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify(responseForRequest(request, {
        tokenOut: '0x0000000000000000000000000000000000000099',
      })), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  )

  await assert.rejects(
    fetchSolverQuote({
      tokenIn: productionQuote.tokenIn,
      tokenOut: productionQuote.tokenOut,
      amountIn: 1n,
      slippageBps: 50,
    }),
    (error: unknown) =>
      error instanceof SolverQuoteError &&
      error.status === 502 &&
      error.message === 'solver response does not match the quote request',
  )
})

test('binds successful responses to execution semantics and exact output floors', async (t) => {
  const account = '0x0000000000000000000000000000000000000033'
  const other = '0x0000000000000000000000000000000000000099'
  const args = {
    tokenIn: productionQuote.tokenIn,
    tokenOut: productionQuote.tokenOut,
    amountIn: 1n,
    slippageBps: 75,
    feeBps: 25,
    recipient: account,
    sender: account,
  } as const
  let overrides: Record<string, unknown> = {}
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify(responseForRequest(request, overrides)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  )

  const accepted = await fetchSolverQuote(args)
  assert.equal(accepted.feeBps, args.feeBps)

  const mismatches: Record<string, unknown>[] = [
    { slippageBps: args.slippageBps + 1 },
    { deadlineSeconds: 601 },
    { requestedFeeBps: args.feeBps + 1 },
    { recipient: other },
    { sender: other },
    { tx: { ...productionQuote.tx, requiredFrom: other } },
    { feeBps: args.feeBps + 1 },
    { amountOutNet: '0' },
    { minAmountOutNet: '0' },
  ]
  for (const mismatch of mismatches) {
    overrides = mismatch
    await assert.rejects(
      fetchSolverQuote(args),
      (error: unknown) => error instanceof SolverQuoteError && error.status === 502,
    )
  }
})

test('display-only quote rejects a transaction-bearing response', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify(responseForRequest(request, {
        tx: productionQuote.tx,
      })), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  )

  await assert.rejects(
    fetchSolverQuote({
      tokenIn: productionQuote.tokenIn,
      tokenOut: productionQuote.tokenOut,
      amountIn: 1n,
      slippageBps: 50,
    }),
    (error: unknown) =>
      error instanceof SolverQuoteError &&
      error.status === 502 &&
      error.message === 'display-only solver response carried a transaction',
  )
})

test('fee override above the server ceiling fails before fetch', async (t) => {
  let fetchCalls = 0
  t.mock.method(globalThis, 'fetch', async (): Promise<Response> => {
    fetchCalls += 1
    throw new Error('fetch must not be called')
  })

  await assert.rejects(
    fetchSolverQuote({
      tokenIn: productionQuote.tokenIn,
      tokenOut: productionQuote.tokenOut,
      amountIn: 1n,
      slippageBps: 50,
      feeBps: 101,
    }),
    (error: unknown) => error instanceof SolverQuoteError && error.status === 400,
  )
  assert.equal(fetchCalls, 0)
})

test('an empty solver URL fails closed without issuing a same-origin request', async (t) => {
  let fetchCalls = 0
  t.mock.method(globalThis, 'fetch', async (): Promise<Response> => {
    fetchCalls += 1
    throw new Error('fetch must not be called')
  })
  const configuredUrl = testEnv.solverUrl
  testEnv.solverUrl = ''
  try {
    await assert.rejects(
      fetchSolverQuote({
        tokenIn: '0x0000000000000000000000000000000000000011',
        tokenOut: '0x0000000000000000000000000000000000000022',
        amountIn: 1n,
        slippageBps: 50,
      }),
      (error: unknown) =>
        error instanceof SolverQuoteError &&
        error.status === 503 &&
        error.message.includes(`chain ${CHAIN_ID}`),
    )
    assert.equal(fetchCalls, 0)
  } finally {
    testEnv.solverUrl = configuredUrl
  }
})

test('a chain-disabled solver fails closed even when an override URL is present', async (t) => {
  let fetchCalls = 0
  t.mock.method(globalThis, 'fetch', async (): Promise<Response> => {
    fetchCalls += 1
    throw new Error('fetch must not be called')
  })
  testFeatures.solver = false
  try {
    await assert.rejects(
      fetchSolverQuote({
        tokenIn: productionQuote.tokenIn,
        tokenOut: productionQuote.tokenOut,
        amountIn: 1n,
        slippageBps: 50,
      }),
      (error: unknown) => error instanceof SolverQuoteError && error.status === 503,
    )
    assert.equal(fetchCalls, 0)
  } finally {
    testFeatures.solver = true
  }
})

test('parses validated shadow observation evidence on successful quotes', () => {
  const quote = parseSolverQuoteResponse({
    ...productionQuote,
    observation: boundedObservation,
  })

  assert.deepEqual(quote.observation, boundedObservation)
})

test('parses active acceptance and fallback evidence atomically', () => {
  const accepted = parseSolverQuoteResponse({
    ...productionQuote,
    observation: activeAcceptedObservation,
  })
  const fallback = parseSolverQuoteResponse({
    ...productionQuote,
    observation: activeFallbackObservation,
  })

  assert.deepEqual(accepted.observation, activeAcceptedObservation)
  assert.deepEqual(fallback.observation, activeFallbackObservation)
})

test('rejects active evidence without exactly one terminal reason', () => {
  const missing = parseSolverQuoteResponse({
    ...productionQuote,
    observation: {
      ...activeAcceptedObservation,
      acceptance: undefined,
    },
  })
  const conflicting = parseSolverQuoteResponse({
    ...productionQuote,
    observation: {
      ...activeAcceptedObservation,
      fallbackReason: 'round_budget_exhausted',
    },
  })
  const unavailableAccepted = parseSolverQuoteResponse({
    ...productionQuote,
    observation: {
      ...activeAcceptedObservation,
      status: 'unavailable',
      upperBoundWei: null,
      gapWei: null,
      gapBps: null,
      unavailableReason: 'dynamic_fee',
    },
  })

  assert.equal('observation' in missing, false)
  assert.equal('observation' in conflicting, false)
  assert.equal('observation' in unavailableAccepted, false)
})

test('structured 422 parses the versioned Rust no-route fixture', () => {
  const error = parseSolverQuoteError(422, completeNoRoute)
  const { error: _message, code: _code, ...metadata } = completeNoRoute

  assert.ok(error instanceof Error)
  assert.ok(error instanceof SolverQuoteError)
  assert.equal(error.name, 'SolverQuoteError')
  assert.equal(error.message, completeNoRoute.error)
  assert.equal(error.status, 422)
  assert.deepEqual(error.noRoute, metadata)
})

test('structured 422 preserves an explicitly truncated static fallback scope', () => {
  const body = {
    ...completeNoRoute,
    routeUniverse: {
      ...routeUniverse,
      source: 'adjacency_fallback',
      fallbackStage: 'adjacency',
      fallbackReason: 'transport',
      scope: 'profile',
      selectionScope: 'profile',
      protocolMask: 0,
      eligibleCount: 0,
      connectorCount: 0,
      shortlistTruncated: true,
      adjacencyFences: null,
    },
  } as const
  const error = parseSolverQuoteError(422, body)

  assert.equal(error.status, 422)
  assert.equal(error.noRoute?.routeUniverse.source, 'adjacency_fallback')
  assert.equal(error.noRoute?.routeUniverse.scope, 'profile')
  assert.equal(error.noRoute?.routeUniverse.shortlistTruncated, true)
  assert.equal(error.noRoute?.routeUniverse.fallbackReason, 'transport')
})

test('structured 422 rejects chain, scope, fallback, truncation, and fence mismatches', () => {
  const malformed = [
    { ...completeNoRoute, chainId: 1 },
    { ...completeNoRoute, requestedChainId: 1 },
    { ...completeNoRoute, routeUniverse: { ...routeUniverse, chainId: 1 } },
    {
      ...completeNoRoute,
      routeUniverse: { ...routeUniverse, source: 'adjacency_complete', scope: 'profile' },
    },
    {
      ...completeNoRoute,
      routeUniverse: {
        ...routeUniverse,
        source: 'adjacency_fallback',
        fallbackStage: 'adjacency',
        fallbackReason: 'transport',
        scope: 'profile',
        selectionScope: 'profile',
        protocolMask: 0,
        eligibleCount: 0,
        connectorCount: 0,
        adjacencyFences: null,
        shortlistTruncated: false,
      },
    },
    {
      ...completeNoRoute,
      routeUniverse: {
        ...routeUniverse,
        topologyFences: { ...routeUniverse.topologyFences, v23: { seq: 19, generation: '4' } },
      },
    },
  ]
  for (const body of malformed) assert.equal(parseSolverQuoteError(422, body).noRoute, null)
})

test('structured 422 retains validated shadow observation evidence', () => {
  const error = parseSolverQuoteError(422, {
    ...completeNoRoute,
    observation: {
      ...boundedObservation,
      status: 'unavailable',
      lowerBoundWei: null,
      upperBoundWei: null,
      gapWei: null,
      gapBps: null,
      unavailableReason: 'no_executable_incumbent',
    },
  })

  assert.equal(error.noRoute?.observation?.status, 'unavailable')
  assert.equal(error.noRoute?.observation?.lowerBoundWei, null)
  assert.equal(error.noRoute?.observation?.unavailableReason, 'no_executable_incumbent')

  const rootUnavailable = parseSolverQuoteError(422, {
    ...completeNoRoute,
    observation: {
      ...boundedObservation,
      status: 'unavailable',
      lowerBoundWei: null,
      upperBoundWei: null,
      gapWei: null,
      gapBps: null,
      unavailableReason: 'dynamic_fee',
    },
  })
  assert.equal(rootUnavailable.noRoute?.observation?.unavailableReason, 'dynamic_fee')
})

test('response context rejects observation evidence with an impossible incumbent shape', () => {
  const unavailableSuccess = parseSolverQuoteResponse({
    ...productionQuote,
    observation: {
      ...boundedObservation,
      status: 'unavailable',
      upperBoundWei: null,
      gapWei: null,
      gapBps: null,
      unavailableReason: 'dynamic_fee',
    },
  })
  const success = parseSolverQuoteResponse({
    ...productionQuote,
    observation: {
      ...boundedObservation,
      status: 'unavailable',
      lowerBoundWei: null,
      upperBoundWei: null,
      gapWei: null,
      gapBps: null,
      unavailableReason: 'no_executable_incumbent',
    },
  })
  const noRoute = parseSolverQuoteError(422, {
    ...completeNoRoute,
    observation: boundedObservation,
  })
  const mismatchedSuccess = parseSolverQuoteResponse({
    ...productionQuote,
    observation: {
      ...boundedObservation,
      status: 'closed',
      lowerBoundWei: '1',
      upperBoundWei: '1',
      gapWei: '0',
      gapBps: '0',
    },
  })

  assert.equal(unavailableSuccess.observation?.lowerBoundWei, boundedObservation.lowerBoundWei)
  assert.equal(unavailableSuccess.observation?.unavailableReason, 'dynamic_fee')
  assert.equal('observation' in success, false)
  assert.ok(noRoute.noRoute)
  assert.equal('observation' in noRoute.noRoute, false)
  assert.equal('observation' in mismatchedSuccess, false)
})

test('malformed optional observation evidence never discards valid quote or no-route metadata', () => {
  const malformedObservation = {
    ...boundedObservation,
    gapWei: '24',
  }
  const quote = parseSolverQuoteResponse({
    ...productionQuote,
    observation: malformedObservation,
  })
  const error = parseSolverQuoteError(422, {
    ...completeNoRoute,
    observation: malformedObservation,
  })

  assert.equal('observation' in quote, false)
  assert.ok(error.noRoute)
  assert.equal('observation' in error.noRoute, false)
  assert.equal(error.noRoute.routeUniverse.canonicalBlock.number, 123)
  assert.equal(error.noRoute.routeUniverse.fingerprint, topologyFingerprint)
})

test('observation work accounting is required and unsigned', () => {
  const missingScheduled = { ...boundedObservation } as Record<string, unknown>
  delete missingScheduled.scheduledPoolExpansions
  const missing = parseSolverQuoteResponse({
    ...productionQuote,
    observation: missingScheduled,
  })
  const negative = parseSolverQuoteResponse({
    ...productionQuote,
    observation: {
      ...boundedObservation,
      materializedClTicks: -1,
    },
  })

  assert.equal('observation' in missing, false)
  assert.equal('observation' in negative, false)
})

test('unknown observation reason is omitted without widening the low-cardinality contract', () => {
  const error = parseSolverQuoteError(422, {
    ...completeNoRoute,
    observation: {
      ...boundedObservation,
      status: 'unavailable',
      lowerBoundWei: null,
      upperBoundWei: null,
      gapWei: null,
      gapBps: null,
      unavailableReason: 'future_unbounded_reason',
    },
  })

  assert.ok(error.noRoute)
  assert.equal('observation' in error.noRoute, false)
  assert.equal(error.noRoute.routeUniverse.source, 'adjacency_complete')
})

test('successful and 422 fixtures share one route-universe wire shape', () => {
  const quote = parseSolverQuoteResponse(scopedProductionQuote)
  const error = parseSolverQuoteError(422, {
    ...completeNoRoute,
    routeUniverse: productionRouteUniverse,
  })

  assert.ok(quote.routeUniverse)
  assert.ok(error.noRoute)
  assert.deepEqual(error.noRoute.routeUniverse, quote.routeUniverse)
})

test('non-422 failures remain typed Errors and retain their HTTP status', () => {
  const upstream = parseSolverQuoteError(502, { error: 'upstream rpc failed: eth_call' })
  assert.ok(upstream instanceof SolverQuoteError)
  assert.equal(upstream.message, 'upstream rpc failed: eth_call')
  assert.equal(upstream.status, 502)
  assert.equal(upstream.noRoute, null)

  const unavailable = parseSolverQuoteError(503, null)
  assert.equal(unavailable.message, 'solver HTTP 503')
  assert.equal(unavailable.status, 503)
  assert.equal(unavailable.noRoute, null)
})

test('parses the certificate and tiers its display', () => {
  const certified = parseSolverQuoteResponse({
    ...scopedProductionQuote,
    certificate: {
      mode: 'shadow',
      scope: 'materialized_route_universe',
      status: 'certified',
      gapBps: '0.0025',
      unroutedPools: 9,
      scannedPools: 48,
    },
  })
  assert.deepEqual(certified.certificate, {
    scope: 'materialized_route_universe',
    status: 'certified',
    gapBps: 0.0025,
    unroutedPools: 9,
    scannedPools: 48,
  })
  assert.deepEqual(certificateDisplay(certified), {
    kind: 'proven',
    gapBpsLabel: '0.01',
    scannedPools: 48,
  })

  // the label rounds UP — the badge never claims tighter than the certificate
  const near = certificateDisplay(parseSolverQuoteResponse({
    ...scopedProductionQuote,
    certificate: {
      scope: 'materialized_route_universe',
      status: 'certified',
      gapBps: '2.8639',
      scannedPools: 73,
    },
  }))
  assert.deepEqual(near, { kind: 'proven', gapBpsLabel: '2.87', scannedPools: 73 })

  // loose bounds go neutral and numberless — the number measures the
  // certificate search stalling, not the route
  const loose = certificateDisplay(parseSolverQuoteResponse({
    ...scopedProductionQuote,
    certificate: {
      scope: 'materialized_route_universe',
      status: 'certified',
      gapBps: '119497.5512',
      scannedPools: 54,
    },
  }))
  assert.deepEqual(loose, { kind: 'certified', scannedPools: 54 })

  // an unparseable gap on a certified quote still gets the neutral chip
  const gapless = certificateDisplay(parseSolverQuoteResponse({
    ...scopedProductionQuote,
    certificate: {
      scope: 'materialized_route_universe',
      status: 'certified',
      scannedPools: 12,
    },
  }))
  assert.deepEqual(gapless, { kind: 'certified', scannedPools: 12 })

  // non-certified statuses parse but render nothing
  const unavailable = parseSolverQuoteResponse({
    ...scopedProductionQuote,
    certificate: {
      scope: 'materialized_route_universe',
      status: 'unavailable',
      reason: 'certificate disabled',
    },
  })
  assert.equal(unavailable.certificate?.status, 'unavailable')
  assert.equal(certificateDisplay(unavailable), null)

  // malformed payloads and absence degrade to "no badge", never to an error
  const malformed = parseSolverQuoteResponse({ ...productionQuote, certificate: 'certified' })
  assert.equal(malformed.certificate, undefined)
  assert.equal(certificateDisplay(malformed), null)
  const unscoped = parseSolverQuoteResponse({
    ...productionQuote,
    certificate: {
      scope: 'materialized_route_universe',
      status: 'certified',
      gapBps: '0',
    },
  })
  assert.equal(unscoped.certificate, undefined)
  assert.equal(certificateDisplay(parseSolverQuoteResponse(productionQuote)), null)
})

test('EN/ZH certificate copy limits proof claims to the materialized universe', () => {
  assert.match(en.swap.certProvenTip, /materialized route universe/)
  assert.match(en.swap.certProvenTip, /not covered/)
  assert.doesNotMatch(en.swap.certProvenTip, /every possible route|all \{\{pools\}\} pools/i)
  assert.match(zh.swap.certProvenTip, /已物化路由范围/)
  assert.match(zh.swap.certProvenTip, /不在证明覆盖内/)
  assert.doesNotMatch(zh.swap.certProvenTip, /全部.*池子|任意路由方案/)
})
