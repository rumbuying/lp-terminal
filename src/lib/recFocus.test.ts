import assert from 'node:assert/strict'
import test from 'node:test'
import { queueRecFocus, takeRecFocus } from './recFocus'
import { parseRecInputs } from './recInputs'

test('the rank handoff delivers the queued address once, lowercased', () => {
  assert.equal(takeRecFocus(), null)
  queueRecFocus('0xAbC')
  assert.equal(takeRecFocus(), '0xabc')
  assert.equal(takeRecFocus(), null)
})

test('a later queue replaces an undelivered one', () => {
  queueRecFocus('0x1')
  queueRecFocus('0x2')
  assert.equal(takeRecFocus(), '0x2')
})

test('rec inputs parse rejects garbage, out-of-floor capital and unknown risk', () => {
  const fallback = { capitalUsd: 1000, risk: 'balanced' as const }
  assert.deepEqual(parseRecInputs(null, fallback), fallback)
  assert.deepEqual(parseRecInputs('not json', fallback), fallback)
  assert.deepEqual(parseRecInputs('{"capitalUsd":5,"risk":"balanced"}', fallback), fallback)
  assert.deepEqual(parseRecInputs('{"capitalUsd":500,"risk":"degen"}', fallback), fallback)
})

test('rec inputs parse accepts the shape the recommender page saves', () => {
  assert.deepEqual(
    parseRecInputs('{"capitalUsd":2500,"risk":"conservative"}', { capitalUsd: 1000, risk: 'balanced' }),
    { capitalUsd: 2500, risk: 'conservative' },
  )
})
