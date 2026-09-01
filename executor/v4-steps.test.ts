import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeFunctionData, zeroAddress } from 'viem'
import { v4Deployment } from '../src/config/networks'
import { v4PoolId, v4PositionManagerAbi, type V4PoolKey } from '../src/lib/uniV4'
import type { StrategyConfig, StrategyPositionSnapshot } from '../shared/strategy/types'
import { decreaseCall, mintCall, v4DecreaseCall, v4MintCall } from './steps'

const token = '0x0000000000000000000000000000000000000002' as const
const owner = '0x0000000000000000000000000000000000000003' as const
const deployment = v4Deployment(4663)
const key: V4PoolKey = { currency0: zeroAddress, currency1: token, fee: 3000, tickSpacing: 60, hooks: zeroAddress }
const config = {
  protocol: 'univ4', chainId: 4663, owner,
  pool: deployment.POOL_MANAGER, poolId: v4PoolId(key), hooks: zeroAddress,
  positionManager: deployment.POSITION_MANAGER,
  safeguards: { enabled: false, maxSlippageBps: 100 },
} as unknown as StrategyConfig
const snapshot = {
  protocol: 'univ4', chainId: 4663, owner,
  pool: deployment.POOL_MANAGER, poolId: v4PoolId(key), hooks: zeroAddress,
  positionManager: deployment.POSITION_MANAGER, tokenId: '7',
  token0: zeroAddress, token1: token, token0Decimals: 18, token1Decimals: 18,
  tickSpacing: 60, feePpm: 3000, unstakedFeePpm: 0,
  tick: 0, sqrtPriceX96: (1n << 96n).toString(), tickLower: -120, tickUpper: 120,
  liquidity: '1000000000000000000', tokensOwed0: '0', tokensOwed1: '0',
  observedAt: 1, blockNumber: '1',
} as StrategyPositionSnapshot

test('v4 executor exits through modifyLiquidities rather than a v3 ABI', () => {
  const call = v4DecreaseCall(config, snapshot)
  const decoded = decodeFunctionData({ abi: v4PositionManagerAbi, data: call.data })
  assert.equal(call.to, deployment.POSITION_MANAGER)
  assert.equal(call.value, 0n)
  assert.equal(decoded.functionName, 'modifyLiquidities')
})

test('v4 native mint carries only the declared native ceiling as msg.value', () => {
  const amount0 = 10n ** 15n
  const call = v4MintCall({
    config,
    snapshot,
    tickLower: -120,
    tickUpper: 120,
    amount0Desired: amount0,
    amount1Desired: 10n ** 15n,
    sqrtPriceX96: 1n << 96n,
  })
  const decoded = decodeFunctionData({ abi: v4PositionManagerAbi, data: call.data })
  assert.equal(call.value, amount0)
  assert.equal(decoded.functionName, 'modifyLiquidities')
})

test('the v3 decrease builder refuses a v4 strategy instead of building a wrong ABI', () => {
  assert.throws(() => decreaseCall(config, snapshot), /E_V4_USE_V4_BUILDER/)
})

test('the generic mint builder routes a v4 strategy to modifyLiquidities', () => {
  const amount0 = 10n ** 15n
  const call = mintCall({
    config,
    snapshot,
    tickLower: -120,
    tickUpper: 120,
    amount0Desired: amount0,
    amount1Desired: 10n ** 15n,
    sqrtPriceX96: 1n << 96n,
  })
  const decoded = decodeFunctionData({ abi: v4PositionManagerAbi, data: call.data })
  assert.equal(call.value, amount0)
  assert.equal(decoded.functionName, 'modifyLiquidities')
})
