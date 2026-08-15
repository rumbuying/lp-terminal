import assert from 'node:assert/strict'
import test from 'node:test'
import { zeroAddress, type Address } from 'viem'
import { ADDR } from '../config/addresses'
import { CHAIN } from '../config/chains'
import type { ClPool } from '../types'
import { clTokenUsd } from './apr'
import { fetchPoolStats } from './poolstats'

const onlyBsc = { skip: CHAIN.key !== 'bsc' }

test('an empty BSC home catalog still fetches a WBNB/USD anchor', onlyBsc, async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return new Response(
      JSON.stringify({
        pairs: [
          {
            chainId: CHAIN.slugs.dexscreener,
            priceUsd: '600',
            liquidity: { usd: 1_000_000 },
            baseToken: { address: ADDR.WNATIVE },
            quoteToken: { address: ADDR.STABLE },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch
  try {
    const stats = await fetchPoolStats([])
    assert.equal(stats.wethUsd, 600)
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('v4 native address(0) uses the same USD anchor as WBNB', onlyBsc, () => {
  const token = '0x0000000000000000000000000000000000000001' as Address
  const pool: ClPool = {
    kind: 'cl',
    protocol: 'univ4',
    address: token,
    poolId: `0x${'11'.repeat(32)}`,
    hooks: zeroAddress,
    token0: zeroAddress,
    token1: token,
    tickSpacing: 10,
    feePpm: 500,
    unstakedFeePpm: 0,
    sqrtPriceX96: 1n << 96n,
    tick: 0,
    liquidity: 1n,
    stakedLiquidity: 0n,
    gauge: null,
    gaugeAlive: false,
    weight: 0n,
    rewardRate: 0n,
    periodFinish: 0n,
  }
  assert.deepEqual(clTokenUsd(pool, 18, 18, undefined, 600), {
    p0: 600,
    p1: 600,
    anchor: 0,
    exact: false,
  })
})
