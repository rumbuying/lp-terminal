import assert from 'node:assert/strict'
import test from 'node:test'
import { zeroAddress, type Address, type PublicClient } from 'viem'
import { HAS_UNI_V4, decodeV4PositionInfo, v4FeesOwed, v4PoolId, v4PoolIdMatches, v4PositionKey } from './uniV4'
import type { V4PoolKey } from './uniV4'
import { CHAIN } from '../config/chains'
import {
  fetchV4Positions,
  finalizeV4PositionMetadata,
  mergeTokenInfoWithVerifiedV4,
  resetV4PositionMetadataCache,
  verifyV4PositionMetadata,
} from './uniV4Positions'
import type { McRes } from './multicall'
import type { ClPosition, TokenInfo } from '../types'

const v4Test = HAS_UNI_V4 ? test : test.skip
const success = (result: unknown): McRes => ({ status: 'success', result })
const failure = (): McRes => ({ status: 'failure' })

/**
 * Read off BSC on 2026-08-02 from the live PositionManager
 * (0x7A4a…f95b). Pinned rather than reconstructed, because the whole point of
 * these tests is that the app's own decoding agrees with what the chain stores
 * — recomputing the input from the same code would test nothing.
 */
const GOLDEN: { tokenId: bigint; info: bigint; key: V4PoolKey; tickLower: number; tickUpper: number }[] = [
  {
    tokenId: 1n,
    info: 34654933621719441954403267493094542174394898388072884496866124156153602906624n,
    key: {
      currency0: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' as Address,
      currency1: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' as Address,
      fee: 500,
      tickSpacing: 10,
      hooks: zeroAddress as Address,
    },
    tickLower: -887270,
    tickUpper: 887270,
  },
  {
    // a NEGATIVE range on both ends — the case a missing sign extension turns
    // into ticks near 16.7 million, putting the position on the wrong side of
    // the price and reporting the wrong token entirely
    tokenId: 985535n,
    info: 105298926430041014245617609224731578945021695659738659260544011463320012377344n,
    key: {
      currency0: '0x55d398326f99059fF775485246999027B3197955' as Address,
      currency1: '0xbe9D156892E55e7154BcD3cB0FEA677F9D3103E1' as Address,
      fee: 330,
      tickSpacing: 3,
      hooks: zeroAddress as Address,
    },
    tickLower: -46899,
    tickUpper: -46896,
  },
  {
    // fee 27400 / spacing 548: v4 leaves fee a FREE FIELD, so nothing here may
    // assume the canonical 100/500/3000/10000 ladder
    tokenId: 985640n,
    info: 84954822498424969904208135756762612116119172362878841062310432289314288171008n,
    key: {
      currency0: '0x55d398326f99059fF775485246999027B3197955' as Address,
      currency1: '0x8554D38b95E4F7Ca11D391008627Df30B2b07777' as Address,
      fee: 27400,
      tickSpacing: 548,
      hooks: zeroAddress as Address,
    },
    tickLower: 77816,
    tickUpper: 78912,
  },
]

function positionWith(key: V4PoolKey): ClPosition {
  return {
    tokenId: 42n,
    pool: {
      kind: 'cl',
      protocol: 'univ4',
      address: '0x0000000000000000000000000000000000000001',
      poolId: v4PoolId(key),
      hooks: key.hooks,
      token0: key.currency0,
      token1: key.currency1,
      tickSpacing: key.tickSpacing,
      feePpm: key.fee,
      lpFeePpm: key.fee,
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
    },
    tickLower: -10,
    tickUpper: 10,
    liquidity: 1n,
    staked: false,
    amount0: 1n,
    amount1: 1n,
    fees0: 0n,
    fees1: 0n,
    earned: 0n,
  }
}

v4Test('PositionInfo decodes to the range the chain actually stores', () => {
  for (const g of GOLDEN) {
    const r = decodeV4PositionInfo(g.info)
    assert.equal(r.tickLower, g.tickLower, `#${g.tokenId} tickLower`)
    assert.equal(r.tickUpper, g.tickUpper, `#${g.tokenId} tickUpper`)
    assert.ok(r.tickLower < r.tickUpper, `#${g.tokenId}: a range must be ordered`)
  }
})

v4Test('the packed pool id agrees with the hash of the reported key', () => {
  for (const g of GOLDEN) {
    const { poolIdPrefix } = decodeV4PositionInfo(g.info)
    assert.ok(v4PoolIdMatches(g.key, poolIdPrefix), `#${g.tokenId} key does not hash to its stored pool`)
    // and the prefix really is the truncation, not a coincidence
    assert.equal(v4PoolId(g.key).slice(0, 52), poolIdPrefix.slice(0, 52))
  }
})

v4Test('a key from another pool fails the match', () => {
  const { poolIdPrefix } = decodeV4PositionInfo(GOLDEN[0].info)
  // same tokens, one rung over — the mistake a fee ladder assumption would make
  const wrong: V4PoolKey = { ...GOLDEN[0].key, fee: 3000, tickSpacing: 60 }
  assert.equal(v4PoolIdMatches(wrong, poolIdPrefix), false)
  assert.equal(v4PoolIdMatches(GOLDEN[1].key, poolIdPrefix), false)
})

v4Test('hasSubscriber reads the low byte, not a tick', () => {
  const base = GOLDEN[0].info - (GOLDEN[0].info & 0xffn)
  assert.equal(decodeV4PositionInfo(base).hasSubscriber, false)
  assert.equal(decodeV4PositionInfo(base + 1n).hasSubscriber, true)
  // and setting it must not disturb the range
  assert.equal(decodeV4PositionInfo(base + 1n).tickLower, GOLDEN[0].tickLower)
  assert.equal(decodeV4PositionInfo(base + 1n).tickUpper, GOLDEN[0].tickUpper)
})

v4Test('the position key is packed, and every field changes it', () => {
  const pm = '0x7A4a5c919aE2541AeD11041A1AEeE68f1287f95b' as Address
  const k = v4PositionKey(pm, -100, 200, 42n)
  assert.match(k, /^0x[0-9a-f]{64}$/)
  assert.notEqual(k, v4PositionKey(pm, -100, 200, 43n), 'the token id is the salt')
  assert.notEqual(k, v4PositionKey(pm, -101, 200, 42n))
  assert.notEqual(k, v4PositionKey(pm, -100, 201, 42n))
  // the owner is the MANAGER, not the wallet — swapping it must change the key,
  // which is what makes reading fees against the wrong owner detectable
  assert.notEqual(k, v4PositionKey('0x000000000000000000000000000000000000dEaD', -100, 200, 42n))
})

v4Test('verified V4 catalog metadata has final precedence over position and farm hints', () => {
  const address = GOLDEN[0].key.currency0
  const hint: TokenInfo = { address, symbol: 'HINT', decimals: 18 }
  const catalog: TokenInfo = { address, symbol: 'USDT', decimals: 6 }

  for (const positionTokens of [{}, { [address]: hint }]) {
    const merged = mergeTokenInfoWithVerifiedV4(
      [positionTokens, { [address.toUpperCase()]: hint }],
      { [address.toLowerCase()]: catalog },
    )
    assert.deepEqual(merged[address.toLowerCase()], catalog)
  }
})

v4Test('a V4 position with failed ERC-20 decimals never becomes executable', () => {
  const token = GOLDEN[0].key.currency0
  const key: V4PoolKey = {
    currency0: zeroAddress,
    currency1: token,
    fee: 500,
    tickSpacing: 10,
    hooks: zeroAddress,
  }
  const position = positionWith(key)

  const failed = finalizeV4PositionMetadata(
    [position],
    [success('UNTRUSTED'), failure()],
  )
  assert.deepEqual(failed, { cl: [], tokens: {} })

  const proved = finalizeV4PositionMetadata(
    [position],
    [success('USDT'), success(6)],
  )
  assert.equal(proved.cl.length, 1)
  assert.equal(proved.tokens[token.toLowerCase()].decimals, 6)
  assert.equal(proved.tokens[zeroAddress].native, true)
})

v4Test('verified V4 token metadata is reused across position-state refreshes', async () => {
  resetV4PositionMetadataCache()
  const token = GOLDEN[0].key.currency0
  const position = positionWith({
    currency0: zeroAddress,
    currency1: token,
    fee: 500,
    tickSpacing: 10,
    hooks: zeroAddress,
  })
  let reads = 0
  const pc = {
    multicall: async ({ contracts }: { contracts: readonly any[] }) => {
      reads += contracts.length
      return contracts.map((call) =>
        call.functionName === 'symbol' ? success('USDT') : success(6),
      )
    },
  } as unknown as PublicClient

  const first = await verifyV4PositionMetadata(pc, [position])
  const second = await verifyV4PositionMetadata(pc, [position])
  resetV4PositionMetadataCache()
  const afterReset = await verifyV4PositionMetadata(pc, [position])

  assert.equal(first.cl.length, 1)
  assert.equal(second.cl.length, 1)
  assert.equal(afterReset.cl.length, 1)
  assert.equal(
    reads,
    4,
    'metadata is reused until an explicit cache reset makes symbol and decimals read again',
  )
  resetV4PositionMetadataCache()
})

v4Test('failed V4 decimals proof is retried instead of poisoning the cache', async () => {
  resetV4PositionMetadataCache()
  const token = GOLDEN[0].key.currency0
  const position = positionWith({
    currency0: zeroAddress,
    currency1: token,
    fee: 500,
    tickSpacing: 10,
    hooks: zeroAddress,
  })
  let attempt = 0
  const pc = {
    multicall: async ({ contracts }: { contracts: readonly any[] }) => {
      attempt++
      return contracts.map((call) => {
        if (call.functionName === 'symbol') return success('USDT')
        return attempt === 1 ? failure() : success(6)
      })
    },
  } as unknown as PublicClient

  const failed = await verifyV4PositionMetadata(pc, [position])
  const retried = await verifyV4PositionMetadata(pc, [position])

  assert.equal(failed.cl.length, 0)
  assert.equal(retried.cl.length, 1)
  assert.equal(attempt, 2)
  resetV4PositionMetadataCache()
})

v4Test('fees owed are growth-since-snapshot times liquidity', () => {
  const Q128 = 1n << 128n
  // one full unit of growth per unit of liquidity
  assert.deepEqual(v4FeesOwed(1000n, Q128, 2n * Q128, 0n, 0n), { fees0: 1000n, fees1: 2000n })
  // nothing has traded since the position was touched
  assert.deepEqual(v4FeesOwed(1000n, 5n * Q128, 5n * Q128, 5n * Q128, 5n * Q128), { fees0: 0n, fees1: 0n })
  // a position holding no liquidity is owed nothing regardless of growth
  assert.deepEqual(v4FeesOwed(0n, 99n * Q128, 99n * Q128, 0n, 0n), { fees0: 0n, fees1: 0n })
})

v4Test('fee growth that has wrapped past 2^256 still gives the real amount', () => {
  const Q128 = 1n << 128n
  const MAX = (1n << 256n) - 1n
  // the accumulator overflowed: `now` is a small number, `last` is near the top.
  // Checked arithmetic would throw here on a pool that has simply been busy.
  const last = MAX - Q128 + 1n // one unit of growth below the wrap point
  const now = 0n // exactly one unit later, having wrapped
  const { fees0 } = v4FeesOwed(1000n, now, 0n, last, 0n)
  assert.equal(fees0, 1000n)
})

// The RPC-index discovery path exists only on a chain that publishes no v4
// position subgraph (Robinhood). The reader must fail CLOSED: a wrong-chain or
// malformed response reads as "no positions for this refresh", never as
// someone else's, and a network error is the same empty answer.
const rpcIndexTest = CHAIN.uniV4?.positionRpcIndex ? test : test.skip

async function withLocation<T>(run: () => Promise<T>): Promise<T> {
  const originalLocation = globalThis.location
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://terminal.example' },
  })
  try {
    return await run()
  } finally {
    if (originalLocation) Object.defineProperty(globalThis, 'location', { configurable: true, value: originalLocation })
    else Reflect.deleteProperty(globalThis, 'location')
  }
}

async function withFetch<T>(respond: (url: string) => Response, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = ((input: unknown) => Promise.resolve(respond(String(input)))) as typeof fetch
  try {
    return await run()
  } finally {
    if (original) globalThis.fetch = original
    else Reflect.deleteProperty(globalThis, 'fetch')
  }
}

const OWNER = '0x00000000000000000000000000000000000000a1' as Address
const emptyRead = { cl: [], tokens: {} }

rpcIndexTest('RPC-index discovery asks the same-origin endpoint for the owner', async () => {
  let seen = ''
  await withLocation(() =>
    withFetch((url) => {
      seen = url
      return new Response(JSON.stringify({ chain: { key: CHAIN.key, id: CHAIN.id }, positions: [] }), { status: 200 })
    }, async () => {
      assert.deepEqual(await fetchV4Positions({} as PublicClient, OWNER), emptyRead)
    }),
  )
  assert.ok(seen.includes('/v4/positions'), seen)
  assert.ok(seen.includes(`owner=${OWNER.toLowerCase()}`), seen)
})

rpcIndexTest('RPC-index discovery fails closed on a wrong-chain response', async () => {
  await withLocation(() =>
    withFetch(
      () => new Response(JSON.stringify({ chain: { key: 'bsc', id: 56 }, positions: ['1'] }), { status: 200 }),
      async () => {
        assert.deepEqual(await fetchV4Positions({} as PublicClient, OWNER), emptyRead)
      },
    ),
  )
})

rpcIndexTest('RPC-index discovery fails closed on a non-array positions payload', async () => {
  await withLocation(() =>
    withFetch(
      () => new Response(JSON.stringify({ chain: { key: CHAIN.key, id: CHAIN.id }, positions: 'nope' }), { status: 200 }),
      async () => {
        assert.deepEqual(await fetchV4Positions({} as PublicClient, OWNER), emptyRead)
      },
    ),
  )
})

rpcIndexTest('RPC-index discovery fails closed on a network error', async () => {
  await withLocation(() =>
    withFetch(() => {
      throw new Error('offline')
    }, async () => {
      assert.deepEqual(await fetchV4Positions({} as PublicClient, OWNER), emptyRead)
    }),
  )
})
