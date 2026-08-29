import assert from 'node:assert/strict'
import test from 'node:test'
import { zeroAddress } from 'viem'
import { ADDR, NATIVE } from '../src/config/addresses'
import { Q96 } from '../src/lib/clmath'
import { usdgValueWethAtSqrt, valuationCurrency, wethValueUsdgAtSqrt } from './stable-valuation'

test('stable valuation follows the anchor price instead of WETH quantity alone', () => {
  const openingWeth = 50n
  const currentWeth = 40n
  const openingUsdg = wethValueUsdgAtSqrt(openingWeth, Q96 * 2n) // price = 4
  const currentUsdg = wethValueUsdgAtSqrt(currentWeth, Q96 * 3n) // price = 9

  assert.equal(openingUsdg, 200n)
  assert.equal(currentUsdg, 360n)
  assert.equal(currentWeth - openingWeth, -10n)
  assert.equal(currentUsdg - openingUsdg, 160n)
})

test('zero quote value never requires a price read', () => {
  assert.equal(wethValueUsdgAtSqrt(0n, 0n), 0n)
  assert.equal(usdgValueWethAtSqrt(0n, 0n), 0n)
})

test('USDG distributions convert back to WETH at the same anchor spot', () => {
  const sqrtPriceX96 = Q96 * 2n // 4 USDG per raw WETH unit in this integer fixture
  const usdg = wethValueUsdgAtSqrt(50n, sqrtPriceX96)
  assert.equal(usdgValueWethAtSqrt(usdg, sqrtPriceX96), 50n)
})

test('v4 native quote amounts use the wrapped-native valuation market', () => {
  assert.equal(valuationCurrency(zeroAddress), ADDR.WNATIVE)
  assert.equal(valuationCurrency(NATIVE), ADDR.WNATIVE)
})
