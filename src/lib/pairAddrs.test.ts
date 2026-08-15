import assert from 'node:assert/strict'
import test from 'node:test'
import { zeroAddress } from 'viem'
import { pairReferenceEntries } from '../components/PairAddrs'

const labels = { pool: 'POOL', poolId: 'POOL ID', hooks: 'HOOKS', manager: 'MANAGER' }

test('v4 pair references distinguish PoolId and hooks from PoolManager', () => {
  const poolId = `0x${'11'.repeat(32)}`
  const manager = `0x${'22'.repeat(20)}`
  const entries = pairReferenceEntries(
    {
      sym0: 'BNB',
      sym1: 'USDT',
      token0: zeroAddress,
      token1: `0x${'33'.repeat(20)}`,
      pool: manager,
      poolId,
      hooks: zeroAddress,
    },
    labels,
  )

  assert.deepEqual(
    entries.slice(2).map(({ k, value, explorer }) => ({ k, value, explorer })),
    [
      { k: 'POOL ID', value: poolId, explorer: undefined },
      { k: 'HOOKS', value: zeroAddress, explorer: 'address' },
      { k: 'MANAGER', value: manager, explorer: 'address' },
    ],
  )
  assert.equal(entries.some((entry) => entry.k === 'POOL'), false)
})

test('ordinary pools still expose their contract as POOL', () => {
  const pool = `0x${'44'.repeat(20)}`
  const entries = pairReferenceEntries(
    {
      sym0: 'A',
      sym1: 'B',
      token0: `0x${'55'.repeat(20)}`,
      token1: `0x${'66'.repeat(20)}`,
      pool,
    },
    labels,
  )
  assert.deepEqual(entries.at(-1), { k: 'POOL', value: pool, explorer: 'address' })
})
