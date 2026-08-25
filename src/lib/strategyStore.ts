import { parseStrategyConfig } from '../../shared/strategy/schema'
import type { StrategyConfig } from '../../shared/strategy/types'

const KEY = 'lp-terminal.strategies.v1'
const TOMBSTONE_KEY = 'lp-terminal.strategy-tombstones.v1'

function loadTombstones(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(TOMBSTONE_KEY) ?? '[]')
    return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string' && id.length > 0) : [])
  } catch {
    return new Set()
  }
}

function saveTombstones(ids: Set<string>): void {
  localStorage.setItem(TOMBSTONE_KEY, JSON.stringify([...ids]))
}

export function loadStrategies(): StrategyConfig[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    if (!Array.isArray(raw)) return []
    const tombstones = loadTombstones()
    return raw.flatMap((x) => {
      try {
        const strategy = parseStrategyConfig(x)
        return tombstones.has(strategy.id) ? [] : [strategy]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

export function saveStrategies(strategies: StrategyConfig[]): void {
  localStorage.setItem(KEY, JSON.stringify(strategies))
}

export function upsertStrategy(strategy: StrategyConfig): StrategyConfig[] {
  const tombstones = loadTombstones()
  const all = loadStrategies()
  // A stale tab must not recreate a strategy deleted in another tab or already
  // archived by the executor. Strategy IDs are UUIDs, so a legitimate new
  // strategy always receives a new ID.
  if (tombstones.has(strategy.id)) {
    saveStrategies(all)
    return all
  }
  const i = all.findIndex((x) => x.id === strategy.id)
  if (i >= 0) all[i] = strategy
  else all.unshift(strategy)
  saveStrategies(all)
  return all
}

export function removeStrategy(id: string): StrategyConfig[] {
  const tombstones = loadTombstones()
  tombstones.add(id)
  saveTombstones(tombstones)
  const all = loadStrategies().filter((x) => x.id !== id)
  saveStrategies(all)
  return all
}

/**
 * Reconcile browser drafts with the executor's authoritative lifecycle state.
 * Active IDs clear an old tombstone (the executor may explicitly reactivate an
 * archived ID), while archived IDs are removed locally and remain suppressed
 * across tabs and deployments.
 */
export function syncStrategyArchiveState(activeStrategyIds: Iterable<string>, archivedStrategyIds: Iterable<string>): StrategyConfig[] {
  const tombstones = loadTombstones()
  for (const id of activeStrategyIds) tombstones.delete(id)
  for (const id of archivedStrategyIds) tombstones.add(id)
  saveTombstones(tombstones)
  const all = loadStrategies().filter((strategy) => !tombstones.has(strategy.id))
  saveStrategies(all)
  return all
}
