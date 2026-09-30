import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeAbiParameters, encodeEventTopics, zeroAddress } from 'viem'
import { fablesHookAbi } from '../src/abi/fables'
import { getSqrtRatioAtTick } from '../src/lib/clmath'
import { fablesRangeId, type FablesPosition } from '../src/lib/fables'
import type { FablesStrategyConfig } from '../shared/strategy/types'
import { allocateFablesFees, claimedFablesFees, cycleOwnedAmounts, cycleSpendableAmounts, fablesSweepFloor, fablesSwapImpactBps, fablesTargetValueBps,
  freshFablesRange, mintedFablesShares } from './fablesCycle'

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

test('cycle spending sweeps all idle above the native gas reserve', () => {
  const currencies = { currency0: zeroAddress, currency1: token }
  assert.deepEqual(cycleSpendableAmounts({ ...currencies,
    current: { amount0: 244n, amount1: 240n }, nativeGasReserve: 10n,
  }), { amount0: 234n, amount1: 240n })
  assert.deepEqual(cycleSpendableAmounts({ ...currencies,
    current: { amount0: 9n, amount1: 240n }, nativeGasReserve: 10n,
  }), { amount0: 0n, amount1: 240n })
  assert.deepEqual(cycleSpendableAmounts({ ...currencies,
    current: { amount0: 10n, amount1: 0n }, nativeGasReserve: 10n,
  }), { amount0: 0n, amount1: 0n })
})

test('sweep floor covers the deposit tx gas and a gas-price drift margin', () => {
  // The signer demands wallet ≥ max0 + gas + reserve with max0 up to budget:
  // a floor of reserve alone leaves the deposit's own gas unfunded.
  assert.equal(fablesSweepFloor(10n, 0n), 10n)
  assert.equal(fablesSweepFloor(10n, 2n), 16n)
  assert.throws(() => fablesSweepFloor(-1n, 1n), /GAS_RESERVE/)
  // A swept wallet sits at the floor; the next precheck needs reserve +
  // estimatedGas at the then-current price — 3× drift margin keeps it passing.
  const reserve = 100n
  const estimatedGas = 5n
  const floor = fablesSweepFloor(reserve, estimatedGas)
  assert.ok(floor >= reserve + estimatedGas)
  assert.ok(floor >= fablesSweepFloor(reserve, estimatedGas))
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

test('preview value split uses the pool spot price and raw token units', () => {
  const units = { amount0: 1n, amount1: 3n }
  assert.deepEqual(fablesTargetValueBps(units, 1n << 96n), { token0: 2_500, token1: 7_500 })
  assert.deepEqual(fablesTargetValueBps(units, 2n << 96n), { token0: 5_714, token1: 4_286 })
  assert.throws(() => fablesTargetValueBps({ amount0: 0n, amount1: 3n }, 1n << 96n), /TARGET_RATIO/)
})

test('new range shares come only from the deposit receipt mint', () => {
  const topics = encodeEventTopics({ abi: fablesHookAbi, eventName: 'Transfer',
    args: { from: zeroAddress, to: owner, id: 7n } })
  const receipt = { logs: [{ address: hook, topics,
    data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [owner, 42n]) }] } as never
  assert.equal(mintedFablesShares(receipt, hook, owner, 7n), 42n)
  assert.equal(mintedFablesShares(receipt, hook, owner, 8n), 0n)
})

test('recenter uses the newest pool tick to choose a distinct share range', () => {
  const config = { riskToken: zeroAddress, range: { lowerPct: 5, upperPct: 5 } } as unknown as FablesStrategyConfig
  const base = { pool: { id: `0x${'11'.repeat(32)}`,
    key: { currency0: zeroAddress, currency1: token, tickSpacing: 10 } } } as unknown as FablesPosition
  const first = freshFablesRange(config, { ...base, tick: -197_000,
    sqrtPriceX96: getSqrtRatioAtTick(-197_000) }, 18, 6)
  const moved = freshFablesRange(config, { ...base, tick: -196_000,
    sqrtPriceX96: getSqrtRatioAtTick(-196_000) }, 18, 6)
  assert.notEqual(fablesRangeId(base.pool.id, first.tickLower, first.tickUpper),
    fablesRangeId(base.pool.id, moved.tickLower, moved.tickUpper))
  assert.ok(first.tickLower < -197_000 && first.tickUpper > -197_000)
  assert.ok(moved.tickLower < -196_000 && moved.tickUpper > -196_000)
})
