import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import { zeroAddress, type Address, type PublicClient } from 'viem'
import {
  clFactoryAbi,
  clGaugeAbi,
  clPoolAbi,
  erc20Abi,
  minterAbi,
  v2FactoryAbi,
  v2GaugeAbi,
  v2PoolAbi,
  voterAbi,
} from '../abi'
import { ADDR, CHAIN_ID } from '../config/addresses'
import type { ClPool, Pool, PoolsData, TokenInfo, V2Pool } from '../types'

type McRes = { status: 'success' | 'failure'; result?: unknown; error?: Error }

async function mc(pc: PublicClient, contracts: unknown[]): Promise<McRes[]> {
  if (contracts.length === 0) return []
  return (await pc.multicall({ contracts: contracts as never })) as McRes[]
}

function ok<T>(r: McRes | undefined): T | undefined {
  return r && r.status === 'success' ? (r.result as T) : undefined
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i)

type PoolAddressCache = { v2N: number; clN: number; v2Addrs: Address[]; clAddrs: Address[] }
type ClStatic = { feePpm: number; unstakedFeePpm: number; tickSpacing: number; token0: Address; token1: Address; gauge: Address | null }
let poolAddressCache: PoolAddressCache | undefined
let clStaticCache: { expiresAt: number; byAddress: Map<string, ClStatic> } | undefined
let lastPoolsData: PoolsData | undefined
const CL_STATIC_TTL_MS = 60_000

// ---- token metadata cache (localStorage, shared with the univ3 browser) ----
const TOKEN_CACHE_KEY = 'up33:tokens:v2'

export function loadTokenCache(): Record<string, TokenInfo> {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_CACHE_KEY) ?? '{}')
  } catch {
    return {}
  }
}
export function saveTokenCache(cache: Record<string, TokenInfo>) {
  try {
    localStorage.setItem(TOKEN_CACHE_KEY, JSON.stringify(cache))
  } catch {
    /* ignore */
  }
}

/** Steady-state refresh: independent reads launch together and become one HTTP JSON batch. */
async function refreshCachedPools(pc: PublicClient): Promise<PoolsData | undefined> {
  if (!poolAddressCache || !lastPoolsData || !clStaticCache) return undefined
  const { v2Addrs, clAddrs, v2N, clN } = poolAddressCache
  const previous = new Map(lastPoolsData.pools.map((pool) => [pool.address.toLowerCase(), pool]))
  const headCalls = [
    { abi: v2FactoryAbi, address: ADDR.V2_FACTORY, functionName: 'allPoolsLength' },
    { abi: clFactoryAbi, address: ADDR.CL_FACTORY, functionName: 'allPoolsLength' },
    { abi: minterAbi, address: ADDR.MINTER, functionName: 'weekly' },
    { abi: minterAbi, address: ADDR.MINTER, functionName: 'epochCount' },
    { abi: minterAbi, address: ADDR.MINTER, functionName: 'activePeriod' },
    { abi: voterAbi, address: ADDR.VOTER, functionName: 'totalWeight' },
    { abi: voterAbi, address: ADDR.VOTER, functionName: 'capMode' },
  ]
  const detailCalls: unknown[] = []
  for (const address of v2Addrs) detailCalls.push(
    { abi: v2PoolAbi, address, functionName: 'metadata' },
    { abi: v2PoolAbi, address, functionName: 'totalSupply' },
    { abi: voterAbi, address: ADDR.VOTER, functionName: 'gauges', args: [address] },
    { abi: voterAbi, address: ADDR.VOTER, functionName: 'weights', args: [address] },
  )
  for (const address of clAddrs) detailCalls.push(
    { abi: clPoolAbi, address, functionName: 'slot0' },
    { abi: clPoolAbi, address, functionName: 'liquidity' },
    { abi: clPoolAbi, address, functionName: 'stakedLiquidity' },
    { abi: voterAbi, address: ADDR.VOTER, functionName: 'weights', args: [address] },
  )
  const refreshStatic = clStaticCache.expiresAt <= Date.now()
  const staticCalls: unknown[] = []
  if (refreshStatic) for (const address of clAddrs) staticCalls.push(
    { abi: clPoolAbi, address, functionName: 'fee' },
    { abi: clPoolAbi, address, functionName: 'unstakedFee' },
    { abi: clPoolAbi, address, functionName: 'tickSpacing' },
    { abi: clPoolAbi, address, functionName: 'token0' },
    { abi: clPoolAbi, address, functionName: 'token1' },
    { abi: voterAbi, address: ADDR.VOTER, functionName: 'gauges', args: [address] },
  )
  const pass2Calls: unknown[] = []
  const pass2Tags: { kind: 'v2fee' | 'alive' | 'rate' | 'finish' | 'gts'; address: string }[] = []
  for (const pool of lastPoolsData.pools) {
    const address = pool.address.toLowerCase()
    if (pool.kind === 'v2') {
      pass2Calls.push({ abi: v2FactoryAbi, address: ADDR.V2_FACTORY, functionName: 'getFee', args: [pool.address, pool.stable] })
      pass2Tags.push({ kind: 'v2fee', address })
    }
    if (!pool.gauge) continue
    const gaugeAbi = pool.kind === 'v2' ? v2GaugeAbi : clGaugeAbi
    pass2Calls.push({ abi: voterAbi, address: ADDR.VOTER, functionName: 'isAlive', args: [pool.gauge] })
    pass2Tags.push({ kind: 'alive', address })
    pass2Calls.push({ abi: gaugeAbi, address: pool.gauge, functionName: 'rewardRate' })
    pass2Tags.push({ kind: 'rate', address })
    pass2Calls.push({ abi: gaugeAbi, address: pool.gauge, functionName: 'periodFinish' })
    pass2Tags.push({ kind: 'finish', address })
    if (pool.kind === 'v2') {
      pass2Calls.push({ abi: v2GaugeAbi, address: pool.gauge, functionName: 'totalSupply' })
      pass2Tags.push({ kind: 'gts', address })
    }
  }

  const [head, detail, staticResult, pass2, blockNumber] = await Promise.all([
    mc(pc, headCalls),
    mc(pc, detailCalls),
    mc(pc, staticCalls),
    mc(pc, pass2Calls),
    pc.getBlockNumber(),
  ])
  const nextV2N = Math.min(Number(ok<bigint>(head[0]) ?? 0n), 300)
  const nextClN = Math.min(Number(ok<bigint>(head[1]) ?? 0n), 600)
  if (nextV2N !== v2N || nextClN !== clN) return undefined

  if (refreshStatic) {
    const byAddress = new Map(clStaticCache.byAddress)
    clAddrs.forEach((address, index) => {
      const base = index * 6
      const token0 = ok<Address>(staticResult[base + 3])
      const token1 = ok<Address>(staticResult[base + 4])
      if (!token0 || !token1) return
      const gauge = ok<Address>(staticResult[base + 5])
      byAddress.set(address.toLowerCase(), {
        feePpm: ok<number>(staticResult[base]) ?? byAddress.get(address.toLowerCase())?.feePpm ?? 0,
        unstakedFeePpm: ok<number>(staticResult[base + 1]) ?? byAddress.get(address.toLowerCase())?.unstakedFeePpm ?? 0,
        tickSpacing: ok<number>(staticResult[base + 2]) ?? byAddress.get(address.toLowerCase())?.tickSpacing ?? 0,
        token0,
        token1,
        gauge: gauge && gauge !== zeroAddress ? gauge : null,
      })
    })
    clStaticCache = { expiresAt: Date.now() + CL_STATIC_TTL_MS, byAddress }
  }

  const pools: Pool[] = []
  let cursor = 0
  for (const address of v2Addrs) {
    const old = previous.get(address.toLowerCase())
    const md = ok<readonly [bigint, bigint, bigint, bigint, boolean, Address, Address]>(detail[cursor])
    const totalSupply = ok<bigint>(detail[cursor + 1])
    const gauge = ok<Address>(detail[cursor + 2])
    const weight = ok<bigint>(detail[cursor + 3])
    cursor += 4
    if (!md || totalSupply === undefined) {
      if (old?.kind === 'v2') pools.push({ ...old })
      continue
    }
    pools.push({
      kind: 'v2', protocol: 'up33', address, token0: md[5], token1: md[6], stable: md[4], reserve0: md[2], reserve1: md[3], totalSupply,
      gaugeTotalSupply: old?.kind === 'v2' ? old.gaugeTotalSupply : 0n,
      feeBps: old?.kind === 'v2' ? old.feeBps : 0,
      gauge: gauge && gauge !== zeroAddress ? gauge : null,
      gaugeAlive: old?.gaugeAlive ?? false,
      weight: weight ?? old?.weight ?? 0n,
      rewardRate: old?.rewardRate ?? 0n,
      periodFinish: old?.periodFinish ?? 0n,
    })
  }
  for (const address of clAddrs) {
    const old = previous.get(address.toLowerCase())
    const slot0 = ok<readonly [bigint, number, ...unknown[]]>(detail[cursor])
    const liquidity = ok<bigint>(detail[cursor + 1])
    const stakedLiquidity = ok<bigint>(detail[cursor + 2])
    const weight = ok<bigint>(detail[cursor + 3])
    cursor += 4
    const fixed = clStaticCache.byAddress.get(address.toLowerCase())
    if (!slot0 || liquidity === undefined || stakedLiquidity === undefined || !fixed) {
      if (old?.kind === 'cl') pools.push({ ...old })
      continue
    }
    pools.push({
      kind: 'cl', protocol: 'up33', address, token0: fixed.token0, token1: fixed.token1, tickSpacing: fixed.tickSpacing,
      feePpm: fixed.feePpm, unstakedFeePpm: fixed.unstakedFeePpm, sqrtPriceX96: slot0[0], tick: Number(slot0[1]), liquidity, stakedLiquidity,
      gauge: fixed.gauge, gaugeAlive: old?.gaugeAlive ?? false, weight: weight ?? old?.weight ?? 0n,
      rewardRate: old?.rewardRate ?? 0n, periodFinish: old?.periodFinish ?? 0n,
    })
  }
  const byAddress = new Map(pools.map((pool) => [pool.address.toLowerCase(), pool]))
  pass2.forEach((result, index) => {
    const tag = pass2Tags[index]
    const pool = byAddress.get(tag.address)
    if (!pool) return
    if (tag.kind === 'v2fee' && pool.kind === 'v2') pool.feeBps = Number(ok<bigint>(result) ?? BigInt(pool.feeBps))
    if (tag.kind === 'alive') pool.gaugeAlive = ok<boolean>(result) ?? pool.gaugeAlive
    if (tag.kind === 'rate') pool.rewardRate = ok<bigint>(result) ?? pool.rewardRate
    if (tag.kind === 'finish') pool.periodFinish = ok<bigint>(result) ?? pool.periodFinish
    if (tag.kind === 'gts' && pool.kind === 'v2') pool.gaugeTotalSupply = ok<bigint>(result) ?? pool.gaugeTotalSupply
  })

  const tokens = { ...lastPoolsData.tokens }
  const cache = loadTokenCache()
  const missing = [...new Set(pools.flatMap((pool) => [pool.token0, pool.token1]).filter((token) => !tokens[token.toLowerCase()]))]
  if (missing.length) {
    const meta = await mc(pc, missing.flatMap((token) => [
      { abi: erc20Abi, address: token, functionName: 'symbol' },
      { abi: erc20Abi, address: token, functionName: 'decimals' },
    ]))
    missing.forEach((token, index) => {
      const info: TokenInfo = { address: token, symbol: ok<string>(meta[index * 2]) ?? token.slice(0, 6) + '…', decimals: ok<number>(meta[index * 2 + 1]) ?? 18 }
      tokens[token.toLowerCase()] = info
      cache[token.toLowerCase()] = info
    })
    saveTokenCache(cache)
  }
  pools.sort((a, b) => a.weight !== b.weight ? (b.weight > a.weight ? 1 : -1) : a.kind === b.kind ? 0 : a.kind === 'cl' ? -1 : 1)
  return {
    pools,
    tokens,
    protocol: {
      weekly: ok<bigint>(head[2]) ?? lastPoolsData.protocol.weekly,
      epochCount: Number(ok<bigint>(head[3]) ?? lastPoolsData.protocol.epochCount),
      activePeriod: Number(ok<bigint>(head[4]) ?? lastPoolsData.protocol.activePeriod),
      totalWeight: ok<bigint>(head[5]) ?? lastPoolsData.protocol.totalWeight,
      capMode: ok<number>(head[6]) ?? lastPoolsData.protocol.capMode,
      blockNumber,
    },
  }
}

export async function fetchPools(pc: PublicClient): Promise<PoolsData> {
  const cached = await refreshCachedPools(pc)
  if (cached) {
    lastPoolsData = cached
    return cached
  }
  const head = await mc(pc, [
    { abi: v2FactoryAbi, address: ADDR.V2_FACTORY, functionName: 'allPoolsLength' },
    { abi: clFactoryAbi, address: ADDR.CL_FACTORY, functionName: 'allPoolsLength' },
    { abi: minterAbi, address: ADDR.MINTER, functionName: 'weekly' },
    { abi: minterAbi, address: ADDR.MINTER, functionName: 'epochCount' },
    { abi: minterAbi, address: ADDR.MINTER, functionName: 'activePeriod' },
    { abi: voterAbi, address: ADDR.VOTER, functionName: 'totalWeight' },
    { abi: voterAbi, address: ADDR.VOTER, functionName: 'capMode' },
  ])
  const blockNumber = await pc.getBlockNumber()

  const v2N = Math.min(Number(ok<bigint>(head[0]) ?? 0n), 300)
  const clN = Math.min(Number(ok<bigint>(head[1]) ?? 0n), 600)

  if (!poolAddressCache || poolAddressCache.v2N !== v2N || poolAddressCache.clN !== clN) {
    const addrRes = await mc(pc, [
      ...range(v2N).map((i) => ({
        abi: v2FactoryAbi,
        address: ADDR.V2_FACTORY,
        functionName: 'allPools',
        args: [BigInt(i)],
      })),
      ...range(clN).map((i) => ({
        abi: clFactoryAbi,
        address: ADDR.CL_FACTORY,
        functionName: 'allPools',
        args: [BigInt(i)],
      })),
    ])
    poolAddressCache = {
      v2N,
      clN,
      v2Addrs: addrRes.slice(0, v2N).map((r) => ok<Address>(r)).filter(Boolean) as Address[],
      clAddrs: addrRes.slice(v2N).map((r) => ok<Address>(r)).filter(Boolean) as Address[],
    }
    clStaticCache = undefined
  }
  const { v2Addrs, clAddrs } = poolAddressCache

  // ---- per-pool detail ----
  const detail: unknown[] = []
  for (const p of v2Addrs) {
    detail.push(
      { abi: v2PoolAbi, address: p, functionName: 'metadata' },
      { abi: v2PoolAbi, address: p, functionName: 'totalSupply' },
      { abi: voterAbi, address: ADDR.VOTER, functionName: 'gauges', args: [p] },
      { abi: voterAbi, address: ADDR.VOTER, functionName: 'weights', args: [p] },
    )
  }
  for (const p of clAddrs) {
    detail.push(
      { abi: clPoolAbi, address: p, functionName: 'slot0' },
      { abi: clPoolAbi, address: p, functionName: 'liquidity' },
      { abi: clPoolAbi, address: p, functionName: 'stakedLiquidity' },
      { abi: voterAbi, address: ADDR.VOTER, functionName: 'weights', args: [p] },
    )
  }
  const refreshClStatic = !clStaticCache || clStaticCache.expiresAt <= Date.now() || clAddrs.some((p) => !clStaticCache!.byAddress.has(p.toLowerCase()))
  if (refreshClStatic) {
    for (const p of clAddrs) {
      detail.push(
        { abi: clPoolAbi, address: p, functionName: 'fee' },
        { abi: clPoolAbi, address: p, functionName: 'unstakedFee' },
        { abi: clPoolAbi, address: p, functionName: 'tickSpacing' },
        { abi: clPoolAbi, address: p, functionName: 'token0' },
        { abi: clPoolAbi, address: p, functionName: 'token1' },
        { abi: voterAbi, address: ADDR.VOTER, functionName: 'gauges', args: [p] },
      )
    }
  }
  const det = await mc(pc, detail)

  const v2Pools: V2Pool[] = []
  let i = 0
  for (const p of v2Addrs) {
    const md = ok<readonly [bigint, bigint, bigint, bigint, boolean, Address, Address]>(det[i])
    const totalSupply = ok<bigint>(det[i + 1]) ?? 0n
    const gauge = ok<Address>(det[i + 2])
    const weight = ok<bigint>(det[i + 3]) ?? 0n
    i += 4
    if (!md) continue
    v2Pools.push({
      kind: 'v2',
      protocol: 'up33',
      address: p,
      token0: md[5],
      token1: md[6],
      stable: md[4],
      reserve0: md[2],
      reserve1: md[3],
      totalSupply,
      gaugeTotalSupply: 0n, // filled in pass 2
      feeBps: 0, // filled below with the stable-aware getFee
      gauge: gauge && gauge !== zeroAddress ? gauge : null,
      gaugeAlive: false,
      weight,
      rewardRate: 0n,
      periodFinish: 0n,
    })
  }
  const clDynamic: { address: Address; slot0: readonly [bigint, number, ...unknown[]]; liquidity: bigint; stakedLiquidity: bigint; weight: bigint }[] = []
  for (const p of clAddrs) {
    const s0 = ok<readonly [bigint, number, number, number, number, boolean]>(det[i])
    const liquidity = ok<bigint>(det[i + 1]) ?? 0n
    const stakedLiquidity = ok<bigint>(det[i + 2]) ?? 0n
    const weight = ok<bigint>(det[i + 3]) ?? 0n
    i += 4
    if (s0) clDynamic.push({ address: p, slot0: s0, liquidity, stakedLiquidity, weight })
  }
  if (refreshClStatic) {
    const byAddress = new Map<string, ClStatic>()
    for (const p of clAddrs) {
      const feePpm = ok<number>(det[i]) ?? 0
      const unstakedFeePpm = ok<number>(det[i + 1]) ?? 0
      const tickSpacing = ok<number>(det[i + 2]) ?? 0
      const token0 = ok<Address>(det[i + 3])
      const token1 = ok<Address>(det[i + 4])
      const gauge = ok<Address>(det[i + 5])
      i += 6
      if (token0 && token1) byAddress.set(p.toLowerCase(), {
        feePpm,
        unstakedFeePpm,
        tickSpacing,
        token0,
        token1,
        gauge: gauge && gauge !== zeroAddress ? gauge : null,
      })
    }
    clStaticCache = { expiresAt: Date.now() + CL_STATIC_TTL_MS, byAddress }
  }
  const clPools: ClPool[] = []
  for (const dynamic of clDynamic) {
    const fixed = clStaticCache?.byAddress.get(dynamic.address.toLowerCase())
    if (!fixed) continue
    clPools.push({
      kind: 'cl',
      protocol: 'up33',
      address: dynamic.address,
      token0: fixed.token0,
      token1: fixed.token1,
      tickSpacing: fixed.tickSpacing,
      feePpm: fixed.feePpm,
      unstakedFeePpm: fixed.unstakedFeePpm,
      sqrtPriceX96: dynamic.slot0[0],
      tick: dynamic.slot0[1],
      liquidity: dynamic.liquidity,
      stakedLiquidity: dynamic.stakedLiquidity,
      gauge: fixed.gauge,
      gaugeAlive: false,
      weight: dynamic.weight,
      rewardRate: 0n,
      periodFinish: 0n,
    })
  }

  // ---- second pass: stable-aware v2 fee + gauge liveness/rates ----
  const pass2: unknown[] = []
  const pass2Tag: { kind: string; idx: number }[] = []
  v2Pools.forEach((p, idx) => {
    pass2.push({
      abi: v2FactoryAbi,
      address: ADDR.V2_FACTORY,
      functionName: 'getFee',
      args: [p.address, p.stable],
    })
    pass2Tag.push({ kind: 'v2fee', idx })
  })
  const allPools: Pool[] = [...v2Pools, ...clPools]
  allPools.forEach((p, idx) => {
    if (!p.gauge) return
    const gaugeAbi = p.kind === 'v2' ? v2GaugeAbi : clGaugeAbi
    pass2.push({ abi: voterAbi, address: ADDR.VOTER, functionName: 'isAlive', args: [p.gauge] })
    pass2Tag.push({ kind: 'alive', idx })
    pass2.push({ abi: gaugeAbi, address: p.gauge, functionName: 'rewardRate' })
    pass2Tag.push({ kind: 'rate', idx })
    pass2.push({ abi: gaugeAbi, address: p.gauge, functionName: 'periodFinish' })
    pass2Tag.push({ kind: 'finish', idx })
    if (p.kind === 'v2') {
      pass2.push({ abi: v2GaugeAbi, address: p.gauge, functionName: 'totalSupply' })
      pass2Tag.push({ kind: 'gts', idx })
    }
  })
  const p2 = await mc(pc, pass2)
  p2.forEach((r, j) => {
    const tag = pass2Tag[j]
    if (tag.kind === 'v2fee') {
      const fee = ok<bigint>(r)
      if (fee !== undefined) (v2Pools[tag.idx] as V2Pool).feeBps = Number(fee)
      return
    }
    const pool = allPools[tag.idx]
    if (tag.kind === 'alive') pool.gaugeAlive = ok<boolean>(r) ?? false
    if (tag.kind === 'rate') pool.rewardRate = ok<bigint>(r) ?? 0n
    if (tag.kind === 'finish') pool.periodFinish = ok<bigint>(r) ?? 0n
    if (tag.kind === 'gts' && pool.kind === 'v2') pool.gaugeTotalSupply = ok<bigint>(r) ?? 0n
  })

  // ---- token metadata ----
  const cache = loadTokenCache()
  const tokens: Record<string, TokenInfo> = {}
  const missing: Address[] = []
  const uniq = new Set<string>()
  for (const p of allPools) {
    for (const t of [p.token0, p.token1]) {
      const k = t.toLowerCase()
      if (uniq.has(k)) continue
      uniq.add(k)
      if (cache[k]) tokens[k] = cache[k]
      else missing.push(t)
    }
  }
  if (missing.length) {
    const metaRes = await mc(
      pc,
      missing.flatMap((t) => [
        { abi: erc20Abi, address: t, functionName: 'symbol' },
        { abi: erc20Abi, address: t, functionName: 'decimals' },
      ]),
    )
    missing.forEach((t, j) => {
      const symbol = ok<string>(metaRes[j * 2]) ?? t.slice(0, 6) + '…'
      const decimals = ok<number>(metaRes[j * 2 + 1]) ?? 18
      const info: TokenInfo = { address: t, symbol, decimals }
      tokens[t.toLowerCase()] = info
      cache[t.toLowerCase()] = info
    })
    saveTokenCache(cache)
  }

  // sort: gauged & emitting first (by vote weight), then by kind
  allPools.sort((a, b) => {
    const aw = a.weight
    const bw = b.weight
    if (aw !== bw) return bw > aw ? 1 : -1
    return a.kind === b.kind ? 0 : a.kind === 'cl' ? -1 : 1
  })

  const result: PoolsData = {
    pools: allPools,
    tokens,
    protocol: {
      weekly: ok<bigint>(head[2]) ?? 0n,
      epochCount: Number(ok<bigint>(head[3]) ?? 0n),
      activePeriod: Number(ok<bigint>(head[4]) ?? 0n),
      totalWeight: ok<bigint>(head[5]) ?? 0n,
      capMode: ok<number>(head[6]) ?? null,
      blockNumber,
    },
  }
  lastPoolsData = result
  return result
}

export function usePools(options: { refetchInterval?: number | false } = {}) {
  const pc = usePublicClient({ chainId: CHAIN_ID })
  return useQuery({
    queryKey: ['pools'],
    enabled: !!pc,
    refetchInterval: options.refetchInterval ?? 20_000,
    queryFn: () => fetchPools(pc as PublicClient),
  })
}

export function tokenOf(data: PoolsData | undefined, addr: Address | string): TokenInfo {
  const k = addr.toLowerCase()
  return (
    data?.tokens[k] ?? {
      address: addr as Address,
      symbol: addr.slice(0, 6) + '…',
      decimals: 18,
    }
  )
}

export function poolLabel(data: PoolsData | undefined, p: Pool): string {
  const t0 = tokenOf(data, p.token0).symbol
  const t1 = tokenOf(data, p.token1).symbol
  return `${t0}/${t1}`
}

export function poolTypeLabel(p: Pool): string {
  if (p.kind === 'v2') {
    if (p.protocol === 'univ2') return 'uniswap v2'
    return p.stable ? 'v2 STABLE' : 'v2 VOLATILE'
  }
  if (p.protocol === 'univ3') return `uniswap v3 ts${p.tickSpacing}`
  return `CL ts${p.tickSpacing}`
}

export function poolFeePct(p: Pool): number {
  return p.kind === 'v2' ? p.feeBps / 100 : p.feePpm / 10_000
}
