import { audit, enabledExecutorStrategies } from './store'
import { EXECUTOR } from './config'

// FR-EXEC-1 (docs/VOLUME-TREND-PRD.zh-CN.md §5.4): a held pool whose volume is
// fading/cliffing — or that sits on the FROM side of a detected migration — is
// recorded as an audit alert so the operator sees the fee-income decline while
// it is happening. Deliberately READ-ONLY: this module never plans or executes
// a rebalance. The evaluation itself stays with the operator (the PRD's
// "trigger an exit evaluation" is served by the alert + the recommendation
// page's fading warnings), because an automated exit on a trend signal alone
// would put capital movement behind the least reliable input in the stack.

type RankSnapshot = {
  ready?: boolean
  rows?: { address?: string; trend?: { class?: string } }[]
  migrationEvents?: {
    fromPool?: string
    toPool?: string
    fromShareStart?: number
    fromShareEnd?: number
  }[]
}

const FETCH_TTL_MS = 30 * 60_000
const ALERT_REPEAT_MS = 24 * 3_600_000

let snapshotAt = 0
let snapshot: RankSnapshot | null = null
const alertedAt = new Map<string, number>()

export async function recordVolumeTrendAlerts(nowMs = Date.now()): Promise<void> {
  try {
    if (nowMs - snapshotAt > FETCH_TTL_MS) {
      const response = await fetch(`${EXECUTOR.indexerBase}/api/pool-rank`, { signal: AbortSignal.timeout(4_000) })
      if (!response.ok) return
      const body = (await response.json()) as RankSnapshot
      snapshot = body?.ready ? body : null
      snapshotAt = nowMs
    }
    if (!snapshot) return
    for (const { config } of enabledExecutorStrategies()) {
      const identity = config.pool.toLowerCase()
      const trend = snapshot.rows?.find((row) => row.address?.toLowerCase() === identity)?.trend?.class
      const event = snapshot.migrationEvents?.find((e) => e.fromPool?.toLowerCase() === identity)
      if (trend !== 'fading' && trend !== 'collapsing' && !event) continue
      const last = alertedAt.get(config.id) ?? 0
      if (nowMs - last < ALERT_REPEAT_MS) continue
      alertedAt.set(config.id, nowMs)
      audit('monitor', 'volume_trend_alert', 'strategy', config.id, {
        code: event ? 'E_VOLUME_MIGRATED' : 'E_VOLUME_FADING',
        trend: trend ?? 'unknown',
        toPool: event?.toPool,
        shareFromPct: event?.fromShareStart !== undefined ? Math.round(event.fromShareStart * 100) : undefined,
        shareToPct: event?.fromShareEnd !== undefined ? Math.round(event.fromShareEnd * 100) : undefined,
        message: 'held pool volume fading/migrating — evaluate an exit; no automatic action taken',
      })
    }
  } catch {
    // Advisory only: the rank endpoint being down must never disturb the
    // executor loop.
  }
}
