import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'
import { toEventSelector, type Address } from 'viem'

const MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951' as Address
const FACTORY = '0x000000e200088d55c39a11f609e5f667729ad49b' as Address
const TOKEN_GENESIS = 4_516_017
const POOL_GENESIS = 9_070
const TOKEN_CREATED = toEventSelector('TokenCreated(address,(string,string,string,bytes))')
const WETH = '0x0000000000000000000000000000000000000d10' as Address
const USDG = '0x0000000000000000000000000000000000000d20' as Address
const CASHCAT = '0x0000000000000000000000000000000000000d30' as Address

const kv = new Map<string, string>()
const launched = new Map<string, number>()
/** how many issued shares the directory currently admits — part of its meaning */
let issuedTokens = 0
let head = TOKEN_GENESIS + 1_000
/** every window the launchpad scan asked for, in order */
let tokenWindows: Array<[number, number]> = []
/** every window the POOL scan asked for — used to prove the ordering rule */
let poolWindows: Array<[number, number]> = []
let logsByBlock = new Map<number, string[]>()
let callOrder: string[] = []

const word = (address: string) => address.toLowerCase().replace('0x', '').padStart(64, '0')
/** a launch log carrying the token in its first data word, plus a metadata tail */
const launchLog = (block: number, token: string) => ({
  data: `0x${word(token)}${'ab'.repeat(64)}`,
  blockNumber: `0x${block.toString(16)}`,
})

mock.module('./config', {
  namedExports: {
    CHAIN: {
      id: 4663,
      key: 'robinhood',
      addr: { WNATIVE: WETH, STABLE: USDG },
      defaultBuy: CASHCAT,
      connectors: [WETH, USDG],
      launchpad: { tokenFactory: FACTORY },
    },
    INDEXER_FINALITY_BLOCKS: 0,
    V4: {
      POOL_MANAGER: MANAGER,
      poolSubgraph: null,
      rpcDirectory: {
        tokenGenesisBlock: TOKEN_GENESIS,
        poolGenesisBlock: POOL_GENESIS,
      },
    },
    log: () => undefined,
    sleep: async () => undefined,
  },
})

const rpcClient = {
  getBlockNumber: async () => BigInt(head),
  request: async ({ params }: { params: [{ fromBlock: string; toBlock: string }] }) => {
    const lo = Number(params[0].fromBlock)
    const hi = Number(params[0].toBlock)
    tokenWindows.push([lo, hi])
    callOrder.push('tokens')
    const out: unknown[] = []
    for (let b = lo; b <= hi; b++)
      for (const token of logsByBlock.get(b) ?? []) out.push(launchLog(b, token))
    return out
  },
}

mock.module('./rpc', {
  namedExports: {
    pc: rpcClient,
    withRotatingRpcClient: <T>(fn: (client: typeof rpcClient) => Promise<T>) => fn(rpcClient),
  },
})

mock.module('./store', {
  namedExports: {
    kvGet: (key: string) => kv.get(key),
    kvSet: (key: string, value: string) => {
      kv.set(key, value)
    },
    tx: (fn: () => void) => fn(),
    insertLaunchpadToken: (address: string, block: number) => {
      const id = address.toLowerCase()
      if (launched.has(id)) return false
      launched.set(id, block)
      return true
    },
    launchpadTokenCount: () => launched.size,
    // Reached through v4Scope, which v4Rpc imports for the generation's scope.
    isLaunchpadToken: (address: string) => launched.has(address.toLowerCase()),
    // the directory's other origin rule; this file is about the launchpad one
    isStockToken: () => false,
    stockTokenCounts: () => ({ measured: 0, proven: issuedTokens }),
  },
})

/** [token, from, to] for every targeted historical scan */
const tokenBackfills: [string, number, number][] = []

mock.module('./v4Subgraph', {
  namedExports: {
    scanV4Windows: async (from: number, to: number) => {
      poolWindows.push([from, to])
      callOrder.push('pools')
      return []
    },
    scanV4ForToken: async (token: string, from: number, to: number) => {
      tokenBackfills.push([token.toLowerCase(), from, to])
      return []
    },
  },
})

const { admitV4Token, backfillV4Rpc, syncLaunchpadTokens, tailV4Rpc } = await import('./v4Rpc')

beforeEach(() => {
  kv.clear()
  launched.clear()
  tokenWindows = []
  poolWindows = []
  callOrder = []
  logsByBlock = new Map()
  head = TOKEN_GENESIS + 1_000
  issuedTokens = 0
  tokenBackfills.length = 0
})

test('the first scan starts at the launchpad genesis, not at chain genesis', async () => {
  await syncLaunchpadTokens(head)
  assert.equal(tokenWindows[0][0], TOKEN_GENESIS)
  assert.equal(kv.get('v4_launchpad_cursor'), String(head))
})

test('a launch is recorded from its first data word, ignoring the metadata tail', async () => {
  const token = '0x00000000000000000000000000000000000000aa'
  logsByBlock.set(TOKEN_GENESIS + 10, [token])
  const added = await syncLaunchpadTokens(head)
  assert.equal(added, 1)
  assert.equal(launched.get(token), TOKEN_GENESIS + 10)
})

test('a resumed scan continues after the stored cursor and never replays it', async () => {
  kv.set('v4_launchpad_cursor', String(TOKEN_GENESIS + 500))
  await syncLaunchpadTokens(head)
  assert.equal(tokenWindows[0][0], TOKEN_GENESIS + 501)
})

test('a cursor ahead of the finalized head is refused, not rewound', async () => {
  kv.set('v4_launchpad_cursor', String(head + 1))
  await assert.rejects(() => syncLaunchpadTokens(head), /refusing a destructive rewind/)
})

// The ordering rule the directory depends on: a pool is admitted by its token,
// so scanning pools through a block whose launches are still unrecorded would
// drop those pools permanently once the cursor moved past them.
test('tokens are always synced before pools, and to the same target', async () => {
  await tailV4Rpc()
  assert.deepEqual(callOrder, ['tokens', 'pools'])
  assert.equal(tokenWindows.at(-1)?.[1], head)
  assert.equal(poolWindows[0][1], head)
})

// The regression this exists for: pools predate the launchpad. Starting the
// pool scan at the TOKEN genesis skipped 4.5M blocks of this chain's history
// and silently cost 166 of its 514 connector pools, which are exactly the
// off-ladder markets the directory was extended to reach.
test('the pool scan starts at the pool genesis, not the launchpad genesis', async () => {
  await tailV4Rpc()
  assert.equal(poolWindows[0][0], POOL_GENESIS)
  assert.ok(POOL_GENESIS < TOKEN_GENESIS)
})

test('the pool scan never reaches back past the pool genesis', async () => {
  // A cursor barely past genesis would make the 120-block overlap underflow.
  kv.set('v4_cursor', String(POOL_GENESIS + 5))
  await tailV4Rpc()
  assert.equal(poolWindows[0][0], POOL_GENESIS)
})

test('the bootstrap publishes the readiness the API gates on', async () => {
  await backfillV4Rpc()
  assert.equal(kv.get('v4_rpc_directory'), '1')
  assert.equal(kv.get('v4_backfilled'), '1')
  assert.equal(kv.get('v4_cursor'), String(head))
  assert.equal(kv.get('v4_target_block'), String(head))
})

test('a second run resumes rather than rebuilding', async () => {
  await backfillV4Rpc()
  const firstEnd = head
  head += 400
  poolWindows = []
  await tailV4Rpc()
  assert.equal(poolWindows[0][0], firstEnd - 120)
  assert.equal(kv.get('v4_cursor'), String(head))
})

// The break this exists for: /api/pools refuses a continuation without a
// generation, so an unset one leaves the first page healthy and every "load
// more" after it returning 400.
test('the directory publishes a generation the API can pin a traversal to', async () => {
  await backfillV4Rpc()
  const generation = kv.get('v4_rpc_generation')
  assert.match(generation ?? '', /^0x[0-9a-f]{64}$/)
})

test('growth alone does not change the generation — the block fence already covers it', async () => {
  await backfillV4Rpc()
  const first = kv.get('v4_rpc_generation')
  head += 5_000
  logsByBlock.set(head - 10, ['0x00000000000000000000000000000000000000ee'])
  await tailV4Rpc()
  assert.equal(kv.get('v4_rpc_generation'), first)
})

// A launch is a MINT: its pools do not exist yet, so admitting it only ever
// appends beyond the traversal fence and the generation is right to stay put.
// An issued share is the opposite — it was minted long before anything here
// read its proxy, so admitting it makes pools with old creation blocks appear
// squarely inside pages already handed out.
test('admitting an issued share changes what the directory means', async () => {
  await backfillV4Rpc()
  const before = kv.get('v4_rpc_generation')

  issuedTokens = 1
  await admitV4Token('0x00000000000000000000000000000000000000AA')
  assert.notEqual(kv.get('v4_rpc_generation'), before)
})

test('admitting a share scans its whole history, both sides, and moves no cursor', async () => {
  await backfillV4Rpc()
  const cursor = kv.get('v4_cursor')

  issuedTokens = 1
  await admitV4Token('0x00000000000000000000000000000000000000AA')

  assert.deepEqual(tokenBackfills, [
    ['0x00000000000000000000000000000000000000aa', POOL_GENESIS, Number(cursor)],
  ])
  // The forward tail owns the cursor. A targeted historical scan that could
  // move it would rewind or advance a fence it knows nothing about.
  assert.equal(kv.get('v4_cursor'), cursor)
  assert.equal(kv.get('v4_target_block'), cursor)
})

// The scope widened whether or not this particular token turned out to have
// any pools. The generation states what the directory MEANS, not what it holds.
test('the generation moves even when the share had no pools', async () => {
  await backfillV4Rpc()
  const before = kv.get('v4_rpc_generation')
  issuedTokens = 3
  assert.equal(await admitV4Token('0x00000000000000000000000000000000000000AA'), 0)
  assert.notEqual(kv.get('v4_rpc_generation'), before)
})
