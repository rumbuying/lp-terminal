import type { Address } from 'viem'
import { EXECUTOR } from './config'
import { pnlCurveRows, recordPerformanceDay } from './calendar'
import { cachedStrategyPerformance } from './performance'
import { listStrategies } from './store'

const INTERVAL_SECONDS = 5 * 60
const DEFAULT_WINDOW_SECONDS = 30 * 24 * 60 * 60
const MAX_WINDOW_SECONDS = 31 * 24 * 60 * 60

type Performance = Awaited<ReturnType<typeof cachedStrategyPerformance>>

function publicPerformance(performance: Performance) {
  return {
    calculatedAt: performance.calculatedAt,
    quote: performance.quote,
    stable: performance.stable,
    summary: performance.summary ? {
      reopens: performance.summary.reopens,
      currentValueQuoteRaw: performance.summary.currentValueQuoteRaw,
      baselineValueQuoteRaw: performance.summary.baselineValueQuoteRaw,
      pnlQuoteRaw: performance.summary.pnlQuoteRaw,
      pnlPct: performance.summary.pnlPct,
      currentValueStableRaw: performance.summary.currentValueUsdgRaw,
      baselineValueStableRaw: performance.summary.baselineValueUsdgRaw,
      pnlStableRaw: performance.summary.pnlUsdgRaw,
      pnlStablePct: performance.summary.pnlUsdgPct,
    } : undefined,
    baselineAt: performance.baseline?.at,
    position: performance.currentPosition ? {
      tokenId: performance.currentPosition.tokenId,
      tick: performance.currentPosition.tick,
      tickLower: performance.currentPosition.tickLower,
      tickUpper: performance.currentPosition.tickUpper,
    } : undefined,
  }
}

export function publicStatusRange(url: URL, now = Math.floor(Date.now() / 1000)) {
  const fromRaw = url.searchParams.get('from')
  const toRaw = url.searchParams.get('to')
  const from = fromRaw && /^\d+$/.test(fromRaw) ? Number(fromRaw) : now - DEFAULT_WINDOW_SECONDS
  const to = toRaw && /^\d+$/.test(toRaw) ? Number(toRaw) : now
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to || to - from > MAX_WINDOW_SECONDS)
    throw new Error('P/L curve range must be at most 31 days')
  return { from, to }
}

export async function publicStrategyStatus(owner: Address, from: number, to: number, deps: {
  loadPerformance?: typeof cachedStrategyPerformance
  recordPerformance?: typeof recordPerformanceDay
  now?: () => number
} = {}) {
  const loadPerformance = deps.loadPerformance ?? cachedStrategyPerformance
  const recordPerformance = deps.recordPerformance ?? recordPerformanceDay
  const selected = listStrategies().filter((row) =>
    row.state !== 'disabled' && row.config.owner.toLowerCase() === owner.toLowerCase())
  const performance = await Promise.all(selected.map(async (row) => {
    try {
      const value = await loadPerformance(row.config, row.state)
      recordPerformance(value)
      return { row, value }
    } catch {
      return { row, value: undefined }
    }
  }))
  const strategyIds = new Set(selected.map((row) => row.config.id))
  return {
    chain: {
      id: EXECUTOR.chainId,
      key: EXECUTOR.network.slug,
      name: EXECUTOR.network.name,
      stable: {
        address: EXECUTOR.network.settlementToken,
        symbol: EXECUTOR.network.settlementSymbol,
        decimals: EXECUTOR.network.settlementDecimals,
      },
    },
    address: owner,
    generatedAt: deps.now?.() ?? Math.floor(Date.now() / 1000),
    intervalSeconds: INTERVAL_SECONDS,
    strategies: performance.map(({ row, value }) => ({
      id: row.config.id,
      name: row.config.name,
      protocol: row.config.protocol,
      state: row.state,
      updatedAt: row.updatedAt,
      pool: row.config.pool,
      activeTokenId: row.config.activeTokenId,
      range: row.config.range,
      ...(value ? { performance: publicPerformance(value) } : { error: 'performance unavailable' }),
    })),
    points: pnlCurveRows(from, to)
      .filter((point) => strategyIds.has(point.strategyId))
      .map((point) => ({
        strategyId: point.strategyId,
        bucketAt: point.bucketAt,
        observedAt: point.observedAt,
        quote: point.quote,
        pnlQuoteRaw: point.pnlRaw,
        pnlStableRaw: point.pnlUsdgRaw,
      })),
  }
}
