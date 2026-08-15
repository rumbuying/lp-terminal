import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  largestFundable,
  pairFrom,
  pairLiquidity,
  refitToBand,
  sidesForBand,
  valueInSide1X64,
  type Pair,
} from './clDeposit'
import { fullRangeTicks, getSqrtRatioAtTick } from './clmath'

// a pool at tick 0 — price 1.0 with matching decimals, so every expectation
// below can be read as "same value on both sides"
const P = getSqrtRatioAtTick(0)
const ONE = 10n ** 18n

const band = (lower: number, upper: number) => ({ lower, upper })
const IN = band(-600, 600) // straddles the price
const OVER = band(600, 1200) // entirely above it: token0 only
const UNDER = band(-1200, -600) // entirely below it: token1 only
const SLIVER = band(0, 1200) // lower edge ON the price: token0 but for a hair

const refit = (p: Pair, b: { lower: number; upper: number }) => refitToBand(p, P, b.lower, b.upper)
const liq = (p: Pair, b: { lower: number; upper: number }) =>
  pairLiquidity(P, b.lower, b.upper, p.amount0, p.amount1)
const worth = (p: Pair) => valueInSide1X64(p, P)
/** parts per million of drift, so tolerances read as what they are */
const driftPpm = (a: bigint, b: bigint) => Number(((a - b) * 1_000_000n) / b)

test('sidesForBand agrees with previewDeposit on every boundary', () => {
  assert.deepEqual(sidesForBand(P, IN.lower, IN.upper), { needs0: true, needs1: true })
  assert.deepEqual(sidesForBand(P, OVER.lower, OVER.upper), { needs0: true, needs1: false })
  assert.deepEqual(sidesForBand(P, UNDER.lower, UNDER.upper), { needs0: false, needs1: true })
  // a band whose edge sits exactly ON the price is one-sided, matching the
  // <= / >= branches previewDeposit takes
  assert.deepEqual(sidesForBand(P, 0, 600), { needs0: true, needs1: false })
  assert.deepEqual(sidesForBand(P, -600, 0), { needs0: false, needs1: true })
})

test('typing fixes the box that was typed in and derives the other', () => {
  const p = pairFrom(P, IN.lower, IN.upper, 100n * ONE, 0)
  assert.equal(p.amount0, 100n * ONE)
  // symmetric band at price 1 -> the same value on the other side
  assert.ok(p.amount1 > 99n * ONE && p.amount1 <= 100n * ONE)
  const q = pairFrom(P, IN.lower, IN.upper, 100n * ONE, 1)
  assert.equal(q.amount1, 100n * ONE)
})

test('typing into a side the band does not take moves the money across at spot', () => {
  const p = pairFrom(P, UNDER.lower, UNDER.upper, 100n * ONE, 0)
  assert.equal(p.amount0, 0n)
  assert.ok(Math.abs(driftPpm(p.amount1, 100n * ONE)) < 10)
})

test('a band change holds the deposit steady in value', () => {
  const start = pairFrom(P, IN.lower, IN.upper, 100n * ONE, 0)
  for (const b of [band(-6000, 6000), band(-60, 60), band(-300, 900), OVER, UNDER, SLIVER]) {
    const moved = refit(start, b)
    assert.ok(
      Math.abs(driftPpm(worth(moved), worth(start))) < 100,
      `[${b.lower},${b.upper}] moved the deposit from ${worth(start)} to ${worth(moved)}`,
    )
  }
})

test('the widening that used to multiply a position by nine now leaves it alone', () => {
  // ±6% band, 100 token0 in. Pinning that 100 and re-deriving the partner took
  // a measured $200 deposit to $1,814 the moment the band was dragged wide.
  const start = pairFrom(P, -600, 600, 100n * ONE, 0)
  // widened DOWNWARD, so the band leans on token1 and the split has to move —
  // a band widened symmetrically around spot stays 50/50 and would prove nothing
  const wide = refit(start, band(-6000, 600))
  assert.ok(Math.abs(driftPpm(worth(wide), worth(start))) < 100)
  assert.ok(wide.amount0 < start.amount0, 'a band leaning down wants less of the token that was typed')
  assert.ok(wide.amount1 > start.amount1, 'and more of the other')
})

test('walking the band from one side of the price to the other never strands the deposit', () => {
  // the defect this module exists for: the deposit ended up on the token the
  // band no longer takes, liquidity came out zero, and the mint reverted
  let p = pairFrom(P, IN.lower, IN.upper, 100n * ONE, 0)
  p = refit(p, OVER)
  assert.equal(p.amount1, 0n, 'a band above the price takes no token1')
  assert.ok(liq(p, OVER) > 0n)
  p = refit(p, UNDER)
  assert.equal(p.amount0, 0n, 'a band below the price takes no token0')
  assert.ok(liq(p, UNDER) > 0n, 'the deposit followed the band across the price')
})

test('toggling the two one-sided modes keeps the size instead of collapsing it', () => {
  // ABOVE on a pool whose tick is already aligned leaves a hair of token1 in
  // the band. Carrying that hair over as the new size turned a $100 position
  // into $0.018; carrying the VALUE over keeps it at $100.
  const above = pairFrom(P, SLIVER.lower, SLIVER.upper, 100n * ONE, 0)
  const below = refit(above, band(-1200, 0))
  assert.ok(Math.abs(driftPpm(worth(below), worth(above))) < 100)
  const back = refit(below, SLIVER)
  assert.ok(Math.abs(driftPpm(back.amount0, 100n * ONE)) < 100, `came back as ${back.amount0}`)
})

test('a band dragged out across the price and back returns to where it started', () => {
  // Each step floors, so the trip is not a bijection to the wei. What has to
  // hold is that it cannot DRIFT: repeat it and the deposit settles rather than
  // walks, or a reader nudging a handle back and forth would inflate a position
  // past their balance.
  const start = pairFrom(P, IN.lower, IN.upper, 100n * ONE, 0)
  let p = start
  for (let i = 0; i < 20; i++) p = refit(refit(p, UNDER), IN)
  assert.ok(Math.abs(driftPpm(worth(p), worth(start))) < 10, `drifted to ${worth(p)}`)
})

test('re-applying the same band settles instead of walking', () => {
  // Not a strict fixed point: weighing the deposit and scaling the reference
  // both floor, so a repeat can shed a wei. It has to not accumulate, because
  // the caller re-runs on the same band — typing an upper tick below the lower
  // one drops the band to null and typing it back re-fires the refit on a pair
  // that has already been through it.
  let p: Pair = refit(pairFrom(P, IN.lower, IN.upper, 100n * ONE, 0), IN)
  const first = p
  for (let i = 0; i < 50; i++) p = refit(p, IN)
  assert.ok(p.amount0 <= first.amount0 && p.amount1 <= first.amount1, 'never grows')
  assert.ok(first.amount0 - p.amount0 <= 100n, `shed ${first.amount0 - p.amount0} wei over 50 passes`)
})

test('an empty deposit stays empty through any band', () => {
  for (const b of [IN, OVER, UNDER]) {
    const p = refit({ amount0: 0n, amount1: 0n }, b)
    assert.equal(p.amount0, 0n)
    assert.equal(p.amount1, 0n)
  }
})

test('largestFundable never exceeds either balance, on any band', () => {
  const bal0 = 3n * ONE
  const bal1 = 7n * ONE
  for (const b of [IN, OVER, UNDER, SLIVER, band(-60, 4000), band(-4000, 60)]) {
    const p = largestFundable(P, b.lower, b.upper, bal0, bal1)
    assert.ok(p.amount0 <= bal0, `token0 ${p.amount0} > ${bal0} on [${b.lower},${b.upper}]`)
    assert.ok(p.amount1 <= bal1, `token1 ${p.amount1} > ${bal1} on [${b.lower},${b.upper}]`)
    assert.ok(liq(p, b) > 0n, 'and it is still worth minting')
  }
})

test('largestFundable spends the binding side to the last wei it can', () => {
  // token1 is the scarce side of a symmetric band at price 1
  const p = largestFundable(P, IN.lower, IN.upper, 1000n * ONE, ONE)
  assert.equal(p.amount1, ONE, 'the binding balance goes in whole, not a wei short')
  assert.ok(p.amount0 < 1000n * ONE)
})

test('a one-sided band bounds only the token it takes', () => {
  const p = largestFundable(P, OVER.lower, OVER.upper, 3n * ONE, 0n)
  assert.equal(p.amount0, 3n * ONE, 'an empty token1 balance cannot bind a token0-only band')
  assert.equal(p.amount1, 0n)
})

test('a balance not yet read does not bind, and neither read sizes nothing', () => {
  const p = largestFundable(P, IN.lower, IN.upper, undefined, ONE)
  assert.ok(p.amount0 > 0n && p.amount1 > 0n)
  assert.deepEqual(largestFundable(P, IN.lower, IN.upper, undefined, undefined), {
    amount0: 0n,
    amount1: 0n,
  })
})

test('a balance the band cannot spend is not a budget', () => {
  // A token1-only band sized off the token0 balance is an offer to deposit a
  // token the wallet has never been asked about — 5 of token1, backed by
  // nothing but the fact that 5 of token0 happened to be lying around.
  assert.deepEqual(largestFundable(P, UNDER.lower, UNDER.upper, 5n * ONE, undefined), {
    amount0: 0n,
    amount1: 0n,
  })
  assert.deepEqual(largestFundable(P, OVER.lower, OVER.upper, undefined, 5n * ONE), {
    amount0: 0n,
    amount1: 0n,
  })
})

test('a full range carries its value like any other band', () => {
  // The widest band a preset offers. It buys enormously more per unit of
  // liquidity than a tight one, which is what would break a reference-scaled
  // refit if the reference were sized wrong.
  const full = fullRangeTicks(1)
  const start = pairFrom(P, IN.lower, IN.upper, 100n * ONE, 0)
  const wide = refitToBand(start, P, full.lower, full.upper)
  assert.ok(Math.abs(driftPpm(worth(wide), worth(start))) < 100, `${worth(start)} -> ${worth(wide)}`)
  assert.ok(refitToBand(wide, P, IN.lower, IN.upper).amount0 > 99n * ONE, 'and comes back')
})

test('pairLiquidity reports zero exactly when the deposit would revert', () => {
  for (const stranded of [
    { pair: { amount0: 100n * ONE, amount1: 0n }, wrongBand: UNDER },
    { pair: { amount0: 0n, amount1: 100n * ONE }, wrongBand: OVER },
  ]) {
    assert.equal(liq(stranded.pair, stranded.wrongBand), 0n)
    // and the refit this module performs is what rescues it
    assert.ok(liq(refit(stranded.pair, stranded.wrongBand), stranded.wrongBand) > 0n)
  }
})

test('the value carried across a band change survives lopsided decimals', () => {
  // a 6-decimal token0 against an 18-decimal token1 puts the spot price ~1e12
  // away from 1, which is where a scaling done in the wrong units shows up
  // an 18-decimal token0 against a 6-decimal token1 puts the RAW price ~1e-12
  // away from 1, which is where a value carried in unscaled token1 units would
  // round to nothing and empty both boxes
  const sqrtP = getSqrtRatioAtTick(-276324)
  const start = pairFrom(sqrtP, -276924, -275724, 10n ** 18n, 0)
  const moved = refitToBand(start, sqrtP, -280000, -270000)
  assert.ok(
    Math.abs(driftPpm(valueInSide1X64(moved, sqrtP), valueInSide1X64(start, sqrtP))) < 100,
    `${valueInSide1X64(start, sqrtP)} -> ${valueInSide1X64(moved, sqrtP)}`,
  )
})
