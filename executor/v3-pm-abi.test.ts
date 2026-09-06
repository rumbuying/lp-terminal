import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeFunctionData, encodeFunctionData } from 'viem'
import { clPmAbi, uniV3PmAbi } from '../src/abi'
import { getAmountsForLiquidity, getLiquidityForAmounts, getSqrtRatioAtTick } from '../src/lib/clmath'
import type { StrategyConfig, StrategyPositionSnapshot } from '../shared/strategy/types'
import { mintCall } from './steps'

const owner = '0x0000000000000000000000000000000000000001'

for (const [name, abi] of [
  ['Slipstream', clPmAbi],
  ['Uniswap V3', uniV3PmAbi],
] as const) {
  test(`${name} position-manager ABI covers monitor and rebalance calls`, () => {
    const decrease = encodeFunctionData({
      abi,
      functionName: 'decreaseLiquidity',
      args: [{
        tokenId: 1n,
        liquidity: 2n,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: 3n,
      }],
    })
    const collect = encodeFunctionData({
      abi,
      functionName: 'collect',
      args: [{ tokenId: 1n, recipient: owner, amount0Max: 4n, amount1Max: 5n }],
    })

    assert.match(encodeFunctionData({ abi, functionName: 'ownerOf', args: [1n] }), /^0x[0-9a-f]+$/)
    assert.match(encodeFunctionData({ abi, functionName: 'multicall', args: [[decrease, collect]] }), /^0x[0-9a-f]+$/)
    assert.match(encodeFunctionData({ abi, functionName: 'burn', args: [1n] }), /^0x[0-9a-f]+$/)
  })
}

test('Uniswap V3 mint minima stay satisfiable when price moves inside the configured band', () => {
  // Production STONKBROKER failure from 2026-09-06: price moved 95 ticks
  // (0.95%) inside a 1% guard, but the NPM resized liquidity against the fixed
  // desired amounts and token1 fell below minima computed from the old size.
  const sqrtAtPlan = 30878640708524949619727287955233n // tick 119315
  const sqrtAtInclusion = 30731260818885556370707435896508n // tick 119220
  const tickLower = 118980
  const tickUpper = 119640
  const amount0Desired = 73979205327105956n
  const amount1Desired = 11588389101563970514222n
  const positionManager = '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3'
  const token0 = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'
  const token1 = '0xe934e36A439C94017B64a3FecE66AF12099aBF50'
  const config = {
    protocol: 'univ3', owner, positionManager,
    safeguards: { enabled: true, maxSlippageBps: 100 },
  } as unknown as StrategyConfig
  const snapshot = {
    protocol: 'univ3', owner, positionManager, token0, token1,
    tickSpacing: 60, feePpm: 3000, sqrtPriceX96: sqrtAtPlan.toString(),
  } as unknown as StrategyPositionSnapshot

  const call = mintCall({
    config, snapshot, tickLower, tickUpper, amount0Desired, amount1Desired,
    feePpm: 3000, sqrtPriceX96: sqrtAtPlan,
  })
  const decoded = decodeFunctionData({ abi: uniV3PmAbi, data: call.data })
  const params = decoded.args[0] as {
    amount0Desired: bigint
    amount1Desired: bigint
    amount0Min: bigint
    amount1Min: bigint
  }
  const sqrtA = getSqrtRatioAtTick(tickLower)
  const sqrtB = getSqrtRatioAtTick(tickUpper)
  const inclusionLiquidity = getLiquidityForAmounts(
    sqrtAtInclusion, sqrtA, sqrtB, params.amount0Desired, params.amount1Desired,
  )
  const inclusionAmounts = getAmountsForLiquidity(sqrtAtInclusion, sqrtA, sqrtB, inclusionLiquidity)

  assert.ok(inclusionAmounts.amount0 >= params.amount0Min, 'token0 minimum must pass inside the band')
  assert.ok(inclusionAmounts.amount1 >= params.amount1Min, 'token1 minimum must pass inside the band')
})
