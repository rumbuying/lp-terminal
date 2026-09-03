import assert from 'node:assert/strict'
import test from 'node:test'
import { decideCycleEconomics } from './economics-gate'

const NOW = 1_700_000_000

const base = {
  now: NOW,
  outSince: NOW - 60,
  collectableFeesQuoteRaw: 2_000n,
  lastCycleCostQuoteRaw: 1_000n,
  minCycleFeeCoverage: 1,
  economicsHoldSeconds: 1_800,
}

test('a disabled gate always executes', () => {
  for (const coverage of [undefined, 0]) {
    const decision = decideCycleEconomics({ ...base, minCycleFeeCoverage: coverage })
    assert.equal(decision.kind, 'execute')
  }
})

test('no cost history fails open — the first cycle always executes', () => {
  for (const cost of [undefined, null, 0n]) {
    const decision = decideCycleEconomics({ ...base, lastCycleCostQuoteRaw: cost })
    assert.equal(decision.kind, 'execute')
  }
})

test('fees at or above the required coverage execute', () => {
  assert.equal(decideCycleEconomics(base).kind, 'execute')
  assert.equal(decideCycleEconomics({ ...base, collectableFeesQuoteRaw: 1_000n }).kind, 'execute')
})

test('thin fees defer with a wait bounded by the crossing time plus hold', () => {
  const decision = decideCycleEconomics({ ...base, collectableFeesQuoteRaw: 999n })
  assert.deepEqual(decision, { kind: 'wait', waitUntil: NOW - 60 + 1_800, feesQuoteRaw: 999n, costQuoteRaw: 1_000n })
})

test('fractional coverage rounds the requirement up', () => {
  const decision = decideCycleEconomics({ ...base, minCycleFeeCoverage: 1.25, collectableFeesQuoteRaw: 1_249n })
  assert.equal(decision.kind, 'wait')
  assert.equal(decideCycleEconomics({ ...base, minCycleFeeCoverage: 1.25, collectableFeesQuoteRaw: 1_250n }).kind, 'execute')
})

test('the escape executes once the position has been out of range for the hold', () => {
  const decision = decideCycleEconomics({ ...base, collectableFeesQuoteRaw: 1n, outSince: NOW - 1_800 })
  assert.equal(decision.kind, 'execute')
  assert.equal(decideCycleEconomics({ ...base, collectableFeesQuoteRaw: 1n, outSince: NOW - 1_799 }).kind, 'wait')
})

test('a missing crossing clock waits from now instead of hanging', () => {
  const decision = decideCycleEconomics({ ...base, outSince: undefined, collectableFeesQuoteRaw: 1n })
  assert.deepEqual(decision, { kind: 'wait', waitUntil: NOW + 1_800, feesQuoteRaw: 1n, costQuoteRaw: 1_000n })
})

test('a non-positive hold never waits', () => {
  assert.equal(decideCycleEconomics({ ...base, economicsHoldSeconds: 0, collectableFeesQuoteRaw: 1n }).kind, 'execute')
})
