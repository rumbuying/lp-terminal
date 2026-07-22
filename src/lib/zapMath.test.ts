import assert from 'node:assert/strict'
import test from 'node:test'
import { solveSwap, splitOutside } from './zapMath'

const A = 10n ** 18n

test('solveSwap: single-sided ratios take none or all', () => {
  assert.equal(solveSwap(A, 0, 2), 0n)
  assert.equal(solveSwap(A, Infinity, 2), A)
})

test('solveSwap: swapped slice matches the ratio at the quoted rate', () => {
  // rho = 1 counter per kept, rate = 1 → half swaps
  assert.equal(solveSwap(A, 1, 1), A / 2n)
  // dep_counter / dep_kept = (s·rate)/(A−s) must equal rho
  const rho = 3.7
  const rate = 0.82
  const s = solveSwap(A, rho, rate)
  const ratio = (Number(s) * rate) / Number(A - s)
  assert.ok(Math.abs(ratio - rho) / rho < 1e-9)
})

test('splitOutside: single-sided targets buy one side with everything', () => {
  assert.deepEqual(splitOutside(A, 0, 1), [{ buyIs0: true, swapIn: A }])
  assert.deepEqual(splitOutside(A, Infinity, 1), [{ buyIs0: false, swapIn: A }])
})

test('splitOutside: slices sum to the input and hit the target ratio', () => {
  const rho = 2.5 // want dep1/dep0 = 2.5
  const r0 = 30_000 // token0 per input
  const r1 = 12_000 // token1 per input
  const spec = splitOutside(A, rho, r0 / r1)
  assert.equal(spec.length, 2)
  const s0 = spec.find((s) => s.buyIs0)!.swapIn
  const s1 = spec.find((s) => !s.buyIs0)!.swapIn
  assert.equal(s0 + s1, A)
  const dep0 = Number(s0) * r0
  const dep1 = Number(s1) * r1
  assert.ok(Math.abs(dep1 / dep0 - rho) / rho < 1e-9)
})

test('splitOutside: equal rates and rho=1 split evenly', () => {
  const spec = splitOutside(A, 1, 1)
  assert.equal(spec.length, 2)
  assert.equal(spec[0].swapIn, A / 2n)
  assert.equal(spec[1].swapIn, A / 2n)
})

test('splitOutside: sub-ppm slivers fold into the other leg', () => {
  // rho so extreme the t0 slice is < A/1e6 → one leg only
  const spec = splitOutside(A, 10_000_000, 1)
  assert.equal(spec.length, 1)
  assert.equal(spec[0].buyIs0, false)
  assert.equal(spec[0].swapIn, A)
})

test('splitOutside: degenerate rate ratio degrades to one leg, never throws', () => {
  for (const bad of [0, NaN, Infinity]) {
    const spec = splitOutside(A, 1, bad)
    assert.equal(spec.length, 1)
    assert.equal(spec[0].swapIn, A)
  }
})
