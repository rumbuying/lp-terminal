import assert from 'node:assert/strict'
import test from 'node:test'
import { buildGuardReport } from './guard-report'
import { tickDistanceBps } from './market-guard'

const NOW = 1_700_000_000

const baseSafeguards = {
  enabled: true,
  volatilityWindowSeconds: 300,
  maxVolatilityBps: 500,
  maxSpotTwapDeviationBps: 500,
  stableMarketSeconds: 60,
  burstWindowMinutes: 30,
  burstTriggerCount: 3,
  burstCooldownMinutes: 20,
  maxSlippageBps: 100,
  maxPlanAgeSeconds: 30,
}

const args = (over: Partial<Parameters<typeof buildGuardReport>[0]>) => ({
  state: 'guard_wait',
  now: NOW,
  safeguards: baseSafeguards,
  pollSeconds: 30,
  confirmationSeconds: 0,
  ...over,
})

test('a volatility violation is the blocking condition with measured value vs limit', () => {
  const report = buildGuardReport(args({
    guardReason: 'market_volatility',
    spotTick: 30,
    marketStats: { count: 12, firstTs: NOW - 300, lastTs: NOW - 30, tick: 0, minTick: -350, maxTick: 350 },
  }))
  const volatility = report.conditions.find((c) => c.id === 'market_volatility')
  assert.equal(volatility?.status, 'fail')
  assert.equal(volatility?.measured, tickDistanceBps(350, -350))
  assert.equal(volatility?.threshold, 500)
  assert.ok(report.blocking.includes('market_volatility'))
  const deviation = report.conditions.find((c) => c.id === 'spot_twap_deviation')
  assert.equal(deviation?.status, 'pass')
  assert.equal(report.waiting, true)
  assert.equal(report.needsManualResume, false)
})

test('a warming sample window blocks through sample_history with unevaluated metrics', () => {
  const report = buildGuardReport(args({
    marketStats: { count: 1, firstTs: NOW - 100, lastTs: NOW - 30, tick: 0, minTick: 0, maxTick: 0 },
  }))
  const history = report.conditions.find((c) => c.id === 'sample_history')
  assert.equal(history?.status, 'wait')
  assert.equal(history?.sampleCount, 1)
  assert.ok(report.blocking.includes('sample_history'))
  const volatility = report.conditions.find((c) => c.id === 'market_volatility')
  assert.equal(volatility?.status, 'wait')
  assert.equal(volatility?.measured, undefined)
})

test('a recovering guard holds on the stability window with a live deadline', () => {
  const report = buildGuardReport(args({
    guardReason: 'spot_twap_deviation',
    guardStableSince: NOW - 30,
    spotTick: 0,
    marketStats: { count: 10, firstTs: NOW - 300, lastTs: NOW - 30, tick: 0, minTick: -10, maxTick: 10 },
  }))
  const stability = report.conditions.find((c) => c.id === 'guard_recovery_stability')
  assert.equal(stability?.status, 'wait')
  assert.equal(stability?.remainingSeconds, 30)
  assert.equal(stability?.waitUntil, NOW + 30)
  assert.ok(report.blocking.includes('guard_recovery_stability'))
})

test('an active burst wait reports the countdown and window usage', () => {
  const report = buildGuardReport(args({
    burstWaitUntil: NOW + 120,
    recentCompletedCycles: 3,
    marketStats: { count: 10, firstTs: NOW - 300, lastTs: NOW - 30, tick: 0, minTick: -10, maxTick: 10 },
  }))
  const burst = report.conditions.find((c) => c.id === 'burst_throttle')
  assert.equal(burst?.status, 'wait')
  assert.equal(burst?.remainingSeconds, 120)
  assert.equal(burst?.measured, 3)
  assert.equal(burst?.threshold, 3)
  assert.ok(report.blocking.includes('burst_throttle'))
})

test('a boundary pause names the side and requires a manual resume', () => {
  const report = buildGuardReport(args({
    state: 'paused_guard',
    pause: { code: 'E_PLAN_STALE', side: 'lower', at: NOW - 120 },
  }))
  const pause = report.conditions.find((c) => c.id === 'boundary_pause')
  assert.equal(pause?.status, 'fail')
  assert.equal(pause?.side, 'lower')
  assert.ok(report.blocking.includes('boundary_pause'))
  assert.equal(report.needsManualResume, true)
})

test('an awaiting-manual strategy reports the confirmation condition', () => {
  const report = buildGuardReport(args({
    state: 'awaiting_manual',
    pause: { code: 'E_PLAN_STALE', reason: 'manual_confirm', at: NOW - 60 },
  }))
  assert.ok(report.conditions.find((c) => c.id === 'manual_confirm'))
  assert.ok(report.blocking.includes('manual_confirm'))
  assert.equal(report.needsManualResume, true)
})

test('an unavailable APR is a blocking pause condition', () => {
  const report = buildGuardReport(args({
    state: 'paused_guard',
    pause: { code: 'E_APR_UNAVAILABLE', at: NOW - 60 },
  }))
  const apr = report.conditions.find((c) => c.id === 'apr_available')
  assert.equal(apr?.status, 'fail')
  assert.ok(report.blocking.includes('apr_available'))
})

test('a healthy monitoring strategy satisfies every evaluated condition', () => {
  const report = buildGuardReport(args({
    state: 'monitoring',
    recentCompletedCycles: 0,
    marketStats: { count: 10, firstTs: NOW - 300, lastTs: NOW - 30, tick: 0, minTick: -10, maxTick: 10 },
  }))
  assert.equal(report.waiting, false)
  assert.deepEqual(report.blocking, [])
  for (const condition of report.conditions) assert.notEqual(condition.status, 'fail')
})

test('cooldown and confirmation waits stay informational', () => {
  const report = buildGuardReport(args({
    state: 'monitoring',
    cooldownUntil: NOW + 90,
    outSide: 'lower',
    outSince: NOW - 30,
    confirmationSeconds: 120,
    recentCompletedCycles: 0,
    marketStats: { count: 10, firstTs: NOW - 300, lastTs: NOW - 30, tick: 0, minTick: -10, maxTick: 10 },
  }))
  const cooldown = report.conditions.find((c) => c.id === 'trigger_cooldown')
  assert.equal(cooldown?.status, 'wait')
  assert.equal(cooldown?.remainingSeconds, 90)
  const confirmation = report.conditions.find((c) => c.id === 'boundary_confirmation')
  assert.equal(confirmation?.status, 'wait')
  assert.equal(confirmation?.side, 'lower')
  assert.deepEqual(report.blocking, [])
})

test('a guard wait with no violated condition falls back to the recheck loop', () => {
  const report = buildGuardReport(args({
    recentCompletedCycles: 0,
    marketStats: { count: 10, firstTs: NOW - 300, lastTs: NOW - 30, tick: 0, minTick: -10, maxTick: 10 },
  }))
  assert.deepEqual(report.blocking, ['monitor_recheck'])
  assert.equal(report.conditions.find((c) => c.id === 'monitor_recheck')?.status, 'wait')
})
