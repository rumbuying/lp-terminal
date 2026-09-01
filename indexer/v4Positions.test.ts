import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'
import { toEventSelector, type Address } from 'viem'

const MANAGER = '0x58daec3116aae6d93017baaea7749052e8a04fa7' as Address
const GENESIS = 9_070
const TRANSFER = toEventSelector('Transfer(address,address,uint256)')
const ZERO = '0x0000000000000000000000000000000000000000'
const OWNER_A = '0x00000000000000000000000000000000000000a1'
const OWNER_B = '0x00000000000000000000000000000000000000b2'

const kv = new Map<string, string>()
/** tokenId -> current owner, the replay the mocked store maintains */
const owners = new Map<number, string>()
let head = GENESIS + 1_000
/** every window the scan asked for, in order */
let windows: Array<[number, number]> = []
let logsByBlock = new Map<number, unknown[]>()

const word = (value: string | number | bigint) =>
  BigInt(value).toString(16).padStart(64, '0')

/** a Transfer log: topics[1]=from, topics[2]=to, topics[3]=tokenId */
const transferLog = (block: number, from: string, to: string, tokenId: number) => ({
  topics: [
    TRANSFER,
    `0x${word(from)}`,
    `0x${word(to)}`,
    `0x${word(tokenId)}`,
  ],
  blockNumber: `0x${block.toString(16)}`,
})

mock.module('./config', {
  namedExports: {
    CHAIN: { id: 4663, key: 'robinhood' },
    INDEXER_FINALITY_BLOCKS: 0,
    V4: { POSITION_MANAGER: MANAGER, positionRpcIndex: { genesisBlock: GENESIS } },
    log: () => undefined,
  },
})

const rpcClient = {
  getBlockNumber: async () => BigInt(head),
  request: async ({ params }: { params: [{ fromBlock: string; toBlock: string }] }) => {
    const lo = Number(params[0].fromBlock)
    const hi = Number(params[0].toBlock)
    windows.push([lo, hi])
    const out: unknown[] = []
    for (let b = lo; b <= hi; b++) out.push(...(logsByBlock.get(b) ?? []))
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
    applyV4Transfer: (tokenId: number, to: string) => {
      const owner = to.toLowerCase()
      if (owner === ZERO) owners.delete(tokenId)
      else owners.set(tokenId, owner)
    },
  },
})

const { backfillV4Positions, tailV4Positions } = await import('./v4Positions')

beforeEach(() => {
  kv.clear()
  owners.clear()
  windows = []
  logsByBlock = new Map()
  head = GENESIS + 1_000
})

test('the first scan starts at the position genesis, not at chain genesis', async () => {
  await tailV4Positions()
  assert.equal(windows[0][0], GENESIS)
  assert.equal(kv.get('v4_position_cursor'), String(head))
})

test('a mint records the recipient, and only the recipient', async () => {
  logsByBlock.set(GENESIS + 5, [transferLog(GENESIS + 5, ZERO, OWNER_A, 1)])
  const applied = await tailV4Positions()
  assert.equal(applied, 1)
  assert.deepEqual([...owners.entries()], [[1, OWNER_A.toLowerCase()]])
})

test('a transfer moves the row; a burn removes it', async () => {
  logsByBlock.set(GENESIS + 5, [transferLog(GENESIS + 5, ZERO, OWNER_A, 1)])
  logsByBlock.set(GENESIS + 6, [transferLog(GENESIS + 6, OWNER_A, OWNER_B, 1)])
  logsByBlock.set(GENESIS + 7, [transferLog(GENESIS + 7, OWNER_B, ZERO, 1)])
  await tailV4Positions()
  assert.equal(owners.size, 0)
})

test('the last transfer in block order wins', async () => {
  logsByBlock.set(GENESIS + 5, [transferLog(GENESIS + 5, ZERO, OWNER_A, 1)])
  logsByBlock.set(GENESIS + 6, [transferLog(GENESIS + 6, OWNER_A, OWNER_B, 1)])
  await tailV4Positions()
  assert.equal(owners.get(1), OWNER_B.toLowerCase())
})

test('a resumed scan continues after the stored cursor', async () => {
  kv.set('v4_position_cursor', String(GENESIS + 500))
  await tailV4Positions()
  assert.equal(windows[0][0], GENESIS + 501)
})

test('a cursor ahead of the finalized head is refused, not rewound', async () => {
  kv.set('v4_position_cursor', String(head + 1))
  await assert.rejects(() => tailV4Positions(), /refusing a destructive rewind/)
})

test('a malformed Transfer log (wrong topic count) fails the window', async () => {
  logsByBlock.set(GENESIS + 5, [{ topics: [TRANSFER], blockNumber: '0x1' }])
  await assert.rejects(() => tailV4Positions(), /malformed Transfer log/)
})

test('the bootstrap publishes the readiness the API gates on', async () => {
  await backfillV4Positions()
  assert.equal(kv.get('v4_positions_backfilled'), '1')
  assert.equal(kv.get('v4_position_cursor'), String(head))
})

test('the tail also marks the replay backfilled once it reaches the head', async () => {
  await tailV4Positions()
  assert.equal(kv.get('v4_positions_backfilled'), '1')
})

test('a second run resumes rather than rebuilding', async () => {
  await backfillV4Positions()
  head += 400
  windows = []
  await tailV4Positions()
  assert.equal(windows[0][0], GENESIS + 1_000 + 1)
  assert.equal(kv.get('v4_position_cursor'), String(head))
})
