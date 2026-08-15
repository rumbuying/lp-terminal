import assert from 'node:assert/strict'
import test from 'node:test'
import { getAddress, isAddress } from 'viem'
import { solverEnabledForChain } from '../features'
import { ACTIVE_IS_BUILD, BUILD_CHAIN, CHAIN, CHAINS, chainByKey } from './index'

/**
 * Every address a chain config hands out must already be in canonical EIP-55
 * form.
 *
 * `getAddress` is NOT the check it looks like: it re-derives the checksum and
 * returns it, so a mixed-case address with a WRONG checksum passes it happily.
 * viem's encoders are the strict ones, and they reject it — which surfaces as
 * an entire multicall chunk failing rather than as an obvious error, so the
 * venue simply reports "no route". That is how a bad `uniV4.STATE_VIEW` once
 * took the whole Uniswap slot down while every unit test stayed green.
 *
 * The walk is recursive on purpose. The previous version listed the fields by
 * hand and so covered exactly the fields that existed when it was written; a
 * new one — `uniV4`, `homeV2` — escaped it silently. Anything address-shaped
 * anywhere in a config is now checked, whether or not this test knows its name.
 */
test('every configured address is already canonically checksummed', () => {
  const seen: string[] = []
  const walk = (label: string, value: unknown): void => {
    if (typeof value === 'string') {
      if (!isAddress(value, { strict: false })) return
      seen.push(label)
      const canonical = getAddress(value.toLowerCase() as `0x${string}`)
      assert.equal(
        value,
        canonical,
        `${label} is not canonically checksummed: ${value} — should be ${canonical}`,
      )
      return
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(`${label}.${k}`, v)
    }
  }
  for (const [key, chain] of Object.entries(CHAINS)) walk(key, chain)
  // a walk that silently found nothing would pass just as loudly
  assert.ok(seen.length > 20, `expected to reach many addresses, reached ${seen.length}`)
})

// `chainByKey` is the only door between a string and a chain config, and the
// strings come from the query bar. Everything downstream — every address, every
// ABI target — is reached through whatever it returns.
test('only a real key opens a chain config', () => {
  for (const key of Object.keys(CHAINS)) {
    assert.equal(chainByKey(key), CHAINS[key], `${key} must resolve to itself`)
  }
  assert.equal(chainByKey(' bsc '), CHAINS.bsc, 'a padded key still names its chain')
  assert.equal(chainByKey(''), null)
  assert.equal(chainByKey(null), null)
  assert.equal(chainByKey(undefined), null)
  assert.equal(chainByKey('solana'), null)
  assert.equal(chainByKey('BSC'), null, 'keys are the lowercase module names, not names')
})

// `CHAINS['__proto__']` is Object.prototype and `CHAINS['constructor']` is a
// function — both truthy, neither a chain. A plain lookup would hand one of
// them to the whole app, which then reads `CHAIN.addr.WNATIVE` off undefined.
// Reachable from a link: ?chain=__proto__.
test('a prototype key is not a chain', () => {
  for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(chainByKey(k), null, `${k} must not resolve to a chain`)
  }
})

// Tests, the indexer and the scripts all import this module with no URL and no
// localStorage to consult. If either reader ever answered something under node,
// a stray environment could silently retarget the indexer or a chain-check run.
test('under node the active chain is the built one', () => {
  assert.equal(CHAIN.key, BUILD_CHAIN.key)
  assert.equal(ACTIVE_IS_BUILD, true)
  assert.ok(Object.hasOwn(CHAINS, BUILD_CHAIN.key), 'the built chain must be a configured one')
})

test('no chain reuses another chain id or key', () => {
  const ids = Object.values(CHAINS).map((c) => c.id)
  assert.equal(new Set(ids).size, ids.length, 'duplicate chain id')
  for (const [key, chain] of Object.entries(CHAINS)) {
    assert.equal(chain.key, key, `${key} disagrees with its own key field`)
  }
})

test('solver UI follows the chain deployment capability', () => {
  assert.equal(solverEnabledForChain(CHAINS.bsc), true)
  assert.equal(solverEnabledForChain(CHAINS.robinhood), true)
  assert.equal(solverEnabledForChain({
    solverUrl: null,
    solverAllowanceTarget: CHAINS.bsc.solverAllowanceTarget,
  }), false)
  assert.equal(solverEnabledForChain({
    solverUrl: CHAINS.bsc.solverUrl,
    solverAllowanceTarget: null,
  }), false)
})

// A connector the router cannot wrap into is a dead hop, and a home DEX that
// claims fee-keyed pools without a fee ladder would probe nothing.
test('each chain declares a usable routing setup', () => {
  for (const [key, chain] of Object.entries(CHAINS)) {
    const lower = chain.connectors.map((c) => c.toLowerCase())
    assert.ok(lower.includes(chain.addr.WNATIVE.toLowerCase()), `${key}: WNATIVE is not a connector`)
    assert.ok(lower.includes(chain.addr.STABLE.toLowerCase()), `${key}: STABLE is not a connector`)
    assert.ok(chain.uniV3Fees.length > 0, `${key}: empty Uniswap fee ladder`)
    if (chain.homeCl.keyedBy === 'fee') {
      assert.ok(chain.homeCl.fees.length > 0, `${key}: fee-keyed home CL with no fee ladder`)
    }
    // The farm pass rides fetchV3VenuePositions, which only runs on a fee-keyed
    // home CL. A farm declared beside a tick-spacing-keyed one would read as
    // configured and silently discover nothing — the exact failure mode that
    // made farmed positions invisible in the first place.
    if (chain.homeClFarm) {
      assert.equal(
        chain.homeCl.keyedBy,
        'fee',
        `${key}: homeClFarm is only read on a fee-keyed home CL, so this farm would never be walked`,
      )
      assert.ok(chain.homeClFarm.reward.symbol.length > 0, `${key}: farm reward needs a symbol to render`)
      assert.notEqual(
        chain.homeClFarm.address.toLowerCase(),
        chain.addr.CL_PM.toLowerCase(),
        `${key}: the farm must be a separate custodian from the position manager`,
      )
    }
    // The v2 farm names its pools by pid and says nothing about which factory
    // deployed them, so the reader verifies each lpToken by CREATE2 against the
    // HOME sweep venue. Declared without one, the sweep has no init-code hash to
    // derive with and every pid fails verification — a farm that reads as
    // configured and finds nothing, which is how staked LP stayed invisible.
    if (chain.homeV2Farm) {
      assert.ok(
        chain.v2Sweep.some((v) => v.protocol === 'home'),
        `${key}: homeV2Farm needs a home v2Sweep venue to verify its lpTokens against`,
      )
      assert.ok(chain.homeV2Farm.reward.symbol.length > 0, `${key}: farm reward needs a symbol to render`)
      assert.notEqual(
        chain.homeV2Farm.address.toLowerCase(),
        chain.homeClFarm?.address.toLowerCase(),
        `${key}: the v2 and CL farms are different contracts`,
      )
    }
  }
})

test('a v4 deployment names distinct contracts for its distinct jobs', () => {
  for (const [key, chain] of Object.entries(CHAINS)) {
    const v4 = chain.uniV4
    if (!v4) continue
    // Position ids are unique PER MANAGER. If this ever equalled the v3 NPM,
    // the two readers would enumerate each other's ids and every card would be
    // about a different position than it claims.
    assert.notEqual(
      v4.POSITION_MANAGER.toLowerCase(),
      chain.uni.V3_NPM.toLowerCase(),
      `${key}: the v4 PositionManager cannot be the v3 NPM`,
    )
    assert.notEqual(
      v4.POSITION_MANAGER.toLowerCase(),
      v4.POOL_MANAGER.toLowerCase(),
      `${key}: the PositionManager holds positions, the singleton holds pools`,
    )
    // An IPFS deployment hash, not a subgraph id: the two are addressed through
    // different gateway paths, and the wrong one 404s on every query.
    if (v4.positionSubgraph !== null) {
      assert.match(
        v4.positionSubgraph,
        /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/,
        `${key}: positionSubgraph must be an IPFS deployment hash`,
      )
    }
    // Published subgraph ids are base58 identifiers, not IPFS deployment
    // hashes. Mixing the two path shapes makes every catalog request 404.
    if (v4.poolSubgraph !== null) {
      assert.match(
        v4.poolSubgraph,
        /^[1-9A-HJ-NP-Za-km-z]{44}$/,
        `${key}: poolSubgraph must be a published subgraph id`,
      )
    }
  }
})

// A v4 route names its pool by (fee, tickSpacing) together, so a ladder with a
// repeated fee or a non-positive spacing would hash to pools nobody created.
test('each v4 rung names a distinct, usable pool key', () => {
  for (const [key, chain] of Object.entries(CHAINS)) {
    if (!chain.uniV4) continue
    assert.ok(chain.uniV4.rungs.length > 0, `${key}: v4 declared with no rungs to probe`)
    const seen = new Set<string>()
    for (const { fee, tickSpacing } of chain.uniV4.rungs) {
      assert.ok(Number.isInteger(fee) && fee > 0 && fee < 1_000_000, `${key}: bad v4 fee ${fee}`)
      assert.ok(Number.isInteger(tickSpacing) && tickSpacing > 0, `${key}: bad v4 tickSpacing ${tickSpacing}`)
      const id = `${fee}:${tickSpacing}`
      assert.ok(!seen.has(id), `${key}: duplicate v4 rung ${id}`)
      seen.add(id)
    }
  }
})

test('BSC catalog enrichment uses GeckoTerminal ids for all four venues', () => {
  assert.deepEqual(CHAINS.bsc.slugs.gecko, {
    network: 'bsc',
    v2Dex: 'uniswap-v2-bsc',
    v3Dex: 'uniswap-bsc',
    extraDexes: [
      { id: 'pancakeswap_v2', label: 'pancake-v2' },
      { id: 'pancakeswap-v3-bsc', label: 'pancake-v3' },
    ],
  })
})
