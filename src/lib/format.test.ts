import assert from 'node:assert/strict'
import test from 'node:test'
import { fmtCompact, fmtNum, fmtUsd, sanitizeAmountInput } from './format'

test('amount input: fraction clamps to the token decimals, never silently zero', () => {
  // 6-decimal USDG: the 7th fraction digit is untypeable, not a hidden zero
  assert.equal(sanitizeAmountInput('0.0000001', 6), '0.000000')
  assert.equal(sanitizeAmountInput('0.0000015', 6), '0.000001')
  assert.equal(sanitizeAmountInput('0.00005', 18), '0.00005') // within precision → untouched
  assert.equal(sanitizeAmountInput('1.5', 0), '1')
})

test('amount input: scientific-notation pastes expand exactly (string math)', () => {
  assert.equal(sanitizeAmountInput('5e-5', 18), '0.00005')
  assert.equal(sanitizeAmountInput('3E-7', 18), '0.0000003')
  assert.equal(sanitizeAmountInput('1.2e3', 18), '1200')
  assert.equal(sanitizeAmountInput('1.2E+3', 6), '1200')
  assert.equal(sanitizeAmountInput('2.5e-7', 6), '0.000000') // expanded, then clamped
  assert.equal(sanitizeAmountInput('1e31', 18), null) // absurd exponents rejected
  assert.equal(sanitizeAmountInput('e5', 18), null) // no mantissa = not an amount
})

test('amount input: normalization and rejection', () => {
  assert.equal(sanitizeAmountInput('', 18), '')
  assert.equal(sanitizeAmountInput('0,05', 18), '0.05') // decimal comma
  assert.equal(sanitizeAmountInput(' 0.05 ', 18), '0.05')
  assert.equal(sanitizeAmountInput('.05', 18), '.05') // leading dot parses fine downstream
  assert.equal(sanitizeAmountInput('abc', 18), null)
  assert.equal(sanitizeAmountInput('1.2.3', 18), null)
  assert.equal(sanitizeAmountInput('-5', 18), null)
})

test('amount input: Chinese-IME fullwidth characters normalize instead of vanishing', () => {
  // rejecting just the fullwidth dot turned "0。05" into "005" — a 100× error
  assert.equal(sanitizeAmountInput('0。05', 6), '0.05')
  assert.equal(sanitizeAmountInput('0．05', 6), '0.05')
  assert.equal(sanitizeAmountInput('０．０５', 18), '0.05')
  assert.equal(sanitizeAmountInput('0，05', 18), '0.05') // fullwidth comma = decimal comma
  assert.equal(sanitizeAmountInput('０。０００００００１', 6), '0.000000') // normalize, then clamp
})

test('fmtNum compresses many-zero decimals to subscript notation', () => {
  assert.equal(fmtNum(0.000072051), '0.0₄72051')
  assert.equal(fmtNum(0.00003), '0.0₄3')
})

test('compact table figures stay short enough for a phone column', () => {
  assert.equal(fmtCompact(4_049), '4K')
  assert.equal(fmtCompact(2_844_349), '2.8M')
  // Intl's compact notation stops at T and then degrades into a grouped number:
  // 2.99e23 used to render "298,973,758,851.7T" — 18 characters, nowrap, which
  // widened the pool table past the viewport and forced sideways scrolling
  assert.equal(fmtCompact(2.99e23), '3.0e+23')
  for (const x of [0, 1, 999, 1e6, 1e12, 1e15, 2.99e23, 2.95e49, -1e30, 1e-9])
    assert.ok(fmtCompact(x).length <= 8, `fmtCompact(${x}) = "${fmtCompact(x)}" is too wide`)
})

test('fmtUsd is exact for real money and bounded for impossible money', () => {
  assert.equal(fmtUsd(4_049), '$4,049')
  assert.equal(fmtUsd(12.345), '$12.35')
  assert.equal(fmtUsd(0.004), '<$0.01')
  // third-party figures (dexscreener) are not sanity-checked upstream: past a
  // trillion the number is wrong, and rendering it exactly costs 30 columns
  assert.equal(fmtUsd(2.99e23), '$3.0e+23')
  assert.ok(fmtUsd(298_973_758_851_651_660_000_000).length <= 9)
})
