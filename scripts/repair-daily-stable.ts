import { parseStrategyConfig } from '../shared/strategy/schema'
import { EXECUTOR } from '../executor/config'
import { historicalBlockAtOrBefore, historicalQuoteValueInUsdg, valuationCurrency } from '../executor/stable-valuation'
import { audit, db, repairStrategyDailyStableEndpoint } from '../executor/store'

type DailyRow = {
  strategy_id: string
  shanghai_day: number
  config_json: string
  first_observed_at: number
  last_observed_at: number
  opening_pnl_raw: string | null
  closing_pnl_raw: string | null
  opening_pnl_usdg_raw: string | null
  closing_pnl_usdg_raw: string | null
  opening_assets_raw: string | null
  closing_assets_raw: string | null
  opening_assets_usdg_raw: string | null
  closing_assets_usdg_raw: string | null
}

type Endpoint = {
  strategyId: string
  day: number
  configJson: string
  endpoint: 'opening' | 'closing'
  observedAt: number
  pnlRaw: string
  assetsRaw: string
  pnlUsdgRaw: string | null
  assetsUsdgRaw: string | null
}

const args = new Set(process.argv.slice(2))
const knownArgs = new Set(['--check', '--apply'])
for (const arg of args) if (!knownArgs.has(arg)) throw new Error(`unknown argument: ${arg}`)
if (args.has('--check') && args.has('--apply')) throw new Error('choose either --check or --apply')
const apply = args.has('--apply')
const check = args.has('--check')
const mode = apply ? 'apply' : check ? 'check' : 'dry-run'
const low = (value: string) => value.toLowerCase()

const rows = db.prepare(`SELECT d.*,s.config_json FROM strategy_daily_snapshots d
  JOIN strategies s ON s.id=d.strategy_id WHERE s.state!='archived'
  ORDER BY d.shanghai_day,d.strategy_id`).all() as unknown as DailyRow[]
const endpoints: Endpoint[] = []
for (const row of rows) {
  for (const endpoint of ['opening', 'closing'] as const) {
    const pnlRaw = row[`${endpoint}_pnl_raw`]
    const assetsRaw = row[`${endpoint}_assets_raw`]
    const pnlUsdgRaw = row[`${endpoint}_pnl_usdg_raw`]
    const assetsUsdgRaw = row[`${endpoint}_assets_usdg_raw`]
    if (pnlRaw === null || assetsRaw === null || (pnlUsdgRaw !== null && assetsUsdgRaw !== null)) continue
    endpoints.push({
      strategyId: row.strategy_id,
      day: row.shanghai_day,
      configJson: row.config_json,
      endpoint,
      observedAt: endpoint === 'opening' ? row.first_observed_at : row.last_observed_at,
      pnlRaw,
      assetsRaw,
      pnlUsdgRaw,
      assetsUsdgRaw,
    })
  }
}

console.log(JSON.stringify({
  mode,
  endpoints: endpoints.length,
  strategies: new Set(endpoints.map((row) => row.strategyId)).size,
  days: new Set(endpoints.map((row) => row.day)).size,
  firstObservedAt: endpoints.length ? Math.min(...endpoints.map((row) => row.observedAt)) : null,
  lastObservedAt: endpoints.length ? Math.max(...endpoints.map((row) => row.observedAt)) : null,
}))
if ((!check && !apply) || endpoints.length === 0) {
  db.close()
  process.exit(0)
}
if (EXECUTOR.chainId !== 4663) throw new Error('daily stable repair is only supported on Robinhood Chain')

const baselineQ = db.prepare(`SELECT value_quote_raw,value_usdg_raw,quote_token FROM strategy_baselines WHERE strategy_id=?`)
const gasQ = db.prepare(`SELECT l.amount,l.meta_json FROM ledger_entries l JOIN cycles c ON c.id=l.cycle_id
  WHERE l.strategy_id=? AND l.kind='gas' AND c.status='completed' AND c.completed_at<=?`)
const withdrawalQ = db.prepare(`SELECT amount,quote_value,meta_json FROM ledger_entries
  WHERE strategy_id=? AND kind='profit_withdrawal'`)

function accountingAt(strategyId: string, observedAt: number) {
  const baseline = baselineQ.get(strategyId) as { value_quote_raw: string; value_usdg_raw: string | null; quote_token: string } | undefined
  if (!baseline?.value_usdg_raw) throw new Error('stable strategy baseline unavailable')
  let gasQuote = 0n
  let gasUsdg = 0n
  for (const row of gasQ.all(strategyId, observedAt) as { amount: string | null; meta_json: string }[]) {
    const meta = JSON.parse(row.meta_json) as Record<string, unknown>
    if (!row.amount || !/^\d+$/.test(row.amount) || meta.gasValuationVersion !== 1
      || typeof meta.settlementValueRaw !== 'string' || !/^\d+$/.test(meta.settlementValueRaw))
      throw new Error('historical gas settlement mark unavailable')
    gasQuote += BigInt(row.amount)
    gasUsdg += BigInt(meta.settlementValueRaw)
  }
  let withdrawnQuote = 0n
  let withdrawnUsdg = 0n
  let withdrawalGasQuote = 0n
  let withdrawalGasUsdg = 0n
  for (const row of withdrawalQ.all(strategyId) as { amount: string | null; quote_value: string | null; meta_json: string }[]) {
    const meta = JSON.parse(row.meta_json) as Record<string, unknown>
    if (typeof meta.withdrawnAt !== 'number' || meta.withdrawnAt > observedAt) continue
    if (!row.amount || !row.quote_value || typeof meta.usdgValueRaw !== 'string'
      || typeof meta.gasQuoteRaw !== 'string' || typeof meta.gasUsdgRaw !== 'string')
      throw new Error('historical withdrawal mark unavailable')
    withdrawnQuote += BigInt(row.quote_value)
    withdrawnUsdg += BigInt(meta.usdgValueRaw)
    withdrawalGasQuote += BigInt(meta.gasQuoteRaw)
    withdrawalGasUsdg += BigInt(meta.gasUsdgRaw)
  }
  return {
    baselineQuote: BigInt(baseline.value_quote_raw),
    baselineUsdg: BigInt(baseline.value_usdg_raw),
    gasQuote: gasQuote + withdrawalGasQuote,
    gasUsdg: gasUsdg + withdrawalGasUsdg,
    withdrawnQuote,
    withdrawnUsdg,
    quoteToken: baseline.quote_token,
  }
}

let nextIndex = 0
let resolved = 0
let written = 0
const failures: { strategyId: string; day: number; endpoint: string; error: string }[] = []
const worker = async () => {
  while (true) {
    const index = nextIndex++
    const row = endpoints[index]
    if (!row) return
    try {
      const config = parseStrategyConfig(JSON.parse(row.configJson))
      if (low(valuationCurrency(config.quoteToken)) !== low(EXECUTOR.network.wrappedNative))
        throw new Error('daily snapshot quote token is unsupported')
      const accounting = accountingAt(row.strategyId, row.observedAt)
      if (low(accounting.quoteToken) !== low(config.quoteToken)) throw new Error('daily snapshot baseline quote token changed')
      const expectedQuotePnl = BigInt(row.assetsRaw) + accounting.withdrawnQuote - accounting.baselineQuote - accounting.gasQuote
      if (expectedQuotePnl !== BigInt(row.pnlRaw)) throw new Error('daily quote accounting identity does not reconcile')

      let pnlUsdg = row.pnlUsdgRaw === null ? undefined : BigInt(row.pnlUsdgRaw)
      let assetsUsdg = row.assetsUsdgRaw === null ? undefined : BigInt(row.assetsUsdgRaw)
      let source: 'accounting_identity' | 'historical_time_block_close' = 'accounting_identity'
      let blockNumber: bigint | undefined
      if (assetsUsdg === undefined && pnlUsdg !== undefined)
        assetsUsdg = pnlUsdg - accounting.withdrawnUsdg + accounting.baselineUsdg + accounting.gasUsdg
      if (assetsUsdg === undefined) {
        source = 'historical_time_block_close'
        blockNumber = await historicalBlockAtOrBefore(row.observedAt)
        assetsUsdg = await historicalQuoteValueInUsdg(BigInt(row.assetsRaw), config.quoteToken, blockNumber)
      }
      if (pnlUsdg === undefined)
        pnlUsdg = assetsUsdg + accounting.withdrawnUsdg - accounting.baselineUsdg - accounting.gasUsdg
      resolved++
      if (apply && repairStrategyDailyStableEndpoint({
        strategyId: row.strategyId,
        day: row.day,
        endpoint: row.endpoint,
        observedAt: row.observedAt,
        pnlRaw: row.pnlRaw,
        assetsRaw: row.assetsRaw,
        pnlUsdgRaw: row.pnlUsdgRaw === null ? pnlUsdg.toString() : undefined,
        assetsUsdgRaw: row.assetsUsdgRaw === null ? assetsUsdg.toString() : undefined,
        source,
        blockNumber: blockNumber?.toString(),
      })) written++
    } catch (error) {
      failures.push({
        strategyId: row.strategyId,
        day: row.day,
        endpoint: row.endpoint,
        error: error instanceof Error ? error.message.slice(0, 180) : 'unknown error',
      })
    }
  }
}

await Promise.all([worker(), worker()])
if (apply) audit('accounting', 'daily_stable_snapshots_repaired', 'chain', String(EXECUTOR.chainId), {
  candidates: endpoints.length,
  resolved,
  written,
  failures: failures.length,
})
db.close()
console.log(JSON.stringify({ complete: failures.length === 0, mode, resolved, written, failures: failures.length }))
if (failures.length) {
  console.error(JSON.stringify({ failures: failures.slice(0, 10) }))
  process.exitCode = 1
}
