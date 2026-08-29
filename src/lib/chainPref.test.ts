import assert from 'node:assert/strict'
import test from 'node:test'
import { chainHref, chainHrefOn, chainKeyIn } from './chainPref'

// Switching to a chain this deployment has no catalog for has to leave the
// host, and land on the same page — the tab lives in the hash, and arriving at
// the wrong one is its own small betrayal.
test('a chain we cannot serve is offered on the origin that can', () => {
  assert.equal(
    chainHrefOn('https://lp-terminal.xyz', 'bsc', 'https://up33-terminal.xyz/#positions'),
    'https://lp-terminal.xyz/?chain=bsc#positions',
  )
  assert.equal(
    chainHrefOn('https://lp-terminal.xyz', 'bsc', 'https://up33-terminal.xyz/?chain=robinhood&q=eth'),
    'https://lp-terminal.xyz/?chain=bsc&q=eth',
    'the stale chain param is replaced, never stacked',
  )
  assert.equal(
    chainHrefOn('https://lp-terminal.xyz', 'bsc', 'http://127.0.0.1:5173/#pools'),
    'https://lp-terminal.xyz/?chain=bsc#pools',
    'rehosting clears an explicit development port',
  )
  assert.equal(
    chainHrefOn('https://lp-terminal.xyz', 'bsc', 'not a url'),
    'https://lp-terminal.xyz/?chain=bsc',
    'a malformed caller still gets a link that names the chain',
  )
})

// The query string is the one chain input that arrives from outside — a pasted
// link, a bookmark, someone else's message. These are its rules.
test('a query string names a chain, or names nothing', () => {
  assert.equal(chainKeyIn('?chain=bsc'), 'bsc')
  assert.equal(chainKeyIn('?a=1&chain=robinhood&b=2'), 'robinhood', 'must survive other params')
  assert.equal(chainKeyIn('chain=bsc'), 'bsc', 'a leading ? is optional in URLSearchParams')
  assert.equal(chainKeyIn(''), '')
  assert.equal(chainKeyIn('?chain='), '')
  assert.equal(chainKeyIn('?other=bsc'), '')
  // %20 round-trips as a space; a padded key must still find its chain
  assert.equal(chainKeyIn('?chain=%20bsc%20'), 'bsc')
})

// Nothing here validates: an unknown key reads back verbatim and config/chains
// is what refuses it. Keeping the two apart is why this module can be imported
// by the config module without a cycle.
test('an unknown key comes back as itself, not as a guess', () => {
  assert.equal(chainKeyIn('?chain=solana'), 'solana')
  assert.equal(chainKeyIn('?chain=__proto__'), '__proto__')
})

test('switching chains keeps the rest of the link', () => {
  const href = chainHref('bsc', 'https://lp-terminal.xyz/?ref=x#positions')
  const u = new URL(href)
  assert.equal(u.searchParams.get('chain'), 'bsc')
  assert.equal(u.searchParams.get('ref'), 'x', 'other params must survive')
  assert.equal(u.hash, '#positions', 'the tab must survive — switching keeps you where you were')
})

test('switching chains always stays on the current origin', () => {
  const href = chainHref('robinhood', 'https://lp-terminal.xyz/pools?ref=x&mode=wide#positions')
  const u = new URL(href)
  assert.equal(u.origin, 'https://lp-terminal.xyz')
  assert.equal(u.pathname, '/pools')
  assert.equal(u.searchParams.get('ref'), 'x')
  assert.equal(u.searchParams.get('mode'), 'wide')
  assert.equal(u.searchParams.get('chain'), 'robinhood')
  assert.equal(u.hash, '#positions')
})

// It is called during a render, so it may not throw. Nothing but a browser
// calls it, and there location.href is always absolute.
test('a link that is not a URL still names the chain', () => {
  assert.equal(chainHref('bsc', ''), '?chain=bsc')
  assert.equal(chainHref('bsc', '/positions'), '?chain=bsc')
})

// Two switches in a row would otherwise leave `?chain=robinhood&chain=bsc`,
// where `URLSearchParams.get` answers with the STALE first one and the very
// link the user just copied sends the next person to the old chain.
test('switching twice rewrites the chain rather than stacking it', () => {
  const once = chainHref('robinhood', 'https://lp-terminal.xyz/#swap')
  const twice = chainHref('bsc', once)
  assert.equal(new URL(twice).searchParams.getAll('chain').length, 1)
  assert.equal(chainKeyIn(new URL(twice).search), 'bsc')
})
