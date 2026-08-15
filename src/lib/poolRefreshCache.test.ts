import assert from 'node:assert/strict'
import test from 'node:test'
import type { Address, PublicClient } from 'viem'
import { ADDR } from '../config/addresses'

const pool = '0x0000000000000000000000000000000000001000' as Address
const token0 = '0x0000000000000000000000000000000000002000' as Address
const token1 = ADDR.WETH

test('pool refresh keeps live ticks while reusing the static address catalog', async () => {
  ;(globalThis as any).localStorage = {
    getItem: () => null,
    setItem: () => undefined,
  }
  const { fetchPools } = await import('../hooks/usePools')
  let tick = 10
  let addressEnumerations = 0
  const client = {
    getBlockNumber: async () => 123n,
    multicall: async ({ contracts }: { contracts: any[] }) => contracts.map((contract) => {
          let result: unknown
          switch (contract.functionName) {
            case 'allPoolsLength': result = contract.address.toLowerCase() === ADDR.CL_FACTORY.toLowerCase() ? 1n : 0n; break
            case 'allPools': addressEnumerations += 1; result = pool; break
            case 'weekly': result = 1n; break
            case 'epochCount': result = 1n; break
            case 'activePeriod': result = 1n; break
            case 'totalWeight': result = 1n; break
            case 'capMode': result = 0; break
            case 'slot0': result = [1n << 96n, tick, 0, 0, 0, true]; break
            case 'liquidity': result = 100n; break
            case 'stakedLiquidity': result = 50n; break
            case 'weights': result = 1n; break
            case 'fee': result = 3_000; break
            case 'unstakedFee': result = 0; break
            case 'tickSpacing': result = 10; break
            case 'token0': result = token0; break
            case 'token1': result = token1; break
            case 'gauges': result = '0x0000000000000000000000000000000000000000'; break
            case 'symbol': result = contract.address.toLowerCase() === token1.toLowerCase() ? 'WETH' : 'T0'; break
            case 'decimals': result = 18; break
            default: throw new Error(`unexpected ${contract.functionName}`)
          }
          return { status: 'success', result }
        }),
  } as unknown as PublicClient

  const first = await fetchPools(client)
  tick = 11
  const second = await fetchPools(client)
  assert.equal(first.pools[0]?.kind === 'cl' ? first.pools[0].tick : undefined, 10)
  assert.equal(second.pools[0]?.kind === 'cl' ? second.pools[0].tick : undefined, 11)
  assert.equal(addressEnumerations, 1)
})
