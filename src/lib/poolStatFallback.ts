import type { PoolStat } from './poolstats'

export function poolStatWithFallback(primary?: PoolStat, fallback?: PoolStat): PoolStat | undefined {
  if (!primary || !fallback) return primary ?? fallback
  return {
    vol24hUsd: primary.vol24hUsd ?? fallback.vol24hUsd,
    liqUsd: primary.liqUsd ?? fallback.liqUsd,
    source: primary.vol24hUsd == null && fallback.vol24hUsd != null ? fallback.source : primary.source,
  }
}
