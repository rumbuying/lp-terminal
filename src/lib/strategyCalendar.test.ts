import assert from 'node:assert/strict'
import test from 'node:test'
import { rawDelta, shanghaiDate, shanghaiDay } from '../../shared/strategy/calendar'

test('calendar day rolls at Beijing midnight', () => {
  assert.equal(shanghaiDate(shanghaiDay(Date.parse('2026-08-12T15:59:59Z') / 1000)), '2026-08-12')
  assert.equal(shanghaiDate(shanghaiDay(Date.parse('2026-08-12T16:00:00Z') / 1000)), '2026-08-13')
})

test('daily P/L is the movement inside the day, not cumulative history', () => {
  assert.equal(rawDelta('500', '520'), '20')
  assert.equal(rawDelta('-30', '-10'), '20')
  assert.equal(rawDelta(null, '10'), null)
})
