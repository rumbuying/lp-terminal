import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateMarketQuality, shouldStartBurstWait, tickDistanceBps } from '../../shared/strategy/market-guard'

test('converts tick displacement into conservative quote-price bps', () => {
  assert.equal(tickDistanceBps(0, 0), 0)
  assert.equal(tickDistanceBps(0, 100), 101)
  assert.equal(tickDistanceBps(100, 0), 101)
})

test('market quality rejects rolling volatility before spot/TWAP deviation', () => {
  assert.deepEqual(evaluateMarketQuality({
    spotTick: 80,
    averageTick: 0,
    minTick: -50,
    maxTick: 50,
    maxVolatilityBps: 100,
    maxSpotTwapDeviationBps: 75,
  }), {
    healthy: false,
    reason: 'market_volatility',
    volatilityBps: 101,
    spotTwapDeviationBps: 81,
  })
})

test('market quality accepts values at or below configured limits', () => {
  const result = evaluateMarketQuality({
    spotTick: 50,
    averageTick: 0,
    minTick: -25,
    maxTick: 25,
    maxVolatilityBps: 100,
    maxSpotTwapDeviationBps: 75,
  })
  assert.equal(result.healthy, true)
})

test('the configured Nth trigger starts a burst wait', () => {
  assert.equal(shouldStartBurstWait(1, 3), false)
  assert.equal(shouldStartBurstWait(2, 3), true)
  assert.equal(shouldStartBurstWait(3, 3), true)
})
