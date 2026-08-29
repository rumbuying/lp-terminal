import { parseStrategyConfig } from '../../shared/strategy/schema'
import type { StrategyConfig } from '../../shared/strategy/types'
import { CHAIN } from '../config/chains'

const LEGACY_KEY = 'lp-terminal.strategies.v1'
const LEGACY_TOMBSTONE_KEY = 'lp-terminal.strategy-tombstones.v1'
export const STRATEGY_STORAGE_KEY = `lp-terminal:${CHAIN.key}:strategies:v2`
export const STRATEGY_TOMBSTONE_STORAGE_KEY = `lp-terminal:${CHAIN.key}:strategy-tombstones:v2`

function storedValue(key: string, legacyKey: string): { raw: string; migrated: boolean } {
  const scoped = localStorage.getItem(key)
  if (scoped !== null) return { raw: scoped, migrated: false }
  const legacy = localStorage.getItem(legacyKey)
  return { raw: legacy ?? '[]', migrated: legacy !== null }
}

function loadTombstones(): Set<string> {
  try {
    const stored = storedValue(STRATEGY_TOMBSTONE_STORAGE_KEY, LEGACY_TOMBSTONE_KEY)
    const raw = JSON.parse(stored.raw)
    const tombstones = new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string' && id.length > 0) : [])
    // Strategy IDs are UUIDs and chain-independent. Copying legacy tombstones
    // into each chain namespace keeps stale tabs from resurrecting a deleted
    // draft without letting the two chains share mutable state afterward.
    if (stored.migrated) saveTombstones(tombstones)
    return tombstones
  } catch {
    return new Set()
  }
}

function saveTombstones(ids: Set<string>): void {
  localStorage.setItem(STRATEGY_TOMBSTONE_STORAGE_KEY, JSON.stringify([...ids]))
}

export function loadStrategies(): StrategyConfig[] {
  try {
    const stored = storedValue(STRATEGY_STORAGE_KEY, LEGACY_KEY)
    const raw = JSON.parse(stored.raw)
    if (!Array.isArray(raw)) return []
    const tombstones = loadTombstones()
    const strategies = raw.flatMap((x) => {
      try {
        const strategy = parseStrategyConfig(x)
        return strategy.chainId !== CHAIN.id || tombstones.has(strategy.id) ? [] : [strategy]
      } catch {
        return []
      }
    })
    if (stored.migrated) saveStrategies(strategies)
    return strategies
  } catch {
    return []
  }
}

export function saveStrategies(strategies: StrategyConfig[]): void {
  localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify(strategies.filter((strategy) => strategy.chainId === CHAIN.id)))
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
