import assert from 'node:assert/strict'
import test from 'node:test'
import type { Address, Hex } from 'viem'
import { preflightSolverTransaction } from './solverPreflight'

const account = '0x0000000000000000000000000000000000000001' as Address
const tx = {
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
