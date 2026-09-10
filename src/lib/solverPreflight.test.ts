import assert from 'node:assert/strict'
import test from 'node:test'
import type { Address, Hex } from 'viem'
import { assertGenuineSolverSettler, preflightSolverTransaction, ZERO_EX_SETTLER_REGISTRY } from './solverPreflight'

const account = '0x0000000000000000000000000000000000000001' as Address
const tx = {
  requiredFrom: account,
  to: '0x0000000000000000000000000000000000000002' as Address,
  data: '0x1234' as Hex,
  value: 7n,
}
const settler = '0x0000000000000000000000000000000000000004' as Address
const registryClient = (estimateGas: (next: unknown) => Promise<bigint>, current: Address = settler, previous: Address = account) => ({
  estimateGas,
  readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args: bigint[] }) => {
    assert.equal(address, ZERO_EX_SETTLER_REGISTRY)
    assert.deepEqual(args, [2n])
    return functionName === 'ownerOf' ? current : previous
  },
})

test('preflights the exact solver transaction and adds 20% gas headroom', async () => {
  let request: unknown
  const client = registryClient(async (next: unknown) => {
      request = next
      return 101n
    })

  assert.equal(await preflightSolverTransaction(client, account, tx, settler), 122n)
  assert.deepEqual(request, { account, to: tx.to, data: tx.data, value: tx.value })
})

test('fails closed when the solver transaction preflight reverts', async () => {
  const failure = new Error('execution reverted')
  const client = registryClient(async () => {
      throw failure
    })

  await assert.rejects(preflightSolverTransaction(client, account, tx, settler), failure)
})

test('accepts the current production transaction shape without requiredFrom', async () => {
  const { requiredFrom: _futureField, ...productionTx } = tx
  let request: unknown
  const client = registryClient(async (next: unknown) => {
      request = next
      return 100n
    })

  assert.equal(await preflightSolverTransaction(client, account, productionTx, settler), 120n)
  assert.deepEqual(request, { account, to: tx.to, data: tx.data, value: tx.value })
})

test('rejects calldata when the submitting account differs from requiredFrom', async () => {
  let estimated = false
  const client = registryClient(async () => {
      estimated = true
      return 1n
    })
  const another = '0x0000000000000000000000000000000000000003' as Address

  await assert.rejects(
    preflightSolverTransaction(client, another, tx, settler),
    /bound to a different submitting account/,
  )
  assert.equal(estimated, false)
})

test('accepts the current or immediately previous registry Settler', async () => {
  const other = '0x0000000000000000000000000000000000000005' as Address
  await assertGenuineSolverSettler(registryClient(async () => 1n), settler)
  await assertGenuineSolverSettler(registryClient(async () => 1n, other, settler), settler)
})

test('rejects counterfeit, paused, or unavailable Settler registry state', async () => {
  const other = '0x0000000000000000000000000000000000000005' as Address
  await assert.rejects(assertGenuineSolverSettler(registryClient(async () => 1n, other, account), settler), /counterfeit/)
  await assert.rejects(assertGenuineSolverSettler({ readContract: async () => { throw new Error('paused') } }, settler), /unavailable or paused/)
})
