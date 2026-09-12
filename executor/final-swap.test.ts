import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'
import { zeroAddress, type Address } from 'viem'
import { NATIVE } from '../src/config/addresses'
import { Q96, applySlippage } from '../src/lib/clmath'
import type { StrategyConfig, StrategyPositionSnapshot } from '../shared/strategy/types'
import type { KyberRouteSummary } from './kyber'

const A = '0x0000000000000000000000000000000000000001' as Address
const B = '0x0000000000000000000000000000000000000002' as Address
const C = '0x0000000000000000000000000000000000000003' as Address
let amountOut = 10_000n, sqrt = Q96, spender = C
let identityOverride: Partial<KyberRouteSummary> = {}
let events: string[] = []
let nativeIn = false
mock.module('./chain', { namedExports: {
  readPoolState: async () => { events.push('pool'); return { sqrtPriceX96: sqrt } },
} })
mock.module('./kyber', { namedExports: {
  quoteKyber: async (tokenIn: Address, tokenOut: Address, amountIn: bigint) => {
    events.push('quote')
    return { routeSummary: { tokenIn, tokenOut, amountIn: amountIn.toString(), amountOut: amountOut.toString(), route: [], ...identityOverride } }
  },
  gatedKyberTx: async (args: { routeSummary: KyberRouteSummary; slippageBps: number; nativeIn: boolean }) => {
    events.push('build')
    nativeIn = args.nativeIn
    return { to: C, approvalTarget: spender, data: '0x', value: 0n, exactApproval: true,
      minOut: applySlippage(BigInt(args.routeSummary.amountOut), args.slippageBps) }
  },
} })
const { prepareFinalSwap, assertFinalSwapBounds } = await import('./final-swap')
const config = { owner: C, safeguards: { maxSlippageBps: 100, maxSwapImpactBps: 100, maxPlanAgeSeconds: 30 } } as StrategyConfig
const snapshot = { token0: A, token1: B } as StrategyPositionSnapshot
const prepare = (overrides: Partial<Parameters<typeof prepareFinalSwap>[0]> = {}) => prepareFinalSwap({
  config, snapshot, tokenIn: A, tokenOut: B, amountIn: 10_000n, slippageBps: 100, approvedTarget: C, ...overrides,
})
beforeEach(() => { amountOut = 10_000n; sqrt = Q96; spender = C; events = []; identityOverride = {}; nativeIn = false })

test('fresh quote, build and pool reference produce the same executable audit values', async () => {
  amountOut = 9_950n
  const result = await prepare()
  assert.deepEqual(events, ['quote', 'build', 'pool'])
  assert.equal(result.quote.routeSummary.amountOut, '9950')
  assert.equal(result.tx.minOut, 9_850n)
})

test('final quote deterioration and a moved pool fail the impact gate', async () => {
  amountOut = 9_899n
  await assert.rejects(prepare(), /E_SWAP_IMPACT/)
  amountOut = 10_000n
  sqrt = Q96 * 2n
  await assert.rejects(prepare(), /E_SWAP_IMPACT/)
})

test('changed spender or route identity fails before send', async () => {
  spender = A
  await assert.rejects(prepare(), /E_SWAP_SPENDER_CHANGED/)
  spender = C
  for (const override of [{ tokenIn: B }, { tokenOut: A }, { amountIn: '9999' }]) {
    identityOverride = override
    await assert.rejects(prepare(), /E_KYBER_IDENTITY/)
  }
})

test('recovery escalation widens the execution floor within the 10% cap, never the impact leg', async () => {
  // A spot quote with an escalated minOut must be sendable: the ladder's whole
  // purpose is re-quoting at a wider minOut after consecutive reverts. With
  // the old base-slippage floor this exact shape (streak 2 → 400 bps) threw
  // E_SWAP_IMPACT pre-send on every later attempt and wedged the recovery.
  await prepare({ slippageBps: 400 })
  await prepare({ slippageBps: 1000 })
  // Slippage past the escalation cap stays invalid…
  await assert.rejects(prepare({ slippageBps: 1001 }), /E_SWAP_SLIPPAGE/)
  // …and the impact leg stays absolute: a deteriorated quote is refused even
  // with escalated tolerance, because the market itself is the problem.
  amountOut = 9_899n
  await assert.rejects(prepare({ slippageBps: 400 }), /E_SWAP_IMPACT/)
})

test('native currency sentinel is normalized to the pool reference', async () => {
  await prepare({ tokenIn: zeroAddress, snapshot: { ...snapshot, token0: zeroAddress } })
  assert.equal(nativeIn, true)
  identityOverride = { tokenIn: NATIVE }
  await prepare({ tokenIn: NATIVE, snapshot: { ...snapshot, token0: zeroAddress } })
})

test('cross-token swaps do not invent a reference from an unrelated pool', async () => {
  await prepare({ tokenOut: C })
  assert.deepEqual(events, ['quote', 'build'])
})

test('invalid or insufficient minOut is rejected even without an impact reference', () => {
  const base = { amountOut: 10_000n, minOut: 9_900n, slippageBps: 100, baseSlippageBps: 100 }
  assertFinalSwapBounds(base)
  for (const minOut of [0n, 9_899n, 10_001n]) assert.throws(() => assertFinalSwapBounds({ ...base, minOut }), /E_SWAP_MIN_OUT/)
  for (const slippageBps of [-1, 1001, NaN, 1.5]) assert.throws(() => assertFinalSwapBounds({ ...base, slippageBps }), /E_SWAP_SLIPPAGE/)
})

test('raw-unit rounding cannot undercut a configured zero-impact floor', () => {
  assert.throws(() => assertFinalSwapBounds({ amountOut: 101n, minOut: 99n, slippageBps: 100,
    baseSlippageBps: 100, maxImpactBps: 0, referenceOut: 101n }), /E_SWAP_IMPACT/)
})

test('the live CASHCAT wedge shape is admissible: near-spot quote at 400 bps escalation', () => {
  // spot reference 10_000; quote 26 bps below spot (the healthy re-quote);
  // streak 2 → escalated slippage 400 bps, base policy 100 bps.
  const referenceOut = 10_000n
  const amountOut = 9_974n
  const minOut = applySlippage(amountOut, 400)
  assertFinalSwapBounds({ amountOut, minOut, slippageBps: 400, baseSlippageBps: 100, maxImpactBps: 150, referenceOut })
  // At the escalation cap (1000 bps) the widest legal minOut still passes…
  assertFinalSwapBounds({ amountOut, minOut: applySlippage(amountOut, 1000), slippageBps: 1000, baseSlippageBps: 100, maxImpactBps: 150, referenceOut })
  // …while an execution floor below the effective tolerance is still refused.
  assert.throws(() => assertFinalSwapBounds({ amountOut, minOut: applySlippage(amountOut, 400) - 1n,
    slippageBps: 400, baseSlippageBps: 100, maxImpactBps: 150, referenceOut }), /E_SWAP_MIN_OUT/)
})
