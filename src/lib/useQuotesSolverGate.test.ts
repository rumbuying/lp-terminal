import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type { Address } from 'viem'

const solverFeature = { solver: false }
const solverEnv = { solverUrl: 'https://robinhood-solver.test' }
let solverCalls = 0

mock.module('../config/features', { namedExports: { FEATURES: solverFeature } })
mock.module('../config/env', {
  namedExports: {
    ENV: solverEnv,
    swapFee: () => ({
      bps: 0,
      receiver: '0x00000000000000000000000000000000000000fe',
    }),
  },
})
mock.module('../lib/directSwap', {
  namedExports: {
    erc20Of: (token: Address) => token,
    quoteDirectCandidates: async () => { throw new Error('direct quote must not run') },
  },
})
mock.module('../lib/solver', {
  namedExports: {
    fetchSolverQuote: async () => {
      solverCalls += 1
      throw new Error('disabled solver must not run')
    },
    solverVenueFeeBps: () => 0,
  },
})
mock.module('../hooks/usePools', {
  namedExports: { usePools: () => ({ data: null, error: null }) },
})
mock.module('wagmi', {
  namedExports: { usePublicClient: () => null },
})

const { useSolverQuote } = await import('../hooks/useQuotes')

test('manual refetch stays disabled when the active chain has no solver', async () => {
  const tokenIn = '0x0000000000000000000000000000000000000011' as Address
  const tokenOut = '0x0000000000000000000000000000000000000022' as Address
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const captured: { refetch?: () => Promise<unknown> } = {}

  function Probe() {
    captured.refetch = useSolverQuote(tokenIn, tokenOut, 1n).refetch
    return null
  }

  renderToString(createElement(QueryClientProvider, { client }, createElement(Probe)))
  assert.ok(captured.refetch)
  await captured.refetch()
  assert.equal(solverCalls, 0)
})
