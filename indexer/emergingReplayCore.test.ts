import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyBurn,
  applyMint,
  applySwap,
  amount1Delta,
  computeSwapStep,
  enterPosition,
  exitPosition,
  initState,
  mulDivRoundingUp,
  nextInitializedTick,
  nextSqrtFromAmount1,
  Q96,
} from './emergingReplayCore'
import { getSqrtRatioAtTick } from '../src/lib/clmath'

const FEE_PPM = 3000 // 0.3%, a canonical v3 tier
const SQRT0 = getSqrtRatioAtTick(0)
const sqrtAt = (t: number) => getSqrtRatioAtTick(t)

test('mulDivRoundingUp: exact ceiling semantics', () => {
  assert.equal(mulDivRoundingUp(10n, 10n, 100n), 1n)
  assert.equal(mulDivRoundingUp(10n, 10n, 99n), 2n)
  assert.equal(mulDivRoundingUp(0n, 10n, 3n), 0n)
})

test('computeSwapStep: whole-span consumption charges fee on the full input', () => {
  const L = 1_000_000n
  // A span of one tick at L=1e6 costs ~30k wei of token1 — 1e6 input stays inside.
  const step = computeSwapStep(SQRT0, sqrtAt(60), L, 1_000n, FEE_PPM)
  const expectedFee = mulDivRoundingUp(1_000n, 3000n, 1_000_000n)
  assert.equal(step.feeAmount, expectedFee)
  assert.equal(step.sqrtNext > SQRT0, true, 'token1 input moves price up')
  assert.ok(step.amountIn + step.feeAmount <= 1_000n)
})

test('computeSwapStep: input too small to reach the target lands short of it', () => {
  const L = 1_000_000n
  const step = computeSwapStep(SQRT0, sqrtAt(60), L, 100n, FEE_PPM)
  assert.equal(step.feeAmount, 1n, 'ceil(100 × 0.003) = 1')
  assert.equal(step.sqrtNext < sqrtAt(60), true)
  assert.equal(step.amountIn + step.feeAmount, 100n, 'the whole input is consumed')
  // Price consistency: reconstructing the net move at down-rounding lands on
  // the input minus the fee, within the up/down rounding pair (±1 wei).
  const netMove = amount1Delta(SQRT0, step.sqrtNext, L, false)
  assert.ok(netMove === 99n || netMove === 98n, `net move ${netMove} ≈ 100 - fee 1`)
})

test('nextInitializedTick walks the registered boundaries only', () => {
  const ticks = new Map([[60, 500n], [-60, 100n]])
  assert.equal(nextInitializedTick(ticks, 0, true), -60)
  assert.equal(nextInitializedTick(ticks, 0, false), 60)
  assert.equal(nextInitializedTick(ticks, 61, false), null)
});

test('replay: shadow share is shadowL/(chainL+shadowL), dilution included (§7.1)', () => {
  const s = initState()
  // Chain liquidity: 1e9 in [-60,60]. The shadow position mirrors the range
  // with its own 1e9 — its L joins the fee denominator, halving its share.
  applyMint(s, -60, 60, 1_000_000_000n)
  enterPosition(s, -60, 60, 1_000_000_000n)

  // Bootstrap the price with a first swap (fees before an observed price are
  // unattributable), then a 1e6-wei swap that stays inside the span.
  applySwap(s, { amount0: '0', amount1: '5', sqrtPriceX96: nextSqrtFromAmount1(SQRT0, 1_000_000_000n, 4n, true).toString(), liquidity: '1000000000', tick: 0 }, FEE_PPM)
  const input = 1_000_000n
  const fee = mulDivRoundingUp(input, 3000n, 1_000_000n) // 3000
  const endSqrt = nextSqrtFromAmount1(s.sqrtP, 1_000_000_000n, input - fee, true)
  const r = applySwap(s, {
    amount0: `-${input - fee}`, amount1: input.toString(),
    sqrtPriceX96: endSqrt.toString(), liquidity: '1000000000', tick: 0,
  }, FEE_PPM)
  assert.equal(r.fee1, fee)
  assert.equal(s.position.owed1, fee / 2n, 'shadow L over (chain L + shadow L), floored')
  assert.equal(r.reconstructedLiquidity, 1_000_000_000n)

  const out = exitPosition(s)
  assert.ok(out.amount0 > 0n && out.amount1 > 0n)
  assert.equal(out.fee1, fee / 2n)
})

test('replay: crossing the upper bound deactivates the position mid-swap', () => {
  const s = initState()
  // Chain liquidity: A (1e9 in [-60,60]) + B (1e12 in [60,120]).
  applyMint(s, -60, 60, 1_000_000_000n)
  applyMint(s, 60, 120, 1_000_000_000_000n)
  // A shadow position mirroring A's range: the fee-share denominator is
  // chain L + shadow L = 2e9 while both sit in the first span.
  enterPosition(s, -60, 60, 1_000_000_000n)

  // Bootstrap the price with a 5-wei swap (far inside the first span at
  // L=1e9), then feed a swap that crosses tick 60 but not tick 120.
  applySwap(s, { amount0: '0', amount1: '5', sqrtPriceX96: nextSqrtFromAmount1(SQRT0, 1_000_000_000n, 4n, true).toString(), liquidity: '1000000000', tick: 0 }, FEE_PPM)

  const spanDelta = amount1Delta(SQRT0, sqrtAt(60), 1_000_000_000n, false)
  const input = spanDelta + 20_000n // crosses tick 60, lands inside [60,120]
  const feeTotal = mulDivRoundingUp(input, 3000n, 1_000_000n)
  void feeTotal
  // Walk it manually to know the end sqrt: step 1 consumes the span...
  const step1 = computeSwapStep(SQRT0, sqrtAt(60), 1_000_000_000n, input, FEE_PPM)
  assert.equal(step1.sqrtNext, sqrtAt(60))
  const step2 = computeSwapStep(sqrtAt(60), sqrtAt(120), 1_000_000_000_000n, input - step1.amountIn - step1.feeAmount, FEE_PPM)
  assert.equal(step2.sqrtNext < sqrtAt(120), true, 'the remainder lands inside B\u2019s span')

  const ev = {
    amount0: `-${(step1.amountOut + step2.amountOut)}`,
    amount1: input.toString(),
    sqrtPriceX96: step2.sqrtNext.toString(),
    liquidity: '1000000000000', // post-crossing active L is B alone
    tick: 60,
  }
  const r = applySwap(s, ev, FEE_PPM)

  // Fees: span1's fee splits between chain-LP and shadow; span2's fee is
  // entirely B's (the shadow is out of range).
  assert.equal(r.fee1, step1.feeAmount + step2.feeAmount)
  assert.equal(s.position.owed1, step1.feeAmount / 2n,
    'floor(share): shadow L over (chain L + shadow L), span1 only')
  assert.equal(r.reconstructedLiquidity, 1_000_000_000_000n,
    'the crossing walk reproduces the event\u2019s own liquidity exactly')
  assert.equal(s.sqrtP, step2.sqrtNext)

  // Exit above range: the price ran past the upper bound, so the principal
  // converted entirely to token1 (the quote side) — plus the owed fees.
  const out = exitPosition(s)
  assert.equal(out.amount0, 0n)
  assert.ok(out.amount1 > 0n)
  assert.equal(out.fee1, step1.feeAmount / 2n)
})

test('replay: a burn whose event was LOST is EXPOSED as an integrity mismatch', () => {
  const s = initState()
  applyMint(s, -60, 60, 1_000_000_000n)
  enterPosition(s, -60, 60, 500_000_000n)
  applySwap(s, { amount0: '0', amount1: '5', sqrtPriceX96: nextSqrtFromAmount1(SQRT0, 1_000_000_000n, 4n, true).toString(), liquidity: '1000000000', tick: 0 }, FEE_PPM)
  // The burn's event never reached the ledger — the ghost tick map still
  // carries A's full 1e9 — while the chain's next event reflects it.
  const spanDelta = amount1Delta(SQRT0, sqrtAt(60), 1_000_000_000n, false)
  const input = spanDelta + 20_000n
  const r = applySwap(s, {
    amount0: '0', amount1: input.toString(),
    sqrtPriceX96: sqrtAt(120).toString(),
    liquidity: '1000000000000', // chain truth: A gone, B alone above tick 60
    tick: 60,
  }, FEE_PPM)
  // The ghost walks its 1e9 across net(60) = -1e9 and collapses to ZERO,
  // while the chain says 1e12. The driver reads that gap and marks the pool
  // unsupported (§7.1) — the mismatch is the safety net.
  assert.equal(r.reconstructedLiquidity, 0n)
  assert.notEqual(r.reconstructedLiquidity, 1_000_000_000_000n)
  assert.equal(s.liquidity, 1_000_000_000_000n, 'the event\u2019s word is adopted verbatim')
})

test('Q96 sanity: tick math agrees with the shared clmath basis', () => {
  assert.equal(Q96, 1n << 96n)
  assert.equal(sqrtAt(60) > SQRT0, true)
})
