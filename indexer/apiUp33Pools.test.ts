import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

// A self-contained catalog DB: this endpoint reads the store directly and must
// not depend on a chain whose gov contracts exist.
const tmp = mkdtempSync(join(tmpdir(), 'lp-terminal-up33-pools-'))
const previousDb = process.env.INDEXER_DB
process.env.INDEXER_DB = join(tmp, 'up33.db')

const store = await import('./store')
const api = await import('./api')
const { CHAIN } = await import('./config')

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const token0 = address(0xa1)
const token1 = address(0xb1)
const token2 = address(0xb2)

store.upsertTokenMeta(token0, 'USDG', 6, true)
store.upsertTokenMeta(token1, 'NET', 9, true)
// token2 deliberately has no metadata row: a pool carrying it must still be
// served, with the unnamed side simply absent from the tokens map.

// An "old head" pool the browser scan would have covered, and "tail" pools
// past any browser budget — the endpoint must carry both, in registry order.
for (const [n, withState] of [
  [1, true],
  [2, true],
  [3, false], // created, first state sweep has not landed yet
  [4, true],
] as const) {
  store.insertPool({
    address: address(n),
    proto: 'up33cl',
    token0,
    token1: n === 4 ? token2 : token1,
    feePpm: 10_000,
    unstakedFeePpm: 150_000,
    tickSpacing: 200,
    gauge: n === 2 ? address(0x99) : undefined,
    pairIndex: n,
  })
  if (withState)
    store.upsertState(address(n), {
      sqrtPrice: 1n << 96n,
      tick: 0,
      liquidity: 517130667738n,
      stakedLiquidity: 1_000n,
      rewardRate: 77n,
      periodFinish: 1_800_000_000n,
      gaugeAlive: n === 2,
      reserve0: 1n,
      reserve1: 1n,
    })
}
// A non-UP33 venue must never leak into the home registry.
store.insertPool({
  address: address(0xf1),
  proto: 'univ3',
  token0,
  token1,
  feePpm: 3_000,
  tickSpacing: 60,
})

after(() => {
  if (previousDb === undefined) delete process.env.INDEXER_DB
  else process.env.INDEXER_DB = previousDb
  rmSync(tmp, { recursive: true, force: true })
})

test('the UP33 registry endpoint serves the complete home CL registry', () => {
  const body = api.getUp33Pools()
  assert.equal(body.schemaVersion, 1)
  assert.equal(body.chain.key, CHAIN.key)
  assert.equal(body.chainId, CHAIN.id)

  assert.deepEqual(
    body.pools.map((p) => p.pairIndex),
    [1, 2, 3, 4],
    'registry order is the factory enumeration order, tail included',
  )

  const head = body.pools[0]
  assert.equal(head.stateReady, true)
  assert.equal(head.sqrtPriceX96, String(1n << 96n))
  assert.equal(head.tick, 0)
  assert.equal(head.liquidity, '517130667738')
  assert.equal(head.stakedLiquidity, '1000')
  assert.equal(head.rewardRate, '77')
  assert.equal(head.periodFinish, 1_800_000_000)
  assert.equal(head.gaugeAlive, false)

  const gauged = body.pools[1]
  assert.equal(gauged.gauge, address(0x99))
  assert.equal(gauged.gaugeAlive, true)

  // A row awaiting its first sweep is present but honestly marked unready.
  assert.equal(body.pools[2].stateReady, false)
  assert.equal(body.pools[2].sqrtPriceX96, null)

  const unnamed = body.pools[3]
  assert.equal(unnamed.stateReady, true)
  assert.ok(body.tokens[token0])
  assert.deepEqual(
    (body.tokens[token1] as { symbol: string } | undefined)?.symbol,
    'NET',
  )
  assert.equal(body.tokens[token2], undefined, 'unnamed sides stay absent, never invented')

  assert.ok(!body.pools.some((p) => p.address === address(0xf1)))
})
