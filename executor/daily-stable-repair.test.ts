import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'lp-daily-stable-repair-'))
process.env.LP_EXECUTOR_DATA_DIR = dir

const { db, recordStrategyDailyPoint, repairStrategyDailyStableEndpoint } = await import('./store')
db.prepare("INSERT INTO strategies(id,config_json,state,updated_at) VALUES('strategy-1','{}','monitoring',1)").run()

after(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('daily repair fills only missing stable fields and is idempotent', () => {
  recordStrategyDailyPoint({
    strategyId: 'strategy-1', observedAt: 100, day: 1,
    quoteToken: '0x0000000000000000000000000000000000000010', quoteSymbol: 'WETH', quoteDecimals: 18,
    pnlRaw: '20', pnlUsdgRaw: null, feesRaw: '0', gasRaw: '5', executionRaw: '0',
    assetsRaw: '120', assetsUsdgRaw: null, reopens: 0,
  })
  const mark = {
    strategyId: 'strategy-1', day: 1, endpoint: 'opening' as const, observedAt: 100,
    pnlRaw: '20', assetsRaw: '120', pnlUsdgRaw: '50', assetsUsdgRaw: '300', source: 'accounting_identity' as const,
  }
  assert.equal(repairStrategyDailyStableEndpoint(mark), true)
  assert.equal(repairStrategyDailyStableEndpoint(mark), false)
  const row = db.prepare('SELECT opening_pnl_usdg_raw,opening_assets_usdg_raw FROM strategy_daily_snapshots').get() as Record<string, string>
  assert.deepEqual({ ...row }, { opening_pnl_usdg_raw: '50', opening_assets_usdg_raw: '300' })
  assert.throws(
    () => repairStrategyDailyStableEndpoint({ ...mark, pnlRaw: '21' }),
    /facts changed/,
  )
})
