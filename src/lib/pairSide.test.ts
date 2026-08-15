import assert from 'node:assert/strict'
import test from 'node:test'
import { bscConfig } from '../config/chains/bsc'
import { robinhoodConfig } from '../config/chains/robinhood'
import { NATIVE_SENTINEL } from '../config/chains/knownTokens'
import { orientPair, quoteAssetsOf, quoteRank, tradedSide } from './pairSide'

const RH = quoteAssetsOf(robinhoodConfig)
const BSC = quoteAssetsOf(bscConfig)

const USDG = robinhoodConfig.addr.STABLE
const WETH = robinhoodConfig.addr.WNATIVE
const VIRTUAL = '0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31'
// a live pools.trade token, and a live Robinhood stock token
const FRONG = '0xb8e6b62b223ee17559385e1dc61f6433d4c3b979'
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC'

test('a long-tail token quoted in the chain dollar is the market', () => {
  assert.equal(tradedSide(FRONG, USDG, RH), 0)
  assert.equal(tradedSide(USDG, FRONG, RH), 1)
  assert.equal(tradedSide(NVDA, USDG, RH), 0)
})

test('the dollar outranks the native wrapper, so WETH/USDG is a WETH market', () => {
  assert.equal(tradedSide(WETH, USDG, RH), 0)
  assert.equal(tradedSide(USDG, WETH, RH), 1)
  assert.ok(quoteRank(USDG, RH) > quoteRank(WETH, RH))
})

test('the native coin ranks with its wrapper, never below a connector', () => {
  assert.ok(quoteRank(NATIVE_SENTINEL, RH) === quoteRank(WETH, RH))
  assert.ok(quoteRank(WETH, RH) > quoteRank(VIRTUAL, RH))
  // and VIRTUAL is still a quote asset — it is one of the chain's connectors
  assert.ok(quoteRank(VIRTUAL, RH) > quoteRank(FRONG, RH))
})

// v4 holds the chain's coin as address(0) rather than as the sentinel, and a
// launchpad pool paired against the coin is the common shape — read the native
// side as an unknown contract and the row calls ETH the market and the token
// the money, which points the swap form at ETH → ETH.
const V4_NATIVE = '0x0000000000000000000000000000000000000000'

test("a v4 pool's address(0) is the chain's coin, not an unknown token", () => {
  assert.equal(quoteRank(V4_NATIVE, RH), quoteRank(NATIVE_SENTINEL, RH))
  assert.ok(quoteRank(V4_NATIVE, RH) > quoteRank(FRONG, RH))
  // ETH/<launchpad token>: the token is the market, the coin is the money
  assert.equal(tradedSide(V4_NATIVE, FRONG, RH), 1)
  assert.equal(tradedSide(FRONG, V4_NATIVE, RH), 0)
  // ETH/USDG: the dollar still outranks the coin
  assert.equal(tradedSide(V4_NATIVE, USDG, RH), 0)
})

test('two long-tail tokens leave token0 leading rather than picking at random', () => {
  const a = '0x1111111111111111111111111111111111111111'
  const b = '0x2222222222222222222222222222222222222222'
  assert.equal(tradedSide(a, b, RH), 0)
  assert.equal(tradedSide(b, a, RH), 0)
})

test('checksum casing does not decide which side is the money', () => {
  assert.equal(tradedSide(FRONG, USDG.toLowerCase(), RH), 0)
  assert.equal(tradedSide(FRONG.toUpperCase().replace('0X', '0x'), USDG, RH), 0)
})

test('every chain answers with its own dollar, not a hardcoded one', () => {
  const USDT = bscConfig.addr.STABLE
  const NVDAB = '0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436'
  assert.equal(tradedSide(NVDAB, USDT, BSC), 0)
  // Robinhood's dollar is nobody on BSC, so it cannot be the quote there
  assert.equal(quoteRank(USDG, BSC), 0)
})

test('orientPair hands back the pair already read as market and money', () => {
  assert.deepEqual(orientPair('A', 'B', 0), { target: 'A', quote: 'B' })
  assert.deepEqual(orientPair('A', 'B', 1), { target: 'B', quote: 'A' })
})
