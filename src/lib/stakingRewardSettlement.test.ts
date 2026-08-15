import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { Address, Hex, TransactionReceipt } from 'viem'
import { ADDR } from '../config/addresses'

const owner = '0x0000000000000000000000000000000000000001' as Address
const gauge = '0x0000000000000000000000000000000000000002' as Address
const quoteToken = '0x0000000000000000000000000000000000000003' as Address
const router = '0x0000000000000000000000000000000000000004' as Address
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex
const receipt = (n: number) => ({ transactionHash: hash(n), status: 'success', blockNumber: 1n, logs: [] }) as unknown as TransactionReceipt

const balances: Record<string, bigint> = {
  [ADDR.UP.toLowerCase()]: 0n,
  [ADDR.WETH.toLowerCase()]: 0n,
  [quoteToken.toLowerCase()]: 0n,
}
const deltas = new Map<string, Record<string, bigint>>()
const sent: { stepIndex: number; txIndex: number }[] = []
const storedReceipts = new Map<Hex, TransactionReceipt>()
const transactionRows: { step_index: number; tx_index: number; state: string; tx_hash: Hex }[] = []
let context: Record<string, unknown> | undefined
let unstaked = false

mock.module('../../executor/chain', {
  namedExports: {
    publicClient: {
      getTransactionReceipt: async ({ hash: transactionHash }: { hash: Hex }) => storedReceipts.get(transactionHash)!,
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'ownerOf') return unstaked ? owner : gauge
        if (functionName === 'stakedValues') return unstaked ? [] : [1n]
        throw new Error(`unexpected read ${functionName}`)
      },
    },
    readTokenBalances: async (_owner: Address, tokens: Address[]) => Object.fromEntries(tokens.map((token) => [token.toLowerCase(), balances[token.toLowerCase()] ?? 0n])),
  },
})
mock.module('../../executor/allowance', {
  namedExports: {
    grantStrategyAllowance: async () => [],
    revokeStrategyAllowance: async () => [],
  },
})
mock.module('../../executor/reward', {
  namedExports: {
    quoteRewardToWeth: async (amountIn: bigint) => ({ routeSummary: { tokenIn: ADDR.UP, tokenOut: ADDR.WETH, amountIn: amountIn.toString(), amountOut: amountIn.toString(), route: [[]] } }),
  },
})
mock.module('../../executor/kyber', {
  namedExports: {
    quoteWithNativeFallback: async (_tokenIn: Address, _tokenOut: Address, amountIn: bigint) => ({ routeSummary: { tokenIn: ADDR.WETH, tokenOut: quoteToken, amountIn: amountIn.toString(), amountOut: '90', route: [[]] } }),
    gatedKyberTx: async ({ tokenIn, tokenOut }: { tokenIn: Address; tokenOut: Address }) => ({ to: router, data: '0x' as Hex, value: 0n, minOut: tokenIn.toLowerCase() === ADDR.UP.toLowerCase() ? 100n : 90n, tokenOut }),
  },
})
mock.module('../../executor/receipts', {
  namedExports: {
    receiptTokenDelta: (value: TransactionReceipt, token: Address) => deltas.get(value.transactionHash)?.[token.toLowerCase()] ?? 0n,
  },
})
mock.module('../../executor/signer', {
  namedExports: {
    sendTracked: async ({ stepIndex, txIndex = 0 }: { stepIndex: number; txIndex?: number }) => {
      sent.push({ stepIndex, txIndex })
      let value: TransactionReceipt
      if (stepIndex === 12) {
        unstaked = true
        balances[ADDR.UP.toLowerCase()] = 100n
        value = receipt(1)
        deltas.set(value.transactionHash, { [ADDR.UP.toLowerCase()]: 100n })
      } else if (stepIndex === 14 && txIndex === 0) {
        balances[ADDR.UP.toLowerCase()] = 0n
        balances[ADDR.WETH.toLowerCase()] = 100n
        value = receipt(2)
        deltas.set(value.transactionHash, { [ADDR.UP.toLowerCase()]: -100n, [ADDR.WETH.toLowerCase()]: 100n })
      } else if (stepIndex === 14 && txIndex === 1) {
        balances[ADDR.WETH.toLowerCase()] = 0n
        balances[quoteToken.toLowerCase()] = 90n
        value = receipt(3)
        deltas.set(value.transactionHash, { [ADDR.WETH.toLowerCase()]: -100n, [quoteToken.toLowerCase()]: 90n })
      } else throw new Error('unexpected transaction')
      storedReceipts.set(value.transactionHash, value)
      transactionRows.push({ step_index: stepIndex, tx_index: txIndex, state: 'confirmed', tx_hash: value.transactionHash })
      return value
    },
  },
})
mock.module('../../executor/steps', {
  namedExports: {
    nftApprovalCall: () => ({}),
    nftOperatorApprovalCall: () => ({}),
    stakeCall: () => ({}),
    unstakeCall: () => ({}),
  },
})
mock.module('../../executor/store', {
  namedExports: {
    getJobContext: () => context,
    jobTransactions: () => transactionRows,
    markStep: () => {},
    nextTransactionIndex: () => 0,
    setJobContext: (_jobId: string, _key: string, value: Record<string, unknown>) => { context = value },
  },
})

const { ensureUnstakedAndRewardConverted } = await import('../../executor/staking')

test('settles a staking reward through WETH into a non-WETH strategy quote token', async () => {
  const job = {
    id: 'job-two-hop',
    config: {
      owner,
      quoteToken,
      positionManager: '0x0000000000000000000000000000000000000005',
      activeTokenId: '1',
      staking: { enabled: true, gauge },
      safeguards: { maxSlippageBps: 100 },
      execution: { lowTransactionMode: false },
    },
  } as any
  const result = await ensureUnstakedAndRewardConverted(job, hash(99))
  assert.deepEqual(sent, [{ stepIndex: 12, txIndex: 0 }, { stepIndex: 14, txIndex: 0 }, { stepIndex: 14, txIndex: 1 }])
  assert.equal(result.rewardUp, 100n)
  assert.equal(result.rewardWeth, 100n)
  assert.equal(result.rewardQuote, 90n)
  assert.equal(result.quotedQuote, 90n)
  assert.equal(context?.settlementToken, quoteToken)
  assert.equal(context?.quoteSwapTxHash, hash(3))

  const replayed = await ensureUnstakedAndRewardConverted(job, hash(99))
  assert.equal(replayed.rewardQuote, 90n)
  assert.deepEqual(sent, [{ stepIndex: 12, txIndex: 0 }, { stepIndex: 14, txIndex: 0 }, { stepIndex: 14, txIndex: 1 }])
})
