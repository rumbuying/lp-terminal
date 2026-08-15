import assert from 'node:assert/strict'
import test from 'node:test'
import type { Address, PublicClient } from 'viem'
import { connectorCandidates, V2_SWEEP_VENUES } from './v2Pairs'
import { fetchV2FarmPositions, resetFarmPools, type V2Farm } from './v2Farm'

const home = V2_SWEEP_VENUES.find((venue) => venue.protocol === 'home')
const farmTest = home ? test : test.skip

farmTest('farm discovery walks every pid once, then reads only known non-zero pids', async () => {
  resetFarmPools()
  const candidates = connectorCandidates().filter(
    (candidate) => candidate.venue.protocol === 'home',
  )
  assert.ok(candidates.length >= 2)
  const pools = candidates.slice(0, 2)
  const userInfoPids: number[] = []
  let failNextKnownPid = false

  const pc = {
    multicall: async ({ contracts }: { contracts: readonly any[] }) =>
      contracts.map((call) => {
        const success = (result: unknown) => ({ status: 'success' as const, result })
        const pid = Number(call.args?.[0] ?? 0n)
        if (call.functionName === 'poolLength') return success(2n)
        if (call.functionName === 'lpToken') return success(pools[pid].address)
        const pool = pools.find(
          (candidate) => candidate.address.toLowerCase() === call.address.toLowerCase(),
        )
        if (call.functionName === 'token0') return success(pool?.token0)
        if (call.functionName === 'token1') return success(pool?.token1)
        if (call.functionName === 'userInfo') {
          userInfoPids.push(pid)
          if (failNextKnownPid && pid === 0) {
            failNextKnownPid = false
            return { status: 'failure' as const }
          }
          return success([pid === 0 ? 10n : 0n, 0n])
        }
        if (call.functionName === 'getReserves') return success([1_000n, 2_000n, 0])
        if (call.functionName === 'totalSupply') return success(100n)
        if (call.functionName === 'pendingCake') return success(5n)
        if (call.functionName === 'symbol') return success('TOKEN')
        if (call.functionName === 'decimals') return success(18)
        return { status: 'failure' as const }
      }),
  } as unknown as PublicClient
  const farm: V2Farm = {
    address: '0x000000000000000000000000000000000000Fa01' as Address,
    reward: { symbol: 'CAKE', decimals: 18 },
  }
  const user = '0x0000000000000000000000000000000000000a11' as Address

  const first = await fetchV2FarmPositions(pc, user, farm)
  const second = await fetchV2FarmPositions(pc, user, farm)
  failNextKnownPid = true
  await assert.rejects(
    fetchV2FarmPositions(pc, user, farm),
    /failed to refresh a known farm position/,
  )
  const recovered = await fetchV2FarmPositions(pc, user, farm)
  resetFarmPools()
  const afterReset = await fetchV2FarmPositions(pc, user, farm)

  assert.equal(first.v2.length, 1)
  assert.equal(second.v2.length, 1)
  assert.equal(recovered.v2.length, 1, 'a failed pid read must remain known and retry')
  assert.equal(afterReset.v2.length, 1)
  assert.deepEqual(
    userInfoPids,
    [0, 1, 0, 0, 0, 0, 1],
    'reset invalidates both the immutable farm map and per-wallet pid discovery',
  )
  resetFarmPools()
})
