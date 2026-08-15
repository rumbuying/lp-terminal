// The sweep, against real SQL. The PROOF is not retested here — src/lib/
// stockToken.test.ts already pins all twenty of its cases, including the two
// this file cares about the consequences of: an impostor holding the real
// beacon is refused, and a failed read rejects rather than reporting "no
// issuer". What this file owns is everything around that call: which tokens get
// asked about, in what order, and what is written down afterwards.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, beforeEach, mock } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'stock-origin-'))
process.env.INDEXER_DB = join(dir, 'index.db')
after(() => rmSync(dir, { recursive: true, force: true }))

const WETH = '0x0000000000000000000000000000000000000d10'
const DEEP = '0x00000000000000000000000000000000000000a1'
const MID = '0x00000000000000000000000000000000000000a2'
const SHALLOW = '0x00000000000000000000000000000000000000a3'
const UNREADABLE = '0x00000000000000000000000000000000000000a4'

/** address → the issuer proven, null for matched-nobody, Error for a failed read */
let answers = new Map<string, string | null | Error>()
/** every address the sweep actually asked the chain about, in call order */
let asked: string[] = []
/** every address whose v4 history the sweep went back for */
let backfilled: string[] = []
let backfillPools = 0
let backfillError: Error | null = null

mock.module('../src/lib/stockToken', {
  namedExports: {
    readStockIssuer: async (_client: unknown, address: string) => {
      asked.push(address.toLowerCase())
      const answer = answers.get(address.toLowerCase()) ?? null
      if (answer instanceof Error) throw answer
      return answer
    },
  },
})
mock.module('./rpc', {
  namedExports: { pc: {}, safeError: (e: unknown) => String(e) },
})
mock.module('./v4Rpc', {
  namedExports: {
    admitV4Token: async (token: string) => {
      backfilled.push(token.toLowerCase())
      if (backfillError) throw backfillError
      return backfillPools
    },
  },
})

const { CHAIN } = await import('./config')
const { db, insertPool, upsertState, setTvl, stockIssuerOf, stockTokenMeasured } = await import(
  './store'
)
const { sweepStockOrigins, STOCK_PROBE_MIN_DEPTH_USD } = await import('./stockOrigin')

const issuer = CHAIN.stockIssuers[0]?.issuer
assert.ok(issuer, 'this test needs a chain that can prove an issuer')

/** a pool deep enough to make its non-anchor token a candidate at the given TVL */
let poolSeq = 0
function seedPool(token: string, tvlUsd: number): void {
  const address = `0x${(++poolSeq).toString(16).padStart(40, '0')}`
  const [token0, token1] = token < WETH ? [token, WETH] : [WETH, token]
  insertPool({ address, proto: 'univ2', token0, token1, feePpm: 3000 })
  upsertState(address, { reserve0: 1n, reserve1: 1n })
  setTvl(address, tvlUsd, false)
}

beforeEach(() => {
  db.exec('DELETE FROM stock_tokens; DELETE FROM pool_state; DELETE FROM pools')
  answers = new Map()
  asked = []
  backfilled = []
  backfillPools = 0
  backfillError = null
  poolSeq = 0
})

test('proven, matched-nobody and unread are three different outcomes on disk', async () => {
  seedPool(DEEP, 500_000)
  seedPool(MID, 10_000)
  seedPool(UNREADABLE, 5_000)
  seedPool(SHALLOW, STOCK_PROBE_MIN_DEPTH_USD - 1)
  answers.set(DEEP, issuer)
  answers.set(MID, null)
  answers.set(UNREADABLE, new Error('connection reset'))

  const swept = await sweepStockOrigins(64)

  // Three answered: the share, the ordinary token, and WETH — which is a
  // candidate like any other, because nothing here treats a token as special
  // on account of what it is. It costs one read, once, and answers nobody.
  assert.deepEqual(swept, { measured: 3, proven: 1, unread: 1, admitted: 0 })
  assert.equal(stockIssuerOf(DEEP), issuer)
  assert.equal(stockTokenMeasured(WETH), true)
  assert.equal(stockIssuerOf(MID), null)
  assert.equal(stockTokenMeasured(MID), true, 'matched-nobody is an answer, and is kept')
  // The point of the whole exercise. A failed read leaves NO answer on file, so
  // the next tick asks again — recording it as "no issuer" would cache one
  // dropped packet into a genuine share that stays unmarked forever, sitting in
  // a list beside the impersonators it exists to be distinguished from.
  assert.equal(stockTokenMeasured(UNREADABLE), false)
  assert.equal(stockTokenMeasured(SHALLOW), false, 'below the floor is never probed')
  assert.ok(!asked.includes(SHALLOW), 'and costs no RPC read either')
})

test('a measured token never comes back, so the backfill drains', async () => {
  seedPool(DEEP, 500_000)
  seedPool(MID, 10_000)
  answers.set(DEEP, issuer)

  assert.equal((await sweepStockOrigins(64)).measured, 3) // DEEP, MID and their WETH side
  assert.deepEqual(
    await sweepStockOrigins(64),
    { measured: 0, proven: 0, unread: 0, admitted: 0 },
    'the second sweep has nothing left to ask about',
  )
})

test('an unread token is asked again on the next tick', async () => {
  seedPool(UNREADABLE, 5_000)
  answers.set(UNREADABLE, new Error('connection reset'))
  assert.equal((await sweepStockOrigins(64)).unread, 1)

  answers.set(UNREADABLE, issuer)
  assert.equal((await sweepStockOrigins(64)).proven, 1)
  assert.equal(stockIssuerOf(UNREADABLE), issuer)
})

// Both sides of a pool are equally deep, so the smallest bound that can say
// anything about ordering is the two sides of the deepest one.
test('a bounded sweep takes the deepest markets first', async () => {
  seedPool(SHALLOW, 2_000)
  seedPool(DEEP, 500_000)
  seedPool(MID, 10_000)

  await sweepStockOrigins(2)
  assert.deepEqual([...asked].sort(), [DEEP, WETH].sort())
})

// A token is a candidate on its DEEPEST market, not on whichever pool the query
// happened to reach first. A share with one real pool and forty dust ones must
// not be ranked by the dust — here DEEP's shallow pool is below MID's, and DEEP
// still has to come first.
test('a token is ranked by its deepest pool, not its shallowest', async () => {
  seedPool(MID, 10_000)
  seedPool(DEEP, 2_000)
  seedPool(DEEP, 500_000)

  await sweepStockOrigins(2)
  assert.deepEqual([...asked].sort(), [DEEP, WETH].sort())
})

test('a chain read is never attempted when nothing is deep enough', async () => {
  seedPool(SHALLOW, STOCK_PROBE_MIN_DEPTH_USD - 1)
  assert.deepEqual(await sweepStockOrigins(64), {
    measured: 0,
    proven: 0,
    unread: 0,
    admitted: 0,
  })
  assert.deepEqual(asked, [])
})

// A share was minted long before anything read its proxy, so proving it widens
// the directory BACKWARDS — its v4 pools were skipped on the day they were
// created. Nothing else ever revisits them, so this is the only chance.
test('proving a share goes back for the v4 pools it already had', async () => {
  seedPool(DEEP, 500_000)
  seedPool(MID, 10_000)
  answers.set(DEEP, issuer)
  backfillPools = 3

  const swept = await sweepStockOrigins(64)
  assert.deepEqual(backfilled, [DEEP], 'only the token that just became a member')
  assert.equal(swept.admitted, 3)
})

test('a token measured as nobody\'s costs no backfill at all', async () => {
  seedPool(MID, 10_000)
  assert.equal((await sweepStockOrigins(64)).measured, 2)
  assert.deepEqual(backfilled, [])
})

// The chain already answered who issued this token. A backfill that cannot
// reach the RPC must not be able to take that answer back.
test('a failed backfill leaves the proof standing', async () => {
  seedPool(DEEP, 500_000)
  answers.set(DEEP, issuer)
  backfillError = new Error('connection reset')

  const swept = await sweepStockOrigins(64)
  assert.equal(swept.proven, 1)
  assert.equal(swept.admitted, 0)
  assert.equal(stockIssuerOf(DEEP), issuer)
})
