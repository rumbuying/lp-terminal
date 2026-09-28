import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'
import { zeroAddress, type Address } from 'viem'
import { ADDR } from '../src/config/addresses'
import { EXECUTOR } from './config'

// Minimal two-token universe: an ERC-20 that trades against wrapped native.
const TOKEN = '0x000000000000000000000000000000000000000A' as Address
const WNATIVE = ADDR.WNATIVE
const POOL = '0x0000000000000000000000000000000000000BEE' as Address

// Mutable per-test quote outputs. `aggOut` is what the Kyber aggregator
// route returns (a non-direct route the executor cannot sign natively);
// `directOut` is the single discovered univ3 3000 ppm pool.
let aggOut = 10_000n
let directOut = 9_990n
let aggregatorOk = true

const previousFetch = globalThis.fetch
mock.module('./chain', { namedExports: {
  publicClient: {
    readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      if (functionName === 'tickSpacings') return []
      if (functionName === 'getPool') {
        const [, , tier] = args as [Address, Address, number]
        return tier === 3000 ? POOL : zeroAddress
      }
      if (functionName === 'quoteExactInputSingle') return [directOut, 0n, 0, 0n]
      throw new Error(`unexpected readContract ${functionName}`)
    },
  },
} })

const { quoteNativeExecutable } = await import('./kyber')

function stubFetch() {
  globalThis.fetch = (async (input: unknown) => ({
    ok: aggregatorOk,
    json: async () => {
      if (!aggregatorOk) return null
      const url = new URL(String(input instanceof Request ? input.url : input))
      return {
        code: 0,
        data: {
          routerAddress: EXECUTOR.kyberRouter,
          routeSummary: {
            tokenIn: TOKEN, tokenOut: WNATIVE,
            amountIn: url.searchParams.get('amountIn') ?? '0',
            amountOut: aggOut.toString(),
            route: [], executorSource: undefined,
          },
        },
      }
    },
  })) as unknown as typeof fetch
}

beforeEach(() => { aggOut = 10_000n; directOut = 9_990n; aggregatorOk = true; stubFetch() })

test('a direct univ3 pool within the lag bound is preferred over a better non-direct aggregator route', async () => {
  directOut = 9_988n // 12 bps behind — the production 2026-09-28 wedge
  const route = await quoteNativeExecutable(TOKEN, WNATIVE, 1_000n, 100)
  assert.equal(route.routeSummary.executorSource, 'univ3')
  assert.equal(route.routeSummary.feePpm, 3000)
  assert.equal(route.routeSummary.amountOut, '9988')
})

test('the lag bound is inclusive at the boundary', async () => {
  directOut = 9_900n // exactly 100 bps behind
  const route = await quoteNativeExecutable(TOKEN, WNATIVE, 1_000n, 100)
  assert.equal(route.routeSummary.executorSource, 'univ3')
})

test('a direct route beyond the lag bound is not silently taken', async () => {
  directOut = 9_899n // 101 bps behind
  const route = await quoteNativeExecutable(TOKEN, WNATIVE, 1_000n, 100)
  assert.equal(route.routeSummary.executorSource, undefined)
  assert.equal(route.routeSummary.amountOut, '10000')
})

test('a zero lag bound only accepts an exactly equal direct route', async () => {
  directOut = 9_999n
  const tighter = await quoteNativeExecutable(TOKEN, WNATIVE, 1_000n, 0)
  assert.equal(tighter.routeSummary.executorSource, undefined)
  directOut = 10_000n
  const equal = await quoteNativeExecutable(TOKEN, WNATIVE, 1_000n, 0)
  assert.equal(equal.routeSummary.executorSource, 'univ3')
})

test('an unavailable aggregator leaves the direct pool executable', async () => {
  aggregatorOk = false
  directOut = 7_000n // far behind a hypothetical best; nothing to compare with
  const route = await quoteNativeExecutable(TOKEN, WNATIVE, 1_000n, 100)
  assert.equal(route.routeSummary.executorSource, 'univ3')
})

test('quote identity validation still binds the aggregator route to the requested pair', async () => {
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({
    code: 0,
    data: { routerAddress: EXECUTOR.kyberRouter, routeSummary: {
      tokenIn: WNATIVE, tokenOut: TOKEN, // reversed pair must be rejected
      amountIn: '1000', amountOut: aggOut.toString(), route: [],
    } },
  }) })) as unknown as typeof fetch
  directOut = 0n // direct quote returns zero → rejected by the quoter path
  await assert.rejects(quoteNativeExecutable(TOKEN, WNATIVE, 1_000n, 100), /E_KYBER_QUOTE/)
})

globalThis.fetch = previousFetch
