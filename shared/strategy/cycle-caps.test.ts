import assert from 'node:assert/strict'
import test from 'node:test'
import {
  consecutiveLowerBreakResetAt,
  countConsecutiveLowerBreaks,
  lowerBreakWindowSeconds,
  nextUtcDayStart,
} from './cycle-caps'

const NOW = 1_700_000_000
const WINDOW = 86_400

const cycle = (minutesAgo: number, triggerSide: string | null = 'lower') => ({
  triggerSide,
  completedAt: NOW - minutesAgo * 60,
})

test('counts the trailing consecutive lower streak inside the window', () => {
  const cycles = [cycle(10), cycle(20), cycle(30), cycle(40, 'upper'), cycle(50)]
  assert.equal(countConsecutiveLowerBreaks(cycles, { now: NOW, windowSeconds: WINDOW }), 3)
})

test('a streak older than the window decays to zero so the cap cannot deadlock', () => {
  // Production deadlock: four lower breaks older than any window, position
  // still below the range, no non-lower cycle possible to reset the count.
  const cycles = [cycle(30 * 24 * 60), cycle(31 * 24 * 60), cycle(32 * 24 * 60), cycle(33 * 24 * 60)]
  assert.equal(countConsecutiveLowerBreaks(cycles, { now: NOW, windowSeconds: WINDOW }), 0)
})

test('a partially aged streak counts only the entries still inside the window', () => {
  const cycles = [cycle(10), cycle(20), cycle(90 * 60), cycle(100 * 60)]
  assert.equal(countConsecutiveLowerBreaks(cycles, { now: NOW, windowSeconds: WINDOW }), 2)
})

test('resetAt is when the threshold-th newest streak entry leaves the window', () => {
  // Streak of 4 (newest first at t-10..40min); threshold 4 releases when the
  // oldest (40min) exits the window.
  const cycles = [cycle(10), cycle(20), cycle(30), cycle(40)]
  assert.equal(
    consecutiveLowerBreakResetAt(cycles, { now: NOW, windowSeconds: WINDOW, threshold: 4 }),
    cycle(40).completedAt + WINDOW,
  )
  // With threshold 2 the cap releases earlier: when the 2nd newest exits.
  assert.equal(
    consecutiveLowerBreakResetAt(cycles, { now: NOW, windowSeconds: WINDOW, threshold: 2 }),
    cycle(20).completedAt + WINDOW,
  )
})

test('resetAt is undefined while the streak is below the threshold', () => {
  const cycles = [cycle(10), cycle(20)]
  assert.equal(consecutiveLowerBreakResetAt(cycles, { now: NOW, windowSeconds: WINDOW, threshold: 3 }), undefined)
})

test('resetAt releases only after enough of an over-threshold streak has aged out', () => {
  // Count 6, threshold 4: releases only when the 3rd oldest has left.
  const cycles = [cycle(10), cycle(20), cycle(30), cycle(40), cycle(50), cycle(60)]
  assert.equal(
    consecutiveLowerBreakResetAt(cycles, { now: NOW, windowSeconds: WINDOW, threshold: 4 }),
    cycle(40).completedAt + WINDOW,
  )
})

test('window comes from config with a 24h default and a sane floor', () => {
  type Safeguards = Parameters<typeof lowerBreakWindowSeconds>[0]
  const with_ = (safeguards: Partial<Safeguards>) => lowerBreakWindowSeconds(safeguards as Safeguards)
  assert.equal(with_({}), 86_400)
  assert.equal(with_({ lowerBreakWindowMinutes: 120 }), 7_200)
  assert.equal(with_({ lowerBreakWindowMinutes: 0.5 }), 60)
})

test('nextUtcDayStart is the following UTC midnight', () => {
  assert.equal(nextUtcDayStart(86_399), 86_400)
  assert.equal(nextUtcDayStart(0), 86_400)
  assert.equal(nextUtcDayStart(86_400), 172_800)
})
