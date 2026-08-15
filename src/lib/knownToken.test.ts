import assert from 'node:assert/strict'
import test from 'node:test'
import { zeroAddress, type Address } from 'viem'
import { bscConfig } from '../config/chains/bsc'
import { robinhoodConfig } from '../config/chains/robinhood'
import { NATIVE_SENTINEL, type KnownToken } from '../config/chains/knownTokens'
import { pairSquats, squattedSymbol } from './knownToken'

const KNOWN = bscConfig.knownTokens
// the real ones, as the chain reports them
const USDC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
// live impostors, measured 2026-08-04
const FAKE_USDC = '0x8765227bfd58905747f947d21ec30191f067c138'
const FAKE_WBNB = '0x5d5e573bc97d36d62c46e9fb913f6804f4a4d26e'

test('the real token wearing its own name is not accused', () => {
  assert.equal(squattedSymbol(KNOWN, { symbol: 'USDC', address: USDC }), null)
  assert.equal(squattedSymbol(KNOWN, { symbol: 'WBNB', address: WBNB }), null)
  // checksum casing on the address must not matter either
  assert.equal(squattedSymbol(KNOWN, { symbol: 'USDC', address: USDC.toLowerCase() }), null)
})

test('a different contract wearing a reserved name is named as such', () => {
  assert.equal(squattedSymbol(KNOWN, { symbol: 'USDC', address: FAKE_USDC })?.address, USDC)
  assert.equal(squattedSymbol(KNOWN, { symbol: 'WBNB', address: FAKE_WBNB })?.address, WBNB)
})

test('case is not a defence', () => {
  // impersonation on this chain routinely varies only in case
  for (const symbol of ['usdc', 'UsDc', 'USDC'])
    assert.equal(squattedSymbol(KNOWN, { symbol, address: FAKE_USDC })?.symbol, 'USDC')
  // ...and PancakeSwap's own token spells itself `Cake`, so the real one must
  // still be recognised when written `CAKE`
  const cake = KNOWN.find((k) => k.symbol === 'Cake')!
  assert.equal(squattedSymbol(KNOWN, { symbol: 'CAKE', address: cake.address }), null)
})

test('honest neighbouring names are left alone', () => {
  // all live on BSC and all distinct strings — a prefix or substring test would
  // have accused every one of them
  for (const symbol of ['Cake-LP', 'USDT.z', 'CakeBaby', 'BTCBR', 'ETHM', 'FDUSD First Digital USD'])
    assert.equal(
      squattedSymbol(KNOWN, { symbol, address: FAKE_USDC }),
      null,
      `${symbol} claims nobody's name`,
    )
})

test('a token nobody has reserved carries no opinion', () => {
  assert.equal(squattedSymbol(KNOWN, { symbol: 'CASHCAT', address: FAKE_USDC }), null)
  assert.equal(squattedSymbol(KNOWN, { symbol: '', address: FAKE_USDC }), null)
  assert.equal(squattedSymbol(KNOWN, { symbol: '   ', address: FAKE_USDC }), null)
})

test('surrounding whitespace in a symbol does not evade the check', () => {
  assert.equal(squattedSymbol(KNOWN, { symbol: ' USDC ', address: FAKE_USDC })?.symbol, 'USDC')
})

test('the native coin owns its own symbol', () => {
  assert.equal(squattedSymbol(KNOWN, { symbol: 'BNB', address: NATIVE_SENTINEL }), null)
  // ...and an ERC-20 claiming it does not
  assert.equal(
    squattedSymbol(KNOWN, { symbol: 'BNB', address: FAKE_WBNB })?.address,
    NATIVE_SENTINEL,
  )
})

// The bug this pair of tests exists for. A v4 PoolKey names the chain's coin
// `address(0)`, and the entry that reserves its ticker is filed under the
// sentinel — so the genuine BNB, in the canonical native BNB/USDT pool that
// carries roughly 12× the wrapped one's liquidity, was the loudest impostor on
// the page. With "hide squat" on, every native-keyed v4 pool vanished.
test('the coin under the name a v4 pool gives it is still the coin', () => {
  assert.equal(squattedSymbol(KNOWN, { symbol: 'BNB', address: zeroAddress }), null)
  // and the fold is a property of the coin, not of BSC — Robinhood Chain's v4
  // names ETH the same way
  assert.equal(
    squattedSymbol(robinhoodConfig.knownTokens, { symbol: 'ETH', address: zeroAddress }),
    null,
  )
})

test('address(0) is folded onto the coin and onto nothing else', () => {
  // The fold decides which address is being asked about; it does not decide the
  // answer. Wearing someone else's reserved name, the zero address is a
  // squatter like any other — a v4 pool that claimed `address(0)` was USDC
  // must still be contradicted.
  assert.equal(squattedSymbol(KNOWN, { symbol: 'USDC', address: zeroAddress })?.address, USDC)
  assert.equal(squattedSymbol(KNOWN, { symbol: 'WBNB', address: zeroAddress })?.address, WBNB)
})

test('a native-keyed v4 pair is not hidden as a squat', () => {
  // the pair-level check the pools filter runs, which is where the disappearing
  // rows came from
  const usdt = KNOWN.find((k) => k.symbol === 'USDT')!
  const coin = { symbol: 'BNB', address: zeroAddress }
  assert.equal(pairSquats(KNOWN, coin, { symbol: 'USDT', address: usdt.address }), false)
})

test('a lookalike symbol is a known gap, not a silent pass', () => {
  // `BNB𝕏` is live on BSC. It is a different string and this cannot see it;
  // the test exists so the limitation is recorded rather than assumed away.
  assert.equal(squattedSymbol(KNOWN, { symbol: 'BNB𝕏', address: FAKE_WBNB }), null)
})

test('a pair is flagged when either side wears a name it does not own', () => {
  const real = { symbol: 'WBNB', address: WBNB }
  const fake = { symbol: 'USDC', address: FAKE_USDC }
  const unrelated = { symbol: 'CASHCAT', address: FAKE_USDC }
  assert.equal(pairSquats(KNOWN, fake, real), true)
  assert.equal(pairSquats(KNOWN, real, fake), true)
  assert.equal(pairSquats(KNOWN, real, unrelated), false)
})

test('a chain reserving nothing accuses nothing', () => {
  const none: KnownToken[] = []
  assert.equal(squattedSymbol(none, { symbol: 'USDC', address: FAKE_USDC }), null)
})

test('Robinhood Chain deliberately reserves no dollar but its own', () => {
  // Neither USDC nor USDT has a canonical deployment there, so tokens claiming
  // them must NOT be accused — there is nothing real to measure them against.
  const rh = robinhoodConfig.knownTokens
  for (const symbol of ['USDC', 'USDT'])
    assert.equal(squattedSymbol(rh, { symbol, address: FAKE_USDC }), null)
  assert.equal(rh.some((k) => k.symbol === 'USDG'), true)
})

test('BSC deliberately reserves no WETH, because a genuine one exists there', () => {
  // 0x4db5a66e is a real "Wrapped Ether" on BSC with 105 pools and a live
  // price. Reserving the symbol would have flagged it.
  assert.equal(
    squattedSymbol(KNOWN, {
      symbol: 'WETH',
      address: '0x4db5a66e937a9f4473fa95b1caf1d1e1d62e29ea' as Address,
    }),
    null,
  )
})

test('no chain reserves one symbol twice', () => {
  // Two entries for a symbol would make the first silently win and the second
  // dead — and which one is "real" would depend on array order.
  for (const cfg of [bscConfig, robinhoodConfig]) {
    const seen = cfg.knownTokens.map((k) => k.symbol.toLowerCase())
    assert.equal(new Set(seen).size, seen.length, `${cfg.key} has a duplicate reserved symbol`)
  }
})
