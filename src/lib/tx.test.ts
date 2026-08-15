import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { ExecutionRevertedError, UserRejectedRequestError } from 'viem'
import type { Address, Hex, ReplacementReason, TransactionReceipt } from 'viem'

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
let active: Address | undefined = '0x0000000000000000000000000000000000000001'
let accountMessage = 'account changed (en)'
const invalidations: Array<{ predicate?: (query: { queryKey: readonly unknown[] }) => boolean }> = []

mock.module('wagmi/actions', {
  namedExports: {
    getAccount: () => ({ address: active }),
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
  namedExports: {
    queryClient: {
      invalidateQueries: async (options: { predicate?: (query: { queryKey: readonly unknown[] }) => boolean }) => {
        invalidations.push(options)
      },
    },
    shouldInvalidateAfterTransaction: () => true,
  },
})
mock.module('../i18n', {
  namedExports: { t: (key: string) => (key === 'tx.accountChanged' ? accountMessage : key) },
})

const { accountChangedMessage, activeAccountMatches, shouldInvalidateForTransaction, step } = await import('./tx')
const { txlog } = await import('./txlog')

test('accountChangedMessage resolves the active language lazily', () => {
  accountMessage = 'account changed (en)'
  assert.equal(accountChangedMessage(), 'account changed (en)')
  accountMessage = '账户已切换 (zh)'
  assert.equal(accountChangedMessage(), '账户已切换 (zh)')
})

test('activeAccountMatches rejects a disconnected or changed wallet account', () => {
  const planned = '0x0000000000000000000000000000000000000001' as Address
  active = planned
  assert.equal(activeAccountMatches(planned), true)
  active = '0x0000000000000000000000000000000000000002'
  assert.equal(activeAccountMatches(planned), false)
  active = undefined
  assert.equal(activeAccountMatches(planned), false)
  active = planned
})

test('transaction invalidation is scoped and never includes public catalogs', () => {
  assert.equal(shouldInvalidateForTransaction(['balances', 56], 'balances'), true)
  assert.equal(shouldInvalidateForTransaction(['positions', 56], 'balances'), false)
  assert.equal(shouldInvalidateForTransaction(['solverQuote', 56], 'swap'), true)
  assert.equal(shouldInvalidateForTransaction(['positions', 56], 'liquidity'), true)
  assert.equal(shouldInvalidateForTransaction(['tickLiq', 'pool'], 'liquidity'), true)
  assert.equal(shouldInvalidateForTransaction(['uniPoolStats', 56, 'pool'], 'liquidity'), false)
  assert.equal(shouldInvalidateForTransaction(['uniPools', '', 1000, 'all'], 'liquidity'), false)
  assert.equal(shouldInvalidateForTransaction(['uniV4Pools', ''], 'liquidity'), false)
  assert.equal(shouldInvalidateForTransaction(['pools'], 'liquidity'), false)
})

test('step invalidates only after success and honors an explicit none scope', async () => {
  invalidations.length = 0
  wait = async () => {
    throw new Error('rpc unavailable')
  }
  assert.equal(await step('failed', async () => hash(1)), null)
  assert.equal(invalidations.length, 0)

  wait = async () => receipt(hash(1))
  assert.ok(await step('approval', async () => hash(1), { invalidate: 'none' }))
  assert.equal(invalidations.length, 0)

  assert.ok(await step('swap', async () => hash(1), { invalidate: 'swap' }))
  assert.equal(invalidations.length, 1)
  assert.equal(invalidations[0].predicate?.({ queryKey: ['solverQuote', 56] }), true)
  assert.equal(invalidations[0].predicate?.({ queryKey: ['positions', 56] }), false)
})

test('a broadcast transaction whose watcher died is logged as sent, not failed', async () => {
  txlog.clear()
  wait = async () => {
    throw new Error('rpc unavailable')
  }
  let failure: string | null = null
  const lost = await step('swap', async () => hash(7), {
    onFail: (why) => {
      failure = why
    },
  })
  const sent = txlog.get().at(-1)
  assert.equal(sent?.kind, 'info', 'the hash is on the network — calling it failed invites a second send')
  assert.equal(sent?.hash, hash(7))
  assert.equal(sent?.text, 'tx.unwatched')
  assert.equal(lost, null, 'the flow above still stops: this step has no receipt to hand it')
  assert.equal(failure, 'error')

  // nothing broadcast — the failure is the whole story, and stays red
  const never = await step('swap', async () => {
    throw new Error('user rejected the request')
  })
  const line = txlog.get().at(-1)
  assert.equal(never, null)
  assert.equal(line?.kind, 'err')
  assert.equal(line?.hash, undefined)
})

test('a step stopped by a pre-flight revert is classified as reverted', async () => {
  const why: string[] = []
  const record = { onFail: (reason: string) => why.push(reason) }

  // the solver pre-flight runs the final calldata as an estimate; a revert there
  // is the chain's verdict on the trade, and the retry advice hangs on saying so
  await step('swap', async () => {
    throw new ExecutionRevertedError({})
  }, record)
  await step('swap', async () => {
    throw new UserRejectedRequestError(new Error('user rejected'))
  }, record)
  await step('swap', async () => {
    throw new Error('fetch failed')
  }, record)

  assert.deepEqual(why, ['reverted', 'rejected', 'error'])
})

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
