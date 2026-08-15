import { parseStrategyConfig } from '../../shared/strategy/schema'
import type { StrategyConfig } from '../../shared/strategy/types'

const KEY = 'lp-terminal.strategies.v1'

export function loadStrategies(): StrategyConfig[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    if (!Array.isArray(raw)) return []
    return raw.flatMap((x) => {
      try {
        return [parseStrategyConfig(x)]
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
  const all = loadStrategies()
  const i = all.findIndex((x) => x.id === strategy.id)
  if (i >= 0) all[i] = strategy
  else all.unshift(strategy)
  saveStrategies(all)
  return all
}

export function removeStrategy(id: string): StrategyConfig[] {
  const all = loadStrategies().filter((x) => x.id !== id)
  saveStrategies(all)
  return all
}
