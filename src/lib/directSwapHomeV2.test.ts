import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeFunctionData, getAddress, slice, type Address } from 'viem'
import { uniSwapRouterAbi } from '../abi'
import { ADDR, CONNECTORS, NATIVE, UNI } from '../config/addresses'
import { CHAIN } from '../config/chains'
import {
  buildDirectTransaction,
  directRouteFeePpm,
  directRouteLabel,
  type DirectRoute,
} from './directSwap'

/**
 * The home DEX's v2 leg (PancakeSwap v2). It runs only where the chain declares
 * one it can encode — Robinhood's v2 is a Solidly fork with no encoder, so
 * `homeV2` is null there and every assertion below would be vacuous.
 *
 * The two facts this file pins were both measured against BSC on 2026-08-02:
 *
 *  - `getAmountOut(1e18, 1e30, 1e30)` returns 997499999999004993 on Pancake's
 *    v2 router and 996999999999005991 on Uniswap's, i.e. 2500 ppm against
 *    3000 ppm. The two v2 venues on one chain do NOT share a fee, so a route
 *    carrying the wrong one would net out the wrong minimum.
 *  - Pancake's SmartRouter carries the SwapRouter02 surface —
 *    swapExactTokensForTokens 0x472b43f3 and multicall(uint256,bytes[])
 *    0x5ae401dc are both in the deployed bytecode, and it embeds no Permit2
 *    address, so a plain ERC-20 approval to it is enough.
 */
const HOME_V2 = CHAIN.homeV2
const homeV2Test = HOME_V2 ? test : test.skip

const tokenOut = getAddress('0x1111111111111111111111111111111111111111') as Address
const recipient = getAddress('0x2222222222222222222222222222222222222222') as Address
const feeReceiver = getAddress('0x3333333333333333333333333333333333333333') as Address
const zeroFee = { bps: 0, receiver: feeReceiver }

const homeV2Route = (connector?: Address): DirectRoute =>
  ({ protocol: 'home', kind: 'v2', feePpm: HOME_V2?.feePpm ?? 0, connector }) as DirectRoute

const build = (route: DirectRoute) =>
  buildDirectTransaction({
    tokenIn: NATIVE,
    tokenOut,
    amountIn: 20_000n,
    minimumAmountOut: 10_000n,
    recipient,
    deadline: 123n,
    route,
    fee: zeroFee,
  })

homeV2Test('a home v2 swap executes on the venue’s SwapRouter02, not its v2 router', () => {
  const transaction = build(homeV2Route())

  // The plain v2 router has no sweep fragment, so settling the terminal fee in
  // the same transaction requires the SwapRouter02-shaped one.
  assert.equal(transaction.to.toLowerCase(), HOME_V2!.SWAP_ROUTER.toLowerCase())
  assert.notEqual(transaction.to.toLowerCase(), ADDR.V2_ROUTER.toLowerCase())
  // and it is the home venue's router, never Uniswap's
  assert.notEqual(transaction.to.toLowerCase(), UNI.V3_SWAP_ROUTER.toLowerCase())

  // native input rides as msg.value and needs no approval
  assert.equal(transaction.spender, null)
  assert.equal(transaction.inputToken, null)
  assert.equal(transaction.value, 20_000n)

  // SwapRouter02's deadline-carrying multicall, not the v1 multicall(bytes[])
  assert.equal(slice(transaction.data, 0, 4), '0x5ae401dc')
  const outer = decodeFunctionData({ abi: uniSwapRouterAbi, data: transaction.data })
  assert.equal(outer.functionName, 'multicall')
  assert.equal(outer.args[0], 123n)

  const swapData = outer.args[1][0]
  assert.equal(slice(swapData, 0, 4), '0x472b43f3')
  const swap = decodeFunctionData({ abi: uniSwapRouterAbi, data: swapData })
  assert.equal(swap.functionName, 'swapExactTokensForTokens')
  // the swap pays the ROUTER, so the sweep that follows can split out the fee
  assert.deepEqual(swap.args, [20_000n, 10_000n, [ADDR.WNATIVE, tokenOut], HOME_V2!.SWAP_ROUTER])

  const settle = decodeFunctionData({ abi: uniSwapRouterAbi, data: outer.args[1][1] })
  assert.equal(settle.functionName, 'sweepToken')
  assert.deepEqual(settle.args, [tokenOut, 10_000n, recipient])
})

homeV2Test('an ERC-20 input approves the home venue’s router, not Uniswap’s', () => {
  const transaction = buildDirectTransaction({
    tokenIn: ADDR.STABLE,
    tokenOut,
    amountIn: 20_000n,
    minimumAmountOut: 10_000n,
    recipient,
    deadline: 123n,
    route: homeV2Route(),
    fee: zeroFee,
  })
  assert.equal(transaction.value, 0n)
  assert.equal(transaction.spender?.toLowerCase(), HOME_V2!.SWAP_ROUTER.toLowerCase())
  assert.equal(transaction.inputToken?.toLowerCase(), ADDR.STABLE.toLowerCase())
})

homeV2Test('the home v2 fee is the venue’s own, and differs from Uniswap’s', () => {
  assert.equal(directRouteFeePpm(homeV2Route()), HOME_V2!.feePpm)
  assert.equal(directRouteFeePpm({ protocol: 'uniswap', kind: 'v2', feePpm: 3000 }), 3000)
  // The measurement that motivates the whole field: reusing Uniswap's 3000 for
  // Pancake would overstate the fee by 5 bps on every v2 quote.
  if (CHAIN.key === 'bsc') {
    assert.equal(HOME_V2!.feePpm, 2500)
    assert.notEqual(HOME_V2!.feePpm, 3000)
  }
})

homeV2Test('a two-hop home v2 route pays the venue fee once per pair', () => {
  const connector = CONNECTORS.find(
    (c) => c.toLowerCase() !== ADDR.WNATIVE.toLowerCase() && c.toLowerCase() !== tokenOut.toLowerCase(),
  )
  assert.ok(connector, 'chain must configure a connector to test the two-hop path')
  const route = homeV2Route(connector)
  assert.equal(directRouteFeePpm(route), HOME_V2!.feePpm * 2)

  const outer = decodeFunctionData({ abi: uniSwapRouterAbi, data: build(route).data })
  assert.equal(outer.functionName, 'multicall')
  const swap = decodeFunctionData({ abi: uniSwapRouterAbi, data: outer.args[1][0] })
  assert.equal(swap.functionName, 'swapExactTokensForTokens')
  // the connector sits between the endpoints, so the leg crosses two pairs
  assert.deepEqual(swap.args, [
    20_000n,
    10_000n,
    [ADDR.WNATIVE, getAddress(connector), tokenOut],
    HOME_V2!.SWAP_ROUTER,
  ])
})

homeV2Test('a home v2 route carrying Uniswap’s fee is refused', () => {
  // Same slot, different venue: 3000 is a valid v2 fee — on the other venue.
  // Encoding it here would quote and settle 5 bps light.
  const wrongVenueFee = { protocol: 'home', kind: 'v2', feePpm: 3000 } as unknown as DirectRoute
  assert.throws(() => build(wrongVenueFee), /Unsupported direct route/)
})

homeV2Test('the home v2 route is labelled after its own venue and fee', () => {
  const label = directRouteLabel(homeV2Route())
  assert.ok(label.startsWith(CHAIN.labels.homeV2), `${label} must name ${CHAIN.labels.homeV2}`)
  assert.ok(!label.includes('Uniswap'), `${label} must not claim Uniswap`)
  assert.ok(label.includes(`${HOME_V2!.feePpm / 10_000}%`), `${label} must carry the venue fee`)
})

// The inverse guard, on a chain that declares no encodable home v2: no such
// route may validate, whatever fee it claims.
const noHomeV2Test = HOME_V2 ? test.skip : test
noHomeV2Test('a chain with no encodable home v2 refuses every home v2 route', () => {
  for (const feePpm of [2500, 3000, 0]) {
    assert.throws(
      () => build({ protocol: 'home', kind: 'v2', feePpm } as unknown as DirectRoute),
      /Unsupported direct route/,
    )
  }
})
