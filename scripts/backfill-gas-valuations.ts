import { parseStrategyConfig } from '../shared/strategy/schema'
import { EXECUTOR } from '../executor/config'
import { historicalQuoteValueInUsdg, valuationCurrency } from '../executor/stable-valuation'
import { audit, backfillLegacyGasValuation, db } from '../executor/store'

type Row = {
  id: string
  strategy_id: string
  job_id: string | null
  ts: number
  block_number: string | null
  tx_hash: string | null
  amount: string | null
  meta_json: string
  config_json: string
}

const args = new Set(process.argv.slice(2))
const knownArgs = new Set(['--apply', '--include-archived'])
for (const arg of args) if (!knownArgs.has(arg)) throw new Error(`unknown argument: ${arg}`)
const apply = args.has('--apply')
const includeArchived = args.has('--include-archived')
const low = (value: string) => value.toLowerCase()

const rows = db.prepare(`SELECT l.id,l.strategy_id,l.job_id,l.ts,l.block_number,l.tx_hash,l.amount,l.meta_json,s.config_json
  FROM ledger_entries l JOIN strategies s ON s.id=l.strategy_id
  WHERE l.kind='gas' ${includeArchived ? '' : "AND s.state!='archived'"}
  ORDER BY CAST(l.block_number AS INTEGER),l.id`).all() as unknown as Row[]

const candidates = rows.flatMap((row) => {
  let meta: Record<string, unknown>
  try { meta = JSON.parse(row.meta_json) as Record<string, unknown> } catch { throw new Error(`invalid metadata on ledger ${row.id}`) }
  if (meta.gasValuationVersion === 1) return []
  if (!row.job_id || !row.block_number || !/^\d+$/.test(row.block_number)
    || !row.tx_hash || !/^0x[0-9a-fA-F]{64}$/.test(row.tx_hash)
    || !row.amount || !/^\d+$/.test(row.amount))
    throw new Error(`legacy gas ledger ${row.id} is missing immutable receipt facts`)
  const config = parseStrategyConfig(JSON.parse(row.config_json))
  const quoteCurrency = valuationCurrency(config.quoteToken)
  if (low(quoteCurrency) !== low(EXECUTOR.network.wrappedNative))
    throw new Error(`legacy gas ledger ${row.id} uses an unsupported quote token`)
  return [{ row, config }]
})

const strategyCount = new Set(candidates.map(({ row }) => row.strategy_id)).size
const firstBlock = candidates[0]?.row.block_number ?? null
const lastBlock = candidates.at(-1)?.row.block_number ?? null
console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry-run',
  scope: includeArchived ? 'all' : 'non-archived',
  rows: candidates.length,
  strategies: strategyCount,
  firstBlock,
  lastBlock,
}))

if (!apply || candidates.length === 0) {
  db.close()
  process.exit(0)
}
if (EXECUTOR.chainId !== 4663) throw new Error('historical gas backfill is only supported on Robinhood Chain')

let nextIndex = 0
let written = 0
const failures: { id: string; error: string }[] = []
const worker = async () => {
  while (true) {
    const index = nextIndex++
    const candidate = candidates[index]
    if (!candidate) return
    const { row, config } = candidate
    try {
      const stableValue = await historicalQuoteValueInUsdg(
        BigInt(row.amount!),
        EXECUTOR.network.wrappedNative,
        BigInt(row.block_number!),
      )
      if (backfillLegacyGasValuation({
        ledgerId: row.id,
        strategyId: row.strategy_id,
        jobId: row.job_id!,
        txHash: row.tx_hash!,
        blockNumber: row.block_number!,
        observedAt: row.ts,
        gasWei: row.amount!,
        quoteToken: config.quoteToken,
        quoteValueRaw: row.amount!,
        settlementToken: EXECUTOR.network.settlementToken,
        settlementValueRaw: stableValue.toString(),
      })) written++
      if ((index + 1) % 25 === 0 || index + 1 === candidates.length)
        console.log(JSON.stringify({ progress: index + 1, total: candidates.length, written, failures: failures.length }))
    } catch (error) {
      failures.push({ id: row.id, error: error instanceof Error ? error.message.slice(0, 180) : 'unknown error' })
    }
  }
}

// Keep historical reads bounded so the live executor retains RPC headroom.
await Promise.all([worker(), worker()])
audit('accounting', 'legacy_gas_valuations_backfilled', 'chain', String(EXECUTOR.chainId), {
  scope: includeArchived ? 'all' : 'non-archived',
  candidates: candidates.length,
  written,
  failures: failures.length,
  source: 'historical_block_close',
})
db.close()

if (failures.length) {
  console.error(JSON.stringify({ failures: failures.slice(0, 10) }))
  process.exitCode = 1
} else {
  console.log(JSON.stringify({ complete: true, written }))
}
