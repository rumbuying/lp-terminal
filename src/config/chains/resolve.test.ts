import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * The precedence ladder, exercised through the real module.
 *
 * The active chain resolves ONCE, at module load, from globals a node test does
 * not have — so each case gets a fresh instance of the module via a
 * cache-busting import specifier, with the globals staged first. Asserting the
 * ladder any other way would mean re-implementing it in the test, which is how
 * a test comes to agree with itself instead of with the code.
 *
 * These run under CHAIN=bsc or CHAIN=robinhood (both are exercised in CI), so
 * every expectation is written against the build chain rather than a literal.
 */
type ChainsModule = typeof import('./index')

const g = globalThis as Record<string, unknown>

function stage(search: string, stored: string | null): void {
  g.window = { location: { search } }
  // node's own localStorage is a getter and throws without --localstorage-file
  Object.defineProperty(g, 'localStorage', {
    value: { getItem: (k: string) => (k === 'up33.chain.v1' ? stored : null) },
    configurable: true,
  })
}

let caseId = 0
async function resolveWith(search: string, stored: string | null): Promise<ChainsModule> {
  stage(search, stored)
  return (await import(`./index?case=${++caseId}`)) as ChainsModule
}

test('a link names the chain, over anything this browser remembers', async () => {
  const { CHAIN, BUILD_CHAIN, CHAINS, ACTIVE_IS_BUILD, CHAIN_SOURCE } = await resolveWith(
    '?chain=robinhood',
    'bsc',
  )
  assert.equal(CHAIN.key, 'robinhood')
  assert.equal(CHAIN, CHAINS.robinhood, 'the same config object, not a copy')
  assert.equal(ACTIVE_IS_BUILD, BUILD_CHAIN.key === 'robinhood')
  assert.equal(CHAIN_SOURCE, 'link')
})

test('what the browser remembers is used when no link says otherwise', async () => {
  const build = (await resolveWith('', null)).BUILD_CHAIN.key
  const { CHAIN, CHAIN_SOURCE } = await resolveWith('', build)
  assert.equal(CHAIN.key, build)
  assert.equal(CHAIN_SOURCE, 'stored')
})

/**
 * A remembered chain this deployment cannot serve is dropped rather than shown.
 *
 * Honouring it put every bare visit into the degraded state — no catalog, no v4
 * directory, a v3-only DexScreener fallback in place of the market table — and
 * nothing on screen said the data lives on another host, so it read as an
 * outage. Nobody chose that: they chose the chain once, somewhere it worked.
 *
 * These tests stage no hostname, so the gateway capability is off and this
 * deployment serves its build chain only — the single-chain case exactly.
 */
test('a remembered chain this deployment cannot serve defers to the build chain', async () => {
  const { BUILD_CHAIN, CHAINS } = await resolveWith('', null)
  const unservable = Object.keys(CHAINS).find((key) => key !== BUILD_CHAIN.key)
  assert.ok(unservable, 'this test needs a second chain to be meaningful')
  const { CHAIN, CHAIN_SOURCE } = await resolveWith('', unservable)
  assert.equal(CHAIN.key, BUILD_CHAIN.key, 'the degraded chain must not be restored from storage')
  assert.equal(CHAIN_SOURCE, 'build', 'and nothing may be recorded as a choice')
})

// A link is someone asking right now, so it still wins — ChainControl is what
// keeps them off a host that cannot answer, by sending those clicks elsewhere.
test('an explicit link still selects a chain this deployment cannot serve', async () => {
  const { BUILD_CHAIN, CHAINS } = await resolveWith('', null)
  const unservable = Object.keys(CHAINS).find((key) => key !== BUILD_CHAIN.key)
  assert.ok(unservable)
  const { CHAIN, CHAIN_SOURCE } = await resolveWith(`?chain=${unservable}`, null)
  assert.equal(CHAIN.key, unservable)
  assert.equal(CHAIN_SOURCE, 'link')
})

/**
 * A first visit lands wherever the deployment points, and must leave NO trace
 * that it did.
 *
 * This is the regression guard on the loop that pins a visitor to a chain
 * nobody chose: boot writes `?chain=` into the bar, the next load reads that
 * back as a link, and the load after that has it in localStorage — after which
 * flipping CHAIN= in the build environment can never move that browser again. Source
 * `build` is what main.tsx checks to stay silent, so it is what this pins.
 */
test('with neither, the build decides and nothing is written down', async () => {
  const { CHAIN, BUILD_CHAIN, ACTIVE_IS_BUILD, CHAIN_SOURCE } = await resolveWith('', null)
  assert.equal(CHAIN.key, BUILD_CHAIN.key)
  assert.equal(ACTIVE_IS_BUILD, true)
  assert.equal(CHAIN_SOURCE, 'build')
})

// `?chain=` arrives from a pasted link, a bookmark, someone else's message.
// A typo in one must not white-screen the terminal — unlike CHAIN=, which is
// ours and throws at load.
test('a link naming no chain we have falls through instead of throwing', async () => {
  for (const bad of ['solana', '__proto__', 'constructor', 'BSC', '%20']) {
    const { CHAIN, BUILD_CHAIN, CHAIN_SOURCE } = await resolveWith(`?chain=${bad}`, null)
    assert.equal(CHAIN.key, BUILD_CHAIN.key, `?chain=${bad} should have fallen through`)
    assert.equal(CHAIN_SOURCE, 'build', `?chain=${bad} is not a choice and must leave no trace`)
  }
})

test('a remembered chain we no longer have falls through too', async () => {
  const { CHAIN, BUILD_CHAIN } = await resolveWith('', 'fantom')
  assert.equal(CHAIN.key, BUILD_CHAIN.key)
})

// Everything downstream — addresses, ABI targets, the wagmi transport — is a
// module constant read off CHAIN. If the façade ever resolved before or apart
// from this module, half the app would be on the other chain.
//
// This is the first and only import of the UNQUERIED './chains' in this file,
// so the façade's copy resolves against the globals staged just above. The
// expectations come from CHAINS.robinhood, which is the same `robinhoodConfig`
// object either instance reaches. Import './chains' plainly anywhere earlier
// and this test fails rather than drifting.
test('the address façade follows the resolved chain', async () => {
  stage('?chain=robinhood', null)
  const addresses = (await import(`../addresses?case=${++caseId}`)) as typeof import('../addresses')
  const { CHAINS } = (await import(`./index?case=${caseId}`)) as ChainsModule
  assert.equal(addresses.CHAIN_ID, CHAINS.robinhood.id)
  assert.equal(addresses.ADDR.WNATIVE, CHAINS.robinhood.addr.WNATIVE)
})
