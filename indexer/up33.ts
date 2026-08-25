import { zeroAddress, type Address } from 'viem'
import { clFactoryAbi, clPoolAbi, voterAbi } from '../src/abi'
import { ADDR, log } from './config'
import { mc, ok, pc } from './rpc'
import { insertPool, poolRow, updatePoolStatic } from './store'

const range = (length: number) => Array.from({ length }, (_, index) => index)

/** Enumerate and refresh the official UP33 CL factory catalog. */
export async function syncUp33Cl(): Promise<string[]> {
  const rawLength = await pc.readContract({ address: ADDR.CL_FACTORY, abi: clFactoryAbi, functionName: 'allPoolsLength' })
  const length = Math.min(Number(rawLength), 600)
  const addresses = (await mc(range(length).map((index) => ({
    abi: clFactoryAbi,
    address: ADDR.CL_FACTORY,
    functionName: 'allPools',
    args: [BigInt(index)],
  })))).map((result) => ok<Address>(result)).filter((address): address is Address => Boolean(address && address !== zeroAddress))

  const details = await mc(addresses.flatMap((address) => [
    { abi: clPoolAbi, address, functionName: 'fee' },
    { abi: clPoolAbi, address, functionName: 'unstakedFee' },
    { abi: clPoolAbi, address, functionName: 'tickSpacing' },
    { abi: clPoolAbi, address, functionName: 'token0' },
    { abi: clPoolAbi, address, functionName: 'token1' },
    { abi: voterAbi, address: ADDR.VOTER, functionName: 'gauges', args: [address] },
  ]))
  const fresh: string[] = []
  addresses.forEach((address, index) => {
    const base = index * 6
    const feePpm = ok<number>(details[base])
    const unstakedFeePpm = ok<number>(details[base + 1])
    const tickSpacing = ok<number>(details[base + 2])
    const token0 = ok<Address>(details[base + 3])
    const token1 = ok<Address>(details[base + 4])
    const rawGauge = ok<Address>(details[base + 5])
    if (feePpm === undefined || unstakedFeePpm === undefined || tickSpacing === undefined || !token0 || !token1) return
    const gauge = rawGauge && rawGauge !== zeroAddress ? rawGauge : undefined
    const wasKnown = Boolean(poolRow(address))
    insertPool({ address, proto: 'up33cl', token0, token1, feePpm, unstakedFeePpm, tickSpacing, gauge, pairIndex: index })
    updatePoolStatic(address, feePpm, unstakedFeePpm, tickSpacing, gauge)
    if (!wasKnown) fresh.push(address.toLowerCase())
  })
  if (fresh.length) log(`[catalog] up33 cl sync: +${fresh.length} pools`)
  return fresh
}
