import assert from 'node:assert/strict'
import test from 'node:test'
import type { Address, PublicClient } from 'viem'
import { ADDR, UNI } from '../config/addresses'
import { getSqrtRatioAtTick } from './clmath'
import type { ClPool, PositionsData } from '../types'

const user = '0x0000000000000000000000000000000000000abc' as Address
const risk = '0x0000000000000000000000000000000000002000' as Address
const poolAddress = '0x0000000000000000000000000000000000001000' as Address

test('known position refresh updates price, liquidity and exact fees without rediscovery', async () => {
  const { refreshKnownPositions } = await import('../hooks/usePositions')
  const pool: ClPool = {
    kind: 'cl', protocol: 'univ3', address: poolAddress, token0: risk, token1: ADDR.WETH,
    tickSpacing: 60, feePpm: 3_000, unstakedFeePpm: 0, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0,
    liquidity: 1_000n, stakedLiquidity: 0n, gauge: null, gaugeAlive: false, weight: 0n, rewardRate: 0n, periodFinish: 0n,
  }
  const known: PositionsData = {
    cl: [{ tokenId: 7n, pool, tickLower: -100, tickUpper: 100, liquidity: 1_000n, staked: false, amount0: 0n, amount1: 0n, fees0: 0n, fees1: 0n, earned: 0n }],
    v2: [],
    tokens: {},
  }
  let multicalls = 0
  let simulations = 0
  const raw = [0n, '0x0000000000000000000000000000000000000000', risk, ADDR.WETH, 3_000, -100, 100, 2_000n, 0n, 0n, 3n, 4n] as const
  const client = {
    multicall: async ({ contracts }: { contracts: any[] }) => {
      multicalls += 1
      return contracts.map((contract) => {
        const result = contract.functionName === 'ownerOf' ? user
          : contract.functionName === 'positions' ? raw
            : contract.functionName === 'slot0' ? [getSqrtRatioAtTick(25), 25, 0, 0, 0, 0, true]
              : contract.functionName === 'liquidity' ? 9_000n
                : undefined
        return result === undefined ? { status: 'failure' } : { status: 'success', result }
      })
    },
    simulateContract: async ({ address }: { address: Address }) => {
      simulations += 1
      assert.equal(address.toLowerCase(), UNI.V3_NPM.toLowerCase())
      return { result: [30n, 40n] }
    },
  } as unknown as PublicClient
  const refreshed = await refreshKnownPositions(client, user, { pools: [], tokens: {}, protocol: { weekly: 0n, epochCount: 0, activePeriod: 0, totalWeight: 0n, capMode: 0, blockNumber: 1n } }, known)
  assert.equal(multicalls, 1)
  assert.equal(simulations, 1)
  assert.equal(refreshed.cl[0].pool.tick, 25)
  assert.equal(refreshed.cl[0].liquidity, 2_000n)
  assert.equal(refreshed.cl[0].fees0, 30n)
  assert.equal(refreshed.cl[0].fees1, 40n)
})
