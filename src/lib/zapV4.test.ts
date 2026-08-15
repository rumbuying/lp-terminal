import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { zeroAddress, type Address, type Hex, type TransactionReceipt } from 'viem'
import { ADDR, NATIVE } from '../config/addresses'
import { CHAIN } from '../config/chains'
import type { ClPool, TokenInfo } from '../types'
import { v4PoolId, type V4PoolKey } from './uniV4'
import type { ZapPlan, ZapTarget } from './zap'

type ContractRequest = {
  account?: Address
  functionName?: string
  args?: readonly unknown[]
  value?: bigint
}

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex
const receipt = (transactionHash: Hex): TransactionReceipt =>
  ({ transactionHash, status: 'success', blockNumber: 1n, logs: [] }) as unknown as TransactionReceipt

let active: Address | undefined
let writes: ContractRequest[] = []
let nextHash = 1
let afterReceipt: (() => void) | null = null
let read = async (_request: ContractRequest): Promise<unknown> => {
  throw new Error('unexpected readContract')
}

mock.module('wagmi/actions', {
  namedExports: {
    getAccount: () => ({ address: active }),
    readContract: async (_config: unknown, request: ContractRequest) => read(request),
    writeContract: async (_config: unknown, request: ContractRequest) => {
      writes.push(request)
      return hash(nextHash++)
    },
    waitForTransactionReceipt: async (_config: unknown, options: { hash: Hex }) => {
      const result = receipt(options.hash)
      afterReceipt?.()
      return result
    },
    sendTransaction: async () => {
      throw new Error('unexpected sendTransaction')
    },
    getPublicClient: () => {
      throw new Error('unexpected getPublicClient')
    },
  },
})
mock.module('../config/wagmi', { namedExports: { wagmiConfig: {} } })
mock.module('../config/query', {
  namedExports: {
    queryClient: { invalidateQueries: async () => {} },
    shouldInvalidateAfterTransaction: () => true,
  },
})

mock.module('../i18n', { namedExports: { t: (key: string) => key } })
// The module is loaded after Node's mocks because zap's executor imports wagmi
// eagerly; static import would evaluate the real browser-only config first.
const { executeZap, v4ZapUnwrapAmount, zapFundingFor, zapStages, zapSwapOutputToken } = await import('./zap')
const { v4Deposit } = await import('./uniV4Write')

const onlyBsc = { skip: CHAIN.key !== 'bsc' }

const TOKEN = '0x55d398326f99059fF775485246999027B3197955' as Address
const MANAGER = '0x0000000000000000000000000000000000000001' as Address
const USER = '0x00000000000000000000000000000000000000A1' as Address
const OTHER = '0x00000000000000000000000000000000000000B2' as Address
const key: V4PoolKey = {
  currency0: zeroAddress,
  currency1: TOKEN,
  fee: 500,
  tickSpacing: 10,
  hooks: zeroAddress,
}
const pool: ClPool = {
  kind: 'cl',
  protocol: 'univ4',
  address: MANAGER,
  poolId: v4PoolId(key),
  hooks: key.hooks,
  token0: key.currency0,
  token1: key.currency1,
  tickSpacing: key.tickSpacing,
  feePpm: key.fee,
  unstakedFeePpm: 0,
  sqrtPriceX96: 1n << 96n,
  tick: 0,
  liquidity: 1_000_000n,
  stakedLiquidity: 0n,
  gauge: null,
  gaugeAlive: false,
  weight: 0n,
  rewardRate: 0n,
  periodFinish: 0n,
}
const target: ZapTarget = {
  kind: 'cl-increase',
  pool,
  tickLower: -100,
  tickUpper: 100,
  tokenId: 42n,
  npm: MANAGER,
}
const nativeToken: TokenInfo = { address: zeroAddress, symbol: 'BNB', decimals: 18, native: true }
const token: TokenInfo = { address: TOKEN, symbol: 'USDT', decimals: 18 }

function plan(overrides: Partial<ZapPlan>): ZapPlan {
  return {
    tokenIn: NATIVE,
    nativeIn: true,
    swapTokenIn: NATIVE,
    wrapInput: false,
    inIs0: true,
    amountIn: 100n,
    keep: 60n,
    legs: [
      {
        buyIs0: false,
        swapIn: 40n,
        via: { via: 'solver', routeLabel: 'solver', venueFeeBps: 0 },
        estOut: 40n,
        impactBps: 1,
      },
    ],
    dep0: 60n,
    dep1: 40n,
    liquidity: 1n,
    dust0: 0n,
    dust1: 0n,
    impactBps: 1,
    ...overrides,
  }
}

function resetWrites() {
  active = USER
  writes = []
  nextHash = 1
  afterReceipt = null
  read = async (request) => {
    if (request.functionName === 'getSlot0') return [1n << 96n, 0, 0, 500] as const
    throw new Error(`unexpected readContract ${request.functionName}`)
  }
}

test('native-keyed v4 funding keeps BNB native and treats WBNB as the same pool side', () => {
  assert.deepEqual(zapFundingFor(pool, NATIVE), {
    nativeIn: true,
    wrapInput: false,
    swapTokenIn: NATIVE,
    inIs0: true,
  })
  assert.deepEqual(zapFundingFor(pool, ADDR.WNATIVE), {
    nativeIn: false,
    wrapInput: false,
    swapTokenIn: ADDR.WNATIVE,
    inIs0: true,
  })
})

test('a swap buying a native v4 currency requests WNATIVE so receipt accounting is exact', () => {
  assert.equal(zapSwapOutputToken(pool, true), ADDR.WNATIVE)
  assert.equal(zapSwapOutputToken(pool, false), TOKEN)
})

test('only WNATIVE amounts destined for the native pool side are unwrapped', () => {
  assert.equal(v4ZapUnwrapAmount(plan({}), pool, [0n, 40n]), 0n, 'kept native BNB is already depositable')
  assert.equal(
    v4ZapUnwrapAmount(
      plan({ tokenIn: ADDR.WNATIVE, nativeIn: false, swapTokenIn: ADDR.WNATIVE }),
      pool,
      [0n, 40n],
    ),
    60n,
    'kept WBNB must become BNB',
  )
  assert.equal(
    v4ZapUnwrapAmount(
      plan({
        tokenIn: TOKEN,
        nativeIn: false,
        swapTokenIn: TOKEN,
        inIs0: false,
        keep: 70n,
        legs: [{ buyIs0: true, swapIn: 30n, via: { via: 'solver', routeLabel: 'solver', venueFeeBps: 0 }, estOut: 25n, impactBps: 1 }],
        dep0: 25n,
        dep1: 70n,
      }),
      pool,
      [23n, 0n],
    ),
    23n,
    'the confirmed WBNB output, not its quote, is unwrapped',
  )
})

test('v4 stages unwrap before approvals and never approve the native currency', () => {
  const wrappedPlan = plan({ tokenIn: ADDR.WNATIVE, nativeIn: false, swapTokenIn: ADDR.WNATIVE })
  assert.deepEqual(
    zapStages(wrappedPlan, target, { ...nativeToken, address: ADDR.WNATIVE, native: false }, nativeToken, token).map(
      (stage) => stage.kind,
    ),
    ['swap', 'unwrap', 'approve1', 'deposit'],
  )
  assert.deepEqual(zapStages(plan({}), target, nativeToken, nativeToken, token).map((stage) => stage.kind), [
    'swap',
    'approve1',
    'deposit',
  ])
})

test('v4 modifyLiquidities is pinned to the planned account', onlyBsc, async () => {
  resetWrites()
  const result = await v4Deposit({
    target: { kind: 'cl-mint', pool, tickLower: 100, tickUpper: 200 },
    user: USER,
    amount0: 10n ** 18n,
    amount1: 0n,
    symbol0: 'BNB',
    symbol1: 'USDT',
    label: 'mint',
  })
  assert.ok(result)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].functionName, 'modifyLiquidities')
  assert.equal(writes[0].account, USER)
})

test('a WBNB zap pins withdraw and stops before deposit after an account change', onlyBsc, async () => {
  resetWrites()
  // Simulate the wallet changing accounts while the unwrap receipt is pending.
  afterReceipt = () => {
    active = OTHER
    afterReceipt = null
  }
  const singleTarget: ZapTarget = {
    kind: 'cl-increase',
    pool,
    tickLower: 100,
    tickUpper: 200,
    tokenId: 42n,
    npm: MANAGER,
  }
  const wrapped = plan({
    tokenIn: ADDR.WNATIVE,
    nativeIn: false,
    swapTokenIn: ADDR.WNATIVE,
    inIs0: true,
    amountIn: 10n ** 18n,
    keep: 10n ** 18n,
    legs: [],
    dep0: 10n ** 18n,
    dep1: 0n,
    impactBps: null,
  })
  const result = await executeZap({
    plan: wrapped,
    target: singleTarget,
    user: USER,
    slipBps: 0,
    stake: false,
    tIn: { address: ADDR.WNATIVE, symbol: 'WBNB', decimals: 18 },
    t0: nativeToken,
    t1: token,
  })
  assert.equal(result.ok, false)
  assert.equal(writes.length, 1, 'account drift must halt before modifyLiquidities')
  assert.equal(writes[0].functionName, 'withdraw')
  assert.equal(writes[0].account, USER)
})
