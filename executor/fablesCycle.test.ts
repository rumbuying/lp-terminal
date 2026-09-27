import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeAbiParameters, encodeEventTopics, zeroAddress } from 'viem'
import { fablesHookAbi } from '../src/abi/fables'
import { allocateFablesFees, claimedFablesFees, cycleOwnedAmounts, fablesSwapImpactBps, mintedFablesShares } from './fablesCycle'

const hook = '0x06a889870c8f83640d6816319f72e2aa579b6080' as const
const owner = '0x0000000000000000000000000000000000000001' as const
const token = '0x0000000000000000000000000000000000000002' as const

test('cycle spending excludes preexisting wallet assets and native gas loss', () => {
  assert.deepEqual(cycleOwnedAmounts({ currency0: zeroAddress, currency1: token,
    baseline: { amount0: 1_000n, amount1: 9_000n },
    current: { amount0: 900n, amount1: 9_500n } }), { amount0: 0n, amount1: 500n })
  assert.throws(() => cycleOwnedAmounts({ currency0: zeroAddress, currency1: token,
    baseline: { amount0: 1_000n, amount1: 9_000n },
    current: { amount0: 900n, amount1: 8_900n } }), /BALANCE_FELL/)
})

test('fee handling allocates only actual cycle-owned balances', () => {
  const funds = { amount0: 90n, amount1: 200n }
  const fees = { amount0: 100n, amount1: 30n }
  assert.deepEqual(allocateFablesFees(funds, fees, 'hold_tokens'), {
    lp: { amount0: 0n, amount1: 170n }, held: { amount0: 90n, amount1: 30n },
  })
  assert.deepEqual(allocateFablesFees(funds, fees, 'reinvest').lp, funds)
})

test('claimed fees are decoded from the actual matching receipt event', () => {
  const topics = encodeEventTopics({ abi: fablesHookAbi, eventName: 'FeesClaimed', args: { owner, rangeId: 7n } })
  const receipt = { logs: [
    { address: hook, topics, data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [12n, 34n]) },
    { address: hook, topics: encodeEventTopics({ abi: fablesHookAbi, eventName: 'FeesClaimed', args: { owner, rangeId: 8n } }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [99n, 99n]) },
  ] } as never
  assert.deepEqual(claimedFablesFees(receipt, hook, owner, 7n), { amount0: 12n, amount1: 34n })
})

test('swap price protection rejects a route with excessive executable shortfall', () => {
  const sqrt = 1n << 96n
  assert.equal(fablesSwapImpactBps({ amountIn: 1000n, quotedOut: 990n,
    tokenIn: zeroAddress, currency0: zeroAddress, sqrtPriceX96: sqrt }), 100n)
})

test('new range shares come only from the deposit receipt mint', () => {
  const topics = encodeEventTopics({ abi: fablesHookAbi, eventName: 'Transfer',
    args: { from: zeroAddress, to: owner, id: 7n } })
  const receipt = { logs: [{ address: hook, topics,
    data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [owner, 42n]) }] } as never
  assert.equal(mintedFablesShares(receipt, hook, owner, 7n), 42n)
  assert.equal(mintedFablesShares(receipt, hook, owner, 8n), 0n)
})
