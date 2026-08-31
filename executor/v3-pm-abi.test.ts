import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeFunctionData } from 'viem'
import { clPmAbi, uniV3PmAbi } from '../src/abi'

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
