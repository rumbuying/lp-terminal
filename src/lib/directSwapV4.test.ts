import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeAbiParameters,
  decodeFunctionData,
  getAddress,
  parseAbiParameters,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { ADDR, NATIVE } from '../config/addresses'
import { CHAIN } from '../config/chains'
import {
  buildDirectTransaction,
  directRouteLabel,
  grossMinimumForNet,
  netAfterFee,
  type DirectRoute,
} from './directSwap'
import { UNI_V4, universalRouterAbi, v4Currency, v4PoolId, v4PoolKey } from './uniV4'

/**
 * Uniswap v4. Runs only where the chain declares a deployment.
 *
 * Everything asserted here was first established against BSC on 2026-08-02 by
 * simulating the builder's OWN calldata through the deployed UniversalRouter:
 * a native-in swap with a 25bp fee passes, a doubled minimum reverts with
 * V4TooLittleReceived, and an ERC-20-in swap passes only when BOTH allowance
 * legs are present — it reverts with AllowanceExpired when the Permit2 leg is
 * missing, which is why `permit2Operator` exists at all.
 */
const V4 = UNI_V4
const v4Test = V4 ? test : test.skip

const tokenOut = getAddress('0x1111111111111111111111111111111111111111') as Address
const recipient = getAddress('0x2222222222222222222222222222222222222222') as Address
const feeReceiver = getAddress('0x3333333333333333333333333333333333333333') as Address

const rung = () => V4?.rungs[1] ?? V4?.rungs[0] ?? { fee: 500, tickSpacing: 10 }
const v4Route = (): DirectRoute => ({
  protocol: 'uniswap',
  kind: 'v4',
  feePpm: rung().fee,
  tickSpacing: rung().tickSpacing,
})

const build = (args: { tokenIn: Address; tokenOut: Address; fee: { bps: number; receiver: Address } }) =>
  buildDirectTransaction({
    tokenIn: args.tokenIn,
    tokenOut: args.tokenOut,
    amountIn: 20_000n,
    minimumAmountOut: 10_000n,
    recipient,
    deadline: 123n,
    route: v4Route(),
    fee: args.fee,
  })

/** unwrap execute(commands, inputs, deadline) -> the v4 action list and params */
function decodeV4(data: Hex): { commands: Hex; actions: Hex; params: readonly Hex[]; deadline: bigint } {
  const outer = decodeFunctionData({ abi: universalRouterAbi, data })
  assert.equal(outer.functionName, 'execute')
  const [commands, inputs, deadline] = outer.args
  const [actions, params] = decodeAbiParameters(parseAbiParameters('bytes, bytes[]'), inputs[0])
  return { commands, actions, params, deadline }
}

const swapParams = parseAbiParameters(
  '((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)',
)

v4Test('a v4 swap dispatches V4_SWAP and settles, skims, then takes — in that order', () => {
  const tx = build({ tokenIn: NATIVE, tokenOut, fee: { bps: 25, receiver: feeReceiver } })
  assert.equal(tx.to.toLowerCase(), V4!.UNIVERSAL_ROUTER.toLowerCase())

  const { commands, actions, params, deadline } = decodeV4(tx.data)
  assert.equal(commands, '0x10', 'the only command is V4_SWAP')
  assert.equal(deadline, 123n)
  // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_PORTION, TAKE
  assert.equal(actions, '0x060c100e')
  assert.equal(params.length, 4)

  const [swap] = decodeAbiParameters(swapParams, params[0])
  // The floor the POOL must clear is the pre-fee one, because TAKE_PORTION
  // skims afterwards — clearing it guarantees the net minimum, and the router
  // reverts with V4TooLittleReceived before any fee is taken.
  assert.equal(swap.amountOutMinimum, grossMinimumForNet(10_000n, 25))
  assert.ok(swap.amountOutMinimum > 10_000n, 'the gross floor sits above the net one')
  assert.ok(netAfterFee(swap.amountOutMinimum, 25) >= 10_000n)
  assert.equal(swap.amountIn, 20_000n)
  assert.equal(swap.hookData, '0x')
  assert.equal(swap.poolKey.fee, rung().fee)
  assert.equal(swap.poolKey.tickSpacing, rung().tickSpacing)
  assert.equal(swap.poolKey.hooks, zeroAddress)

  // the fee is skimmed off the OUTPUT currency, to the configured receiver
  const [portion] = [decodeAbiParameters(parseAbiParameters('address, address, uint256'), params[2])]
  assert.equal(getAddress(portion[1]), feeReceiver)
  assert.equal(portion[2], 25n)
  // and the remainder goes to the recipient, not to whoever sent the tx
  const [take] = [decodeAbiParameters(parseAbiParameters('address, address, uint256'), params[3])]
  assert.equal(getAddress(take[1]), recipient)
  assert.equal(take[2], 0n, 'OPEN_DELTA — take whatever is left, not a fixed amount')
})

v4Test('a zero terminal fee omits the skim rather than passing zero bips', () => {
  const { actions, params } = decodeV4(
    build({ tokenIn: NATIVE, tokenOut, fee: { bps: 0, receiver: feeReceiver } }).data,
  )
  // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE — no TAKE_PORTION
  assert.equal(actions, '0x060c0e')
  assert.equal(params.length, 3)
})

v4Test('the native coin stays address(0) — it is NOT folded onto its wrapper', () => {
  // This is the whole reason v4Currency exists. On BSC the native BNB/USDT
  // 0.05% pool holds roughly twelve times the WBNB-keyed pool's liquidity, so
  // normalising the native sentinel to WNATIVE would silently route into the
  // shallow one.
  assert.equal(v4Currency(NATIVE), zeroAddress)
  assert.equal(v4Currency(ADDR.WNATIVE), ADDR.WNATIVE)
  assert.notEqual(v4Currency(NATIVE), v4Currency(ADDR.WNATIVE))

  const nativeKey = v4PoolKey(v4Currency(NATIVE), ADDR.STABLE, rung().fee, rung().tickSpacing)
  const wrappedKey = v4PoolKey(v4Currency(ADDR.WNATIVE), ADDR.STABLE, rung().fee, rung().tickSpacing)
  assert.notEqual(v4PoolId(nativeKey), v4PoolId(wrappedKey), 'these must be different pools')

  const { params } = decodeV4(build({ tokenIn: NATIVE, tokenOut, fee: { bps: 0, receiver: feeReceiver } }).data)
  const [swap] = decodeAbiParameters(swapParams, params[0])
  const currencies = [swap.poolKey.currency0, swap.poolKey.currency1].map((c) => c.toLowerCase())
  assert.ok(currencies.includes(zeroAddress), 'a native-in swap must key on address(0)')
  assert.ok(!currencies.includes(ADDR.WNATIVE.toLowerCase()), 'and must not key on the wrapper')
})

v4Test('poolId reproduces a pool that exists on chain', () => {
  // Golden value, read back from BSC on 2026-08-02: the native BNB/USDT 0.05%
  // pool, whose StateView.getSlot0 reports a live price and ~1.14e23 liquidity.
  // If the key encoding ever drifts, this is the assertion that notices.
  if (CHAIN.key !== 'bsc') return
  const key = v4PoolKey(zeroAddress as Address, ADDR.STABLE, 500, 10)
  assert.equal(key.currency0, zeroAddress, 'native sorts first')
  assert.equal(
    v4PoolId(key),
    '0xa77d89e40ddd6a57b72ad4a8c55554b2fd6171026c903462a9f9c7be133811a6',
  )
})

v4Test('an ERC-20 input approves Permit2 AND names the router as its operator', () => {
  const tx = build({ tokenIn: ADDR.STABLE, tokenOut, fee: { bps: 0, receiver: feeReceiver } })
  assert.equal(tx.value, 0n)
  // the token is approved to Permit2 — never to the router
  assert.equal(tx.spender?.toLowerCase(), V4!.PERMIT2.toLowerCase())
  assert.notEqual(tx.spender?.toLowerCase(), V4!.UNIVERSAL_ROUTER.toLowerCase())
  // and Permit2 must then be approved to the router, or settlement reverts
  assert.equal(tx.permit2Operator?.toLowerCase(), V4!.UNIVERSAL_ROUTER.toLowerCase())
  assert.equal(tx.inputToken?.toLowerCase(), ADDR.STABLE.toLowerCase())
})

v4Test('a native input needs no approval at all', () => {
  const tx = build({ tokenIn: NATIVE, tokenOut, fee: { bps: 0, receiver: feeReceiver } })
  assert.equal(tx.value, 20_000n)
  assert.equal(tx.spender, null)
  assert.equal(tx.inputToken, null)
  assert.equal(tx.permit2Operator, null, 'msg.value settles the input; Permit2 is not involved')
})

v4Test('every other kind of route stays free of the Permit2 leg', () => {
  const clRoute: DirectRoute = CHAIN.homeCl.keyedBy === 'fee'
    ? { protocol: 'home', kind: 'cl', keyedBy: 'fee', feePpm: CHAIN.homeCl.fees[0] }
    : { protocol: 'home', kind: 'cl', keyedBy: 'tickSpacing', tickSpacing: 200, feePpm: 10_000 }
  for (const route of [{ protocol: 'uniswap', kind: 'v3', feePpm: CHAIN.uniV3Fees[0] } as DirectRoute, clRoute]) {
    const tx = buildDirectTransaction({
      tokenIn: ADDR.STABLE, tokenOut, amountIn: 20_000n, minimumAmountOut: 10_000n,
      recipient, deadline: 123n, route, fee: { bps: 0, receiver: feeReceiver },
    })
    assert.equal(tx.permit2Operator, null, `${directRouteLabel(route)} must not ask for Permit2`)
  }
})

v4Test('a rung this chain does not probe is refused', () => {
  const offLadder: DirectRoute = { protocol: 'uniswap', kind: 'v4', feePpm: 500, tickSpacing: 7777 }
  assert.throws(
    () => buildDirectTransaction({
      tokenIn: NATIVE, tokenOut, amountIn: 20_000n, minimumAmountOut: 10_000n,
      recipient, deadline: 123n, route: offLadder, fee: { bps: 0, receiver: feeReceiver },
    }),
    /Unsupported direct route/,
  )
  // and a fee paired with the WRONG spacing names a pool nobody created
  const mismatched: DirectRoute = {
    protocol: 'uniswap', kind: 'v4', feePpm: V4!.rungs[0].fee, tickSpacing: V4!.rungs[1].tickSpacing,
  }
  assert.throws(
    () => buildDirectTransaction({
      tokenIn: NATIVE, tokenOut, amountIn: 20_000n, minimumAmountOut: 10_000n,
      recipient, deadline: 123n, route: mismatched, fee: { bps: 0, receiver: feeReceiver },
    }),
    /Unsupported direct route/,
  )
})

// The inverse: a chain with no v4 must refuse the kind outright.
const noV4Test = V4 ? test.skip : test
noV4Test('a chain with no v4 deployment refuses every v4 route', () => {
  assert.throws(
    () => buildDirectTransaction({
      tokenIn: NATIVE, tokenOut, amountIn: 20_000n, minimumAmountOut: 10_000n,
      recipient, deadline: 123n,
      route: { protocol: 'uniswap', kind: 'v4', feePpm: 500, tickSpacing: 10 },
      fee: { bps: 0, receiver: feeReceiver },
    }),
    /Unsupported direct route/,
  )
})
