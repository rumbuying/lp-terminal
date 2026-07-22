import assert from 'node:assert/strict'
import test from 'node:test'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import {
  ManualRefreshGate,
  quoteDataIsStale,
  selectUsableQuoteData,
  solverQuoteCanAutoRefresh,
  solverQuoteNeedsManualRefresh,
  solverQuoteRefetchInterval,
} from './solverRefresh'

test('cached solver and direct data leave selection and request refresh at the age boundary', () => {
  const solver = { source: 'solver' }
  const direct = { source: 'direct' }
  const select = (solverDataUpdatedAt = 1_001, directDataUpdatedAt = 1_001, solverError = false, directError = false) =>
    selectUsableQuoteData({
      solverData: solver,
      directData: direct,
      solverError,
      directError,
      solverDataUpdatedAt,
      directDataUpdatedAt,
      now: 16_000,
    })

  assert.deepEqual(select(), { solver, direct, hasStaleData: false })
  assert.deepEqual(select(1_000), { solver: null, direct, hasStaleData: true })
  assert.deepEqual(select(1_001, 1_000), { solver, direct: null, hasStaleData: true })
  assert.deepEqual(select(1_001, 1_001, true), { solver: null, direct, hasStaleData: false })
  assert.deepEqual(select(1_001, 1_001, false, true), { solver, direct: null, hasStaleData: false })
  assert.equal(quoteDataIsStale(1_000, 15_999), false)
  assert.equal(quoteDataIsStale(1_000, 16_000), true)
})

test('solver auto-refreshes three times, then requires a fresh manual quote', () => {
  for (let settled = 0; settled <= 3; settled += 1) {
    assert.equal(solverQuoteRefetchInterval({ dataUpdateCount: settled, errorUpdateCount: 0 }), 15_000)
  }
  assert.equal(solverQuoteRefetchInterval({ dataUpdateCount: 4, errorUpdateCount: 0 }), false)
  assert.equal(solverQuoteRefetchInterval({ dataUpdateCount: 0, errorUpdateCount: 4 }), false)
  assert.equal(solverQuoteRefetchInterval({ dataUpdateCount: 4, errorUpdateCount: 0 }, 1), 15_000)
  assert.equal(solverQuoteRefetchInterval({ dataUpdateCount: 5, errorUpdateCount: 0 }, 1), false)

  assert.equal(solverQuoteNeedsManualRefresh(true, true), false)
  assert.equal(solverQuoteNeedsManualRefresh(true, false), true)
  assert.equal(solverQuoteNeedsManualRefresh(false, false), false)
})

test('concurrent manual refreshes share one request and one settlement', async () => {
  const gate = new ManualRefreshGate()
  const query = {}
  let calls = 0
  let settlements = 0
  let resolve!: (value: number) => void
  const refetch = () => {
    calls += 1
    return new Promise<number>((done) => {
      resolve = done
    }).then((value) => {
      settlements += 1
      return value
    })
  }

  const first = gate.run(query, refetch)
  const second = gate.run(query, refetch)

  assert.equal(first, second)
  assert.equal(calls, 1)
  resolve(42)
  assert.equal(await first, 42)
  assert.equal(await second, 42)
  assert.equal(settlements, 1)

  const third = gate.run(query, async () => {
    calls += 1
    settlements += 1
    return 43
  })
  assert.equal(await third, 43)
  assert.equal(calls, 2)
  assert.equal(settlements, 2)
})

test('an exhausted solver ignores automatic invalidation but still refetches manually', async () => {
  const client = new QueryClient()
  const solverKey = ['solverQuote', 'test'] as const
  const directKey = ['directQuote', 'test'] as const
  for (let settled = 0; settled < 4; settled += 1) client.setQueryData(solverKey, settled)
  client.setQueryData(directKey, 0)
  let solverCalls = 0
  let directCalls = 0
  const solver = new QueryObserver(client, {
    queryKey: solverKey,
    queryFn: async () => ++solverCalls,
    enabled: (query) => solverQuoteCanAutoRefresh(query.state),
    staleTime: Infinity,
  })
  const direct = new QueryObserver(client, {
    queryKey: directKey,
    queryFn: async () => ++directCalls,
    staleTime: Infinity,
  })
  const stopSolver = solver.subscribe(() => {})
  const stopDirect = direct.subscribe(() => {})

  try {
    await client.invalidateQueries()
    assert.equal(solverCalls, 0)
    assert.equal(directCalls, 1)
    await solver.refetch()
    assert.equal(solverCalls, 1)
  } finally {
    stopSolver()
    stopDirect()
    client.clear()
  }
})
