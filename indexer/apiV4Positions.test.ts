import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const tmp = mkdtempSync(join(tmpdir(), 'lp-terminal-api-v4-pos-'))
process.env.CHAIN = 'robinhood'
process.env.INDEXER_DB = join(tmp, 'catalog.db')

const store = await import('./store')
const api = await import('./api')
const { CHAIN, V4 } = await import('./config')

if (!V4?.positionRpcIndex) throw new Error('Robinhood test requires a configured v4 position RPC index')

const ownerA = '0x00000000000000000000000000000000000000a1'
const ownerB = '0x00000000000000000000000000000000000000b2'
const ZERO = '0x0000000000000000000000000000000000000000'

after(() => {
  rmSync(tmp, { recursive: true, force: true })
})

test('v4 positions endpoint rejects a missing or malformed owner', () => {
  assert.throws(() => api.getV4Positions(new URLSearchParams()), /requires owner/)
  assert.throws(
    () => api.getV4Positions(new URLSearchParams({ owner: 'nope' })),
    /invalid v4 positions owner/,
  )
})

test('the endpoint answers empty and not-ready until the replay backfills', () => {
  store.kvSet('ready', '1')
  store.kvSet('v4_positions_backfilled', '')
  const out = api.getV4Positions(new URLSearchParams({ owner: ownerA }))
  assert.equal(out.ready, false)
  assert.deepEqual(out.positions, [])
})

test('mint, transfer and burn are reflected in the owner query', () => {
  store.applyV4Transfer(1, ownerA, 100)
  store.applyV4Transfer(2, ownerA, 101)
  store.applyV4Transfer(2, ownerB, 102) // moved to B
  store.applyV4Transfer(3, ownerA, 103)
  store.applyV4Transfer(3, ZERO, 104) // burned
  store.kvSet('ready', '1')
  store.kvSet('v4_positions_backfilled', '1')

  const out = api.getV4Positions(new URLSearchParams({ owner: ownerA }))
  assert.equal(out.ready, true)
  assert.deepEqual(out.positions, ['1'])
  assert.deepEqual(api.getV4Positions(new URLSearchParams({ owner: ownerB })).positions, ['2'])
  assert.equal(out.chain.key, CHAIN.key)
  assert.equal(out.chainId, CHAIN.id)
})
