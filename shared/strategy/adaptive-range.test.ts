import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateAdaptiveRangeStability, nextAdaptiveRangeScale, scaledRangePcts, shouldContractAdaptiveRange, shouldWidenAdaptiveRange } from './adaptive-range'

test('quick boundary crossing widens by the square-root lifetime ratio', () => {
  assert.equal(nextAdaptiveRangeScale({
    enabled: true, now: 3_600, positionStartedAt: 0, previousScale: 1,
    targetSeconds: 9 * 3_600, maxMultiplier: 10, recoveryDecay: 0.8,
  }), 3)
})

test('widening compounds, caps, and later decays gradually', () => {
  assert.equal(nextAdaptiveRangeScale({
    enabled: true, now: 900, positionStartedAt: 0, previousScale: 2,
    targetSeconds: 3_600, maxMultiplier: 3, recoveryDecay: 0.8,
  }), 3)
  assert.equal(nextAdaptiveRangeScale({
    enabled: true, now: 7_200, positionStartedAt: 0, previousScale: 3,
    targetSeconds: 3_600, maxMultiplier: 4, recoveryDecay: 0.5,
  }), 2)
  assert.deepEqual(scaledRangePcts(30, 150, 4), { lowerPct: 99 - 1e-9, upperPct: 500 })
})

test('a rapid crossing keeps its width unless the strategy is losing and the prior cycle was fee-deficient', () => {
  assert.equal(shouldWidenAdaptiveRange({ pnlQuoteRaw: -1n, lastNetFeesQuoteRaw: 9n, lastCycleCostQuoteRaw: 10n }), true)
  assert.equal(shouldWidenAdaptiveRange({ pnlQuoteRaw: 1n, lastNetFeesQuoteRaw: 0n, lastCycleCostQuoteRaw: 10n }), false)
  assert.equal(shouldWidenAdaptiveRange({ pnlQuoteRaw: -1n, lastNetFeesQuoteRaw: 10n, lastCycleCostQuoteRaw: 10n }), false)
  assert.equal(nextAdaptiveRangeScale({
    enabled: true, now: 60, positionStartedAt: 0, previousScale: 2,
    targetSeconds: 120, maxMultiplier: 4, recoveryDecay: 0.5, allowWiden: false,
  }), 2)
})

test('timed contraction requires recovery and a fee safety margin', () => {
  assert.equal(shouldContractAdaptiveRange({ pnlQuoteRaw: 1n, currentFeesQuoteRaw: 124n, priorCycleCostQuoteRaw: 100n, feeCoverageMultiplier: 1.25 }), false)
  assert.equal(shouldContractAdaptiveRange({ pnlQuoteRaw: 1n, currentFeesQuoteRaw: 125n, priorCycleCostQuoteRaw: 100n, feeCoverageMultiplier: 1.25 }), true)
  assert.equal(shouldContractAdaptiveRange({ pnlQuoteRaw: -1n, currentFeesQuoteRaw: 1_000n, priorCycleCostQuoteRaw: 100n, feeCoverageMultiplier: 1.25 }), false)
})

test('contraction stability requires a calm lookback that never left the current range', () => {
  assert.deepEqual(evaluateAdaptiveRangeStability({ minTick: -100, maxTick: 100, tickLower: -200, tickUpper: 200, maxVolatilityBps: 250 }), {
    stable: true,
    stayedInRange: true,
    volatilityBps: 203,
  })
  assert.equal(evaluateAdaptiveRangeStability({ minTick: -150, maxTick: 150, tickLower: -200, tickUpper: 200, maxVolatilityBps: 250 }).stable, false)
  assert.equal(evaluateAdaptiveRangeStability({ minTick: -200, maxTick: 100, tickLower: -200, tickUpper: 200, maxVolatilityBps: 500 }).stable, true)
  assert.equal(evaluateAdaptiveRangeStability({ minTick: -100, maxTick: 200, tickLower: -200, tickUpper: 200, maxVolatilityBps: 500 }).stable, false)
})
