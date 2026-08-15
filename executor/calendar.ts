import type { StrategyConfig } from '../shared/strategy/types'
import { rawDelta, shanghaiDate, shanghaiDay } from '../shared/strategy/calendar'
import { cachedStrategyPerformance } from './performance'
import { listStrategies, recordStrategyDailyPoint, strategyDailySnapshots } from './store'

type CalendarPerformance = Awaited<ReturnType<typeof cachedStrategyPerformance>>
let capturing = false

export function recordPerformanceDay(performance: CalendarPerformance) {
  if (!performance.summary || !performance.quote) return false
  recordStrategyDailyPoint({
    strategyId: performance.strategyId,
    observedAt: performance.calculatedAt ?? Math.floor(Date.now() / 1000),
    day: shanghaiDay(performance.calculatedAt ?? Math.floor(Date.now() / 1000)),
    quoteToken: performance.quote.address,
    quoteSymbol: performance.quote.symbol,
    quoteDecimals: performance.quote.decimals,
    pnlRaw: performance.summary.pnlQuoteRaw,
    feesRaw: performance.summary.netFeesQuoteRaw,
    gasRaw: performance.summary.gasCostQuoteRaw,
    executionRaw: performance.summary.executionCostQuoteRaw,
    assetsRaw: performance.summary.currentValueQuoteRaw,
    reopens: performance.summary.reopens,
  })
  return true
}

export async function captureDailyPerformance() {
  if (capturing) return
  capturing = true
  try {
    for (const row of listStrategies()) {
      try { recordPerformanceDay(await cachedStrategyPerformance(row.config, row.state)) } catch { /* isolate strategy valuation failures */ }
    }
  } finally { capturing = false }
}

const text = (value: unknown) => value === null || value === undefined ? null : String(value)
export function calendarRows(fromDay?: number, toDay?: number) {
  return strategyDailySnapshots(fromDay, toDay).map((row) => {
    const config = JSON.parse(String(row.config_json)) as StrategyConfig
    const openingPnl = text(row.opening_pnl_raw), closingPnl = text(row.closing_pnl_raw)
    return {
      strategyId: String(row.strategy_id), name: config.name, protocol: config.protocol, range: config.range, state: String(row.state),
      day: Number(row.shanghai_day), date: shanghaiDate(Number(row.shanghai_day)), firstObservedAt: Number(row.first_observed_at), lastObservedAt: Number(row.last_observed_at),
      quote: { address: String(row.quote_token), symbol: String(row.quote_symbol), decimals: Number(row.quote_decimals) },
      pnlRaw: rawDelta(openingPnl, closingPnl), feesRaw: rawDelta(String(row.opening_fees_raw), String(row.closing_fees_raw))!,
      gasRaw: rawDelta(String(row.opening_gas_raw), String(row.closing_gas_raw))!, executionRaw: rawDelta(String(row.opening_execution_raw), String(row.closing_execution_raw))!,
      openingAssetsRaw: text(row.opening_assets_raw), closingAssetsRaw: text(row.closing_assets_raw),
      reopens: Number(row.closing_reopens) - Number(row.opening_reopens),
    }
  })
}
