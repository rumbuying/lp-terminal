import assert from 'node:assert/strict'
import test from 'node:test'
import { zeroAddress } from 'viem'
import { robinhoodConfig } from '../config/chains/robinhood'
import { monogram, monogramHue, resolveImageUri, tokenImageUrl } from './tokenImage'

const KNOWN = robinhoodConfig.knownTokens
const USDG = robinhoodConfig.addr.STABLE
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC'
const FRONG = '0xb8e6b62b223ee17559385e1dc61f6433d4c3b979'

test('an ipfs image resolves onto one fixed gateway', () => {
  const cid = 'QmQ6kg43Lg8mUeBrMmqtpyfh3q8paJWaNcz9mNcopJPqdN'
  assert.equal(resolveImageUri(`ipfs://${cid}`), `https://ipfs.io/ipfs/${cid}`)
  assert.equal(resolveImageUri(`ipfs/${cid}`), `https://ipfs.io/ipfs/${cid}`)
  assert.equal(resolveImageUri(`ipfs://${cid}/logo.png`), `https://ipfs.io/ipfs/${cid}/logo.png`)
  // CIDv1 too
  assert.equal(
    resolveImageUri('ipfs://bafkreihse6lq6ttgcoq4sp5fpiomxtmizf4j4m76uvusfxhm3vrhuih5bq'),
    'https://ipfs.io/ipfs/bafkreihse6lq6ttgcoq4sp5fpiomxtmizf4j4m76uvusfxhm3vrhuih5bq',
  )
})

test('a token supplies a picture, never a destination', () => {
  assert.equal(resolveImageUri('javascript:alert(1)'), null)
  assert.equal(resolveImageUri('//evil.test/x.png'), null)
  assert.equal(resolveImageUri('http://evil.test/x.png'), null)
  assert.equal(resolveImageUri('data:text/html;base64,PHNjcmlwdD4='), null)
  assert.equal(resolveImageUri('ipfs://../../etc/passwd'), null)
  assert.equal(resolveImageUri(''), null)
  assert.equal(resolveImageUri(undefined), null)
})

test('https and inline images pass', () => {
  assert.equal(resolveImageUri('https://x.test/a.png'), 'https://x.test/a.png')
  const inline = 'data:image/svg+xml;base64,PHN2Zy8+'
  assert.equal(resolveImageUri(inline), inline)
})

test('the launchpad document wins, because it is the token itself speaking', () => {
  const url = tokenImageUrl({
    address: FRONG,
    knownTokens: KNOWN,
    launchpad: {
      launchpad: 'poolsTrade',
      creator: '0x7A6C474b4DcD35b72203D2B569EAfE4C9b5C768e',
      release: 'v2',
      description: '',
      website: '',
      image: 'ipfs://QmQ6kg43Lg8mUeBrMmqtpyfh3q8paJWaNcz9mNcopJPqdN',
    },
  })
  assert.equal(url, 'https://ipfs.io/ipfs/QmQ6kg43Lg8mUeBrMmqtpyfh3q8paJWaNcz9mNcopJPqdN')
})

test('a proven stock token is served from its own issuer, keyed on its address', () => {
  assert.equal(
    tokenImageUrl({ address: NVDA, issuer: 'robinhood', knownTokens: KNOWN }),
    `https://cdn.robinhood.com/ncw_assets/logos/${NVDA.toLowerCase()}.png`,
  )
  // an issuer that publishes no endpoint gets none invented for it
  assert.equal(tokenImageUrl({ address: NVDA, issuer: 'ondo', knownTokens: KNOWN }), null)
})

test('a reserved symbol carries the logo of the one address it means', () => {
  assert.ok(tokenImageUrl({ address: USDG, knownTokens: KNOWN })?.startsWith('https://coin-images.coingecko.com/'))
  assert.equal(tokenImageUrl({ address: USDG.toLowerCase(), knownTokens: KNOWN }), tokenImageUrl({ address: USDG, knownTokens: KNOWN }))
})

test('the coin keeps its logo under the name a v4 pool gives it', () => {
  // Same coin, two names: `address(0)` in a PoolKey, the sentinel in the entry
  // that carries the picture. Asking under the pool's name used to reach
  // nothing, so every native v4 row wore a monogram.
  const coin = robinhoodConfig.knownTokens.find((k) => k.symbol === 'ETH')!
  const bySentinel = tokenImageUrl({ address: coin.address, knownTokens: KNOWN })
  assert.ok(bySentinel, 'the chain reserves its coin with a logo')
  assert.equal(tokenImageUrl({ address: zeroAddress, knownTokens: KNOWN }), bySentinel)
})

test('an unproven token gets no picture at all', () => {
  // a token calling itself USDG from a different contract reaches nothing
  assert.equal(tokenImageUrl({ address: '0x00000000000000000000000000000000deadbeef', knownTokens: KNOWN }), null)
})

test('the monogram separates two tokens sharing one name', () => {
  assert.equal(monogram('USDG'), 'US')
  assert.equal(monogram('frong'), 'FR')
  assert.equal(monogram('🐸'), '🐸'.slice(0, 2).toUpperCase())
  assert.equal(monogram(''), '?')
  assert.notEqual(monogramHue(NVDA), monogramHue('0x00000000000000000000000000000000deadbeef'))
  assert.equal(monogramHue(NVDA), monogramHue(NVDA.toUpperCase()))
})
