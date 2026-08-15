// Which swap struct the v4 payload carries is a version question with no loud
// failure mode: v4-periphery inserted `minHopPriceX36` between
// `amountOutMinimum` and `hookData`, so encoding the wrong shape does not
// revert at encode time — it hands the router a payload whose tail means
// something else. These tests pin both shapes and the selection between them.
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { decodeAbiParameters, parseAbiParameters, zeroAddress, type Address } from 'viem'
import { robinhoodConfig } from '../config/chains/robinhood'

// One mutable clone, because `encodeV4Swap` reads the flag at call time from
// the config object it captured at import — flipping it here is what lets a
// single file exercise both eras without re-importing the module under test.
const chain = {
  ...robinhoodConfig,
  uniV4: { ...robinhoodConfig.uniV4!, perHopSlippage: true },
}
mock.module('../config/chains', {
  namedExports: { CHAIN: chain, BUILD_CHAIN: chain, ACTIVE_IS_BUILD: true },
})

const { encodeV4Swap, v4PoolKey } = await import('./uniV4')

const V4_PAYLOAD = parseAbiParameters('bytes actions, bytes[] params')
const PRE_PER_HOP = parseAbiParameters(
  '((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)',
)
const PER_HOP = parseAbiParameters(
  '((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)',
)

const TOKEN = '0x6245e67affA44a23077f0Ea7f981a8DC743a0c47' as Address
const RECIPIENT = '0x00000000000000000000000000000000000000A1' as Address
const AMOUNT_IN = 10_000_000_000_000_000n
const MIN_OUT = 2_000_000_000_000_000_000_000n

/** the SWAP action's own params — the first entry in the encoded action list */
function swapParams(perHopSlippage: boolean) {
  chain.uniV4.perHopSlippage = perHopSlippage
  const { inputs } = encodeV4Swap({
    key: v4PoolKey(zeroAddress as Address, TOKEN, 2500, 60),
    zeroForOne: true,
    amountIn: AMOUNT_IN,
    grossMinimumOut: MIN_OUT,
    recipient: RECIPIENT,
    fee: { bps: 0, receiver: RECIPIENT },
  })
  const [, params] = decodeAbiParameters(V4_PAYLOAD, inputs[0])
  return params[0]
}

test('a post-per-hop router gets minHopPriceX36, and it is zero', () => {
  const [swap] = decodeAbiParameters(PER_HOP, swapParams(true))
  assert.equal(swap.amountIn, AMOUNT_IN)
  assert.equal(swap.amountOutMinimum, MIN_OUT)
  // Zero is how the caller declines the per-hop floor. A nonzero value here
  // would impose a second, PRICE-denominated floor the user was never shown.
  assert.equal(swap.minHopPriceX36, 0n)
  assert.equal(swap.hookData, '0x')
  assert.equal(swap.poolKey.fee, 2500)
  assert.equal(swap.poolKey.tickSpacing, 60)
})

test('a pre-per-hop router gets the shorter struct, with hookData straight after the floor', () => {
  const [swap] = decodeAbiParameters(PRE_PER_HOP, swapParams(false))
  assert.equal(swap.amountIn, AMOUNT_IN)
  assert.equal(swap.amountOutMinimum, MIN_OUT)
  assert.equal(swap.hookData, '0x')
})

test('the two shapes are not interchangeable — the mismatch this guards is silent', () => {
  const perHop = swapParams(true)
  const preHop = swapParams(false)
  assert.notEqual(perHop, preHop)

  // The failure mode is what makes the config flag worth having: the old shape
  // decodes under the new ABI without throwing, and the field the router would
  // read as a per-hop price floor is hookData's offset — a number so large it
  // rejects every fill rather than admitting one.
  const [asIfNew] = decodeAbiParameters(PER_HOP, preHop)
  assert.notEqual(asIfNew.minHopPriceX36, 0n)
  assert.ok(asIfNew.minHopPriceX36 > 0n)
})
