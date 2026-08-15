import assert from 'node:assert/strict'
import test from 'node:test'
import { adoptLegacyInto, chainKey, legacyStorageChain } from './chainStore'

/** a Storage whose `key(i)` reflects insertion order, like the real one */
function fakeStore(seed: Record<string, string> = {}): Storage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed))
  return {
    map,
    get length() {
      return map.size
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage & { map: Map<string, string> }
}

test('a scoped key names its chain', () => {
  assert.match(chainKey('up33.rpcUrl.v1'), /^up33\.rpcUrl\.v1@(bsc|robinhood)$/)
})

test('a reassigned origin keeps legacy data on its historical chain', () => {
  assert.equal(legacyStorageChain('lp-terminal.xyz', 'bsc'), 'robinhood')
  assert.equal(legacyStorageChain('up33-terminal.xyz', 'bsc'), 'robinhood')
  assert.equal(legacyStorageChain('bsc.lp-terminal.xyz', 'robinhood'), 'bsc')
  assert.equal(legacyStorageChain('BSC.LP-TERMINAL.XYZ.', 'robinhood'), 'bsc')
  assert.equal(legacyStorageChain('localhost', 'bsc'), 'bsc')
  assert.equal(legacyStorageChain('', 'robinhood'), 'robinhood')
})

// Everything in storage before the switcher existed was written by a build of
// this origin, which served one chain. Dropping it instead would silently lose
// the user's range-order bookkeeping — those tags exist nowhere else.
test('pre-switcher entries are adopted into the built chain', () => {
  const s = fakeStore({
    'up33.rpcUrl.v1': 'https://node.example',
    'up33.limitOrders.v1': '{"7":{}}',
    'up33:tokens:v2': '{"0xabc":{}}',
    'theme.v1': 'amber',
  })
  adoptLegacyInto(s, 'robinhood')
  assert.equal(s.getItem('up33.rpcUrl.v1@robinhood'), 'https://node.example')
  assert.equal(s.getItem('up33.limitOrders.v1@robinhood'), '{"7":{}}')
  assert.equal(s.getItem('up33:tokens:v2@robinhood'), '{"0xabc":{}}')
  assert.equal(s.getItem('up33.rpcUrl.v1'), null, 'the legacy entry must not linger')
  assert.equal(s.getItem('theme.v1'), 'amber', 'unscoped preferences are left alone')
})

// Pending swaps get one key per hash, and the scan that finds them is a
// startsWith. The chain therefore has to sit BEFORE the hash, or the walk on
// one chain would pick up the other chain's rows.
test('per-hash entries keep their hash and gain the chain in front of it', () => {
  const a = `0x${'1'.repeat(64)}`
  const b = `0x${'2'.repeat(64)}`
  const s = fakeStore({
    [`up33.pendingSwaps.v2.${a}`]: '{"id":"a"}',
    [`up33.pendingSwaps.v2.${b}`]: '{"id":"b"}',
  })
  adoptLegacyInto(s, 'bsc')
  assert.equal(s.getItem(`up33.pendingSwaps.v2@bsc.${a}`), '{"id":"a"}')
  assert.equal(s.getItem(`up33.pendingSwaps.v2@bsc.${b}`), '{"id":"b"}')
  assert.equal([...s.map.keys()].filter((k) => k.startsWith('up33.pendingSwaps.v2.')).length, 0)
  assert.ok(`up33.pendingSwaps.v2@bsc.${a}`.startsWith('up33.pendingSwaps.v2@bsc.'))
  assert.ok(!`up33.pendingSwaps.v2@robinhood.${a}`.startsWith('up33.pendingSwaps.v2@bsc.'))
})

// `removeItem` reindexes the store, so a walk that mutated as it went would
// skip whatever slid into the slot it just vacated — with three entries it
// would adopt the first and the third and leave the second behind forever.
test('the walk adopts every entry, not every other one', () => {
  const s = fakeStore(
    Object.fromEntries(
      [1, 2, 3, 4, 5].map((n) => [`up33.pendingSwaps.v2.0x${String(n).repeat(64)}`, `${n}`]),
    ),
  )
  adoptLegacyInto(s, 'bsc')
  const adopted = [...s.map.keys()].filter((k) => k.startsWith('up33.pendingSwaps.v2@bsc.'))
  assert.equal(adopted.length, 5)
  assert.equal(s.length, 5, 'nothing left behind under the legacy name')
})

// Two tabs, one mid-migration: the scoped entry is the one written by the build
// that already knows about chains, so it wins and the legacy copy is dropped.
test('an existing scoped entry is not overwritten by the legacy one', () => {
  const s = fakeStore({
    'up33.rpcUrl.v1': 'https://old.example',
    'up33.rpcUrl.v1@bsc': 'https://new.example',
  })
  adoptLegacyInto(s, 'bsc')
  assert.equal(s.getItem('up33.rpcUrl.v1@bsc'), 'https://new.example')
  assert.equal(s.getItem('up33.rpcUrl.v1'), null)
})

test('adopting twice changes nothing the second time', () => {
  const s = fakeStore({ 'up33.limitOrders.v1': '{"7":{}}' })
  adoptLegacyInto(s, 'bsc')
  const after = new Map(s.map)
  adoptLegacyInto(s, 'bsc')
  assert.deepEqual([...s.map.entries()], [...after.entries()])
})
