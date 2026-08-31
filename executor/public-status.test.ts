import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'lp-public-status-'))
process.env.LP_EXECUTOR_DATA_DIR = dir
process.env.LP_EXECUTOR_CHAIN_ID = '56'

test('public status returns only running strategies owned by the requested address and redacts executor config', async () => {
  const [{ originalStrategyDraft }, { upsertStrategy }, { publicStrategyStatus }, { UNI }] = await Promise.all([
    import('../shared/strategy/schema'), import('./store'), import('./public-status'), import('../src/config/addresses'),
  ])
  const owner = '0x0000000000000000000000000000000000000011' as const
  const other = '0x0000000000000000000000000000000000000022' as const
  const base = originalStrategyDraft({
    owner, protocol: 'univ3', pool: '0x0000000000000000000000000000000000000033', positionManager: UNI.V3_NPM,
    riskToken: '0x0000000000000000000000000000000000000044', quoteToken: '0x0000000000000000000000000000000000000055', activeTokenId: '7',
  })
  upsertStrategy(base)
  upsertStrategy({ ...base, id: 'running-owner', name: 'Running owner strategy', enabled: true })
  upsertStrategy({ ...base, id: 'running-other', owner: other, name: 'Other strategy', enabled: true })
  const value = {
    strategyId: 'running-owner', calculatedAt: 123, state: 'monitoring',
    quote: { address: base.quoteToken, symbol: 'QUOTE', decimals: 18 },
    stable: { address: base.quoteToken, symbol: 'USDT', decimals: 18 },
    summary: {
      reopens: 2, currentValueQuoteRaw: '120', baselineValueQuoteRaw: '100', pnlQuoteRaw: '20', pnlPct: 20,
      currentValueUsdgRaw: '120', baselineValueUsdgRaw: '100', pnlUsdgRaw: '20', pnlUsdgPct: 20,
    },
    baseline: null, currentPosition: { tokenId: '7', tick: 0, tickLower: -10, tickUpper: 10 },
  } as any
  const result = await publicStrategyStatus(owner, 0, 1_000, {
    loadPerformance: async () => value,
    recordPerformance: () => true,
    now: () => 456,
  })
  assert.equal(result.generatedAt, 456)
  assert.deepEqual(result.strategies.map((strategy) => strategy.id), ['running-owner'])
  assert.equal('performance' in result.strategies[0] ? result.strategies[0].performance.summary?.pnlStableRaw : null, '20')
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('running-other'), false)
  assert.equal(serialized.includes('walletId'), false)
  assert.equal(serialized.includes('execution'), false)
  assert.equal(serialized.includes('signerAddress'), false)
})

test.after(() => rmSync(dir, { recursive: true, force: true }))
