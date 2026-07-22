import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { Hex, ReplacementReason, TransactionReceipt } from 'viem'

type WaitOptions = {
  onReplaced?: (event: {
    reason: ReplacementReason
    replacedTransaction: { hash: Hex }
    transaction: { hash: Hex }
  }) => void
}

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex
const receipt = (transactionHash: Hex): TransactionReceipt =>
  ({ transactionHash, status: 'success', blockNumber: 1n, logs: [] }) as unknown as TransactionReceipt

let wait = async (_options: WaitOptions): Promise<TransactionReceipt> => receipt(hash(1))

mock.module('wagmi/actions', {
  namedExports: {
    readContract: async () => {
      throw new Error('unexpected readContract')
    },
    writeContract: async () => {
      throw new Error('unexpected writeContract')
    },
    waitForTransactionReceipt: async (_config: unknown, options: WaitOptions) => wait(options),
  },
})
mock.module('../config/wagmi', { namedExports: { wagmiConfig: {} } })
mock.module('../config/query', {
  namedExports: { queryClient: { invalidateQueries: async () => {} } },
})
mock.module('../i18n', { namedExports: { t: (key: string) => key } })

const { step } = await import('./tx')

test('step keeps tracking after observer errors and classifies replacements', async () => {
  wait = async () => receipt(hash(1))
  const submitted = await step('swap', async () => hash(1), {
    onSubmitted: () => {
      throw new Error('storage observer failed')
    },
  })
  assert.equal(submitted?.transactionHash, hash(1))

  let replacement: [Hex, Hex, ReplacementReason] | null = null
  wait = async (options) => {
    options.onReplaced?.({
      reason: 'repriced',
      replacedTransaction: { hash: hash(1) },
      transaction: { hash: hash(2) },
    })
    return receipt(hash(2))
  }
  const repriced = await step('swap', async () => hash(1), {
    onReplaced: (oldHash, newHash, reason) => {
      replacement = [oldHash, newHash, reason]
    },
  })
  assert.equal(repriced?.transactionHash, hash(2))
  assert.deepEqual(replacement, [hash(1), hash(2), 'repriced'])

  let failure: string | null = null
  wait = async (options) => {
    options.onReplaced?.({
      reason: 'cancelled',
      replacedTransaction: { hash: hash(3) },
      transaction: { hash: hash(4) },
    })
    return receipt(hash(4))
  }
  const cancelled = await step('swap', async () => hash(3), {
    onFail: (why) => {
      failure = why
    },
  })
  assert.equal(cancelled, null)
  assert.equal(failure, 'rejected')
})
