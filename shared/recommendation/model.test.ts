import test from 'node:test'
import assert from 'node:assert/strict'
import { chooseLookback, rankRecommendations, replayRange, scoreCandidate } from './model'
import type { RecommendationCandidate, RecommendationItem, RecommendationMode, RecommendationRankPrior, RecommendationRisk } from './types'

const now = 1_800_000_000
const candidate = (overrides: Partial<RecommendationCandidate> = {}): RecommendationCandidate => ({
  pool: '0x0000000000000000000000000000000000000001', protocol: 'univ3',
  token0: '0x0000000000000000000000000000000000000010', token1: '0x0000000000000000000000000000000000000011',
  symbol0: 'WETH', symbol1: 'TEST', decimals0: 18, decimals1: 18, token0Usd: 3000, token1Usd: 30,
  token0IsRisk: true, hasStableQuote: true, feePpm: 3000, unstakedFeePpm: 0, tickSpacing: 60, tick: 100_000,
  sqrtPriceX96: '11755562826496067164730007768449', liquidity: '100000000000000000000', stakedLiquidity: '0',
  tvlUsd: 100_000, vol1hUsd: 1_000, vol6hUsd: 6_000, vol24hUsd: 24_000,
  statsUpdatedAt: now, stateUpdatedAt: now, gaugeAlive: false, rewardRate: '0', periodFinish: 0, upUsd: null,
  marketHistory: [], tickHistory: [], ...overrides,
})

const COST = { protocol: 'univ3' as const, gasUsdPerCycle: 0.05, executionBpsPerCycle: 10, cycleSeconds: 45, sampleCycles: 20, source: 'protocol' as const }
/** 24h of 5-minute samples oscillating ±250 ticks (≈±2.5%): inside ±5%, across ±1%. */
const CALM_TICKS = Array.from({ length: 24 * 12 + 1 }, (_, index) => ({
  ts: now - (24 * 12 - index) * 300,
  tick: 100_000 + (index % 2 === 0 ? -250 : 250),
}))
const rankPrior = (overrides: Partial<RecommendationRankPrior> = {}): RecommendationRankPrior => ({
  generatedAt: now - 3_600, coverage: 2, sigmaDaily: 0.03, sigmaAnnual: 0.572,
  feeApr7d: 0.2, volDayUsd: 24_000, emitApr: null, ...overrides,
})
const scoreWide = (overrides: Partial<RecommendationCandidate> = {}, risk: RecommendationRisk = 'balanced', mode: RecommendationMode = 'fees') => {
  const items = scoreCandidate({ candidate: candidate({ tickHistory: CALM_TICKS, ...overrides }), capitalUsd: 1_000, mode, risk, now, cost: COST })
  const wide = items.find((item) => item.range.lowerPct === 5)
  assert.ok(wide, '±5% band should be scored')
  return wide
}

test('bootstrap chooses 6h and recognizes a short spike', () => {
  assert.equal(chooseLookback(candidate(), now)?.reason, 'stable_intraday')
  assert.equal(chooseLookback(candidate({ vol1hUsd: 10_000 }), now)?.reason, 'short_spike')
})

test('missing intraday falls back to 24h without treating null as zero', () => {
  const result = chooseLookback(candidate({ vol1hUsd: null, vol6hUsd: null }), now)
  assert.equal(result?.window, 'h24')
  assert.equal(result?.hourlyVolumeUsd, 1_000)
  assert.ok((result?.confidence ?? 1) < 0.5)
})

test('mature history still rejects a current 1h spike and validates long windows', () => {
  const marketHistory = Array.from({ length: 15 * 24 + 1 }, (_, index) => ({
    ts: now - (15 * 24 - index) * 3_600,
    vol1hUsd: 1_000,
    vol6hUsd: 6_000,
    vol24hUsd: 24_000,
  }))
  const result = chooseLookback(candidate({ vol1hUsd: 12_000, marketHistory }), now)
  assert.equal(result?.reason, 'short_spike')
  assert.notEqual(result?.window, 'h1')
  assert.ok((result?.hourlyVolumeUsd ?? Infinity) <= 1_000)
  assert.ok(result?.errors.d3 !== undefined)
  assert.ok(result?.errors.d7 !== undefined)
})

test('wider ranges recenter no more often on the same path', () => {
  const ticks = Array.from({ length: 120 }, (_, i) => ({ ts: now - 120 * 60 + i * 60, tick: 100_000 + (i % 20) * 20 }))
  const narrow = replayRange(candidate(), 1, ticks)
  const wide = replayRange(candidate(), 5, ticks)
  assert.ok(narrow.reopens >= wide.reopens)
})

test('risk downside is oriented correctly when the risk token is token1', () => {
  const ticks = [
    { ts: now - 60, tick: 100_000 },
    { ts: now, tick: 100_300 },
  ]
  const replay = replayRange(candidate({ token0IsRisk: false }), 5, ticks)
  assert.ok(replay.downsideRatios.at(-1)! < 0)
  assert.ok(replay.range.tickLower < 100_000 && replay.range.tickUpper > 100_000)
})

test('capital above two percent of TVL is rejected', () => {
  const scored = scoreCandidate({
    candidate: candidate(), capitalUsd: 2_001, mode: 'fees', risk: 'balanced', now,
    cost: { protocol: 'univ3', gasUsdPerCycle: 0.05, executionBpsPerCycle: 10, cycleSeconds: 45, sampleCycles: 20, source: 'protocol' },
  })
  assert.deepEqual(scored, [])
})

test('one-way rallies are stress-tested with a reflected reversal path', () => {
  const tickHistory = Array.from({ length: 7 * 24 + 1 }, (_, index) => ({
    ts: now - (7 * 24 - index) * 3_600,
    tick: 95_000 + Math.round(index * (5_000 / (7 * 24))),
  }))
  const scored = scoreCandidate({
    candidate: candidate({ tickHistory }), capitalUsd: 1_000, mode: 'fees', risk: 'balanced', now,
    cost: { protocol: 'univ3', gasUsdPerCycle: 0.05, executionBpsPerCycle: 10, cycleSeconds: 45, sampleCycles: 20, source: 'protocol' },
  })
  const wide = scored.find((item) => item.range.lowerPct === 10)
  assert.ok(wide)
  assert.ok(wide.projection24h.cvar95Usd < -10)
})

test('bands that would exceed the balanced daily recenter budget are observation-only', () => {
  const tickHistory = Array.from({ length: 24 * 12 + 1 }, (_, index) => ({
    ts: now - (24 * 12 - index) * 300,
    tick: 100_000 + (index % 2 === 0 ? -250 : 250),
  }))
  const scored = scoreCandidate({
    candidate: candidate({ tickHistory }), capitalUsd: 1_000, mode: 'fees', risk: 'balanced', now,
    cost: { protocol: 'univ3', gasUsdPerCycle: 0.05, executionBpsPerCycle: 10, cycleSeconds: 45, sampleCycles: 20, source: 'protocol' },
  })
  const narrow = scored.find((item) => item.range.lowerPct === 1)
  assert.ok(narrow)
  assert.ok(narrow.projection24h.reopens > 6)
  assert.ok(narrow.gateReasons.includes('excessive_reopens'))
})

test('ranking excludes low confidence and negative-net candidates from recommendations', () => {
  const base = {
    rank: 0, pool: '0x1', protocol: 'univ3', pair: 'A/B', mode: 'fees',
    lookback: { window: 'h6', hourlyVolumeUsd: 1, confidence: 1, reason: 'bootstrap_6h', errors: {} },
    range: { lowerPct: 2, upperPct: 2, tickLower: 0, tickUpper: 10, actualLowerPct: 2, actualUpperPct: 2 },
    projection24h: { grossFeeUsd: 2, rewardUsd: 0, gasUsd: 0, executionUsd: 0, netUsd: 2, riskAdjustedNetUsd: 2, reopens: 0, inRangePct: 100, cvar95Usd: 0, coverageRatio: null },
    confidence: { level: 'medium', score: 0.6 }, market: { tvlUsd: 1, vol1hUsd: 1, vol6hUsd: 1, vol24hUsd: 1, feePpm: 1, statsUpdatedAt: now, tickCoverageHours: 24 },
    cost: { protocol: 'univ3', gasUsdPerCycle: 0, executionBpsPerCycle: 0, cycleSeconds: 1, sampleCycles: 1, source: 'default' }, gateReasons: [], warnings: [],
  } as RecommendationItem
  const low = { ...base, pool: '0x2', confidence: { level: 'low' as const, score: 0.2 }, projection24h: { ...base.projection24h, riskAdjustedNetUsd: 3 } }
  const negative = { ...base, pool: '0x3', projection24h: { ...base.projection24h, netUsd: -1, riskAdjustedNetUsd: -1 } }
  const ranked = rankRecommendations([base, low, negative])
  assert.equal(ranked.items.length, 1)
  assert.equal(ranked.items[0].pool, '0x1')
})

test('ranking uses a wider eligible band when the highest-net narrow band fails a hard gate', () => {
  const base = {
    rank: 0, pool: '0x1', protocol: 'univ3', pair: 'A/B', mode: 'fees',
    lookback: { window: 'h24', hourlyVolumeUsd: 1, confidence: 1, reason: 'walk_forward', errors: {} },
    range: { lowerPct: 1, upperPct: 1, tickLower: 0, tickUpper: 10, actualLowerPct: 1, actualUpperPct: 1 },
    projection24h: { grossFeeUsd: 12, rewardUsd: 0, gasUsd: 1, executionUsd: 1, netUsd: 10, riskAdjustedNetUsd: 8, reopens: 20, inRangePct: 99, cvar95Usd: -4, coverageRatio: 2.5 },
    confidence: { level: 'high', score: 0.9 }, market: { tvlUsd: 1, vol1hUsd: 1, vol6hUsd: 1, vol24hUsd: 1, feePpm: 1, statsUpdatedAt: now, tickCoverageHours: 24 },
    cost: { protocol: 'univ3', gasUsdPerCycle: 1, executionBpsPerCycle: 1, cycleSeconds: 1, sampleCycles: 30, source: 'pool' },
    gateReasons: ['excessive_reopens'], warnings: [],
  } as RecommendationItem
  const wider = {
    ...base,
    range: { ...base.range, lowerPct: 5, upperPct: 5 },
    projection24h: { ...base.projection24h, netUsd: 5, riskAdjustedNetUsd: 4, reopens: 2 },
    gateReasons: [],
  }
  const ranked = rankRecommendations([base, wider])
  assert.equal(ranked.observed[0].range.lowerPct, 1)
  assert.equal(ranked.items[0].range.lowerPct, 5)
})

test('a rank prior below the LVR floor gates conservative but only warns balanced', () => {
  const belowFloor = rankPrior({ coverage: 0.8 })
  const conservative = scoreWide({ poolRank: belowFloor }, 'conservative')
  assert.ok(conservative.gateReasons.includes('pool_below_lvr_floor'))
  const balanced = scoreWide({ poolRank: belowFloor }, 'balanced')
  assert.ok(!balanced.gateReasons.includes('pool_below_lvr_floor'))
  assert.ok(balanced.warnings.includes('below_lvr_floor'))
})

test('a rank prior at or above the LVR floor leaves gates and warnings untouched', () => {
  const wide = scoreWide({ poolRank: rankPrior({ coverage: 1.4 }) })
  assert.ok(!wide.gateReasons.includes('pool_below_lvr_floor'))
  assert.ok(!wide.warnings.includes('below_lvr_floor'))
})

test('a projection far above the 7-day volume baseline warns, a baseline-priced one does not', () => {
  // projected daily volume = 1_000/h × 24 = 24_000
  const spiky = scoreWide({ poolRank: rankPrior({ volDayUsd: 4_000 }) })
  assert.ok(spiky.warnings.includes('volume_above_baseline'))
  const priced = scoreWide({ poolRank: rankPrior({ volDayUsd: 24_000 }) })
  assert.ok(!priced.warnings.includes('volume_above_baseline'))
})

test('rewards projections reconcile against the rank snapshot emission APR', () => {
  // live gauge: 1 UP/s over a pool with half its TVL staked → live APR ≈ 631
  const rewardsPool = (emitApr: number | null) => ({
    protocol: 'up33' as const, gaugeAlive: true, periodFinish: now + 86_400, upUsd: 1,
    rewardRate: '1000000000000000000',
    stakedLiquidity: '50000000000000000000',
    poolRank: rankPrior({ emitApr }),
  })
  const divergent = scoreWide(rewardsPool(0.05), 'balanced', 'rewards')
  assert.ok(divergent.warnings.includes('emit_apr_divergence'))
  const consistent = scoreWide(rewardsPool(650), 'balanced', 'rewards')
  assert.ok(!consistent.warnings.includes('emit_apr_divergence'))
})

test('a missing or malformed rank prior changes nothing', () => {
  const absent = scoreWide()
  assert.equal(absent.poolRank, undefined)
  assert.ok(!absent.warnings.some((w) => ['below_lvr_floor', 'volume_above_baseline', 'emit_apr_divergence'].includes(w)))
  const malformed = scoreWide({ poolRank: { ...rankPrior(), coverage: Number.NaN } as unknown as RecommendationRankPrior })
  assert.ok(!malformed.gateReasons.includes('pool_below_lvr_floor'))
  assert.ok(!malformed.warnings.includes('below_lvr_floor'))
})

test('a fresh prior rides along on the scored item for the UI', () => {
  const prior = rankPrior({ coverage: 2.5 })
  const wide = scoreWide({ poolRank: prior })
  assert.deepEqual(wide.poolRank, prior)
})
