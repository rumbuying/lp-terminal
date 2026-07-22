import assert from 'node:assert/strict'
import test from 'node:test'
import type { Address, PublicClient } from 'viem'
import { previewV2ClaimFees } from './v2Fees'

const pool = '0x0000000000000000000000000000000000000001' as Address
const user = '0x0000000000000000000000000000000000000002' as Address

test('previews materialized V2 fees as the LP owner', async () => {
  let request: Record<string, unknown> | undefined
  const client = {
    simulateContract: async (next: Record<string, unknown>) => {
      request = next
      return { result: [11n, 22n] as const }
    },
  } as unknown as PublicClient

  assert.deepEqual(await previewV2ClaimFees(client, pool, user, [0n, 0n]), [11n, 22n])
  assert.equal(request?.address, pool)
  assert.equal(request?.functionName, 'claimFees')
  assert.equal(request?.account, user)
})

test('keeps getter fees when the V2 preview fails', async () => {
  const client = {
    simulateContract: async () => {
      throw new Error('rpc unavailable')
    },
  } as unknown as PublicClient

  assert.deepEqual(await previewV2ClaimFees(client, pool, user, [3n, 4n]), [3n, 4n])
})

test('trusts a successful zero V2 preview over stale getters', async () => {
  const client = {
    simulateContract: async () => ({ result: [0n, 0n] as const }),
  } as unknown as PublicClient

  assert.deepEqual(await previewV2ClaimFees(client, pool, user, [3n, 4n]), [0n, 0n])
})
