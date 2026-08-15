import assert from 'node:assert/strict'
import test from 'node:test'
import {
  allInCostBps,
  AUTO_IMPACT_LIMIT_BPS,
  autoSlippage,
  clampSlippageBps,
  CONFIRM_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  MIN_SLIPPAGE_BPS,
  needsSlippageConfirm,
  retrySlippage,
  slippagePctToBps,
} from './swapGate'

test('auto slippage = impact + pool fee + max(0.3%, half the impact)', () => {
  // zero impact, no fee: just the 0.3% pad
  assert.deepEqual(autoSlippage(0, 0), { bps: 30, tone: 'green' })
  // the pool fee tier rides along as a volatility prior (1% pool -> +1%)
  assert.deepEqual(autoSlippage(0, 100), { bps: 130, tone: 'amber' })
  assert.deepEqual(autoSlippage(20, 30), { bps: 80, tone: 'green' })
  // half-the-impact overtakes the pad once impact > 0.6%
  assert.deepEqual(autoSlippage(100, 30), { bps: 180, tone: 'amber' })
  assert.deepEqual(autoSlippage(300, 100), { bps: 550, tone: 'red' })
  // no 3% ceiling — a thin/volatile token gets real headroom
  assert.deepEqual(autoSlippage(800, 100), { bps: 1300, tone: 'red' })
})

test('auto declines past the high-impact limit so the user must choose', () => {
  // at the limit it still auto-derives (10% impact, 1% pool -> 16%)
  assert.deepEqual(autoSlippage(AUTO_IMPACT_LIMIT_BPS, 100), { bps: 1600, tone: 'red' })
  // beyond it, no guess — the caller forces a manual choice
  assert.equal(autoSlippage(AUTO_IMPACT_LIMIT_BPS + 1, 100), null)
  assert.equal(autoSlippage(2500, 0), null)
})

test('auto slippage tolerates a missing/garbage impact or fee', () => {
  assert.deepEqual(autoSlippage(Number.NaN, 100), { bps: 130, tone: 'amber' })
  assert.deepEqual(autoSlippage(-5, 0), { bps: 30, tone: 'green' })
  assert.deepEqual(autoSlippage(0, Number.NaN), { bps: 30, tone: 'green' })
  assert.deepEqual(autoSlippage(0, -40), { bps: 30, tone: 'green' })
})

test('slippage bps clamps to the sane band', () => {
  assert.equal(clampSlippageBps(5), MIN_SLIPPAGE_BPS)
  assert.equal(clampSlippageBps(99_999), MAX_SLIPPAGE_BPS)
  assert.equal(clampSlippageBps(250), 250)
  assert.equal(clampSlippageBps(Number.NaN), MIN_SLIPPAGE_BPS)
})

test('retry floor after a slippage halt: 1.5x, ceil to 0.1%, clamped', () => {
  assert.equal(retrySlippage(100), 150) // 1% -> 1.5%
  assert.equal(retrySlippage(150), 230) // 1.5% -> 2.25% -> ceil 2.3%
  assert.equal(retrySlippage(10), 20) // floor value still moves up
  assert.equal(retrySlippage(4000), MAX_SLIPPAGE_BPS) // never past the 50% ceiling
  assert.equal(retrySlippage(0), MIN_SLIPPAGE_BPS)
})

test('a tolerance past 10% has to be confirmed a second time', () => {
  assert.equal(CONFIRM_SLIPPAGE_BPS, 1000)
  assert.equal(needsSlippageConfirm(CONFIRM_SLIPPAGE_BPS + 1), true)
  assert.equal(needsSlippageConfirm(2500), true)
  assert.equal(needsSlippageConfirm(MAX_SLIPPAGE_BPS), true)
  // exactly 10% is a number the user landed on at the editor, and stands
  assert.equal(needsSlippageConfirm(CONFIRM_SLIPPAGE_BPS), false)
  assert.equal(needsSlippageConfirm(300), false)
  assert.equal(needsSlippageConfirm(MIN_SLIPPAGE_BPS), false)
  // no tolerance chosen yet is not a wide one — that button says CHOOSE SLIPPAGE
  assert.equal(needsSlippageConfirm(undefined), false)
})

test('the tolerances AUTO derives on its own reach past the confirm line', () => {
  // the guard has to be reachable without anyone typing a number: AUTO covers
  // impact + pool fee + a pad, and a thin pool crosses 10% by itself
  const derived = autoSlippage(800, 100) as { bps: number }
  assert.equal(needsSlippageConfirm(derived.bps), true) // 13%
  // while an ordinary trade on a 0.30% pool stays under it, unasked
  assert.equal(needsSlippageConfirm((autoSlippage(100, 30) as { bps: number }).bps), false) // 1.8%
  // and the post-halt retry floor climbs there too, without a second opinion
  assert.equal(needsSlippageConfirm(retrySlippage(700)), true) // 7% -> 10.5%
  assert.equal(needsSlippageConfirm(retrySlippage(600)), false) // 6% -> 9%
})

test('typed slippage percent parses to clamped bps or null', () => {
  assert.equal(slippagePctToBps('2.5'), 250)
  assert.equal(slippagePctToBps('0'), null)
  assert.equal(slippagePctToBps(''), null)
  assert.equal(slippagePctToBps('abc'), null)
  assert.equal(slippagePctToBps('100'), MAX_SLIPPAGE_BPS) // 100% → clamps to 50%
})

// Live capture, WETH->CASHCAT 0.001 at block 14620232, both replayed on a fork
// pinned to it: the solver DELIVERED 26.66 bps more than the best direct route
// while its per-route cost number read worse. These are those exact wei.
const SOLVER_OUT = 27824940167729483416n
const DIRECT_OUT = 27750957768818896557n
const SOLVER_IMPACT_BPS = 20
const DIRECT_POOL_FEE_BPS = 30

// A baseline above both outputs — its level cancels out of the comparison,
// which is the entire point of sharing one.
const MID_OUT = 27_900_000_000_000_000_000n

test('the shared baseline ranks routes the way their outputs do', () => {
  const solverCost = allInCostBps(SOLVER_OUT, MID_OUT) as number
  const directCost = allInCostBps(DIRECT_OUT, MID_OUT) as number
  // the solver row must read CHEAPER, because it delivers more
  assert.ok(solverCost < directCost)
  // and the gap must match the measured on-chain delivery gap (+26.66 bps)
  const measured = Number(((SOLVER_OUT - DIRECT_OUT) * 10_000n) / DIRECT_OUT)
  assert.ok(Math.abs(directCost - solverCost - measured) <= 1)
})

test('the per-route cost ranked those same two routes backwards', () => {
  // why one shared baseline exists. The shipped comparison summed each row's
  // own impact with its own pool fee: 20 + 35.5 blended for the solver against
  // 0 + 30 for the single direct pool.
  const solverOld = SOLVER_IMPACT_BPS + 35.5
  const directOld = 0 + DIRECT_POOL_FEE_BPS
  assert.ok(solverOld > directOld) // the better route looked worse
  // against one denominator the same two rows order by delivered output
  assert.ok((allInCostBps(SOLVER_OUT, MID_OUT) as number) < (allInCostBps(DIRECT_OUT, MID_OUT) as number))
})

// Live capture, WETH->UP 1.0 at block 14669650, straight off the solver.
// The probe routes 100% through the 0.30% v2 pool; full size routes 91% into
// the 1.00% CL pool, which is why the two wrong numbers miss in OPPOSITE
// directions and neither can be nudged into the other.
const UP_NET_OUT = 15492887659763651613081n
const UP_MID_OUT = 15631003702256628545100n
const UP_IMPACT_BPS = 59 // the whole headline before this change
const UP_ROUTE_FEE_BPS = 93.48 // share-weighted across the split

test('the headline is baseline-relative cost, not raw probe degradation or a naive sum', () => {
  const allIn = allInCostBps(UP_NET_OUT, UP_MID_OUT) as number
  assert.equal(allIn, 88) // 88.36, to the display's resolution

  // it must sit STRICTLY between the two numbers that shipped: the bare size
  // move understates by the probe route's own 30 bps fee, and adding the full
  // route's fee back overstates by counting the 0.30%->1.00% gap twice
  const naiveSum = UP_IMPACT_BPS + UP_ROUTE_FEE_BPS
  assert.ok(UP_IMPACT_BPS < allIn && allIn < naiveSum)
  assert.ok(Math.abs(naiveSum - 152.48) < 1e-9) // fractional venue fee, float noise
})

test('the cost is unavailable for a missing or stale baseline', () => {
  assert.equal(allInCostBps(SOLVER_OUT * 2n, MID_OUT), null)
  assert.equal(allInCostBps(MID_OUT, MID_OUT), 0) // no gap to the selected baseline
  assert.equal(allInCostBps(SOLVER_OUT, null), null)
})

test('autoSlippage takes raw probe degradation, never baseline-relative cost', () => {
  // it adds the pool fee itself, so handing it a fee-inclusive number counts
  // that fee twice — this pins the two apart
  const impact = 40
  const poolFee = 30
  const raw = autoSlippage(impact, poolFee)
  const doubled = autoSlippage(impact + poolFee, poolFee)
  assert.notDeepEqual(raw, doubled)
  assert.deepEqual(raw, { bps: 100, tone: 'green' }) // 40 + 30 + max(30, 20)
  assert.deepEqual(doubled, { bps: 140, tone: 'amber' }) // fee counted twice: 70 + 30 + 35
})
