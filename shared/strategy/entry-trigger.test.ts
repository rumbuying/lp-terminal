import assert from 'node:assert/strict'
import test from 'node:test'
import { assertEntryTrigger } from './entry-trigger'
import type { StrategyConfig, StrategyExecutionPlan, StrategyPositionSnapshot } from './types'

const now = 1_800_000_000
const config = { trigger: { source: 'spot', pollSeconds: 4, confirmationSeconds: 30 }, safeguards: { maxPlanAgeSeconds: 30 } } as StrategyConfig
const snapshot = { observedAt: now, tick: -101, tickLower: -100, tickUpper: 100 } as StrategyPositionSnapshot
const plan = { action: 'recenter', triggerSide: 'lower' } as StrategyExecutionPlan
const check = (args: Partial<Parameters<typeof assertEntryTrigger>[0]> = {}) => assertEntryTrigger({ config, plan, snapshot, now, ...args })

test('queued boundary jobs must still be outside the same boundary', () => {
  assert.doesNotThrow(() => check())
  for (const tick of [-100, 0, 99, 100, 101])
    assert.throws(() => check({ snapshot: { ...snapshot, tick } }), /E_TRIGGER_CHANGED/)
  assert.doesNotThrow(() => check({ plan: { ...plan, triggerSide: 'upper' }, snapshot: { ...snapshot, tick: 100 } }))
})

test('manual execution and fee collection keep their original intent', () => {
  const inside = { ...snapshot, tick: 0 }
  assert.doesNotThrow(() => check({ snapshot: inside, plan: { ...plan, manualExecution: true } }))
  assert.doesNotThrow(() => check({ snapshot: inside, plan: { ...plan, triggerSide: 'manual' } }))
  assert.doesNotThrow(() => check({ snapshot: inside, plan: { ...plan, action: 'collect_fees' } }))
})

test('scheduled contraction needs an in-range spot, independent of the boundary TWAP', () => {
  const contraction = { ...plan, triggerSide: 'adaptive_contraction' as const }
  assert.throws(() => check({ plan: contraction }), /E_TRIGGER_CHANGED/)
  assert.doesNotThrow(() => check({ plan: contraction, snapshot: { ...snapshot, tick: 0 }, config: { ...config, trigger: { ...config.trigger, source: 'sampled_twap' } } }))
})

test('TWAP jobs use a fresh sufficiently-covered average rather than a spot substitution', () => {
  const twapConfig = { ...config, trigger: { ...config.trigger, source: 'sampled_twap' as const } }
  const average = { tick: -102, count: 16, firstTs: now - 60, lastTs: now }
  assert.doesNotThrow(() => check({ config: twapConfig, snapshot: { ...snapshot, tick: 0 }, average }))
  assert.throws(() => check({ config: twapConfig, average: { ...average, tick: 0 } }), /E_TRIGGER_CHANGED/)
  for (const unavailable of [undefined, { ...average, count: 1 }, { ...average, firstTs: now - 20 }, { ...average, lastTs: now - 9 }])
    assert.throws(() => check({ config: twapConfig, average: unavailable }), /E_TRIGGER_UNAVAILABLE/)
})

test('a stale or invalid snapshot cannot authorize an automatic entry', () => {
  for (const observedAt of [now - 31, now + 1, NaN])
    assert.throws(() => check({ snapshot: { ...snapshot, observedAt } }), /E_TRIGGER_UNAVAILABLE/)
  assert.throws(() => check({ snapshot: { ...snapshot, tick: NaN } }), /E_TRIGGER_UNAVAILABLE/)
})
