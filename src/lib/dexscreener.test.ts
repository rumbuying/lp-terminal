import assert from 'node:assert/strict'
import test from 'node:test'
import { dsPairUrl } from './dexscreener'
import { CHAIN } from '../config/chains'

const SLUG = CHAIN.slugs.dexscreener

const POOL = '0x23D641FeCcD207E8794c593e8240444A0674C4Ba' // WETH/UP v3, checksummed
const LOWER = POOL.toLowerCase() // how the indexer API returns it

test('builds the dexscreener pair page for a pool address', () => {
  assert.equal(dsPairUrl(POOL), `https://dexscreener.com/${SLUG}/${POOL}`)
  assert.equal(dsPairUrl(LOWER), `https://dexscreener.com/${SLUG}/${LOWER}`)
})

// The address is the only part of the URL that comes from data, so anything
// that is not exactly an address must produce NO link rather than a link
// somewhere unintended. Each of these is a way an attacker-controlled string
// re-points a naively-interpolated href.
test('refuses anything that is not a 20-byte hex address', () => {
  for (const bad of [
    '',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '//evil.tld', // protocol-relative: would leave dexscreener.com entirely
    'https://evil.tld',
    '../../../evil', // path traversal off the chain-slug prefix
    `${POOL}?to=evil.tld`, // query appended to the pair path
    `${POOL}#@evil.tld`,
    `${POOL}@evil.tld`, // userinfo trick
    `${POOL}/../../evil`,
    ` ${POOL}`, // leading space — \s must not be eaten by the anchors
    `${POOL}\n`,
    POOL.slice(0, -1), // 19.5 bytes
    POOL + 'ab', // 21 bytes
    POOL.replace('0x', ''), // no prefix
    '0x' + 'g'.repeat(40), // non-hex
  ])
    assert.equal(dsPairUrl(bad), null, `should have refused ${JSON.stringify(bad)}`)
})

// Belt to the regex's braces: whatever comes back must parse, and must parse
// as dexscreener over https. Nothing else is an acceptable place to send a user.
test('every URL it does build is https://dexscreener.com', () => {
  for (const addr of [POOL, LOWER, '0x' + '0'.repeat(40), '0x' + 'f'.repeat(40)]) {
    const u = new URL(dsPairUrl(addr)!)
    assert.equal(u.protocol, 'https:')
    assert.equal(u.host, 'dexscreener.com')
    assert.equal(u.pathname, `/${SLUG}/${addr}`)
    assert.equal(u.search, '')
    assert.equal(u.hash, '')
  }
})
