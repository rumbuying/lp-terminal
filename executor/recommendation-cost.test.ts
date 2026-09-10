import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'lp-recommendation-cost-'))
process.env.LP_EXECUTOR_DATA_DIR = dir

const { addRecommendationCostSamples, recommendationCostProfile } = await import('./recommendation')
const { EXECUTOR } = await import('./config')
const { db } = await import('./store')

after(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const empty = () => ({ gas: [] as number[], executionBps: [] as number[], duration: [] as number[], cycles: 0 })

test('cost calibration uses pinned settlement gas and actual cycle capital', () => {
  const samples = empty()
  const gasRaw = (123n * 10n ** BigInt(EXECUTOR.network.settlementDecimals) / 1000n).toString()
  addRecommendationCostSamples(samples, {
    quote: { decimals: 2 },
    summary: {},
    cycles: [{
      startedAt: 100,
      completedAt: 130,
      gasCostQuoteRaw: '999999999',
      gasValuationComplete: false,
      gasCostUsdgRaw: gasRaw,
      gasStableValuationComplete: true,
      executionCostQuoteRaw: '10',
      capitalQuoteRaw: '1000',
    }],
  } as never)
  assert.deepEqual(samples, { gas: [0.123], executionBps: [100], duration: [30], cycles: 1 })
  assert.deepEqual(recommendationCostProfile('univ3', samples, 'protocol'), {
    protocol: 'univ3', gasUsdPerCycle: 0.123, executionBpsPerCycle: 100,
    cycleSeconds: 30, sampleCycles: 1, source: 'protocol',
  })
})

test('an incomplete stable gas mark yields unavailable costs, not defaults', () => {
  const samples = empty()
  addRecommendationCostSamples(samples, {
    quote: { decimals: 2 },
    summary: {},
    cycles: [{
      startedAt: 100,
      completedAt: 130,
      gasCostQuoteRaw: '25',
      gasValuationComplete: true,
      gasCostUsdgRaw: '0',
      gasStableValuationComplete: false,
      executionCostQuoteRaw: '10',
      capitalQuoteRaw: '1000',
    }],
  } as never)
  assert.deepEqual(recommendationCostProfile('univ3', samples, 'protocol'), {
    protocol: 'univ3', gasUsdPerCycle: 0, executionBpsPerCycle: 0,
    cycleSeconds: 0, sampleCycles: 0, source: 'unavailable',
  })
})
