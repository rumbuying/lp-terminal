import assert from 'node:assert/strict'
import test from 'node:test'
import type { Address, Hex } from 'viem'
import { preflightSolverTransaction } from './solverPreflight'

const account = '0x0000000000000000000000000000000000000001' as Address
const tx = {
  requiredFrom: account,
  to: '0x0000000000000000000000000000000000000002' as Address,
  data: '0x1234' as Hex,
  value: 7n,
}

test('preflights the exact solver transaction and adds 20% gas headroom', async () => {
  let request: unknown
  const client = {
    estimateGas: async (next: unknown) => {
      request = next
      return 101n
    },
  }

  assert.equal(await preflightSolverTransaction(client, account, tx), 122n)
  assert.deepEqual(request, { account, to: tx.to, data: tx.data, value: tx.value })
})

test('fails closed when the solver transaction preflight reverts', async () => {
  const failure = new Error('execution reverted')
  const client = {
    estimateGas: async () => {
      throw failure
    },
  }

  await assert.rejects(preflightSolverTransaction(client, account, tx), failure)
})

test('accepts the current production transaction shape without requiredFrom', async () => {
  const { requiredFrom: _futureField, ...productionTx } = tx
  let request: unknown
  const client = {
    estimateGas: async (next: unknown) => {
      request = next
      return 100n
    },
  }

  assert.equal(await preflightSolverTransaction(client, account, productionTx), 120n)
  assert.deepEqual(request, { account, to: tx.to, data: tx.data, value: tx.value })
})

test('rejects calldata when the submitting account differs from requiredFrom', async () => {
  let estimated = false
  const client = {
    estimateGas: async () => {
      estimated = true
      return 1n
    },
  }
  const another = '0x0000000000000000000000000000000000000003' as Address

  await assert.rejects(
    preflightSolverTransaction(client, another, tx),
    /bound to a different submitting account/,
  )
  assert.equal(estimated, false)
})
