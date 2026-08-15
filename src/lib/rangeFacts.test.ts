import assert from 'node:assert/strict'
import { test } from 'node:test'
import { concentration, valueMix } from './rangeFacts'

const close = (a: number | null, b: number, tol = 1e-6) => {
  assert.ok(a !== null, 'expected a number')
  assert.ok(Math.abs(a - b) <= tol, `${a} !~= ${b}`)
}

test('concentration matches the canonical capital-efficiency figures', () => {
  // the numbers every v3 explainer quotes
  close(concentration(0.995, 1, 1.005), 400.497, 0.01)
  close(concentration(0.99, 1, 1.01), 200.494, 0.01)
  close(concentration(0.9, 1, 1.1), 20.4384, 0.001)
})

test('concentration approaches 2/x for a narrow +/-x band', () => {
  for (const x of [0.001, 0.005, 0.02]) {
    const c = concentration(1 - x, 1, 1 + x)!
    assert.ok(Math.abs(c - 2 / x) / (2 / x) < 0.02, `${c} vs ${2 / x}`)
  }
})

test('concentration is invariant to a uniform rescale of the prices', () => {
  const a = concentration(0.9, 1, 1.1)!
  for (const k of [1e-9, 3000, 1e12]) close(concentration(0.9 * k, k, 1.1 * k), a, a * 1e-9)
})

test('a full range is 1x by construction', () => {
  close(concentration(0, 1, Infinity), 1)
  // the real caller passes tickToPrice(MIN_TICK) / tickToPrice(MAX_TICK), which
  // underflow and overflow the double — same answer as the exact limits
  close(concentration(0, 2988, Infinity), 1)
})

test('one unbounded side still concentrates on the bounded one', () => {
  close(concentration(0.9, 1, Infinity), 2 / (2 - Math.sqrt(0.9)), 1e-9)
  close(concentration(0, 1, 1.1), 2 / (2 - 1 / Math.sqrt(1.1)), 1e-9)
})

test('a band the price has not reached reports what it is worth on arrival', () => {
  // price below the band clamps to pa, which is the state it enters in
  const arrival = concentration(1, 1, 1.1)!
  close(concentration(1, 0.5, 1.1), arrival, 1e-9)
  close(concentration(1, 0.9, 1.1), arrival, 1e-9)
  const exit = concentration(0.9, 1.1, 1.1)!
  close(concentration(0.9, 5, 1.1), exit, 1e-9)
})

test('concentration rejects a degenerate or unusable band', () => {
  assert.equal(concentration(1.1, 1, 0.9), null)
  assert.equal(concentration(1, 1, 1), null)
  assert.equal(concentration(0.9, 0, 1.1), null)
  assert.equal(concentration(0.9, NaN, 1.1), null)
})

test('value mix is 50/50 at the geometric centre of a band', () => {
  const m = valueMix(0.9, Math.sqrt(0.9 * 1.1), 1.1)!
  close(m.v0, 0.5, 1e-9)
  close(m.v1, 0.5, 1e-9)
})

test('value mix leans to the token the position is being handed', () => {
  // above the geometric centre the band has sold token0 into token1
  const hi = valueMix(0.9, 1.05, 1.1)!
  assert.ok(hi.v1 > hi.v0)
  const lo = valueMix(0.9, 0.95, 1.1)!
  assert.ok(lo.v0 > lo.v1)
})

test('value mix degenerates to one token at and past each bound', () => {
  assert.deepEqual(valueMix(0.9, 0.9, 1.1), { v0: 1, v1: 0 })
  assert.deepEqual(valueMix(0.9, 0.5, 1.1), { v0: 1, v1: 0 })
  assert.deepEqual(valueMix(0.9, 1.1, 1.1), { v0: 0, v1: 1 })
  assert.deepEqual(valueMix(0.9, 9, 1.1), { v0: 0, v1: 1 })
})

test('value mix is invariant to a uniform rescale, and sums to one', () => {
  const a = valueMix(0.9, 1.02, 1.1)!
  for (const k of [1e-9, 3000, 1e12]) {
    const b = valueMix(0.9 * k, 1.02 * k, 1.1 * k)!
    close(b.v0, a.v0, 1e-9)
    close(b.v0 + b.v1, 1, 1e-12)
  }
})

test('a full range holds half its value in each token', () => {
  const m = valueMix(0, 2988, Infinity)!
  close(m.v0, 0.5, 1e-12)
  close(m.v1, 0.5, 1e-12)
})

test('value mix rejects a degenerate band', () => {
  assert.equal(valueMix(1.1, 1, 0.9), null)
  assert.equal(valueMix(0.9, 0, 1.1), null)
})
