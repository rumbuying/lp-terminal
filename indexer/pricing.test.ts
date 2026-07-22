import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'lp-terminal-pricing-'))
process.env.INDEXER_DB = join(dir, 'test.db')

const { reprice, tvlOf, v3Price1Per0, v3SpotOk, weightedMedian } = await import('./state')
const { db, insertPool, setTokenPrice, upsertState, upsertTokenMeta } = await import('./store')

after(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('v3 spot price comes from sqrtPriceX96, decimals-adjusted', () => {
  // the autopsied P/USDG pool (P 18dec, USDG 6dec): sqrt implies ≈ $66.7/P —
  // the balance ratio the old code used had priced it $733,344 (11,000× off)
  const p = v3Price1Per0('647112078155313432359389', 18, 6)
  assert.ok(p !== null && Math.abs(p - 66.71) / 66.71 < 0.01)
  // same-decimals identity: sqrt = 2^96 → price exactly 1
  assert.equal(v3Price1Per0(String(2 ** 96), 18, 18), 1)
  // absent/degenerate states never price
  assert.equal(v3Price1Per0(null, 18, 6), null)
  assert.equal(v3Price1Per0('0', 18, 6), null)
})

test('a v3 pool only votes on price when its slot0 is a market', () => {
  assert.equal(v3SpotOk('12345', 180_896), true)
  // no in-range liquidity: slot0 is wherever the last poke left it, and the
  // next dust swap moves it anywhere for free
  assert.equal(v3SpotOk('0', 180_896), false)
  assert.equal(v3SpotOk(null, 180_896), false)
  // parked at the boundary (MAX_TICK 887272) — a broken init, not a market.
  // This is the pool that minted the $3.5e50 quote on 2026-07-22.
  assert.equal(v3SpotOk('12345', 887_271), false)
  assert.equal(v3SpotOk('12345', -887_271), false)
  assert.equal(v3SpotOk('12345', null), false)
  assert.equal(v3SpotOk('not-a-number', 0), false)
})

test('a token price is the depth-weighted median of its quotes', () => {
  // one manipulated pool must outweigh every honest pool, not just out-claim it
  assert.equal(weightedMedian([{ usd: 5, depth: 1_000 }]), 5)
  assert.equal(
    weightedMedian([
      { usd: 1e9, depth: 400 }, // manipulated, thin
      { usd: 2, depth: 10_000 }, // honest, deep
    ]),
    2,
  )
  // three-way: the middle of the depth mass wins, not the biggest number
  assert.equal(
    weightedMedian([
      { usd: 100, depth: 500 },
      { usd: 2, depth: 900 },
      { usd: 2.1, depth: 800 },
    ]),
    2.1,
  )
})

test('tvl clamps a runaway pool-priced side to the credible side', () => {
  // the autopsied case: $387 credible USDG vs $10.85M pool-priced P → $774 approx
  assert.deepEqual(tvlOf(10_850_000, false, 387, true), { tvl: 774, approx: true })
  // both credible: plain sum, exact
  assert.deepEqual(tvlOf(5_000, true, 5_200, true), { tvl: 10_200, approx: false })
  // pool-priced side under the ratio passes through (honest near-edge pools)
  assert.deepEqual(tvlOf(9_000, true, 600, false), { tvl: 9_600, approx: false })
  // one side unpriced: 2× the priced side, approximate
  assert.deepEqual(tvlOf(null, false, 1_000, true), { tvl: 2_000, approx: true })
  // junk-vs-junk: the smaller side bounds the claim
  assert.deepEqual(tvlOf(1e9, false, 100, false), { tvl: 200, approx: true })
  // nothing priced: no figure
  assert.deepEqual(tvlOf(null, false, null, false), { tvl: null, approx: false })
})

test('tvl caps a side at the credible depth that established its price', () => {
  // two junk sides inflated by the SAME factor pass the ratio test (that is how
  // a $1.4k pool reported $2.95e49) — the depth cap is what actually bounds it
  assert.deepEqual(tvlOf(1e24, false, 1e24, false, 1e5, 1e5), { tvl: 200_000, approx: true })
  // a side under its cap is untouched
  assert.deepEqual(tvlOf(4_000, false, 4_100, false, 1e5, 1e5), { tvl: 8_100, approx: false })
  // the cap applies before the ratio test, and the ratio test still wins when
  // it is the tighter bound
  assert.deepEqual(tvlOf(1e9, false, 100, false, 1e6, Infinity), { tvl: 200, approx: true })
})

// ---------------------------------------------------------------------------
// End-to-end: the 2026-07-22 poisoning, replayed against the real pass.
//
// One v3 pool parked at MAX_TICK with zero in-range liquidity, holding $1,464
// of real USDG, priced its counter-token at $3.5e50; that price then out-bid
// every honest quote (its fabricated "depth" was 1e19× bigger) and spread until
// 120 of the 120 rows the POOLS tab fetches were fabricated.
// ---------------------------------------------------------------------------

const A = (n: number) => '0x' + n.toString(16).padStart(40, '0')
const [USDG, WETH, GME, KITTY, FAKE, JUNK] = [1, 2, 3, 4, 5, 6].map(A)
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970341n
const sqrtX96 = (p1per0: number, dec0: number, dec1: number) =>
  BigInt(Math.round(Math.sqrt(p1per0 * 10 ** (dec1 - dec0)) * 2 ** 96))
const units = (x: number, dec: number) => BigInt(Math.round(x * 10 ** Math.min(dec, 15))) * 10n ** BigInt(Math.max(dec - 15, 0))

const priceOf = (addr: string) =>
  (db.prepare('SELECT price_usd FROM tokens WHERE address = ?').get(addr) as { price_usd: number | null }).price_usd
const poolTvl = (addr: string) =>
  db.prepare('SELECT tvl_usd, tvl_approx FROM pool_state WHERE address = ?').get(addr) as {
    tvl_usd: number | null
    tvl_approx: number
  }

test('reprice: a boundary-tick pool with no in-range liquidity cannot mint a price', () => {
  for (const [a, sym, dec] of [
    [USDG, 'USDG', 6],
    [WETH, 'WETH', 18],
    [GME, 'GME', 18],
    [KITTY, 'KITTY', 18],
    [FAKE, 'FAKE', 18],
    [JUNK, 'JUNK', 18],
  ] as const)
    upsertTokenMeta(a, sym, dec, true)
  setTokenPrice(USDG, 1, 100_000, 'gt')
  setTokenPrice(WETH, 2_000, 100_000, 'gt')

  // patient zero: 0.239 GME + 1408 USDG, slot0 pinned at MAX_TICK, L = 0
  const gmeUsdg = A(0x100)
  insertPool({ address: gmeUsdg, proto: 'univ3', token0: GME, token1: USDG, feePpm: 10_000, tickSpacing: 200 })
  upsertState(gmeUsdg, {
    sqrtPrice: MAX_SQRT_RATIO,
    tick: 887_271,
    liquidity: 0n,
    reserve0: units(0.239, 18),
    reserve1: units(1_408, 6),
  })

  // honest: 5 WETH + 1e7 KITTY at 2,000,000 KITTY/WETH → KITTY = $0.001
  const wethKitty = A(0x101)
  insertPool({ address: wethKitty, proto: 'univ3', token0: WETH, token1: KITTY, feePpm: 3_000, tickSpacing: 60 })
  upsertState(wethKitty, {
    sqrtPrice: sqrtX96(2e6, 18, 18),
    tick: 180_896,
    liquidity: 36_819_258_015_569_838_458_222n,
    reserve0: units(5, 18),
    reserve1: units(1e7, 18),
  })

  // thin dissenter on the same token, 1000× off: $400 of USDG vs $10k of WETH
  const usdgKitty = A(0x102)
  insertPool({ address: usdgKitty, proto: 'univ2', token0: USDG, token1: KITTY, feePpm: 3_000 })
  upsertState(usdgKitty, { reserve0: units(400, 6), reserve1: units(4e8, 18), totalSupply: 1n })

  // hop 2, and then a pool where FAKE's balance alone would claim $1e9
  const kittyFake = A(0x103)
  insertPool({ address: kittyFake, proto: 'univ2', token0: KITTY, token1: FAKE, feePpm: 3_000 })
  upsertState(kittyFake, { reserve0: units(1e6, 18), reserve1: units(1e3, 18), totalSupply: 1n })
  const fakeJunk = A(0x104)
  insertPool({ address: fakeJunk, proto: 'univ2', token0: FAKE, token1: JUNK, feePpm: 3_000 })
  upsertState(fakeJunk, { reserve0: units(1e9, 18), reserve1: units(1e6, 18), totalSupply: 1n })

  reprice()

  // 1. the boundary pool never priced GME, and its TVL is 2× the credible side
  assert.equal(priceOf(GME), null)
  const gmeTvl = poolTvl(gmeUsdg)
  assert.ok(gmeTvl.tvl_usd !== null && Math.abs(gmeTvl.tvl_usd - 2_816) < 1, `got ${gmeTvl.tvl_usd}`)
  assert.equal(gmeTvl.tvl_approx, 1)

  // 2. the deep honest quote sets KITTY; the thin 1000×-off pool does not move it
  const kitty = priceOf(KITTY)
  assert.ok(kitty !== null && Math.abs(kitty - 0.001) / 0.001 < 0.01, `got ${kitty}`)

  // 3. hop 2 prices FAKE, but its depth is capped by KITTY's — so the pool where
  //    FAKE holds a nominal $1e9 reports $200k, not $2e9
  const fake = priceOf(FAKE)
  assert.ok(fake !== null && Math.abs(fake - 1) < 0.01, `got ${fake}`)
  const junkTvl = poolTvl(fakeJunk)
  assert.ok(junkTvl.tvl_usd !== null && junkTvl.tvl_usd <= 250_000, `got ${junkTvl.tvl_usd}`)
  assert.equal(junkTvl.tvl_approx, 1)

  // 4. the invariant the frontpage actually depends on
  const worst = db.prepare('SELECT MAX(tvl_usd) AS m FROM pool_state').get() as { m: number | null }
  assert.ok((worst.m ?? 0) < 1e9, `a pool reported ${worst.m}`)
  const dearest = db.prepare('SELECT MAX(price_usd) AS m FROM tokens').get() as { m: number | null }
  assert.ok((dearest.m ?? 0) <= 1e9, `a token priced ${dearest.m}`)
})

test('reprice: a poisoned price does not survive the next pass', () => {
  // simulate the live DB state: KITTY pinned at a fantasy price with the
  // fabricated depth that used to make it unbeatable
  setTokenPrice(KITTY, 3.5e50, 1e49, 'pool')
  reprice()
  const kitty = priceOf(KITTY)
  assert.ok(kitty !== null && Math.abs(kitty - 0.001) / 0.001 < 0.01, `got ${kitty}`)

  // an out-of-band GT seed is dropped too, whatever depth it claims
  setTokenPrice(WETH, 1e30, 1e9, 'gt')
  reprice()
  assert.equal(priceOf(WETH), null)
})
