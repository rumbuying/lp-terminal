import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeFunctionData, getAddress, slice, zeroAddress, type Address } from 'viem'
import { clSwapRouterFeeAbi } from '../abi'
import { ADDR, NATIVE } from '../config/addresses'
import { CHAIN } from '../config/chains'
import { buildDirectTransaction, type DirectRoute } from './directSwap'
import { HOME_CL_FEES, HOME_CL_FEE_KEYED } from './homeCl'

// The fee-keyed home CL (PancakeSwap v3). Its routing fixtures cannot share
// directSwap.test.ts, whose mock multicall responses are indexed for the
// tick-spacing shape — so this file covers the calldata that actually moves
// money, and runs only on a build whose home DEX is fee-keyed.
//
// The selectors asserted below were read off the deployed BSC bytecode on
// 2026-08-02: Pancake's SwapRouter carries exactInputSingle 0x414bf389 (the
// SwapRouter-v1 struct, deadline inside) and multicall(bytes[]) 0xac9650d8,
// while SwapRouter02's 0x04e45aaf is absent.
const feeKeyedTest = HOME_CL_FEE_KEYED ? test : test.skip

const tokenOut = getAddress('0x1111111111111111111111111111111111111111') as Address
const recipient = getAddress('0x2222222222222222222222222222222222222222') as Address
const feeReceiver = getAddress('0x3333333333333333333333333333333333333333') as Address
const zeroFee = { bps: 0, receiver: feeReceiver }

const feeRung = () => HOME_CL_FEES[0] ?? 2500

feeKeyedTest('a fee-keyed home route encodes the fee where the router expects it', () => {
  const transaction = buildDirectTransaction({
    tokenIn: NATIVE,
    tokenOut,
    amountIn: 20_000n,
    minimumAmountOut: 10_000n,
    recipient,
    deadline: 123n,
    route: { protocol: 'home', kind: 'cl', keyedBy: 'fee', feePpm: feeRung() },
    fee: zeroFee,
  })

  assert.equal(transaction.to.toLowerCase(), ADDR.CL_SWAP_ROUTER.toLowerCase())
  // native input rides as msg.value and needs no approval
  assert.equal(transaction.spender, null)
  assert.equal(transaction.inputToken, null)
  assert.equal(transaction.value, 20_000n)

  // multicall(bytes[]) — NOT SwapRouter02's multicall(uint256,bytes[])
  assert.equal(slice(transaction.data, 0, 4), '0xac9650d8')
  const outer = decodeFunctionData({ abi: clSwapRouterFeeAbi, data: transaction.data })
  assert.equal(outer.functionName, 'multicall')

  const swapData = outer.args[0][0]
  assert.equal(slice(swapData, 0, 4), '0x414bf389')
  const swap = decodeFunctionData({ abi: clSwapRouterFeeAbi, data: swapData })
  assert.equal(swap.functionName, 'exactInputSingle')
  assert.deepEqual(swap.args[0], {
    tokenIn: ADDR.WNATIVE,
    tokenOut,
    fee: feeRung(),
    recipient: zeroAddress,
    deadline: 123n,
    amountIn: 20_000n,
    amountOutMinimum: 10_000n,
    sqrtPriceLimitX96: 0n,
  })

  // a zero fee settles through the plain sweep, never the *WithFee variant
  const settle = decodeFunctionData({ abi: clSwapRouterFeeAbi, data: outer.args[0][1] })
  assert.equal(settle.functionName, 'sweepToken')
  assert.deepEqual(settle.args, [tokenOut, 10_000n, recipient])
})

feeKeyedTest('a tick-spacing route is refused rather than encoded as a fee', () => {
  // The two units share a slot: a spacing of 200 encoded as a fee tier would
  // silently address the 0.02% pool. The route carries its shape so this is
  // caught before any calldata exists.
  const wrongShape = {
    protocol: 'home',
    kind: 'cl',
    keyedBy: 'tickSpacing',
    tickSpacing: 200,
    feePpm: 10_000,
  } as unknown as DirectRoute
  assert.throws(
    () =>
      buildDirectTransaction({
        tokenIn: NATIVE,
        tokenOut,
        amountIn: 20_000n,
        minimumAmountOut: 10_000n,
        recipient,
        deadline: 123n,
        route: wrongShape,
        fee: zeroFee,
      }),
    /Unsupported direct route/,
  )
})

feeKeyedTest('a fee tier this chain does not run is refused', () => {
  const offLadder = HOME_CL_FEES.includes(3000) ? 7777 : 3000
  assert.throws(
    () =>
      buildDirectTransaction({
        tokenIn: NATIVE,
        tokenOut,
        amountIn: 20_000n,
        minimumAmountOut: 10_000n,
        recipient,
        deadline: 123n,
        route: { protocol: 'home', kind: 'cl', keyedBy: 'fee', feePpm: offLadder },
        fee: zeroFee,
      }),
    /Unsupported direct route/,
  )
})

feeKeyedTest('the home CL ladder carries the rungs the chain actually runs', () => {
  assert.ok(HOME_CL_FEES.length > 0)
  // Pancake's 2500 rung has no Uniswap counterpart and is where several live
  // bStock pools sit — losing it would quietly halve the venue's reach.
  if (CHAIN.key === 'bsc') {
    assert.ok(HOME_CL_FEES.includes(2500), 'BSC must probe Pancake’s 0.25% tier')
    assert.ok(!CHAIN.uniV3Fees.includes(2500), 'Uniswap has no 0.25% tier to fall back on')
  }
})
