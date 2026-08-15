import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { zeroAddress, type Address } from 'viem'
import { ADDR, UNI } from '../config/addresses'

const quoteToken = '0x0000000000000000000000000000000000000003' as Address
const upWethPool = '0x0000000000000000000000000000000000000010' as Address
const uni500Pool = '0x0000000000000000000000000000000000000020' as Address
const uni3000Pool = '0x0000000000000000000000000000000000000030' as Address
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const pair = (a: string, b: string, x: string, y: string) =>
  [a.toLowerCase(), b.toLowerCase()].sort().join(':') === [x.toLowerCase(), y.toLowerCase()].sort().join(':')

mock.module('../../executor/config', {
  namedExports: {
    EXECUTOR: {
      kyberBase: 'https://kyber.invalid',
      kyberChain: 'robinhood',
      kyberRouter: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
    },
  },
})
mock.module('../../executor/chain', {
  namedExports: {
    publicClient: {
      readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
        if (same(address, ADDR.CL_FACTORY) && functionName === 'tickSpacings') return [60]
        if (same(address, ADDR.CL_FACTORY) && functionName === 'getPool') {
          const [tokenIn, tokenOut] = args as readonly [Address, Address]
          return pair(tokenIn, tokenOut, ADDR.UP, ADDR.WETH) ? upWethPool : zeroAddress
        }
        if (same(address, UNI.V3_FACTORY) && functionName === 'getPool') {
          const [tokenIn, tokenOut, fee] = args as readonly [Address, Address, number]
          if (!pair(tokenIn, tokenOut, ADDR.WETH, quoteToken)) return zeroAddress
          if (fee === 500) return uni500Pool
          if (fee === 3000) return uni3000Pool
          return zeroAddress
        }
        if (same(address, ADDR.CL_QUOTER) && functionName === 'quoteExactInputSingle') {
          const params = (args as readonly [{ amountIn: bigint }])[0]
          return [(params.amountIn * 8n) / 10n, 1n, 0, 0n]
        }
        if (same(address, UNI.V3_QUOTER) && functionName === 'quoteExactInputSingle') {
          const params = (args as readonly [{ amountIn: bigint; fee: number }])[0]
          return [params.amountIn * (params.fee === 500 ? 2n : 19n) / (params.fee === 500 ? 1n : 10n), 1n, 0, 0n]
        }
        throw new Error(`unexpected ${address} ${functionName}`)
      },
    },
  },
})

mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ code: 1 }), {
  status: 503,
  headers: { 'content-type': 'application/json' },
}))

const { quoteRewardToQuote } = await import('../../executor/reward')

test('two-hop reward quote falls back to canonical native pools and chooses the best V3 fee tier', async () => {
  const result = await quoteRewardToQuote(100n, quoteToken)
  assert.equal(result.weth.routeSummary.executorSource, 'up33_cl')
  assert.equal(result.wethAmountOut, 80n)
  assert.equal(result.quote?.routeSummary.executorSource, 'univ3')
  assert.equal(result.quote?.routeSummary.feePpm, 500)
  assert.equal(result.amountOut, 160n)
})
