import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeFunctionData, zeroAddress, type Address } from 'viem'
import { NATIVE } from '../src/config/addresses'
import { uniSwapRouterAbi } from '../src/abi'
import { buildDirectTransaction } from '../src/lib/directSwap'
import { V4_NATIVE, directBuildCurrency } from './fablesLimits'

const PONS = '0x39dBED3a2bd333467115dE45665cC57F813C4571' as Address
const OWNER = '0x2Bb53df69EFA1b967660F2780DDcF6f76F90ae78' as Address

const build = (tokenIn: Address, tokenOut: Address) => buildDirectTransaction({
  tokenIn, tokenOut, amountIn: 1_000_000_000_000_000_000n, minimumAmountOut: 1n,
  recipient: OWNER, deadline: BigInt(Math.floor(Date.now() / 1000) + 60),
  route: { protocol: 'uniswap', kind: 'v3', feePpm: 3000 }, fee: { bps: 0, receiver: OWNER },
})

const innerCalls = (data: `0x${string}`) => {
  const outer = decodeFunctionData({ abi: uniSwapRouterAbi, data })
  assert.equal(outer.functionName, 'multicall')
  return ((outer.args as readonly unknown[])[1] as readonly `0x${string}`[])
    .map(call => decodeFunctionData({ abi: uniSwapRouterAbi, data: call }).functionName)
}

test('a v4 pool currency maps onto the builder native sentinel', () => {
  assert.equal(V4_NATIVE, zeroAddress)
  assert.equal(directBuildCurrency(V4_NATIVE), NATIVE)
  assert.equal(directBuildCurrency(PONS), PONS)
})

test('a Fables native-output leg unwraps WETH9 instead of sweeping address zero', () => {
  // The zero address is what a Fables pool key reports for native value; the
  // raw value made the builder settle with sweepToken(0x0), whose balanceOf
  // call returns empty returndata and reverts without a reason.
  const fixed = innerCalls(build(PONS, directBuildCurrency(V4_NATIVE)).data)
  assert.deepEqual(fixed, ['exactInputSingle', 'unwrapWETH9'])
  const raw = innerCalls(build(PONS, V4_NATIVE).data)
  assert.deepEqual(raw, ['exactInputSingle', 'sweepToken'])
})

test('a Fables native-input leg spends value and needs no token approval', () => {
  const tx = build(directBuildCurrency(V4_NATIVE), PONS)
  assert.equal(tx.value, 1_000_000_000_000_000_000n)
  assert.equal(tx.spender, null)
  assert.deepEqual(innerCalls(tx.data), ['exactInputSingle', 'sweepToken'])
})
