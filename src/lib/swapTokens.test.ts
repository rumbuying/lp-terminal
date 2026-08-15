import assert from 'node:assert/strict'
import test from 'node:test'
import { zeroAddress, type Address } from 'viem'
import { NATIVE } from '../config/addresses'
import type { TokenInfo } from '../types'
import { defaultSwapOutput, mergeSwapTokens, NATIVE_TOKEN } from './swapTokens'

const token = (address: string, symbol: string): TokenInfo => ({
  address: address as Address,
  symbol,
  decimals: 18,
})

const native = token('0x0000000000000000000000000000000000000001', 'BNB')
const defaultBuy = token('0x0000000000000000000000000000000000000002', 'NVDAB')
const stable = token('0x0000000000000000000000000000000000000003', 'USDT')
const wrapped = token('0x0000000000000000000000000000000000000004', 'WBNB')
const other = token('0x0000000000000000000000000000000000000005', 'OTHER')

const preferred = [defaultBuy.address, stable.address, wrapped.address]

test('default swap output follows the configured preference order', () => {
  assert.equal(defaultSwapOutput([native, wrapped, stable, defaultBuy], native, preferred), defaultBuy)
  assert.equal(defaultSwapOutput([native, wrapped, stable], native, preferred), stable)
  assert.equal(defaultSwapOutput([native, wrapped], native, preferred), wrapped)
})

test('default swap output excludes the input and falls back to any other token', () => {
  assert.equal(defaultSwapOutput([stable, wrapped, other], stable, preferred), wrapped)
  assert.equal(defaultSwapOutput([stable, other], stable, preferred), other)
  assert.equal(defaultSwapOutput([native], native, preferred), null)
})

const keyed = (...tokens: TokenInfo[]): Record<string, TokenInfo> =>
  Object.fromEntries(tokens.map((t) => [t.address.toLowerCase(), t]))

test('the coin is in the picker before any catalog has answered', () => {
  assert.deepEqual(mergeSwapTokens([undefined, undefined]), [NATIVE_TOKEN])
})

// The bug: a v4 catalog reports the chain's coin as `address(0)`, so merging by
// raw address produced TWO coins in the swap picker — and the second one wore
// the ⚠ mark and carried an address no wallet can spend from.
test('a catalog naming the coin address(0) adds no second coin', () => {
  const fromV4: TokenInfo = {
    address: zeroAddress,
    symbol: NATIVE_TOKEN.symbol,
    decimals: NATIVE_TOKEN.decimals,
    native: true,
  }
  const list = mergeSwapTokens([keyed(fromV4, other)])

  const coins = list.filter((t) => t.symbol === NATIVE_TOKEN.symbol)
  assert.equal(coins.length, 1)
  // and it is the spendable one — the balance and swap paths know the coin
  // only by the sentinel, so a row addressed `0x0000…` is unfundable
  assert.equal(coins[0].address, NATIVE)
  assert.equal(list[0], coins[0], 'the coin still leads the picker')
})

test('a later catalog wins under the same identity', () => {
  const stub = token(other.address, 'OTHER')
  const named = { ...stub, symbol: 'Other Token' }
  const list = mergeSwapTokens([keyed(stub), keyed(named)])
  assert.equal(list.find((t) => t.address === other.address)?.symbol, 'Other Token')
})

test("the chain's own assets lead and everything else sorts by symbol", () => {
  const zed = token('0x00000000000000000000000000000000000000aa', 'ZED')
  const abc = token('0x00000000000000000000000000000000000000bb', 'ABC')
  const list = mergeSwapTokens([keyed(zed, abc)], [zed.address.toLowerCase()])

  assert.equal(list[0], zed, 'pinned first, whatever it is called')
  const rest = list.slice(1).map((t) => t.symbol)
  assert.deepEqual(rest, [...rest].sort((a, b) => a.localeCompare(b)))
})
