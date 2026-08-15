import assert from 'node:assert/strict'
import test from 'node:test'
import type { Address } from 'viem'
import { launcherRelease, type LaunchpadConfig } from '../config/chains/launchpad'
import { create2Proves, parseTokenUri } from './launchpadToken'

// FRONG's real document, read off Robinhood Chain 2026-08-05 — base64, with an
// emoji in the description, which is the case a naive atob() gets wrong
const FRONG_URI =
  'data:application/json;base64,eyJkZXNjcmlwdGlvbiI6IkZyb25nIOKAlCBUaGUgb2ZmaWNpYWwgUG9vbHMuVHJhZGUgbWFzY290LCBub3cgaG9wcGVkIG92ZXIgdG8gU29sYW5hLiDwn5C4IEJvcm4gb24gVW5pc3dhcC4gQnVpbHQgZm9yIHRoZSBwb29scy4gQ29taW5nIHRvIGVhdCBTb2xhbmEuIiwgIndlYnNpdGUiOiJodHRwczovL3Bvb2xzLnRyYWRlLyIsICJpbWFnZSI6ImlwZnM6Ly9RbVE2a2c0M0xnOG1VZUJyTW1xdHB5ZmgzcThwYUpXYU5jejltTmNvcEpQcWROIn0='

test("a real token's document is read whole, emoji and all", () => {
  const doc = parseTokenUri(FRONG_URI)
  assert.ok(doc)
  assert.equal(doc.website, 'https://pools.trade/')
  assert.equal(doc.image, 'ipfs://QmQ6kg43Lg8mUeBrMmqtpyfh3q8paJWaNcz9mNcopJPqdN')
  // the frog survives the round trip: bytes re-read as UTF-8, not as latin-1
  assert.ok(doc.description.includes('🐸'))
})

test('a document missing fields still yields the ones it has', () => {
  const uri = 'data:application/json;base64,' + Buffer.from('{"image":"ipfs://Qm1"}').toString('base64')
  assert.deepEqual(parseTokenUri(uri), { description: '', website: '', image: 'ipfs://Qm1' })
})

test('non-string fields are dropped rather than rendered', () => {
  const uri =
    'data:application/json;base64,' +
    Buffer.from('{"image":{"url":"x"},"website":42,"description":"ok"}').toString('base64')
  assert.deepEqual(parseTokenUri(uri), { description: 'ok', website: '', image: '' })
})

test('a plain (unencoded) data document is read too', () => {
  assert.equal(parseTokenUri('data:application/json,{"image":"https://x.test/a.png"}')?.image, 'https://x.test/a.png')
})

test('anything that is not a data document is not fetched to find out', () => {
  assert.equal(parseTokenUri(undefined), null)
  assert.equal(parseTokenUri(''), null)
  assert.equal(parseTokenUri('https://evil.test/meta.json'), null)
  assert.equal(parseTokenUri('ipfs://QmSomething'), null)
  assert.equal(parseTokenUri('data:application/json;base64,not base64 at all!!'), null)
  assert.equal(parseTokenUri('data:application/json;base64,' + Buffer.from('[1,2,3]').toString('base64')), null)
})

test('the CREATE2 answer is the proof, and casing is not part of it', () => {
  const addr = '0xb8E6B62B223ee17559385E1DC61f6433d4c3b979'
  assert.ok(create2Proves(addr, addr.toLowerCase()))
  assert.ok(create2Proves(addr.toLowerCase(), addr))
})

test('a token that hashes anywhere else is not this factory’s', () => {
  assert.equal(create2Proves('0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'), false)
  // an unread answer proves nothing either — it must never pass
  assert.equal(create2Proves(undefined, '0x0000000000000000000000000000000000000002'), false)
})

// The real shape on Robinhood Chain: two generations, and the newer one running
// at two addresses because it was redeployed to a vanity address hours later.
const V1 = '0x00004c4ccc709Ef590F7C81102C0689F0263D4e9' as Address
const V2_FIRST = '0x7A6C474b4DcD35b72203D2B569EAfE4C9b5C768e' as Address
const V2_VANITY = '0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0' as Address
const at = (address: Address) => ({ address, deployTx: `0x${'11'.repeat(32)}` as const })
const PAD: LaunchpadConfig = {
  id: 'poolsTrade',
  label: 'POOLS.TRADE',
  url: 'https://pools.trade/',
  tokenFactory: '0x000000e200088D55C39a11F609E5F667729ad49b' as Address,
  deployer: '0x32f4B2e69EbD7746596AF8699DAC1908F43107aD' as Address,
  create2Factory: '0x4e59b44847b379578588920cA78FbF26c0B4956C' as Address,
  releases: [
    { id: 'v1', short: 'V1', launchers: [at(V1)] },
    { id: 'v2', short: 'V2', launchers: [at(V2_FIRST), at(V2_VANITY)] },
  ],
}

test('each launcher names its own generation', () => {
  assert.equal(launcherRelease(V1, PAD), 'v1')
  assert.equal(launcherRelease(V2_FIRST, PAD), 'v2')
})

// The regression this exists for: v2 shipped at 0x7A6C… and was redeployed to
// the vanity 0x0000FffF… fourteen hours later, with both taking sales. A config
// that held ONE launcher per generation read every sale from the other address
// as a bare mint — which is what FRONG and UNIDUCK actually did.
test('a generation deployed twice answers the same for both addresses', () => {
  assert.equal(launcherRelease(V2_VANITY, PAD), launcherRelease(V2_FIRST, PAD))
})

test('the comparison is by address and casing is not part of it', () => {
  assert.equal(launcherRelease(V2_VANITY.toLowerCase(), PAD), 'v2')
  assert.equal(launcherRelease(V1.toUpperCase().replace('0X', '0x'), PAD), 'v1')
})

// The launcher's constructor takes only Permit2, so its bytecode is free for
// anyone to redeploy — and on this chain two unrelated launchpads already mint
// through the same factory. Only the addresses the config vouches for count.
test('a launcher this config does not vouch for names no generation', () => {
  assert.equal(launcherRelease('0xe050309b2f42cd5f788ab6ee1a07467770c03bf7', PAD), null)
  // a wallet that minted straight off the factory is the ordinary case
  assert.equal(launcherRelease('0x9c92dc5152ccaecc263a24427253f442bc8957c7', PAD), null)
})
