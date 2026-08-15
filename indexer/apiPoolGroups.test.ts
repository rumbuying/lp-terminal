// One row per origin-proven token, with its markets underneath.
//
// The bug this endpoint exists for was invisible in every per-pool test: the
// pools tab fetched the top rows by TVL and then kept the ones whose token
// happened to be a launchpad mint, so a chip narrowed a PAGE rather than a
// catalog and "bStock" showed four markets out of however many exist. So the
// assertions here are all about what the catalog contains, never about what one
// page of it happened to hold.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const tmp = mkdtempSync(join(tmpdir(), 'lp-terminal-pool-groups-'))
const previous = { chain: process.env.CHAIN, db: process.env.INDEXER_DB }
process.env.CHAIN = 'bsc'
process.env.INDEXER_DB = join(tmp, 'catalog.db')

const store = await import('./store')
const api = await import('./api')
const { CHAIN, V4 } = await import('./config')

after(() => {
  process.env.CHAIN = previous.chain
  process.env.INDEXER_DB = previous.db
  rmSync(tmp, { recursive: true, force: true })
})

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const poolId = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
const HOOKLESS = address(0)
const DYNAMIC_FEE_FLAG = 0x800000

const issuer = CHAIN.stockIssuers[0]?.issuer
assert.ok(issuer, 'this test needs a chain that can prove an issuer')
const otherIssuer = CHAIN.stockIssuers.map((a) => a.issuer).find((i) => i !== issuer)
assert.ok(otherIssuer, 'and a second one, to prove the chips are actually separate')

const USDT = address(0xd1)
/** the deep share: pools across v2, v3 and v4 */
const SHARE = address(0xa1)
/** a share of the same issuer with one shallow pool */
const THIN = address(0xa2)
/** a share of a DIFFERENT issuer — must never appear under the first chip */
const RIVAL = address(0xa3)
/** a launchpad mint, so the two origins can be told apart */
const LAUNCHED = address(0xa4)
/** proven nothing: an ordinary token that has been measured and matched nobody */
const ORDINARY = address(0xa5)

let seq = 0
function v23(token: string, proto: 'univ2' | 'univ3', feePpm: number, tvl: number, vol: number) {
  const addr = address(0x1000 + ++seq)
  const [token0, token1] = token < USDT ? [token, USDT] : [USDT, token]
  store.insertPool({ address: addr, proto, token0, token1, feePpm })
  store.upsertState(addr, { reserve0: 1n, reserve1: 1n, totalSupply: 1n })
  store.setTvl(addr, tvl, false)
  store.upsertStats(addr, vol, 10, tvl, 'geckoterminal')
  return addr
}
function v4(token: string, keyFeePpm: number, hooks: string, tvl: number, vol: number) {
  const id = poolId(0x2000 + ++seq)
  const [currency0, currency1] = token < USDT ? [token, USDT] : [USDT, token]
  store.insertV4Pool({
    poolId: id,
    poolManager: V4?.POOL_MANAGER ?? address(0xff),
    currency0,
    currency1,
    keyFeePpm,
    tickSpacing: 60,
    hooks,
    createdBlock: 1,
  })
  store.upsertV4MarketStats(id, vol, 5, tvl, 'geckoterminal')
  return id
}

for (const token of [SHARE, THIN, RIVAL, LAUNCHED, ORDINARY, USDT])
  store.upsertTokenMeta(token, `T${token.slice(-2)}`, 18, true)
store.recordStockToken(SHARE, issuer)
store.recordStockToken(THIN, issuer)
store.recordStockToken(RIVAL, otherIssuer)
store.recordStockToken(ORDINARY, null)
store.insertLaunchpadToken(LAUNCHED, 1)

// SHARE: $300k across three protocols, $1.5M of volume, one hooked v4 pool.
const shareV2 = v23(SHARE, 'univ2', 3_000, 100_000, 1_000_000)
const shareV3 = v23(SHARE, 'univ3', 500, 150_000, 400_000)
const shareV4 = v4(SHARE, 2_500, HOOKLESS, 50_000, 100_000)
const shareHooked = v4(SHARE, 2_500, address(0xbeef), 10_000, 90_000)
const shareDynamic = v4(SHARE, DYNAMIC_FEE_FLAG, HOOKLESS, 5_000, 80_000)
v23(THIN, 'univ2', 3_000, 900, 50)
v23(RIVAL, 'univ2', 3_000, 999_999, 999_999)
v23(LAUNCHED, 'univ2', 3_000, 2_000, 400)
v23(ORDINARY, 'univ2', 3_000, 888_888, 888_888)
store.kvSet('ready', '1')

const groups = (query: string) =>
  api.getPoolGroups(new URLSearchParams(query)) as ReturnType<typeof api.getPoolGroups>

test('a chip returns the tokens the chain proved, not the tokens on one page', () => {
  const body = groups(`origin=stock:${issuer}`)
  assert.equal(body.origin, `stock:${issuer}`)
  assert.deepEqual(
    body.groups.map((g) => g.token),
    [SHARE, THIN],
    'both of this issuer\'s tokens, deepest first',
  )
  assert.equal(body.count, 2)
  // A rival issuer's token is deeper than either and must still be absent —
  // the chip is a claim about origin, not about size.
  assert.ok(!body.groups.some((g) => g.token === RIVAL))
  assert.ok(!body.groups.some((g) => g.token === ORDINARY))
  assert.ok(!body.groups.some((g) => g.token === LAUNCHED))
})

test('the two origins are separate memberships, proven different ways', () => {
  assert.deepEqual(
    groups('origin=launchpad').groups.map((g) => g.token),
    [LAUNCHED],
  )
  assert.deepEqual(
    groups(`origin=stock:${otherIssuer}`).groups.map((g) => g.token),
    [RIVAL],
  )
})

test('a group aggregates every protocol its token trades in', () => {
  const [share] = groups(`origin=stock:${issuer}`).groups
  assert.equal(share.poolCount, 5, 'two address-keyed pools and three v4 ones')
  assert.equal(share.tvlUsd, 100_000 + 150_000 + 50_000 + 10_000 + 5_000)
  assert.equal(share.vol24hUsd, 1_000_000 + 400_000 + 100_000 + 90_000 + 80_000)
})

// Fees are volume times a rate, so a pool with no fixed rate has no fee to
// state. A dynamic-fee pool's rate is whatever its hook decides per swap, and a
// hooked pool may route part of the fee somewhere this cannot see. Both are
// left out rather than guessed at, and feePools says how many were counted.
test('fees are summed only over pools whose rate is knowable', () => {
  const [share] = groups(`origin=stock:${issuer}`).groups
  const expected =
    (1_000_000 * 3_000) / 1e6 + (400_000 * 500) / 1e6 + (100_000 * 2_500) / 1e6
  assert.equal(share.fees24hUsd, expected)
  assert.equal(share.feePools, 3, 'of five pools; the hooked and dynamic ones are excluded')
})

test('a group carries its pools, deepest first and bounded', () => {
  const [share] = groups(`origin=stock:${issuer}&pools=3`).groups
  assert.equal(share.pools.length, 3)
  assert.deepEqual(
    share.pools.map((p) => (p as { poolId?: string; address: string }).poolId ?? p.address),
    [shareV3, shareV2, shareV4],
    'the three deepest, whichever protocol they belong to',
  )
  // Rows are the same shape /api/pools serves, so the client parses them with
  // the same code and re-proves them the same way.
  assert.equal(share.pools[0].proto, 'univ3')
  assert.equal(share.pools[2].proto, 'univ4')
  assert.ok(share.pools.every((p) => typeof p.tvlUsd === 'number'))
  assert.ok(share.poolCount > share.pools.length, 'and says how many it did not send')
})

test('ranking by volume is a different order, and says so', () => {
  const body = groups(`origin=stock:${issuer}&sort=vol`)
  assert.equal(body.sort, 'vol')
  assert.deepEqual(
    body.groups.map((g) => g.token),
    [SHARE, THIN],
  )
})

test('a depth floor drops the groups below it', () => {
  const body = groups(`origin=stock:${issuer}&min_tvl=1000`)
  assert.deepEqual(body.groups.map((g) => g.token), [SHARE], 'THIN totals $900')
  assert.equal(body.count, 1, 'and the count agrees with the page')
})

test('paging by cursor covers every group exactly once', () => {
  const first = groups(`origin=stock:${issuer}&limit=1`)
  assert.deepEqual(first.groups.map((g) => g.token), [SHARE])
  assert.ok(first.nextCursor)
  const second = groups(
    `origin=stock:${issuer}&limit=1&after=${encodeURIComponent(first.nextCursor!)}`,
  )
  assert.deepEqual(second.groups.map((g) => g.token), [THIN])
  assert.equal(second.nextCursor, null)
})

test('an unmeasured group pages after every measured one, and is not a zero', () => {
  const blind = address(0xa6)
  store.upsertTokenMeta(blind, 'BLIND', 18, true)
  store.recordStockToken(blind, issuer)
  const addr = address(0x9001)
  store.insertPool({ address: addr, proto: 'univ2', token0: blind, token1: USDT, feePpm: 3_000 })

  const body = groups(`origin=stock:${issuer}`)
  assert.deepEqual(body.groups.map((g) => g.token), [SHARE, THIN, blind])
  const unmeasured = body.groups.at(-1)!
  assert.equal(unmeasured.tvlUsd, null, 'nothing measured is null, never 0')
  assert.equal(unmeasured.vol24hUsd, null)
  assert.equal(unmeasured.fees24hUsd, null)
  assert.equal(unmeasured.poolCount, 1)

  // And the cursor can carry that absence without turning it into a value.
  const page = groups(`origin=stock:${issuer}&limit=2`)
  const rest = groups(
    `origin=stock:${issuer}&limit=2&after=${encodeURIComponent(page.nextCursor!)}`,
  )
  assert.deepEqual(rest.groups.map((g) => g.token), [blind])
})

test('an origin nobody can prove is refused rather than answered empty', () => {
  for (const bad of ['', 'stock:enron', 'whatever', 'stock:'])
    assert.throws(() => groups(`origin=${bad}`), /origin|issuer/)
  assert.throws(() => groups(`origin=stock:${issuer}&sort=apr`), /sort/)
})

test('every sort the grouped table offers actually reorders it', () => {
  // FEES and FEE APR used to highlight when clicked and change nothing: the
  // client fell back to TVL for anything it could not name, so the header
  // claimed an order the rows were not in. A shallow pool doing heavy volume
  // is the case that tells the four orders apart.
  const YIELD = address(0xa7)
  store.upsertTokenMeta(YIELD, 'YIELD', 18, true)
  store.recordStockToken(YIELD, issuer)
  v23(YIELD, 'univ2', 3_000, 1_000, 1_000_000)

  const rank = (sort: string, token: string) =>
    groups(`origin=stock:${issuer}&sort=${sort}&limit=100`).groups.findIndex(
      (g) => g.token === token,
    )
  assert.ok(rank('tvl', SHARE) < rank('tvl', YIELD), 'SHARE is the deeper book')
  assert.ok(rank('vol', SHARE) < rank('vol', YIELD), 'and trades more in absolute terms')
  assert.ok(rank('fees', SHARE) < rank('fees', YIELD))
  assert.ok(rank('feeApr', YIELD) < rank('feeApr', SHARE), 'but YIELD earns far more per dollar')

  assert.throws(() => groups(`origin=stock:${issuer}&sort=rewards`), /sort must be one of/)
})

// getV23Pools grew fastV23Count because recounting on every continuation makes
// browsing unusable. The same aggregate is the whole cost here, and the total
// cannot change under a cursor.
test('a continuation does not recount a total that cannot have moved', () => {
  const first = groups(`origin=stock:${issuer}&limit=1`)
  assert.equal(typeof first.count, 'number')
  assert.ok(first.count! > 1)
  const second = groups(
    `origin=stock:${issuer}&limit=1&after=${encodeURIComponent(first.nextCursor!)}`,
  )
  assert.equal(second.count, null)
  assert.equal(second.groups.length, 1)
  assert.notDeepEqual(second.groups[0].token, first.groups[0].token)
})

test('a repeated request is served from the cache, and a bad one never is', () => {
  api.clearPoolGroupsCache()
  const query = new URLSearchParams(`origin=stock:${issuer}`)
  const first = api.preparePoolGroupsResponse(query)
  assert.equal(first.status, 'MISS')
  const hit = api.preparePoolGroupsResponse(new URLSearchParams(`origin=stock:${issuer}`))
  assert.equal(hit.status, 'HIT')
  assert.match(hit.response.etag, /^W\/".+"$/, 'a weak validator, like every other pool response')
  assert.equal(hit.response.etag, first.response.etag)

  // Param order is not identity — the same question asked twice is one entry.
  assert.equal(
    api.preparePoolGroupsResponse(new URLSearchParams(`sort=tvl&origin=stock:${issuer}`)).status,
    'HIT',
  )
  // A rejected request is part of the contract and is never answered from a
  // last-good body, however stale the cache is allowed to get.
  assert.throws(() => api.preparePoolGroupsResponse(new URLSearchParams('origin=stock:enron')))
  assert.throws(() => api.preparePoolGroupsResponse(new URLSearchParams('origin=launchpad&nope=1')))
})
