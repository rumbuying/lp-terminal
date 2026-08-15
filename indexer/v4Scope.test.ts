// The scope gate: on a chain whose v4 directory comes from an RPC scan rather
// than a subgraph, a pool is admitted only when the chain has proven where one
// of its currencies came from — or when both are routing core. This is what
// keeps a 257k-pool chain's directory in the low thousands, so it is worth
// pinning directly.
import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'
import { encodeAbiParameters, keccak256, zeroAddress, type Address, type Hex } from 'viem'

const MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951' as Address
const FACTORY = '0x000000e200088d55c39a11f609e5f667729ad49b' as Address
const LAUNCHED = '0x00000000000000000000000000000000000000aa' as Address
const OUTSIDER = '0x00000000000000000000000000000000000000bb' as Address
const OTHER = '0x00000000000000000000000000000000000000cc' as Address
/** an issued share — proven origin by the other route, not a launchpad mint */
const SHARE = '0x00000000000000000000000000000000000000dd' as Address
/** sorts ABOVE the share, so the share can occupy currency0 against it */
const HIGHER = '0x00000000000000000000000000000000000000ee' as Address
/** sorts BELOW the launched token, so it can occupy currency0 against it */
const LOWER = '0x0000000000000000000000000000000000000011' as Address
// the routing backbone — core on both sides is the second admission rule
const WETH = '0x0000000000000000000000000000000000000d10' as Address
const USDG = '0x0000000000000000000000000000000000000d20' as Address
const CASHCAT = '0x0000000000000000000000000000000000000d30' as Address

const kv = new Map<string, string>()
const pools = new Map<string, { currency0: string; currency1: string }>()
const launchpad = new Set<string>([LAUNCHED.toLowerCase()])
const issued = new Set<string>([SHARE.toLowerCase()])
let getLogs: (r: {
  fromBlock: bigint
  toBlock: bigint
  args?: Record<string, unknown>
}) => Promise<unknown[]> = async () => []
/** every range the scanner asked for, with the currency filter it carried */
let ranges: Array<[number, number, string]> = []

const poolIdOf = (c0: Address, c1: Address, fee: number, spacing: number, hooks: Address): Hex =>
  keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'uint24' },
        { type: 'int24' },
        { type: 'address' },
      ],
      [c0, c1, fee, spacing, hooks],
    ),
  )

/** a PoolKey off every canonical rung, the way this chain's real ones are */
const offLadder = (c0: Address, c1: Address, fee: number, spacing: number) => ({
  id: poolIdOf(c0, c1, fee, spacing, zeroAddress as Address),
  currency0: c0,
  currency1: c1,
  fee,
  tickSpacing: spacing,
  hooks: zeroAddress,
})

const initializeLog = (c0: Address, c1: Address, block: number) => ({
  args: {
    id: poolIdOf(c0, c1, 2500, 60, zeroAddress),
    currency0: c0,
    currency1: c1,
    fee: 2500,
    tickSpacing: 60,
    hooks: zeroAddress,
  },
  blockNumber: BigInt(block),
})

mock.module('./config', {
  namedExports: {
    CHAIN: {
      id: 4663,
      key: 'robinhood',
      addr: { WNATIVE: WETH, STABLE: USDG },
      defaultBuy: CASHCAT,
      connectors: [WETH, USDG],
    },
    INDEXER_FINALITY_BLOCKS: 0,
    V4: {
      POOL_MANAGER: MANAGER,
      poolSubgraph: null,
      rpcDirectory: { TOKEN_FACTORY: FACTORY, genesisBlock: 100 },
    },
    log: () => undefined,
    sleep: async () => undefined,
  },
})

const rpcClient = {
  getBlockNumber: async () => 1_000n,
  getLogs: (r: { fromBlock: bigint; toBlock: bigint; args?: Record<string, unknown> }) => {
    ranges.push([
      Number(r.fromBlock),
      Number(r.toBlock),
      Object.keys(r.args ?? {}).join(',') || 'unfiltered',
    ])
    return getLogs(r)
  },
}
mock.module('./rpc', {
  namedExports: {
    pc: rpcClient,
    withRotatingRpcClient: <T>(fn: (client: typeof rpcClient) => Promise<T>) => fn(rpcClient),
    mc: async () => [],
    ok: () => undefined,
  },
})

mock.module('./store', {
  namedExports: {
    isLaunchpadToken: (address: string) => launchpad.has(address.toLowerCase()),
    isStockToken: (address: string) => issued.has(address.toLowerCase()),
    kvGet: (key: string) => kv.get(key),
    kvSet: (key: string, value: string) => {
      kv.set(key, value)
    },
    tx: (fn: () => void) => fn(),
    insertV4Pool: (p: { poolId: string; currency0: string; currency1: string }) => {
      const id = p.poolId.toLowerCase()
      if (pools.has(id)) return false
      pools.set(id, { currency0: p.currency0, currency1: p.currency1 })
      return true
    },
    v4PoolRow: (id: string) => pools.get(id.toLowerCase()),
    setV4EventIdentity: () => undefined,
    clearV4Featured: () => undefined,
    deleteStaleV4SnapshotCandidates: () => undefined,
    hasCompleteV4SnapshotRows: () => false,
    markV4Featured: () => undefined,
    missingV4TokensPage: () => [],
    pruneV4StatsExcept: () => undefined,
    setV4SnapshotGeneration: () => undefined,
    upsertV4GraphStats: () => undefined,
    upsertV4TokenMeta: () => undefined,
    v4SnapshotGenerationCount: () => 0,
  },
})

const { scanV4ForToken, scanV4Windows } = await import('./v4Subgraph')

beforeEach(() => {
  kv.clear()
  pools.clear()
  ranges = []
  getLogs = async () => []
})

test('a pool on a launched token is admitted, whichever side it sits on', async () => {
  getLogs = async () => [
    initializeLog(LAUNCHED, OTHER, 300), // launched token as currency0
    initializeLog(LOWER, LAUNCHED, 301), // and as currency1
  ]
  const fresh = await scanV4Windows(200, 400, 200)
  assert.equal(fresh.length, 2)
  assert.equal(pools.size, 2)
})

test('a pool between two outsiders is skipped, not stored', async () => {
  getLogs = async () => [initializeLog(OUTSIDER, OTHER, 300)]
  const fresh = await scanV4Windows(200, 400, 200)
  assert.deepEqual(fresh, [])
  assert.equal(pools.size, 0)
})

test('skipping still advances the cursor — an out-of-scope pool is not revisited', async () => {
  getLogs = async () => [initializeLog(OUTSIDER, OTHER, 300)]
  await scanV4Windows(200, 400, 200)
  assert.equal(kv.get('v4_cursor'), '400')
})

test('a native-keyed launch pool is admitted — address(0) is never the launched side', async () => {
  getLogs = async () => [initializeLog(zeroAddress as Address, LAUNCHED, 300)]
  const fresh = await scanV4Windows(200, 400, 200)
  assert.equal(fresh.length, 1)
  assert.equal(pools.size, 1)
})

// Rule 2. v4 enforces no fee ladder, so the real ETH/USDG market on this chain
// sits at (460, 9) and WETH/USDG at (200, 4). No rung shortlist reaches those;
// observing the Initialize log is the only way, which is why core pairs are
// admitted at ANY key rather than only at the probed rungs.
test('a core pair is admitted on a key no rung shortlist would guess', async () => {
  getLogs = async () => [
    { ...initializeLog(WETH, USDG, 300), args: offLadder(WETH, USDG, 200, 4) },
  ]
  const fresh = await scanV4Windows(200, 400, 200)
  assert.equal(fresh.length, 1)
  assert.equal(pools.size, 1)
})

test('one core side is not enough — that rule would admit most of the chain', async () => {
  // The native coin is currency0 in 110k of this chain's 257k pools, so
  // "either side is core" is not a scope at all.
  getLogs = async () => [initializeLog(zeroAddress as Address, OUTSIDER, 300)]
  const fresh = await scanV4Windows(200, 400, 200)
  assert.deepEqual(fresh, [])
  assert.equal(pools.size, 0)
})

test('a launched token still needs no core partner', async () => {
  getLogs = async () => [initializeLog(LAUNCHED, OTHER, 300)]
  assert.equal((await scanV4Windows(200, 400, 200)).length, 1)
})

// Rule 2, and the reason it has to exist separately: a tokenized share is not
// a launchpad mint, and it is quoted against whatever its venue lists — rarely
// another core token. Under the other two rules alone no stock pool on this
// chain is ever admitted, so the stock chips would have nothing v4 to show.
test('an issued share is admitted on either side, like a launched token', async () => {
  getLogs = async () => [
    initializeLog(SHARE, HIGHER, 300), // the share as currency0
    initializeLog(LOWER, SHARE, 301), // and as currency1
  ]
  const fresh = await scanV4Windows(200, 400, 200)
  assert.equal(fresh.length, 2)
  assert.equal(pools.size, 2)
})

test('an unproven token is still an outsider, whatever it calls itself', async () => {
  getLogs = async () => [initializeLog(OUTSIDER, OTHER, 300)]
  assert.deepEqual(await scanV4Windows(200, 400, 200), [])
})

test('scope is applied before the durable fence, so an old out-of-scope row cannot throw', async () => {
  // An in-scope row behind the cursor is a genuine fence violation; an
  // out-of-scope one was never going to be stored, so it must not raise.
  getLogs = async () => [initializeLog(OUTSIDER, OTHER, 150)]
  await assert.doesNotReject(() => scanV4Windows(200, 400, 200))
  assert.equal(pools.size, 0)
})

// Filtered to one currency, the whole of history returns a handful of logs, so
// the response-size ceiling that makes the unfiltered scan chunk never comes
// near. Reusing that scan's 500k window cost 59 requests per side on Robinhood
// (29,272,162 blocks) to fetch what one call returns.
test('a targeted scan asks for the whole range at once, on each side', async () => {
  getLogs = async () => []
  await scanV4ForToken(SHARE, 100, 30_000_000)

  assert.deepEqual(ranges, [
    [100, 30_000_000, 'currency0'],
    [100, 30_000_000, 'currency1'],
  ])
})

// A provider with a hard RANGE cap is still handled: the adaptive scanner
// halves until the request is accepted, which is what makes asking for
// everything first safe rather than reckless.
test('a range the provider refuses is halved, not given up on', async () => {
  let refuseAbove = 8_000_000
  getLogs = async ({ fromBlock, toBlock }) => {
    if (Number(toBlock) - Number(fromBlock) + 1 > refuseAbove)
      throw new Error('query returned more than 10000 results: block range too large')
    return []
  }
  await scanV4ForToken(SHARE, 1, 16_000_000)
  refuseAbove = Infinity

  const accepted = ranges.filter(([lo, hi]) => hi - lo + 1 <= 8_000_000)
  assert.ok(accepted.length > 0, 'it converged on a width the provider takes')
  assert.equal(ranges[0][1] - ranges[0][0] + 1, 16_000_000, 'after trying the whole span first')
  // and it covered the range without a gap, per side
  const side0 = ranges.filter(([, , side]) => side === 'currency0').filter(([lo, hi]) => hi - lo + 1 <= 8_000_000)
  assert.equal(side0[0][0], 1)
  assert.equal(side0.at(-1)![1], 16_000_000)
  for (let i = 1; i < side0.length; i++) assert.equal(side0[i][0], side0[i - 1][1] + 1)
})
