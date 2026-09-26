import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'
import { numberToHex, toEventSelector, type Hex } from 'viem'
import { FABLES_HOOKS } from '../src/config/fables'

const hooks = Object.keys(FABLES_HOOKS) as Hex[]
const owner = '0x00000000000000000000000000000000000000aa'
const recipient = '0x00000000000000000000000000000000000000bb'
const word = (address: string) => `0x${address.slice(2).padStart(64, '0')}` as Hex
const id = numberToHex(123n, { size: 32 })
const deposited = toEventSelector('Deposited(address,uint256,uint128)')
const withdrawn = toEventSelector('Withdrawn(address,uint256,uint128)')
const transfer = toEventSelector('Transfer(address,address,uint256,uint256)')
const kv = new Map<string, string>()
const candidates = new Set<string>()
let head = 100
let logs: Array<{ address: Hex; topics: Hex[]; blockNumber: Hex }> = []
let reviewed = true
let windows: Array<[number, number]> = []

mock.module('./config', { namedExports: {
  CHAIN: { id: 4663 }, INDEXER_FINALITY_BLOCKS: 0, log: () => undefined, now: () => 1_000,
} })
const rpc = {
  getBlockNumber: async () => BigInt(head),
  request: async ({ params }: { params: [{ fromBlock: Hex; toBlock: Hex }] }) => {
    const lo = Number(params[0].fromBlock)
    const hi = Number(params[0].toBlock)
    windows.push([lo, hi])
    return logs.filter(row => Number(row.blockNumber) >= lo && Number(row.blockNumber) <= hi)
  },
}
mock.module('./rpc', { namedExports: {
  pc: rpc, withRotatingRpcClient: <T>(fn: (client: typeof rpc) => Promise<T>) => fn(rpc),
} })
mock.module('./store', { namedExports: {
  kvGet: (key: string) => kv.get(key),
  kvSet: (key: string, value: string) => { kv.set(key, value) },
  tx: (fn: () => void) => fn(),
  addFablesCandidate: (address: string, hook: string, rangeId: string) => {
    candidates.add(`${address}:${hook}:${rangeId}`)
  },
} })
mock.module('../src/lib/fables', { namedExports: {
  readFablesPools: async () => hooks.map((hook, i) => ({
    id: numberToHex(i, { size: 32 }), key: { hooks: hook }, active: true, reviewed: reviewed || i !== 0,
  })),
} })

const { fablesCandidatesFromLog, tailFablesPositions } = await import('./fablesPositions')

beforeEach(() => {
  kv.clear(); candidates.clear(); logs = []; windows = []; reviewed = true; head = 100
})

test('deposit, withdrawal and share transfer all preserve owner/range candidates', async () => {
  logs = [
    { address: hooks[0], topics: [deposited, word(owner), id], blockNumber: numberToHex(10) },
    { address: hooks[0], topics: [withdrawn, word(owner), id], blockNumber: numberToHex(20) },
    { address: hooks[0], topics: [transfer, word(owner), word(recipient), id], blockNumber: numberToHex(30) },
  ]
  assert.equal(await tailFablesPositions(), 3)
  assert.deepEqual([...candidates].sort(), [
    `${owner}:${hooks[0]}:123`, `${recipient}:${hooks[0]}:123`,
  ].sort())
  assert.equal(kv.get('fables_position_cursor'), '100')
  assert.equal(kv.get('fables_positions_backfilled'), '1')
})

test('a resume scans only blocks after the durable cursor', async () => {
  kv.set('fables_position_cursor', '60')
  await tailFablesPositions()
  assert.equal(windows[0][0], 61)
  assert.equal(kv.get('fables_position_cursor'), '100')
})

test('unreviewed active pool blocks replay before advancing the cursor', async () => {
  reviewed = false
  await assert.rejects(() => tailFablesPositions(), /requires review/)
  assert.equal(kv.get('fables_position_cursor'), undefined)
})

test('malformed and unreviewed hook logs are rejected', () => {
  assert.throws(() => fablesCandidatesFromLog({
    address: hooks[0], topics: [deposited, '0x01' as Hex, id], blockNumber: numberToHex(1),
  }), /malformed/)
  assert.throws(() => fablesCandidatesFromLog({
    address: '0x0000000000000000000000000000000000000001',
    topics: [deposited, word(owner), id], blockNumber: numberToHex(1),
  }), /unreviewed/)
})
