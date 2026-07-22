import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeFunctionData, getAddress, zeroAddress, type Address, type PublicClient } from 'viem'
import { clSwapRouterAbi, uniSwapRouterAbi } from '../abi'
import { ADDR, NATIVE, UNI } from '../config/addresses'
import type { Pool } from '../types'
import {
  buildDirectTransaction,
  grossMinimumForNet,
  netAfterFee,
  quoteDirectCandidates,
  type DirectRoute,
} from './directSwap'

const tokenIn = getAddress('0x0000000000000000000000000000000000000011')
const tokenOut = getAddress('0x0000000000000000000000000000000000000022')
const recipient = getAddress('0x0000000000000000000000000000000000000033')
const feeReceiver = getAddress('0x0000000000000000000000000000000000000044')
const fee = { bps: 9, receiver: feeReceiver }

function expectAddress(actual: Address, expected: Address): void {
  assert.equal(actual.toLowerCase(), expected.toLowerCase())
}

test('gross minimum is the least amount whose net covers the requested minimum', () => {
  for (const net of [0n, 1n, 999n, 10_000n, 1_000_000_000_000_000_000n]) {
    const gross = grossMinimumForNet(net, 9)
    assert.ok(netAfterFee(gross, 9) >= net)
    if (gross > 0n) assert.ok(netAfterFee(gross - 1n, 9) < net)
  }
})

test('quotes direct Uniswap tiers and matching UP33 CL pools in one multicall, ranked net of fee', async () => {
  const pools = [
    {
      kind: 'cl',
      protocol: 'up33',
      token0: tokenIn,
      token1: tokenOut,
      tickSpacing: 200,
      feePpm: 10_000,
    },
    { kind: 'v2', protocol: 'up33', token0: tokenIn, token1: tokenOut },
    {
      kind: 'cl',
      protocol: 'up33',
      token0: tokenIn,
      token1: getAddress('0x0000000000000000000000000000000000000099'),
      tickSpacing: 100,
      feePpm: 500,
    },
    // The registry is permissionless and metadata calls can fail independently:
    // an unusable pool on this pair must not take the working routes down.
    {
      kind: 'cl',
      protocol: 'up33',
      token0: tokenIn,
      token1: tokenOut,
      tickSpacing: 50,
      feePpm: 1_000_000,
    },
    {
      kind: 'cl',
      protocol: 'up33',
      token0: tokenIn,
      token1: tokenOut,
      tickSpacing: 0,
      feePpm: 500,
    },
  ] as Pool[]
  let calls = 0
  const outputs: readonly (readonly [bigint, bigint])[] = [
    [19_000n, 200n],
    [20_000n, 200n],
    [21_000n, 220n],
  ]
  const client = {
    multicall: async ({ contracts }: { contracts: readonly Record<string, unknown>[] }) => {
      calls++
      if (calls === 1) {
        assert.equal(contracts.length, 5)
        return contracts.map((_, index) => ({
          status: 'success' as const,
          result:
            index < 2
              ? getAddress(`0x${String(index + 1).padStart(40, '0')}`)
              : zeroAddress,
        }))
      }
      assert.equal(contracts.length, 6)
      expectAddress(contracts[0].address as Address, UNI.V2_ROUTER)
      expectAddress(contracts[2].address as Address, UNI.V3_QUOTER)
      expectAddress(contracts[4].address as Address, ADDR.CL_QUOTER)
      assert.equal(
        ((contracts[4].args as readonly [{ tickSpacing: number }])[0]).tickSpacing,
        200,
      )
      return contracts.map((_, index) => {
        const output = outputs[Math.floor(index / 2)][index % 2]
        return {
          status: 'success' as const,
          result: index < 2 ? [index % 2 ? 100n : 10_000n, output] : [output, 0n, 0, 0n],
        }
      })
    },
  } as unknown as PublicClient

  const quotes = await quoteDirectCandidates(client, pools, tokenIn, tokenOut, 10_000n, 9)

  assert.equal(calls, 2)
  assert.equal(quotes.best?.route.protocol, 'up33')
  assert.equal(quotes.best?.amountOut, 20_982n)
  assert.equal(quotes.best?.impactBps, 455)
  assert.equal(quotes.byProtocol.uniswap?.route.kind, 'v3')
  assert.equal(quotes.byProtocol.up33, quotes.best)
  assert.deepEqual(quotes.status, { uniswap: 'quoted', up33: 'quoted' })
  // The CL winner's Quoter response does not expose its per-step rounded fee,
  // so the direct fallback cannot honestly reconstruct a fee-free baseline.
  assert.equal(quotes.midOut, null)
})

test('builds a usable direct baseline when the probe winner is Uniswap V2', async () => {
  let calls = 0
  const client = {
    multicall: async ({ contracts }: { contracts: readonly Record<string, unknown>[] }) => {
      calls += 1
      if (calls === 1) {
        return contracts.map((_, index) => ({
          status: 'success' as const,
          result: index === 0 ? getAddress('0x0000000000000000000000000000000000000055') : zeroAddress,
        }))
      }
      return [
        { status: 'success' as const, result: [10_000n, 20_060n] },
        { status: 'success' as const, result: [100n, 200n] },
      ]
    },
  } as unknown as PublicClient

  const quotes = await quoteDirectCandidates(client, [], tokenIn, tokenOut, 10_000n, 9)

  assert.equal(quotes.best?.route.kind, 'v2')
  assert.equal(quotes.midOut, 20_060n)
})

test('rejects a V2 baseline destroyed by small-probe rounding', async () => {
  const reserve = 1_000_000_000_000n
  const v2Out = (amountIn: bigint) => (amountIn * 997n * reserve) / (reserve * 1_000n + amountIn * 997n)
  const fullOut = v2Out(300n)
  const probeOut = v2Out(3n)
  assert.deepEqual([fullOut, probeOut], [299n, 2n])

  let calls = 0
  const client = {
    multicall: async ({ contracts }: { contracts: readonly Record<string, unknown>[] }) => {
      calls += 1
      if (calls === 1) {
        return contracts.map((_, index) => ({
          status: 'success' as const,
          result: index === 0 ? getAddress('0x0000000000000000000000000000000000000055') : zeroAddress,
        }))
      }
      return [
        { status: 'success' as const, result: [300n, fullOut] },
        { status: 'success' as const, result: [3n, probeOut] },
      ]
    },
  } as unknown as PublicClient

  const quotes = await quoteDirectCandidates(client, [], tokenIn, tokenOut, 300n, 0)

  assert.equal(quotes.best?.amountOut, 299n)
  assert.equal(quotes.midOut, null)
})

test('rejects a V2 baseline below another route full quote', async () => {
  let calls = 0
  const client = {
    multicall: async ({ contracts }: { contracts: readonly Record<string, unknown>[] }) => {
      calls += 1
      if (calls === 1) {
        return contracts.map((_, index) => ({
          status: 'success' as const,
          result: index < 2 ? getAddress(`0x${String(index + 1).padStart(40, '0')}`) : zeroAddress,
        }))
      }
      return [
        { status: 'success' as const, result: [10_000n, 9_900n] },
        { status: 'success' as const, result: [100n, 99n] },
        { status: 'success' as const, result: [9_930n, 0n, 0, 0n] },
        { status: 'success' as const, result: [98n, 0n, 0, 0n] },
      ]
    },
  } as unknown as PublicClient

  const quotes = await quoteDirectCandidates(client, [], tokenIn, tokenOut, 10_000n, 9)

  // The V2 probe implies 9_929, which is above the best net (9_922) but
  // below its full gross (9_930): terminal fees must not hide the bad baseline.
  assert.equal(quotes.best?.amountOut, 9_922n)
  assert.equal(quotes.midOut, null)
})

test('distinguishes a failed protocol quote from an absent pool', async () => {
  let calls = 0
  const client = {
    multicall: async ({ contracts }: { contracts: readonly Record<string, unknown>[] }) => {
      calls++
      if (calls === 1) {
        return contracts.map((_, index) => ({
          status: 'success' as const,
          result: index === 1 ? getAddress('0x0000000000000000000000000000000000000055') : zeroAddress,
        }))
      }
      return contracts.map(() => ({ status: 'failure' as const }))
    },
  } as unknown as PublicClient

  const quotes = await quoteDirectCandidates(client, [], tokenIn, tokenOut, 10_000n, 9)

  assert.equal(quotes.best, null)
  assert.deepEqual(quotes.status, { uniswap: 'failed', up33: 'absent' })
})

test('does not quote a partially discovered Uniswap protocol', async () => {
  let calls = 0
  const client = {
    multicall: async ({ contracts }: { contracts: readonly Record<string, unknown>[] }) => {
      calls++
      return contracts.map((_, index) =>
        index === 0
          ? { status: 'failure' as const }
          : { status: 'success' as const, result: zeroAddress },
      )
    },
  } as unknown as PublicClient

  const quotes = await quoteDirectCandidates(client, [], tokenIn, tokenOut, 10_000n, 9)

  assert.equal(calls, 1)
  assert.equal(quotes.best, null)
  assert.deepEqual(quotes.status, { uniswap: 'failed', up33: 'absent' })
})

test('ranks a protocol by its executable tiers when another tier reverts', async () => {
  let calls = 0
  const client = {
    multicall: async ({ contracts }: { contracts: readonly Record<string, unknown>[] }) => {
      calls++
      if (calls === 1) {
        // discovery: the v2 pair and the first v3 tier both exist
        return contracts.map((_, index) => ({
          status: 'success' as const,
          result: index < 2 ? getAddress(`0x${String(index + 1).padStart(40, '0')}`) : zeroAddress,
        }))
      }
      return contracts.map((_, index) => {
        // the v3 tier is created but illiquid — its quote reverts; v2 fills fine
        if (index >= 2) return { status: 'failure' as const }
        return { status: 'success' as const, result: index === 0 ? [10_000n, 20_000n] : [100n, 200n] }
      })
    },
  } as unknown as PublicClient

  const quotes = await quoteDirectCandidates(client, [], tokenIn, tokenOut, 10_000n, 9)

  // a dead fee-tier pool no longer poisons the protocol: the surviving v2 tier
  // still ranks and becomes the best executable quote
  assert.equal(quotes.best?.route.kind, 'v2')
  assert.equal(quotes.best?.amountOut, 19_982n)
  assert.equal(quotes.byProtocol.uniswap?.route.kind, 'v2')
  assert.deepEqual(quotes.status, { uniswap: 'quoted', up33: 'absent' })
})

test('keeps a full Uniswap quote when impact probing or the UP33 registry is unavailable', async () => {
  let calls = 0
  const client = {
    multicall: async ({ contracts }: { contracts: readonly Record<string, unknown>[] }) => {
      calls++
      if (calls === 1) {
        return contracts.map((_, index) => ({
          status: 'success' as const,
          result: index === 1 ? getAddress('0x0000000000000000000000000000000000000055') : zeroAddress,
        }))
      }
      assert.equal(contracts.length, 2)
      return [{ status: 'success' as const, result: [20_000n, 0n, 0, 0n] }, { status: 'failure' as const }]
    },
  } as unknown as PublicClient

  const quotes = await quoteDirectCandidates(client, null, tokenIn, tokenOut, 10_000n, 9)

  assert.equal(quotes.best?.amountOut, 19_982n)
  assert.equal(quotes.best?.impactBps, null)
  assert.deepEqual(quotes.status, { uniswap: 'quoted', up33: 'failed' })
})

test('marks impact unavailable when the amount is too small for a distinct probe', async () => {
  let calls = 0
  const client = {
    multicall: async ({ contracts }: { contracts: readonly Record<string, unknown>[] }) => {
      calls++
      if (calls === 1) {
        return contracts.map((_, index) => ({
          status: 'success' as const,
          result: index === 1 ? getAddress('0x0000000000000000000000000000000000000055') : zeroAddress,
        }))
      }
      assert.equal(contracts.length, 1)
      return [{ status: 'success' as const, result: [80n, 0n, 0, 0n] }]
    },
  } as unknown as PublicClient

  const quotes = await quoteDirectCandidates(client, [], tokenIn, tokenOut, 50n, 9)

  assert.equal(quotes.best?.amountOut, 80n)
  assert.equal(quotes.best?.impactBps, null)
  // no probe, so no baseline either — this is the one state where the UI has
  // no cost to show and says so
  assert.equal(quotes.midOut, null)
  assert.deepEqual(quotes.status, { uniswap: 'quoted', up33: 'absent' })
})

test('Uniswap V2 multicall fixes swap target, gross minimum and fee settlement', () => {
  const minimumAmountOut = 10_000n
  const grossMinimum = grossMinimumForNet(minimumAmountOut, fee.bps)
  const transaction = buildDirectTransaction({
    tokenIn,
    tokenOut,
    amountIn: 20_000n,
    minimumAmountOut,
    recipient,
    deadline: 123n,
    route: { protocol: 'uniswap', kind: 'v2', feePpm: 3000 },
    fee,
  })

  expectAddress(transaction.to, UNI.V3_SWAP_ROUTER)
  expectAddress(transaction.spender!, UNI.V3_SWAP_ROUTER)
  expectAddress(transaction.inputToken!, tokenIn)
  expectAddress(transaction.outputToken!, tokenOut)
  assert.equal(transaction.value, 0n)
  const outer = decodeFunctionData({ abi: uniSwapRouterAbi, data: transaction.data })
  assert.equal(outer.functionName, 'multicall')
  assert.equal(outer.args[0], 123n)
  const [swapData, settleData] = outer.args[1]
  const swap = decodeFunctionData({ abi: uniSwapRouterAbi, data: swapData })
  assert.equal(swap.functionName, 'swapExactTokensForTokens')
  assert.deepEqual(swap.args, [20_000n, grossMinimum, [tokenIn, tokenOut], getAddress(UNI.V3_SWAP_ROUTER)])
  const settle = decodeFunctionData({ abi: uniSwapRouterAbi, data: settleData })
  assert.equal(settle.functionName, 'sweepTokenWithFee')
  assert.deepEqual(settle.args, [tokenOut, grossMinimum, recipient, 9n, feeReceiver])
})

test('Uniswap V3 native output is unwrapped atomically after the fee', () => {
  const grossMinimum = grossMinimumForNet(10_000n, fee.bps)
  const transaction = buildDirectTransaction({
    tokenIn,
    tokenOut: NATIVE,
    amountIn: 20_000n,
    minimumAmountOut: 10_000n,
    recipient,
    deadline: 123n,
    route: { protocol: 'uniswap', kind: 'v3', feePpm: 500 },
    fee,
  })

  assert.equal(transaction.outputToken, null)
  const outer = decodeFunctionData({ abi: uniSwapRouterAbi, data: transaction.data })
  assert.equal(outer.functionName, 'multicall')
  const swap = decodeFunctionData({ abi: uniSwapRouterAbi, data: outer.args[1][0] })
  assert.equal(swap.functionName, 'exactInputSingle')
  assert.deepEqual(swap.args[0], {
    tokenIn,
    tokenOut: ADDR.WETH,
    fee: 500,
    recipient: getAddress(UNI.V3_SWAP_ROUTER),
    amountIn: 20_000n,
    amountOutMinimum: grossMinimum,
    sqrtPriceLimitX96: 0n,
  })
  const settle = decodeFunctionData({ abi: uniSwapRouterAbi, data: outer.args[1][1] })
  assert.equal(settle.functionName, 'unwrapWETH9WithFee')
  assert.deepEqual(settle.args, [grossMinimum, recipient, 9n, feeReceiver])
})

test('UP33 CL native input uses WETH calldata, ETH value and no approval', () => {
  const grossMinimum = grossMinimumForNet(10_000n, fee.bps)
  const transaction = buildDirectTransaction({
    tokenIn: NATIVE,
    tokenOut,
    amountIn: 20_000n,
    minimumAmountOut: 10_000n,
    recipient,
    deadline: 123n,
    route: { protocol: 'up33', kind: 'cl', tickSpacing: 200, feePpm: 10_000 },
    fee,
  })

  expectAddress(transaction.to, ADDR.CL_SWAP_ROUTER)
  assert.equal(transaction.spender, null)
  assert.equal(transaction.inputToken, null)
  assert.equal(transaction.value, 20_000n)
  const outer = decodeFunctionData({ abi: clSwapRouterAbi, data: transaction.data })
  assert.equal(outer.functionName, 'multicall')
  const swap = decodeFunctionData({ abi: clSwapRouterAbi, data: outer.args[0][0] })
  assert.equal(swap.functionName, 'exactInputSingle')
  assert.deepEqual(swap.args[0], {
    tokenIn: ADDR.WETH,
    tokenOut,
    tickSpacing: 200,
    recipient: zeroAddress,
    deadline: 123n,
    amountIn: 20_000n,
    amountOutMinimum: grossMinimum,
    sqrtPriceLimitX96: 0n,
  })
  const settle = decodeFunctionData({ abi: clSwapRouterAbi, data: outer.args[0][1] })
  assert.equal(settle.functionName, 'sweepTokenWithFee')
  assert.deepEqual(settle.args, [tokenOut, grossMinimum, recipient, 9n, feeReceiver])
})

test('zero-fee Uniswap swap settles through plain sweepToken, no fee args', () => {
  const grossMinimum = grossMinimumForNet(10_000n, 0)
  const transaction = buildDirectTransaction({
    tokenIn,
    tokenOut,
    amountIn: 20_000n,
    minimumAmountOut: 10_000n,
    recipient,
    deadline: 123n,
    route: { protocol: 'uniswap', kind: 'v2', feePpm: 3000 },
    fee: { bps: 0, receiver: feeReceiver },
  })

  const outer = decodeFunctionData({ abi: uniSwapRouterAbi, data: transaction.data })
  assert.equal(outer.functionName, 'multicall')
  const settle = decodeFunctionData({ abi: uniSwapRouterAbi, data: outer.args[1][1] })
  assert.equal(settle.functionName, 'sweepToken')
  assert.deepEqual(settle.args, [tokenOut, grossMinimum, recipient])
})

test('zero-fee CL native output unwraps through plain unwrapWETH9, no fee args', () => {
  const grossMinimum = grossMinimumForNet(10_000n, 0)
  const transaction = buildDirectTransaction({
    tokenIn,
    tokenOut: NATIVE,
    amountIn: 20_000n,
    minimumAmountOut: 10_000n,
    recipient,
    deadline: 123n,
    route: { protocol: 'up33', kind: 'cl', tickSpacing: 200, feePpm: 10_000 },
    fee: { bps: 0, receiver: feeReceiver },
  })

  const outer = decodeFunctionData({ abi: clSwapRouterAbi, data: transaction.data })
  assert.equal(outer.functionName, 'multicall')
  const settle = decodeFunctionData({ abi: clSwapRouterAbi, data: outer.args[0][1] })
  assert.equal(settle.functionName, 'unwrapWETH9')
  assert.deepEqual(settle.args, [grossMinimum, recipient])
})

test('rejects routes that do not belong to a supported direct protocol shape', () => {
  const base = {
    tokenIn,
    tokenOut,
    amountIn: 20_000n,
    minimumAmountOut: 10_000n,
    recipient,
    deadline: 123n,
    fee,
  }
  assert.throws(
    () =>
      buildDirectTransaction({
        ...base,
        route: { protocol: 'up33', kind: 'v2', feePpm: 3000 } as unknown as DirectRoute,
      }),
    /Unsupported direct route/,
  )
  // a 100% CL fee makes the fee-free baseline divide by zero — up33 reads its
  // fee live off the pool, so this is the only route fee that is not a constant
  assert.throws(
    () =>
      buildDirectTransaction({
        ...base,
        route: { protocol: 'up33', kind: 'cl', tickSpacing: 200, feePpm: 1_000_000 },
      }),
    /Unsupported direct route/,
  )
  assert.throws(
    () =>
      buildDirectTransaction({
        ...base,
        route: { protocol: 'uniswap', kind: 'v3', feePpm: 2500 } as unknown as DirectRoute,
      }),
    /Unsupported direct route/,
  )
})
