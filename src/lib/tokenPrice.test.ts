import assert from 'node:assert/strict'
import test from 'node:test'
import { pickDsTokenUsd, type DsPair } from './tokenPrice'
import { CHAIN } from '../config/chains'

const SLUG = CHAIN.slugs.dexscreener

const UP = '0x57C0E45cB534413D1C20A4240955d6bB250BB4F1'
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'

// shaped like the live dexscreener rows that motivated this module: two deep
// UP/WETH pools around $0.140 and an $8-liquidity v4 pool marked $0.1585
const pairs: DsPair[] = [
  {
    chainId: SLUG,
    priceUsd: '0.1405',
    priceNative: '0.00007610',
    liquidity: { usd: 277107 },
    baseToken: { address: UP },
    quoteToken: { address: WETH },
  },
  {
    chainId: SLUG,
    priceUsd: '0.1402',
    priceNative: '0.00007595',
    liquidity: { usd: 247016 },
    baseToken: { address: UP },
    quoteToken: { address: WETH },
  },
  {
    chainId: SLUG,
    priceUsd: '0.1585',
    liquidity: { usd: 8.25 },
    baseToken: { address: UP },
    quoteToken: { address: WETH },
  },
  // same token on another chain must never leak in
  {
    chainId: 'base',
    priceUsd: '9.99',
    liquidity: { usd: 5_000_000 },
    baseToken: { address: UP },
    quoteToken: { address: WETH },
  },
]

test('prices from the most-liquid pair on this chain, not the best-looking mid', () => {
  assert.equal(pickDsTokenUsd(pairs, UP), 0.1405)
  // case-insensitive address match
  assert.equal(pickDsTokenUsd(pairs, UP.toLowerCase()), 0.1405)
})

test('quote-side tokens derive USD via priceUsd / priceNative', () => {
  const weth = pickDsTokenUsd(pairs, WETH)
  assert.ok(weth !== null && Math.abs(weth - 0.1405 / 0.0000761) < 0.01)
})

test('dust pools below the liquidity floor never price a token', () => {
  const dustOnly = pairs.filter((p) => Number(p.liquidity?.usd) < 100)
  assert.equal(pickDsTokenUsd(dustOnly, UP), null)
})

test('tolerates garbage rows without throwing', () => {
  const garbage: DsPair[] = [
    {},
    { chainId: SLUG },
    { chainId: SLUG, liquidity: { usd: 'nope' }, baseToken: { address: UP }, priceUsd: '1' },
    { chainId: SLUG, liquidity: { usd: 5000 }, baseToken: { address: UP }, priceUsd: '0' },
    // quote-side without priceNative cannot derive — must be skipped
    { chainId: SLUG, liquidity: { usd: 5000 }, quoteToken: { address: WETH }, priceUsd: '0.14' },
  ]
  assert.equal(pickDsTokenUsd(garbage, UP), null)
  assert.equal(pickDsTokenUsd(garbage, WETH), null)
  assert.equal(pickDsTokenUsd([], UP), null)
})
