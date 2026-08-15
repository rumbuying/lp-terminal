import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeAbiParameters, encodeFunctionData, erc20Abi, pad, toFunctionSelector, toHex, type Address, type Hex, type TransactionReceipt } from 'viem'
import { NATIVE_SENTINEL, PORTAL_ETA_SEC, PORTAL_INBOX, REMOTE_CHAINS, resolveIntent, type BridgeTokenOption } from '../../config/bridge'
import { acrossAppFee, mapAcrossQuote, quoteAcross, type AcrossQuoteJson } from './across'
import { checkPendingTransfer, fmtEtaShort, nextCheckAt, pendingBridges, type PendingTransfer } from './pending'
import { aliasL1Address, childEthDepositTxHash, DEPOSIT_ETH_CALLDATA, parseEthDepositReceipt, quotePortal } from './portal'
import { mapRelayQuote, quoteRelay, relayAppFee, type RelayQuoteJson } from './relay'
import { mergeTokenSupports, providersFor, sameSymbolLoose, type AcrossRouteJson, type RelayChainsJson, type RelayCurrencyV2 } from './tokens'
import { BridgeQuoteError, type BridgeFee } from './types'
import { FEATURES } from '../../config/features'

// The canonical-inbox route model and the token discovery around it are
// written for Robinhood; a build with no bridge has nothing to assert.
const homeChainTest = FEATURES.bridge ? test : test.skip

const ETH_REMOTE = REMOTE_CHAINS[0] // ETHEREUM
const BASE_REMOTE = REMOTE_CHAINS.find((r) => r.label === 'BASE')!

const RH_USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address
const L1_USDG = '0xe343167631d89B6Ffc58B88d6b7fB0228795491D' as Address
const RH_WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address
const L1_WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address
const L1_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address

const USDG_OPTION: BridgeTokenOption = {
  symbol: 'USDG',
  decimals: 6,
  robinhoodToken: RH_USDG,
  remoteToken: L1_USDG,
  providers: ['relay', 'across'],
}
const ETH_OPTION: BridgeTokenOption = {
  symbol: 'ETH',
  decimals: 18,
  robinhoodToken: NATIVE_SENTINEL,
  remoteToken: NATIVE_SENTINEL,
  providers: ['portal', 'relay', 'across'],
}

// fixtures are trimmed live API captures (2026-07-18), shapes verbatim
const RELAY_USDG_OUT: RelayQuoteJson = {
  steps: [
    {
      id: 'approve',
      kind: 'transaction',
      requestId: '0xcfb2f6aa3bbe7a8fedc5a7ab20a87c0d97f39136250a935da21d925e8aeabb34',
      items: [
        {
          data: {
            to: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
            data: '0x095ea7b3',
            value: '0',
            chainId: 4663,
          },
          check: null,
        },
      ],
    },
    {
      id: 'deposit',
      kind: 'transaction',
      requestId: '0xcfb2f6aa3bbe7a8fedc5a7ab20a87c0d97f39136250a935da21d925e8aeabb34',
      items: [
        {
          data: {
            to: '0x4cd00e387622c35bddb9b4c962c136462338bc31',
            data: '0xe8017952',
            value: null,
            chainId: 4663,
          },
          check: { endpoint: '/intents/status?requestId=0xcfb2…' },
        },
      ],
    },
  ],
  details: {
    currencyOut: { amount: '99831382', minimumAmount: '97834754' },
    timeEstimate: 1,
  },
}

const ACROSS_USDG_OUT: AcrossQuoteJson = {
  checks: {
    allowance: {
      token: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
      spender: '0xD29C85F15DF544bA632C9E25829fd29d767d7978',
      actual: '0',
      expected: '100000000',
    },
  },
  swapTx: {
    chainId: 4663,
    to: '0xD29C85F15DF544bA632C9E25829fd29d767d7978',
    data: '0xad5425c6',
    value: null,
  },
  expectedOutputAmount: '99830520',
  minOutputAmount: '99830520',
  expectedFillTime: 3,
  quoteExpiryTimestamp: 1784358599,
}

const ACROSS_ETH_IN: AcrossQuoteJson = {
  checks: {
    allowance: {
      token: '0x0000000000000000000000000000000000000000',
      spender: '0x10D8b8DaA26d307489803e10477De69C0492B610',
      actual: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
      expected: '10000000000000000',
    },
  },
  swapTx: {
    chainId: 8453,
    to: '0x10D8b8DaA26d307489803e10477De69C0492B610',
    data: '0x1a2b3c4d',
    value: '10000000000000000',
  },
  expectedOutputAmount: '9963410317377467',
  minOutputAmount: '9963410317377467',
  expectedFillTime: 1,
}

test('relay mapper: approve+deposit steps, requestId, bigint outputs', () => {
  const q = mapRelayQuote(RELAY_USDG_OUT)
  assert.equal(q.provider, 'relay')
  assert.deepEqual(
    q.steps.map((s) => s.kind),
    ['approve', 'deposit'],
  )
  assert.equal(q.steps[0].chainId, 4663)
  assert.equal(q.steps[1].value, 0n) // null value -> 0n
  assert.equal(q.outputAmount, 99831382n)
  assert.equal(q.minOutput, 97834754n)
  assert.equal(q.etaSec, 1)
  assert.deepEqual(q.tracker, {
    provider: 'relay',
    requestId: '0xcfb2f6aa3bbe7a8fedc5a7ab20a87c0d97f39136250a935da21d925e8aeabb34',
  })
  assert.equal(q.expiresAt, null)
})

test('relay mapper refuses non-transaction step kinds', () => {
  const bad: RelayQuoteJson = {
    ...RELAY_USDG_OUT,
    steps: [{ id: 'authorize', kind: 'signature', items: [] }],
  }
  assert.throws(() => mapRelayQuote(bad), BridgeQuoteError)
})

test('across mapper rebuilds an EXACT approve (never the API infinite one)', () => {
  const q = mapAcrossQuote(ACROSS_USDG_OUT)
  assert.deepEqual(
    q.steps.map((s) => s.kind),
    ['approve', 'deposit'],
  )
  const approve = q.steps[0]
  assert.equal(approve.to, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168')
  assert.equal(
    approve.data,
    encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: ['0xD29C85F15DF544bA632C9E25829fd29d767d7978', 100000000n],
    }),
  )
  assert.equal(q.steps[1].value, 0n) // swapTx.value null -> 0n
  assert.equal(q.outputAmount, 99830520n)
  assert.equal(q.expiresAt, 1784358599)
  assert.deepEqual(q.tracker, { provider: 'across', originChainId: 4663 })
})

test('across mapper: native input needs no approve, keeps value', () => {
  const q = mapAcrossQuote(ACROSS_ETH_IN)
  assert.deepEqual(
    q.steps.map((s) => s.kind),
    ['deposit'],
  )
  assert.equal(q.steps[0].value, 10000000000000000n)
  assert.equal(q.tracker.provider === 'across' && q.tracker.originChainId, 8453)
})

test('across mapper surfaces provider errors', () => {
  assert.throws(() => mapAcrossQuote({ message: 'Unable to find tokenDetails', code: 'ROUTE_NOT_ENABLED' }), BridgeQuoteError)
})

test('fee units per provider derive from one bps number', () => {
  // Relay: bps as string; Across: decimal fraction — mixing these up would
  // charge 100x, so pin both encodings (9 bps as the example rate)
  assert.equal(relayAppFee(9), '9')
  assert.equal(acrossAppFee(9), '0.0009')
})

test('zero-fee quotes omit provider fee params entirely', async () => {
  // fee.bps 0 must drop appFees/appFee from the requests — sending "0" would
  // gamble on both providers' validation instead of our own
  const leg = resolveIntent({ dir: 'out', token: USDG_OPTION, remote: ETH_REMOTE, amount: 1_000_000n })
  const fee: BridgeFee = { bps: 0, receiver: '0x1111111111111111111111111111111111111111' as Address }
  const seen: { relayBody?: Record<string, unknown>; acrossUrl?: string } = {}
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    if (init?.body) seen.relayBody = JSON.parse(String(init.body)) as Record<string, unknown>
    else seen.acrossUrl = u
    return new Response(JSON.stringify({ message: 'stub reject' }), { status: 500 })
  }) as typeof fetch
  try {
    await assert.rejects(quoteRelay(leg, 1_000_000n, fee, null), BridgeQuoteError)
    await assert.rejects(quoteAcross(leg, 1_000_000n, fee, null), BridgeQuoteError)
  } finally {
    globalThis.fetch = orig
  }
  assert.ok(seen.relayBody && !('appFees' in seen.relayBody))
  assert.ok(seen.acrossUrl && !seen.acrossUrl.includes('appFee'))
})

homeChainTest('intent resolution: robinhood is always one leg, same token both sides', () => {
  const out = resolveIntent({ dir: 'out', token: ETH_OPTION, remote: ETH_REMOTE, amount: 1n })
  assert.equal(out.originChainId, 4663)
  assert.equal(out.destChainId, ETH_REMOTE.chain.id)
  const usdgIn = resolveIntent({ dir: 'in', token: USDG_OPTION, remote: ETH_REMOTE, amount: 1n })
  assert.equal(usdgIn.originChainId, ETH_REMOTE.chain.id)
  assert.equal(usdgIn.inputToken, L1_USDG)
  assert.equal(usdgIn.outputToken, RH_USDG)
  assert.equal(usdgIn.inputDecimals, 6)
  assert.equal(usdgIn.inputSymbol, 'USDG')
  assert.equal(usdgIn.outputSymbol, 'USDG')
})

// ---- canonical bridge (portal) ----

// real deposit pair (L1 tx 0x4bbe5afd…, validated live 2026-07-18): the bridge
// event's aliased sender, the InboxMessageDelivered payload and the resulting
// child tx hash on Robinhood
const FIXTURE = {
  msgNum: 43494n,
  aliasedSender: '0xc66B13d57560540773956d0A78D2f18f0e30F8FF' as Address,
  dest: '0xb55a13d57560540773956D0a78d2F18f0e30E7EE' as Address,
  value: 90658430000000000n,
  childTxHash: '0x5ed39f3bf5979435ead99b4b45aa62be82434caf60872dacc0d4b4d21764eb2e' as Hex,
}

test('portal: depositEth calldata is the real selector', () => {
  assert.equal(DEPOSIT_ETH_CALLDATA, toFunctionSelector('function depositEth()'))
})

test('portal: L1→L2 alias matches a real deposit (sender = alias(dest) for EOA self-deposit)', () => {
  assert.equal(aliasL1Address(FIXTURE.dest), FIXTURE.aliasedSender)
})

test('portal: child EthDeposit tx hash derivation matches a real fill', () => {
  const h = childEthDepositTxHash(4663n, FIXTURE.msgNum, FIXTURE.aliasedSender, FIXTURE.dest, FIXTURE.value)
  assert.equal(h, FIXTURE.childTxHash)
})

homeChainTest('portal: deposit receipt parses to the derived child hash', () => {
  const packed = `0x${FIXTURE.dest.slice(2)}${pad(toHex(FIXTURE.value), { size: 32 }).slice(2)}` as Hex
  const receipt = {
    from: FIXTURE.dest, // EOA self-deposit: tx sender == destination
    logs: [
      {
        address: PORTAL_INBOX,
        topics: [
          '0xff64905f73a67fb594e0f940a8075a860db489ad991e032f48c81123eb52d60b',
          pad(toHex(FIXTURE.msgNum), { size: 32 }),
        ],
        data: encodeAbiParameters([{ type: 'bytes' }], [packed]),
      },
    ],
  } as unknown as TransactionReceipt
  assert.equal(parseEthDepositReceipt(receipt), FIXTURE.childTxHash)
})

test('portal: quotes are lossless 1:1 with the measured ETA, deposits-from-Ethereum only', () => {
  const leg = resolveIntent({ dir: 'in', token: ETH_OPTION, remote: ETH_REMOTE, amount: 123n })
  const q = quotePortal(leg, 123n)
  assert.equal(q.outputAmount, 123n)
  assert.equal(q.minOutput, 123n)
  assert.equal(q.etaSec, PORTAL_ETA_SEC)
  assert.equal(q.expiresAt, null)
  assert.deepEqual(q.steps, [
    { kind: 'deposit', chainId: 1, to: PORTAL_INBOX, data: DEPOSIT_ETH_CALLDATA, value: 123n },
  ])
  // guards: no withdrawals, no non-Ethereum remotes, no ERC-20s
  assert.throws(() => quotePortal(resolveIntent({ dir: 'out', token: ETH_OPTION, remote: ETH_REMOTE, amount: 1n }), 1n), BridgeQuoteError)
  assert.throws(() => quotePortal(resolveIntent({ dir: 'in', token: ETH_OPTION, remote: BASE_REMOTE, amount: 1n }), 1n), BridgeQuoteError)
  assert.throws(() => quotePortal(resolveIntent({ dir: 'in', token: USDG_OPTION, remote: ETH_REMOTE, amount: 1n }), 1n), BridgeQuoteError)
})

// ---- token discovery (same-token only, engine-reported support) ----

const RELAY_CHAINS_FIX: RelayChainsJson = {
  chains: [
    {
      id: 4663,
      currency: { symbol: 'ETH', decimals: 18, supportsBridging: true },
      erc20Currencies: [
        { symbol: 'USDG', address: RH_USDG, decimals: 6, supportsBridging: true },
        { symbol: 'DEAD', address: '0x00000000000000000000000000000000000dead1' as Address, decimals: 18, supportsBridging: false },
      ],
    },
    { id: 1, currency: { symbol: 'ETH', decimals: 18, supportsBridging: true } },
    { id: 8453, currency: { symbol: 'ETH', decimals: 18, supportsBridging: true } },
  ],
}

const RELAY_CUR_FIX: Record<string, RelayCurrencyV2[]> = {
  USDG: [
    { chainId: 4663, address: RH_USDG, symbol: 'USDG', decimals: 6, metadata: { verified: true } },
    // mainnet USDG is listed UNVERIFIED by relay — trusted only via the across route address
    { chainId: 1, address: L1_USDG, symbol: 'USDG', decimals: 6, metadata: { verified: false } },
  ],
  WETH: [
    { chainId: 4663, address: RH_WETH, symbol: 'WETH', decimals: 18, metadata: { verified: false } },
    { chainId: 1, address: L1_WETH, symbol: 'WETH', decimals: 18, metadata: { verified: true } },
    // scam twin on mainnet — must never be picked
    { chainId: 1, address: '0x00000000000000000000000000000000000dead2' as Address, symbol: 'WETH', decimals: 18, metadata: { verified: false } },
  ],
}

const ACROSS_ROUTES_FIX: AcrossRouteJson[] = [
  // ethereum pair
  { originChainId: 1, originToken: L1_WETH, destinationChainId: 4663, destinationToken: NATIVE_SENTINEL, originTokenSymbol: 'ETH', destinationTokenSymbol: 'ETH', isNative: true },
  { originChainId: 1, originToken: L1_WETH, destinationChainId: 4663, destinationToken: RH_WETH, originTokenSymbol: 'WETH', destinationTokenSymbol: 'WETH' },
  // across labels mainnet USDG "USDG-MAINNET" — still the same token
  { originChainId: 1, originToken: L1_USDG, destinationChainId: 4663, destinationToken: RH_USDG, originTokenSymbol: 'USDG-MAINNET', destinationTokenSymbol: 'USDG' },
  // cross-token legs (dropped by product decision): USDC→USDG and USDG→USDC
  { originChainId: 1, originToken: L1_USDC, destinationChainId: 4663, destinationToken: RH_USDG, originTokenSymbol: 'USDC', destinationTokenSymbol: 'USDG' },
  { originChainId: 4663, originToken: RH_USDG, destinationChainId: 1, destinationToken: L1_USDC, originTokenSymbol: 'USDG', destinationTokenSymbol: 'USDC' },
  // base pair: only ETH + cross-token USDC→USDG
  { originChainId: 8453, originToken: '0x4200000000000000000000000000000000000006' as Address, destinationChainId: 4663, destinationToken: NATIVE_SENTINEL, originTokenSymbol: 'ETH', destinationTokenSymbol: 'ETH', isNative: true },
  { originChainId: 8453, originToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address, destinationChainId: 4663, destinationToken: RH_USDG, originTokenSymbol: 'USDC', destinationTokenSymbol: 'USDG' },
]

homeChainTest('discovery: ethereum pair = ETH(portal+relay+across) + USDG(relay+across) + WETH(across only)', () => {
  const list = mergeTokenSupports({
    remoteChainId: 1,
    relayChains: RELAY_CHAINS_FIX,
    relayCurrencies: RELAY_CUR_FIX,
    acrossRoutes: ACROSS_ROUTES_FIX,
  })
  assert.deepEqual(
    list.map((s) => s.symbol),
    ['ETH', 'USDG', 'WETH'],
  )
  const [eth, usdg, weth] = list
  assert.deepEqual({ relay: eth.relay, across: eth.across, portal: eth.portal }, { relay: true, across: true, portal: true })
  assert.equal(usdg.remoteToken, L1_USDG) // route-confirmed, NOT the USDC leg
  assert.deepEqual({ relay: usdg.relay, across: usdg.across, portal: usdg.portal }, { relay: true, across: true, portal: false })
  assert.equal(weth.remoteToken, L1_WETH) // verified twin wins, scam twin ignored
  assert.deepEqual({ relay: weth.relay, across: weth.across, portal: weth.portal }, { relay: false, across: true, portal: false })
  // direction resolution: portal is deposit-only
  assert.deepEqual(providersFor(eth, 'in'), ['portal', 'relay', 'across'])
  assert.deepEqual(providersFor(eth, 'out'), ['relay', 'across'])
})

homeChainTest('discovery: cross-token USDC→USDG legs are gone; base pair has no USDG', () => {
  const list = mergeTokenSupports({
    remoteChainId: 8453,
    relayChains: RELAY_CHAINS_FIX,
    relayCurrencies: RELAY_CUR_FIX,
    acrossRoutes: ACROSS_ROUTES_FIX,
  })
  // USDG exists on the 4663 side but base has no same-token counterpart →
  // it must NOT appear (the old USDC→USDG mapping is exactly what was removed)
  assert.deepEqual(
    list.map((s) => s.symbol),
    ['ETH'],
  )
  assert.equal(list[0].portal, false) // canonical bridge pairs with Ethereum only
})

homeChainTest('discovery: a failed live Inbox verification demotes the canonical route', () => {
  const list = mergeTokenSupports({
    remoteChainId: 1,
    relayChains: RELAY_CHAINS_FIX,
    relayCurrencies: RELAY_CUR_FIX,
    acrossRoutes: ACROSS_ROUTES_FIX,
    portalOk: false,
  })
  const eth = list.find((s) => s.symbol === 'ETH')!
  assert.equal(eth.portal, false)
  assert.equal(eth.relay, true) // the other engines are untouched
})

test('discovery: loose symbol guard accepts chain-suffixed labels, rejects different assets', () => {
  assert.ok(sameSymbolLoose('USDG-MAINNET', 'USDG'))
  assert.ok(sameSymbolLoose('USDG', 'USDG'))
  assert.ok(!sameSymbolLoose('USDC', 'USDG'))
  assert.ok(!sameSymbolLoose('WETH', 'ETH'))
})

// ---- pending transfers: conservative scheduling ----

const basePending: PendingTransfer = {
  id: '0xdep',
  provider: 'relay',
  tracker: { provider: 'relay', requestId: '0xreq' },
  createdAt: 1_000_000,
  etaSec: 5,
  originChainId: 1,
  destChainId: 4663,
  symbol: 'ETH',
  amountIn: '0.05',
  expectedOut: '50000000000000000',
  decimals: 18,
  depositTxHash: '0xdep',
  status: 'pending',
}

test('pending: first check waits ~90% of ETA (min 8s), then slow cadence by speed class', () => {
  // fast bridge (5s eta): first check at the 8s floor, then every 20s
  assert.equal(nextCheckAt(basePending), 1_000_000 + 8_000)
  assert.equal(nextCheckAt({ ...basePending, checkedAt: 1_010_000 }), 1_030_000)
  // canonical (~600s): first check at 540s, then every 60s — a 10-min transfer
  // costs a handful of status reads, not hundreds
  const portal: PendingTransfer = { ...basePending, etaSec: 600 }
  assert.equal(nextCheckAt(portal), 1_000_000 + 540_000)
  assert.equal(nextCheckAt({ ...portal, checkedAt: 1_000_000 + 540_000 }), 1_000_000 + 600_000)
})

test('pending: short eta formatter is locale-neutral', () => {
  assert.equal(fmtEtaShort(600), '~10m')
  assert.equal(fmtEtaShort(7), '~7s')
})

test('pending: portal check resolves via child receipt probe; missing hash goes stale', async () => {
  const portalT: PendingTransfer = {
    ...basePending,
    provider: 'portal',
    tracker: { provider: 'portal', childTxHash: FIXTURE.childTxHash },
  }
  const found = await checkPendingTransfer(portalT, async () => true)
  assert.equal(found.status, 'filled')
  assert.equal(found.fillTxHash, FIXTURE.childTxHash)
  const notYet = await checkPendingTransfer(portalT, async () => false)
  assert.equal(notYet.status, undefined)
  assert.ok(typeof notYet.checkedAt === 'number')
  const unparseable = await checkPendingTransfer(
    { ...portalT, tracker: { provider: 'portal', childTxHash: null } },
    async () => true,
  )
  assert.equal(unparseable.status, 'stale')
})

test('pending store: cross-tab writes merge instead of last-writer-wins', () => {
  // node has no localStorage — install a stub BEFORE the store's first lazy read
  const backing = new Map<string, string>()
  const stub = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  }
  const g = globalThis as { localStorage?: unknown }
  g.localStorage = stub
  const KEY = 'up33.bridgePending.v1'
  const A: PendingTransfer = { ...basePending, id: 'A', depositTxHash: 'A' }
  const B: PendingTransfer = { ...basePending, id: 'B', depositTxHash: 'B' }
  try {
    backing.set(KEY, JSON.stringify([A]))
    assert.deepEqual(pendingBridges.get().map((e) => e.id), ['A']) // lazy first load

    // another tab fills A and adds B; this tab then applies a stale pending-check patch
    backing.set(KEY, JSON.stringify([{ ...A, status: 'filled', fillTxHash: '0xf' }, B]))
    pendingBridges.update('A', { checkedAt: 123, status: 'stale' })
    const merged = pendingBridges.get()
    const a1 = merged.find((e) => e.id === 'A')!
    assert.equal(a1.status, 'filled') // terminal state never regresses
    assert.equal(a1.fillTxHash, '0xf')
    assert.equal(a1.checkedAt, 123) // non-status patch still lands
    assert.ok(merged.some((e) => e.id === 'B')) // the other tab's add survived

    // another tab dismisses B → our next mutation drops it too
    backing.set(KEY, JSON.stringify([{ ...A, status: 'filled', fillTxHash: '0xf' }]))
    pendingBridges.update('A', { checkedAt: 456 })
    assert.ok(!pendingBridges.get().some((e) => e.id === 'B'))

    // storage becomes unreadable → memory carries the session (never wiped)
    g.localStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    pendingBridges.update('A', { checkedAt: 789 })
    assert.equal(pendingBridges.get().find((e) => e.id === 'A')?.checkedAt, 789)
  } finally {
    delete g.localStorage
  }
})

test('pending: relay/across status mapping', async () => {
  const orig = globalThis.fetch
  try {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: 'success', txHashes: ['0xa', '0xfill'] }), { status: 200 })) as typeof fetch
    const r = await checkPendingTransfer(basePending, async () => false)
    assert.equal(r.status, 'filled')
    assert.equal(r.fillTxHash, '0xfill')

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: 'expired' }), { status: 200 })) as typeof fetch
    const acrossT: PendingTransfer = {
      ...basePending,
      provider: 'across',
      tracker: { provider: 'across', originChainId: 1, depositTxHash: '0xdep' },
    }
    const a = await checkPendingTransfer(acrossT, async () => false)
    assert.equal(a.status, 'refunded')

    // transient API failure → only checkedAt moves; cadence retries later
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as typeof fetch
    const quiet = await checkPendingTransfer(basePending, async () => false)
    assert.equal(quiet.status, undefined)
    assert.ok(typeof quiet.checkedAt === 'number')
  } finally {
    globalThis.fetch = orig
  }
})
