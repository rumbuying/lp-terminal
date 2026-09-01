/**
 * Focused check for the quick-flow safeguard defaults:
 *   1. recommendedSafeguards() must produce values that pass parseStrategyConfig
 *      for every band the quick flow offers (and extremes).
 *   2. The simple-start server rule: a draft without enabled safeguards gets the
 *      band-scaled recommendation; a draft with enabled limits keeps them.
 * Run: CHAIN=robinhood npx tsx scripts/safeguards-defaults-check.ts
 */
import assert from 'node:assert/strict'
import { originalStrategyDraft, parseStrategyConfig, recommendedSafeguards } from '../shared/strategy/schema'
import type { StrategyConfig } from '../shared/strategy/types'
import { UNI } from '../src/config/addresses'

const base = (overrides: Partial<StrategyConfig> = {}): StrategyConfig => ({
  ...originalStrategyDraft({
    owner: '0x0000000000000000000000000000000000000001',
    protocol: 'univ3',
    pool: '0x0000000000000000000000000000000000000002',
    positionManager: UNI.V3_NPM,
    riskToken: '0x0000000000000000000000000000000000000004',
    quoteToken: '0x0000000000000000000000000000000000000005',
  }),
  ...overrides,
})

// 1. Every offered band round-trips through the strict schema.
for (const band of [1, 2, 3, 5, 8, 10]) {
  const draft = base({ range: { mode: 'symmetric', lowerPct: band, upperPct: band } })
  const guarded = { ...draft, safeguards: recommendedSafeguards(band) }
  const parsed = parseStrategyConfig(JSON.parse(JSON.stringify(guarded)))
  assert.equal(parsed.safeguards.enabled, true)
  assert.equal(parsed.safeguards.maxRebalancesPerDay, recommendedSafeguards(band).maxRebalancesPerDay)
  assert.equal(parsed.safeguards.maxVolatilityBps, recommendedSafeguards(band).maxVolatilityBps)
  assert.equal(parsed.safeguards.minNetAprPct, undefined, 'minNetAprPct must stay unset (not wired)')
}

// Band scaling matches the reviewed table: narrow bands cap harder.
assert.equal(recommendedSafeguards(1).maxRebalancesPerDay, 4)
assert.equal(recommendedSafeguards(2).maxRebalancesPerDay, 4)
assert.equal(recommendedSafeguards(3).maxRebalancesPerDay, 5)
assert.equal(recommendedSafeguards(5).maxRebalancesPerDay, 8)
assert.equal(recommendedSafeguards(10).maxRebalancesPerDay, 12)
assert.equal(recommendedSafeguards(5).maxVolatilityBps, 1000)
assert.equal(recommendedSafeguards(5).maxSpotTwapDeviationBps, 300)
assert.equal(recommendedSafeguards(2).maxVolatilityBps, 400)
assert.equal(recommendedSafeguards(10).maxVolatilityBps, 2000)

// Degenerate inputs stay inside schema bounds.
for (const weird of [0.001, 0.5, 99, Number.NaN, Number.POSITIVE_INFINITY]) {
  const { maxVolatilityBps, maxSpotTwapDeviationBps, maxRebalancesPerDay } = recommendedSafeguards(weird)
  assert.ok(maxVolatilityBps !== undefined && maxVolatilityBps >= 1 && maxVolatilityBps <= 10_000)
  assert.ok(maxSpotTwapDeviationBps !== undefined && maxSpotTwapDeviationBps >= 100 && maxSpotTwapDeviationBps <= 10_000)
  assert.ok(maxRebalancesPerDay !== undefined && maxRebalancesPerDay >= 4 && maxRebalancesPerDay <= 12)
}

// 2. The executor/simple.ts branch (mirrored here without a chain dependency):
//    disabled draft -> recommendation for the band; enabled draft -> untouched.
const pickSafeguards = (draft: StrategyConfig): StrategyConfig['safeguards'] =>
  draft.safeguards.enabled
    ? draft.safeguards
    : recommendedSafeguards(Math.min(draft.range.lowerPct, draft.range.upperPct))

const legacyDraft = base({ range: { mode: 'symmetric', lowerPct: 2, upperPct: 2 } }) // old cached frontend
assert.equal(legacyDraft.safeguards.enabled, false, 'factory default stays neutral')
const enforced = pickSafeguards(legacyDraft)
assert.equal(enforced.enabled, true)
assert.equal(enforced.maxRebalancesPerDay, 4) // band 2 -> strictest cap
assert.equal(enforced.maxVolatilityBps, 400)

const editedDraft = { ...base(), safeguards: { ...recommendedSafeguards(5), maxRebalancesPerDay: 3 } }
const kept = pickSafeguards(editedDraft)
assert.equal(kept.maxRebalancesPerDay, 3, 'explicitly enabled limits are preserved')
parseStrategyConfig(JSON.parse(JSON.stringify({ ...editedDraft, safeguards: kept })))

console.log('safeguards defaults check: ok')
