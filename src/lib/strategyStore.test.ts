import assert from 'node:assert/strict'
import test from 'node:test'
import { originalStrategyDraft } from '../../shared/strategy/schema'
import type { StrategyConfig } from '../../shared/strategy/types'
import { UNI } from '../config/addresses'
import { loadStrategies, removeStrategy, saveStrategies, syncStrategyArchiveState, upsertStrategy } from './strategyStore'

const values = new Map<string, string>()
const originalLocalStorage = globalThis.localStorage

const draft = (id: string): StrategyConfig => ({
  ...originalStrategyDraft({
    owner: '0x0000000000000000000000000000000000000001',
    protocol: 'univ3',
    pool: '0x0000000000000000000000000000000000000002',
    positionManager: UNI.V3_NPM,
    riskToken: '0x0000000000000000000000000000000000000004',
    quoteToken: '0x0000000000000000000000000000000000000005',
  }),
  id,
})

test.before(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size },
    },
  })
})

test.beforeEach(() => values.clear())

test.after(() => {
  if (originalLocalStorage === undefined) delete (globalThis as { localStorage?: Storage }).localStorage
  else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage })
})

test('executor archive state removes a stale local strategy and suppresses stale-tab writes', () => {
  const archived = draft('strategy-archived')
  const localOnly = draft('strategy-local')
  upsertStrategy(archived)
  upsertStrategy(localOnly)

  assert.deepEqual(syncStrategyArchiveState([], [archived.id]).map((strategy) => strategy.id), [localOnly.id])
  assert.deepEqual(upsertStrategy(archived).map((strategy) => strategy.id), [localOnly.id])
  assert.deepEqual(loadStrategies().map((strategy) => strategy.id), [localOnly.id])
})

test('an authoritative active strategy clears an old archive tombstone', () => {
  const strategy = draft('strategy-reactivated')
  syncStrategyArchiveState([], [strategy.id])
  syncStrategyArchiveState([strategy.id], [])

  assert.deepEqual(upsertStrategy(strategy).map((item) => item.id), [strategy.id])
})

test('local deletion cannot be undone by a stale tab', () => {
  const strategy = draft('strategy-deleted-locally')
  upsertStrategy(strategy)
  removeStrategy(strategy.id)

  assert.deepEqual(upsertStrategy(strategy), [])
  // Simulate an already-open tab still running the pre-tombstone frontend.
  saveStrategies([strategy])
  assert.deepEqual(loadStrategies(), [])
})
