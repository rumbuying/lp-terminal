import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'lp-terminal-indexer-'))
process.env.INDEXER_DB = join(dir, 'test.db')

const { db, insertPool, upsertState } = await import('./store')
const { pc } = await import('./rpc')
const { sweepState } = await import('./state')

after(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('partial pool reads preserve the last-good state', async () => {
  const v2 = '0x0000000000000000000000000000000000000001'
  const v3 = '0x0000000000000000000000000000000000000002'
  const complete = '0x0000000000000000000000000000000000000003'
  const v3Token0 = '0x0000000000000000000000000000000000000020'
  const v3Token1 = '0x0000000000000000000000000000000000000021'
  insertPool({
    address: v2,
    proto: 'univ2',
    token0: '0x0000000000000000000000000000000000000010',
    token1: '0x0000000000000000000000000000000000000011',
    feePpm: 3_000,
  })
  insertPool({ address: v3, proto: 'univ3', token0: v3Token0, token1: v3Token1, feePpm: 500, tickSpacing: 10 })
  insertPool({
    address: complete,
    proto: 'univ2',
    token0: '0x0000000000000000000000000000000000000030',
    token1: '0x0000000000000000000000000000000000000031',
    feePpm: 3_000,
  })
  upsertState(v2, { reserve0: 11n, reserve1: 12n, totalSupply: 13n })
  upsertState(v3, { sqrtPrice: 14n, tick: 15, liquidity: 16n, reserve0: 17n, reserve1: 18n })
  upsertState(complete, { reserve0: 31n, reserve1: 32n, totalSupply: 33n })

  const read = (address: string) =>
    db
      .prepare('SELECT sqrt_price, tick, liquidity, reserve0, reserve1, total_supply, updated FROM pool_state WHERE address = ?')
      .get(address)
  const v2Before = read(v2)
  const v3Before = read(v3)

  const original = pc.multicall
  Object.defineProperty(pc, 'multicall', {
    configurable: true,
    value: async ({ contracts }: { contracts: { address: string; functionName: string }[] }) =>
      contracts.map((call) => {
        if (call.address === v2 && call.functionName === 'getReserves')
          return { status: 'success', result: [21n, 22n, 0] }
        if (call.address === v2 && call.functionName === 'totalSupply') return { status: 'failure' }
        if (call.address === v3 && call.functionName === 'slot0') return { status: 'success', result: [24n, 25] }
        if (call.address === v3 && call.functionName === 'liquidity') return { status: 'success', result: 26n }
        if (call.address === v3Token0) return { status: 'success', result: 27n }
        if (call.address === v3Token1) return { status: 'failure' }
        if (call.address === complete && call.functionName === 'getReserves')
          return { status: 'success', result: [41n, 42n, 0] }
        if (call.address === complete && call.functionName === 'totalSupply') return { status: 'success', result: 43n }
        throw new Error(`unexpected call: ${call.address} ${call.functionName}`)
      }),
  })
  try {
    assert.equal(await sweepState([v2, v3, complete]), 1)
    assert.deepEqual(read(v2), v2Before)
    assert.deepEqual(read(v3), v3Before)
    const { updated: _updated, ...completeAfter } = read(complete) as Record<string, unknown>
    assert.deepEqual(completeAfter, {
      sqrt_price: null,
      tick: null,
      liquidity: null,
      reserve0: '41',
      reserve1: '42',
      total_supply: '43',
    })
  } finally {
    Object.defineProperty(pc, 'multicall', { configurable: true, value: original })
  }
})
