import assert from 'node:assert/strict'
import test from 'node:test'
import { zeroAddress } from 'viem'
import { v4Deployment } from '../../src/config/networks'
import { v4PoolId, type V4PoolKey } from '../../src/lib/uniV4'
import { originalStrategyDraft, parseStrategyConfig } from './schema'

const owner = '0x0000000000000000000000000000000000000001' as const
const token = '0x0000000000000000000000000000000000000002' as const

test('v4 strategy persists the singleton-safe pool identity', () => {
  const deployment = v4Deployment(4663)
  const key: V4PoolKey = { currency0: zeroAddress, currency1: token, fee: 3000, tickSpacing: 60, hooks: zeroAddress }
  const config = originalStrategyDraft({
    chainId: 4663,
    owner,
    protocol: 'univ4',
    pool: deployment.POOL_MANAGER,
    poolId: v4PoolId(key),
    hooks: key.hooks,
    positionManager: deployment.POSITION_MANAGER,
    riskToken: token,
    quoteToken: zeroAddress,
    activeTokenId: '7',
  })
  const parsed = parseStrategyConfig(config)
  assert.equal(parsed.protocol, 'univ4')
  assert.equal(parsed.poolId, v4PoolId(key))
  assert.equal(parsed.hooks, zeroAddress)
})

test('v4 strategy cannot collapse every pool onto the singleton address', () => {
  const deployment = v4Deployment(4663)
  const config = originalStrategyDraft({
    chainId: 4663,
    owner,
    protocol: 'univ4',
    pool: deployment.POOL_MANAGER,
    poolId: `0x${'11'.repeat(32)}`,
    positionManager: deployment.POSITION_MANAGER,
    riskToken: token,
    quoteToken: zeroAddress,
  })
  assert.throws(() => parseStrategyConfig({ ...config, poolId: undefined }), /poolId/)
})
