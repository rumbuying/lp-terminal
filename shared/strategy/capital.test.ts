import assert from 'node:assert/strict'
import test from 'node:test'
import { planCapitalHarvest } from './capital'

test('profit below 10 USDG remains deployable', () => {
  const plan = planCapitalHarvest({
    amount0: 60n, amount1: 60n, activeValueQuote: 120n, capitalCapQuote: 100n,
    excessValueUsdg: 9_999_999n, thresholdUsdg: 10_000_000n,
  })
  assert.equal(plan.triggered, false)
  assert.deepEqual([plan.deploy0, plan.deploy1, plan.profit0, plan.profit1], [60n, 60n, 0n, 0n])
})

test('profit at 10 USDG is retained and deployment is capped at principal', () => {
  const plan = planCapitalHarvest({
    amount0: 60n, amount1: 60n, activeValueQuote: 120n, capitalCapQuote: 100n,
    excessValueUsdg: 10_000_000n, thresholdUsdg: 10_000_000n,
  })
  assert.equal(plan.triggered, true)
  assert.deepEqual([plan.deploy0, plan.deploy1, plan.profit0, plan.profit1], [50n, 50n, 10n, 10n])
})

test('loss never tops up deployment', () => {
  const plan = planCapitalHarvest({
    amount0: 40n, amount1: 40n, activeValueQuote: 80n, capitalCapQuote: 100n,
    excessValueUsdg: 0n, thresholdUsdg: 10_000_000n,
  })
  assert.equal(plan.triggered, false)
  assert.deepEqual([plan.deploy0, plan.deploy1], [40n, 40n])
})
