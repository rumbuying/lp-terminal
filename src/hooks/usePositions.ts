import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import type { Address, PublicClient } from 'viem'
import { clGaugeAbi, clPmAbi, clPoolAbi, erc20Abi, uniV2PairAbi, uniV3FactoryAbi, uniV3PmAbi, uniV3PoolAbi, v2GaugeAbi, v2PoolAbi } from '../abi'
import { ADDR, CHAIN_ID, EXPLORER, UNI } from '../config/addresses'
import { MAX_UINT128, getAmountsForLiquidity, getSqrtRatioAtTick } from '../lib/clmath'
import { previewV2ClaimFees } from '../lib/v2Fees'
import type { ClPool, ClPosition, PoolsData, PositionsData, TokenInfo, V2Pool, V2Position } from '../types'
import { usePools } from './usePools'

type McRes = { status: 'success' | 'failure'; result?: unknown }
async function mc(pc: PublicClient, contracts: unknown[]): Promise<McRes[]> {
  if (contracts.length === 0) return []
  return (await pc.multicall({ contracts: contracts as never })) as McRes[]
}
function ok<T>(r: McRes | undefined): T | undefined {
  return r && r.status === 'success' ? (r.result as T) : undefined
}

/**
 * Enumerate the complete ERC-721 owner inventory in bounded multicalls.
 * Closed LP NFTs remain in the wallet forever, so a fixed first-N cap will
 * eventually hide every newly minted strategy position once the wallet has
 * accumulated N old NFTs.
 */
async function ownerTokenIds(pc: PublicClient, abi: typeof clPmAbi | typeof uniV3PmAbi, manager: Address, owner: Address, count: number): Promise<bigint[]> {
  const ids: bigint[] = []
  const batchSize = 100
  for (let start = 0; start < count; start += batchSize) {
    const end = Math.min(count, start + batchSize)
    const results = await mc(pc, Array.from({ length: end - start }, (_, offset) => ({
      abi,
      address: manager,
      functionName: 'tokenOfOwnerByIndex',
      args: [owner, BigInt(start + offset)],
    })))
    ids.push(...results.map((result) => ok<bigint>(result)).filter((id): id is bigint => id !== undefined))
  }
  return ids
}

type RawPos = readonly [
  bigint, // nonce
  Address, // operator
  Address, // token0
  Address, // token1
  number, // tickSpacing
  number, // tickLower
  number, // tickUpper
  bigint, // liquidity
  bigint,
  bigint,
  bigint, // tokensOwed0
  bigint, // tokensOwed1
]

// same tuple shape as RawPos, but index 4 is the uint24 fee tier (univ3 NPMs
// are fee-keyed where Slipstream is tickSpacing-keyed)
type RawUniPos = RawPos

/**
 * Uniswap v2 wallet positions. V2 LP is a plain ERC-20 — there is no NFT
 * enumeration like the NPMs, and the official factory holds 15k+ pairs
 * (mostly dust), so pair-side sweeps are out. Discover from the WALLET
 * instead: Blockscout lists the address's ERC-20 holdings in one call, and
 * every UNI-V2 entry is verified on-chain (factory() must be the official
 * deployment — a spoofed "Uniswap V2" token fails this) with balance,
 * reserves and supply read fresh. Blockscout being down hides univ2
 * positions for that refresh only — same degrade contract as the univ3
 * fetch below.
 */
async function fetchUniV2Positions(
  pc: PublicClient,
  user: Address,
): Promise<{ v2: V2Position[]; tokens: Record<string, TokenInfo> }> {
  const res = await fetch(`${EXPLORER}/api/v2/addresses/${user}/tokens?type=ERC-20`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`blockscout ${res.status}`)
  type Held = { token?: { symbol?: string | null; address?: string; address_hash?: string }; value?: string }
  const body = (await res.json()) as { items?: Held[] }
  const pairs = [
    ...new Set(
      (body.items ?? [])
        .filter((it) => it.token?.symbol === 'UNI-V2' && BigInt(it.value ?? '0') > 0n)
        .map((it) => (it.token?.address_hash ?? it.token?.address)?.toLowerCase())
        .filter((a): a is string => !!a),
    ),
  ] as Address[]
  if (pairs.length === 0) return { v2: [], tokens: {} }

  const det = await mc(
    pc,
    pairs.flatMap((p) => [
      { abi: uniV2PairAbi, address: p, functionName: 'factory' },
      { abi: uniV2PairAbi, address: p, functionName: 'token0' },
      { abi: uniV2PairAbi, address: p, functionName: 'token1' },
      { abi: uniV2PairAbi, address: p, functionName: 'getReserves' },
      { abi: uniV2PairAbi, address: p, functionName: 'totalSupply' },
      { abi: uniV2PairAbi, address: p, functionName: 'balanceOf', args: [user] },
    ]),
  )

  const v2: V2Position[] = []
  pairs.forEach((p, j) => {
    const base = j * 6
    const factory = ok<Address>(det[base])
    const token0 = ok<Address>(det[base + 1])
    const token1 = ok<Address>(det[base + 2])
    const reserves = ok<readonly [bigint, bigint, number]>(det[base + 3])
    const totalSupply = ok<bigint>(det[base + 4]) ?? 0n
    const walletLp = ok<bigint>(det[base + 5]) ?? 0n
    if (factory?.toLowerCase() !== UNI.V2_FACTORY.toLowerCase()) return
    if (!token0 || !token1 || !reserves || walletLp === 0n || totalSupply === 0n) return
    const pool: V2Pool = {
      kind: 'v2',
      protocol: 'univ2',
      address: p,
      token0,
      token1,
      stable: false,
      reserve0: reserves[0],
      reserve1: reserves[1],
      totalSupply,
      gaugeTotalSupply: 0n,
      feeBps: 30, // uniswap v2 flat 0.30%, rolled into reserves
      gauge: null,
      gaugeAlive: false,
      weight: 0n,
      rewardRate: 0n,
      periodFinish: 0n,
    }
    v2.push({
      pool,
      walletLp,
      stakedLp: 0n,
      earned: 0n,
      claimable0: 0n,
      claimable1: 0n,
      amount0: (walletLp * reserves[0]) / totalSupply,
      amount1: (walletLp * reserves[1]) / totalSupply,
    })
  })

  // erc20 metadata for pair tokens outside the UP33 registry, so any pair
  // renders with real symbols/decimals
  const tokens: Record<string, TokenInfo> = {}
  const uniq = [...new Set(v2.flatMap((r) => [r.pool.token0, r.pool.token1]))]
  const meta = await mc(
    pc,
    uniq.flatMap((a) => [
      { abi: erc20Abi, address: a, functionName: 'symbol' },
      { abi: erc20Abi, address: a, functionName: 'decimals' },
    ]),
  )
  uniq.forEach((a, j) => {
    tokens[a.toLowerCase()] = {
      address: a,
      symbol: ok<string>(meta[j * 2]) ?? a.slice(0, 6) + '…',
      decimals: ok<number>(meta[j * 2 + 1]) ?? 18,
    }
  })
  return { v2, tokens }
}

/**
 * Uniswap v3 wallet positions (official Robinhood Chain deployment). Pools are
 * discovered per position via factory.getPool and read fresh (slot0/liquidity/
 * tickSpacing); tokens outside the UP33 registry get erc20 metadata fetched so
 * any pair renders correctly. No gauges here — positions are never staked.
 */
async function fetchUniPositions(
  pc: PublicClient,
  user: Address,
  pools: PoolsData,
): Promise<{ cl: ClPosition[]; tokens: Record<string, TokenInfo> }> {
  const none = { cl: [], tokens: {} }
  const cntRes = await mc(pc, [
    { abi: uniV3PmAbi, address: UNI.V3_NPM, functionName: 'balanceOf', args: [user] },
  ])
  const count = Number(ok<bigint>(cntRes[0]) ?? 0n)
  if (count === 0) return none

  const ids = await ownerTokenIds(pc, uniV3PmAbi, UNI.V3_NPM, user, count)
  if (ids.length === 0) return none

  const posRes = await mc(
    pc,
    ids.map((id) => ({ abi: uniV3PmAbi, address: UNI.V3_NPM, functionName: 'positions', args: [id] })),
  )
  const raws = ids
    .map((id, j) => ({ id, raw: ok<RawUniPos>(posRes[j]) }))
    .filter((x): x is { id: bigint; raw: RawUniPos } => !!x.raw)
    // drop empty NFTs (closed positions linger in wallets)
    .filter(({ raw }) => raw[7] > 0n || raw[10] > 0n || raw[11] > 0n)
  if (raws.length === 0) return none

  // resolve each distinct (token0, token1, fee) to its pool address
  const poolKeys = new Map<string, { token0: Address; token1: Address; fee: number }>()
  for (const { raw } of raws) {
    poolKeys.set(`${raw[2].toLowerCase()}|${raw[3].toLowerCase()}|${raw[4]}`, {
      token0: raw[2],
      token1: raw[3],
      fee: raw[4],
    })
  }
  const keys = [...poolKeys.entries()]
  const addrRes = await mc(
    pc,
    keys.map(([, k]) => ({
      abi: uniV3FactoryAbi,
      address: UNI.V3_FACTORY,
      functionName: 'getPool',
      args: [k.token0, k.token1, k.fee],
    })),
  )

  // pool state + erc20 metadata for tokens the UP33 registry doesn't know
  const unknownTokens = new Set<string>()
  for (const [, k] of keys) {
    for (const t of [k.token0, k.token1]) {
      if (!pools.tokens[t.toLowerCase()]) unknownTokens.add(t.toLowerCase())
    }
  }
  const tokenList = [...unknownTokens] as Address[]
  const poolAddrs = keys.map(([, ], i) => ok<Address>(addrRes[i]))
  const stateCalls: unknown[] = poolAddrs.flatMap((a) =>
    a
      ? [
          { abi: uniV3PoolAbi, address: a, functionName: 'slot0' },
          { abi: uniV3PoolAbi, address: a, functionName: 'liquidity' },
          { abi: uniV3PoolAbi, address: a, functionName: 'tickSpacing' },
        ]
      : [],
  )
  const metaCalls: unknown[] = tokenList.flatMap((t) => [
    { abi: erc20Abi, address: t, functionName: 'symbol' },
    { abi: erc20Abi, address: t, functionName: 'decimals' },
  ])
  const r = await mc(pc, [...stateCalls, ...metaCalls])

  const poolByKey = new Map<string, ClPool>()
  let ri = 0
  keys.forEach(([key, k], i) => {
    const address = poolAddrs[i]
    if (!address) return
    const s0 = ok<readonly [bigint, number, number, number, number, number, boolean]>(r[ri])
    const liquidity = ok<bigint>(r[ri + 1]) ?? 0n
    const tickSpacing = ok<number>(r[ri + 2]) ?? 0
    ri += 3
    if (!s0) return
    poolByKey.set(key, {
      kind: 'cl',
      protocol: 'univ3',
      address,
      token0: k.token0,
      token1: k.token1,
      tickSpacing,
      feePpm: k.fee, // univ3 fee unit (hundredths of a bip) == ppm
      unstakedFeePpm: 0,
      sqrtPriceX96: s0[0],
      tick: s0[1],
      liquidity,
      stakedLiquidity: 0n,
      gauge: null,
      gaugeAlive: false,
      weight: 0n,
      rewardRate: 0n,
      periodFinish: 0n,
    })
  })
  const tokens: Record<string, TokenInfo> = {}
  tokenList.forEach((t, i) => {
    const base = stateCalls.length + i * 2
    tokens[t.toLowerCase()] = {
      address: t,
      symbol: ok<string>(r[base]) ?? t.slice(0, 6) + '…',
      decimals: ok<number>(r[base + 1]) ?? 18,
    }
  })

  const cl: ClPosition[] = []
  for (const { id, raw } of raws) {
    const pool = poolByKey.get(`${raw[2].toLowerCase()}|${raw[3].toLowerCase()}|${raw[4]}`)
    if (!pool) continue
    const { amount0, amount1 } = getAmountsForLiquidity(
      pool.sqrtPriceX96,
      getSqrtRatioAtTick(raw[5]),
      getSqrtRatioAtTick(raw[6]),
      raw[7],
    )
    cl.push({
      tokenId: id,
      pool,
      tickLower: raw[5],
      tickUpper: raw[6],
      liquidity: raw[7],
      staked: false,
      amount0,
      amount1,
      fees0: raw[10],
      fees1: raw[11],
      earned: 0n,
    })
  }
  return { cl, tokens }
}

async function fetchPositionsFull(
  pc: PublicClient,
  user: Address,
  pools: PoolsData,
): Promise<PositionsData> {
  // univ3 discovery runs concurrently with the UP33 passes below
  const uniP = fetchUniPositions(pc, user, pools).catch(() => ({ cl: [], tokens: {} }))
  const uniV2P = fetchUniV2Positions(pc, user).catch(() => ({ v2: [], tokens: {} }))
  const clPools = pools.pools.filter((p): p is ClPool => p.kind === 'cl')
  const v2Pools = pools.pools.filter((p): p is V2Pool => p.kind === 'v2')
  const clGauges = clPools.filter((p) => p.gauge)

  // pass 1: counts + per-pool balances
  const pass1: unknown[] = [
    { abi: clPmAbi, address: ADDR.CL_PM, functionName: 'balanceOf', args: [user] },
    ...clGauges.map((p) => ({
      abi: clGaugeAbi,
      address: p.gauge!,
      functionName: 'stakedValues',
      args: [user],
    })),
    ...v2Pools.flatMap((p) => [
      { abi: v2PoolAbi, address: p.address, functionName: 'balanceOf', args: [user] },
      { abi: v2PoolAbi, address: p.address, functionName: 'claimable0', args: [user] },
      { abi: v2PoolAbi, address: p.address, functionName: 'claimable1', args: [user] },
      ...(p.gauge
        ? [
            { abi: v2GaugeAbi, address: p.gauge, functionName: 'balanceOf', args: [user] },
            { abi: v2GaugeAbi, address: p.gauge, functionName: 'earned', args: [user] },
          ]
        : []),
    ]),
  ]
  const r1 = await mc(pc, pass1)
  let idx = 0
  const walletCount = Number(ok<bigint>(r1[idx++]) ?? 0n)
  const stakedIdsByGauge: { pool: ClPool; ids: bigint[] }[] = []
  for (const p of clGauges) {
    const ids = ok<readonly bigint[]>(r1[idx++]) ?? []
    if (ids.length) stakedIdsByGauge.push({ pool: p, ids: [...ids] })
  }
  const v2Raw: {
    pool: V2Pool
    walletLp: bigint
    claimable0: bigint
    claimable1: bigint
    stakedLp: bigint
    earned: bigint
  }[] = []
  for (const p of v2Pools) {
    const walletLp = ok<bigint>(r1[idx++]) ?? 0n
    const claimable0 = ok<bigint>(r1[idx++]) ?? 0n
    const claimable1 = ok<bigint>(r1[idx++]) ?? 0n
    let stakedLp = 0n
    let earned = 0n
    if (p.gauge) {
      stakedLp = ok<bigint>(r1[idx++]) ?? 0n
      earned = ok<bigint>(r1[idx++]) ?? 0n
    }
    if (walletLp > 0n || stakedLp > 0n || claimable0 > 0n || claimable1 > 0n || earned > 0n) {
      v2Raw.push({ pool: p, walletLp, claimable0, claimable1, stakedLp, earned })
    }
  }

  // pass 2: wallet tokenIds
  const walletIds = await ownerTokenIds(pc, clPmAbi, ADDR.CL_PM, user, walletCount)

  // pass 3: position structs (+ earned for staked)
  const stakedFlat = stakedIdsByGauge.flatMap(({ pool, ids }) => ids.map((id) => ({ pool, id })))
  const pass3: unknown[] = [
    ...walletIds.map((id) => ({
      abi: clPmAbi,
      address: ADDR.CL_PM,
      functionName: 'positions',
      args: [id],
    })),
    ...stakedFlat.flatMap(({ pool, id }) => [
      { abi: clPmAbi, address: ADDR.CL_PM, functionName: 'positions', args: [id] },
      { abi: clGaugeAbi, address: pool.gauge!, functionName: 'earned', args: [user, id] },
    ]),
  ]
  const r3 = await mc(pc, pass3)

  const poolByKey = new Map<string, ClPool>()
  for (const p of clPools) {
    poolByKey.set(`${p.token0.toLowerCase()}|${p.token1.toLowerCase()}|${p.tickSpacing}`, p)
  }
  const findPool = (raw: RawPos): ClPool | undefined =>
    poolByKey.get(`${raw[2].toLowerCase()}|${raw[3].toLowerCase()}|${raw[4]}`)

  const cl: ClPosition[] = []

  const buildPos = (
    id: bigint,
    raw: RawPos,
    staked: boolean,
    earned: bigint,
  ): ClPosition | null => {
    const pool = findPool(raw)
    if (!pool) return null
    const liquidity = raw[7]
    const { amount0, amount1 } = getAmountsForLiquidity(
      pool.sqrtPriceX96,
      getSqrtRatioAtTick(raw[5]),
      getSqrtRatioAtTick(raw[6]),
      liquidity,
    )
    return {
      tokenId: id,
      pool,
      tickLower: raw[5],
      tickUpper: raw[6],
      liquidity,
      staked,
      amount0,
      amount1,
      fees0: raw[10],
      fees1: raw[11],
      earned,
    }
  }

  walletIds.forEach((id, j) => {
    const raw = ok<RawPos>(r3[j])
    if (!raw) return
    const pos = buildPos(id, raw, false, 0n)
    if (pos && (pos.liquidity > 0n || pos.fees0 > 0n || pos.fees1 > 0n)) cl.push(pos)
  })
  stakedFlat.forEach(({ id }, j) => {
    const base = walletIds.length + j * 2
    const raw = ok<RawPos>(r3[base])
    const earned = ok<bigint>(r3[base + 1]) ?? 0n
    if (!raw) return
    const pos = buildPos(id, raw, true, earned)
    if (pos) cl.push(pos)
  })

  // univ3 wallet positions join here so the fee simulation below covers them
  const uni = await uniP
  cl.push(...uni.cl)

  // pass 4: exact uncollected fees for wallet positions via collect() simulation
  // (collect is signature-identical on both NPMs — only the address differs)
  await Promise.all(
    cl
      .filter((p) => !p.staked)
      .map(async (p) => {
        try {
          const sim = await pc.simulateContract({
            abi: clPmAbi,
            address: p.pool.protocol === 'univ3' ? UNI.V3_NPM : ADDR.CL_PM,
            functionName: 'collect',
            args: [
              {
                tokenId: p.tokenId,
                recipient: user,
                amount0Max: MAX_UINT128,
                amount1Max: MAX_UINT128,
              },
            ],
            account: user,
          })
          const [f0, f1] = sim.result as readonly [bigint, bigint]
          p.fees0 = f0
          p.fees1 = f1
        } catch {
          /* keep tokensOwed fallback */
        }
      }),
  )

  // Solidly claimable getters only expose fees materialized by a prior pool
  // interaction. Simulating claimFees as the owner includes the latest index.
  await Promise.all(
    v2Raw
      .filter((r) => r.pool.protocol === 'up33' && r.walletLp > 0n)
      .map(async (r) => {
        const [fee0, fee1] = await previewV2ClaimFees(pc, r.pool.address, user, [r.claimable0, r.claimable1])
        r.claimable0 = fee0
        r.claimable1 = fee1
      }),
  )

  const v2: V2Position[] = v2Raw.map((r) => {
    const lp = r.walletLp + r.stakedLp
    const ts = r.pool.totalSupply
    return {
      pool: r.pool,
      walletLp: r.walletLp,
      stakedLp: r.stakedLp,
      earned: r.earned,
      claimable0: r.claimable0,
      claimable1: r.claimable1,
      amount0: ts > 0n ? (lp * r.pool.reserve0) / ts : 0n,
      amount1: ts > 0n ? (lp * r.pool.reserve1) / ts : 0n,
    }
  })

  const uniV2 = await uniV2P
  v2.push(...uniV2.v2)

  return { cl, v2, tokens: { ...uni.tokens, ...uniV2.tokens } }
}

const POSITION_DISCOVERY_TTL_MS = 60_000
const positionDiscoveryCache = new Map<string, { discoveredAt: number; data: PositionsData }>()
const positionKey = (position: ClPosition) => `${position.pool.protocol}:${position.tokenId.toString()}`

/**
 * Refreshes every known position in one Multicall while the slower inventory
 * discovery is cached. Ownership changes force immediate rediscovery, so a
 * rebalance/stake/unstake still appears on the next 15-second UI refresh.
 */
export async function refreshKnownPositions(pc: PublicClient, user: Address, pools: PoolsData, known: PositionsData): Promise<PositionsData> {
  const calls: unknown[] = []
  for (const position of known.cl) {
    const pmAbi = position.pool.protocol === 'univ3' ? uniV3PmAbi : clPmAbi
    const manager = position.pool.protocol === 'univ3' ? UNI.V3_NPM : ADDR.CL_PM
    calls.push(
      { abi: pmAbi, address: manager, functionName: 'ownerOf', args: [position.tokenId] },
      { abi: pmAbi, address: manager, functionName: 'positions', args: [position.tokenId] },
    )
    if (position.staked && position.pool.gauge)
      calls.push({ abi: clGaugeAbi, address: position.pool.gauge, functionName: 'earned', args: [user, position.tokenId] })
  }
  const uniquePools = [...new Map(known.cl.map((position) => [position.pool.address.toLowerCase(), position.pool])).values()]
  for (const pool of uniquePools) {
    const abi = pool.protocol === 'univ3' ? uniV3PoolAbi : clPoolAbi
    calls.push(
      { abi, address: pool.address, functionName: 'slot0' },
      { abi, address: pool.address, functionName: 'liquidity' },
    )
    if (pool.protocol === 'up33') calls.push({ abi: clPoolAbi, address: pool.address, functionName: 'stakedLiquidity' })
  }
  for (const position of known.v2) {
    if (position.pool.protocol === 'univ2') {
      calls.push(
        { abi: uniV2PairAbi, address: position.pool.address, functionName: 'getReserves' },
        { abi: uniV2PairAbi, address: position.pool.address, functionName: 'totalSupply' },
        { abi: uniV2PairAbi, address: position.pool.address, functionName: 'balanceOf', args: [user] },
      )
    } else {
      calls.push(
        { abi: v2PoolAbi, address: position.pool.address, functionName: 'balanceOf', args: [user] },
        { abi: v2PoolAbi, address: position.pool.address, functionName: 'claimable0', args: [user] },
        { abi: v2PoolAbi, address: position.pool.address, functionName: 'claimable1', args: [user] },
      )
      if (position.pool.gauge) calls.push(
        { abi: v2GaugeAbi, address: position.pool.gauge, functionName: 'balanceOf', args: [user] },
        { abi: v2GaugeAbi, address: position.pool.gauge, functionName: 'earned', args: [user] },
      )
    }
  }

  const results = await mc(pc, calls)
  let cursor = 0
  const rawByPosition = new Map<string, RawPos>()
  const earnedByPosition = new Map<string, bigint>()
  for (const position of known.cl) {
    const nftOwner = ok<Address>(results[cursor++])
    const raw = ok<RawPos>(results[cursor++])
    const expectedOwner = position.staked ? position.pool.gauge : user
    if (!nftOwner || !expectedOwner || nftOwner.toLowerCase() !== expectedOwner.toLowerCase() || !raw)
      throw new Error('E_POSITION_INVENTORY_CHANGED')
    rawByPosition.set(positionKey(position), raw)
    if (position.staked && position.pool.gauge) {
      const earned = ok<bigint>(results[cursor++])
      if (earned === undefined) throw new Error('E_POSITION_INVENTORY_CHANGED')
      earnedByPosition.set(positionKey(position), earned)
    }
  }

  const livePools = new Map<string, ClPool>()
  for (const pool of uniquePools) {
    const slot0 = ok<readonly [bigint, number, ...unknown[]]>(results[cursor++])
    const liquidity = ok<bigint>(results[cursor++])
    const stakedLiquidity = pool.protocol === 'up33' ? ok<bigint>(results[cursor++]) : 0n
    if (!slot0 || liquidity === undefined || stakedLiquidity === undefined) throw new Error('E_POSITION_POOL_CHANGED')
    const latest = pools.pools.find((candidate): candidate is ClPool => candidate.kind === 'cl' && candidate.address.toLowerCase() === pool.address.toLowerCase()) ?? pool
    livePools.set(pool.address.toLowerCase(), {
      ...latest,
      sqrtPriceX96: slot0[0],
      tick: Number(slot0[1]),
      liquidity,
      stakedLiquidity,
    })
  }

  const cl: ClPosition[] = known.cl.map((position) => {
    const raw = rawByPosition.get(positionKey(position))!
    const pool = livePools.get(position.pool.address.toLowerCase())!
    if (raw[2].toLowerCase() !== pool.token0.toLowerCase() || raw[3].toLowerCase() !== pool.token1.toLowerCase())
      throw new Error('E_POSITION_POOL_CHANGED')
    if (raw[7] === 0n && raw[10] === 0n && raw[11] === 0n) throw new Error('E_POSITION_INVENTORY_CHANGED')
    const amounts = getAmountsForLiquidity(pool.sqrtPriceX96, getSqrtRatioAtTick(raw[5]), getSqrtRatioAtTick(raw[6]), raw[7])
    return {
      ...position,
      pool,
      tickLower: raw[5],
      tickUpper: raw[6],
      liquidity: raw[7],
      amount0: amounts.amount0,
      amount1: amounts.amount1,
      fees0: raw[10],
      fees1: raw[11],
      earned: earnedByPosition.get(positionKey(position)) ?? 0n,
    }
  })

  await Promise.all(cl.filter((position) => !position.staked).map(async (position) => {
    try {
      const simulation = await pc.simulateContract({
        abi: clPmAbi,
        address: position.pool.protocol === 'univ3' ? UNI.V3_NPM : ADDR.CL_PM,
        functionName: 'collect',
        args: [{ tokenId: position.tokenId, recipient: user, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
        account: user,
      })
      const [fee0, fee1] = simulation.result as readonly [bigint, bigint]
      position.fees0 = fee0
      position.fees1 = fee1
    } catch { /* tokensOwed fallback remains honest */ }
  }))

  const v2: V2Position[] = []
  for (const position of known.v2) {
    if (position.pool.protocol === 'univ2') {
      const reserves = ok<readonly [bigint, bigint, number]>(results[cursor++])
      const totalSupply = ok<bigint>(results[cursor++])
      const walletLp = ok<bigint>(results[cursor++])
      if (!reserves || !totalSupply || walletLp === undefined || walletLp === 0n) throw new Error('E_POSITION_INVENTORY_CHANGED')
      const pool = { ...position.pool, reserve0: reserves[0], reserve1: reserves[1], totalSupply }
      v2.push({ ...position, pool, walletLp, amount0: (walletLp * reserves[0]) / totalSupply, amount1: (walletLp * reserves[1]) / totalSupply })
      continue
    }
    const walletLp = ok<bigint>(results[cursor++]) ?? 0n
    let claimable0 = ok<bigint>(results[cursor++]) ?? 0n
    let claimable1 = ok<bigint>(results[cursor++]) ?? 0n
    const stakedLp = position.pool.gauge ? ok<bigint>(results[cursor++]) ?? 0n : 0n
    const earned = position.pool.gauge ? ok<bigint>(results[cursor++]) ?? 0n : 0n
    if (walletLp === 0n && stakedLp === 0n && claimable0 === 0n && claimable1 === 0n && earned === 0n)
      throw new Error('E_POSITION_INVENTORY_CHANGED')
    const latest = pools.pools.find((candidate): candidate is V2Pool => candidate.kind === 'v2' && candidate.address.toLowerCase() === position.pool.address.toLowerCase()) ?? position.pool
    if (walletLp > 0n) [claimable0, claimable1] = await previewV2ClaimFees(pc, latest.address, user, [claimable0, claimable1])
    const lp = walletLp + stakedLp
    v2.push({
      ...position,
      pool: latest,
      walletLp,
      stakedLp,
      earned,
      claimable0,
      claimable1,
      amount0: latest.totalSupply > 0n ? (lp * latest.reserve0) / latest.totalSupply : 0n,
      amount1: latest.totalSupply > 0n ? (lp * latest.reserve1) / latest.totalSupply : 0n,
    })
  }
  return { cl, v2, tokens: known.tokens }
}

async function fetchPositions(pc: PublicClient, user: Address, pools: PoolsData): Promise<PositionsData> {
  const key = user.toLowerCase()
  const cached = positionDiscoveryCache.get(key)
  if (cached && Date.now() - cached.discoveredAt < POSITION_DISCOVERY_TTL_MS) {
    try {
      const data = await refreshKnownPositions(pc, user, pools, cached.data)
      positionDiscoveryCache.set(key, { ...cached, data })
      return data
    } catch {
      // A disappeared/changed NFT is normally an executor rebalance. Fall
      // through to full discovery immediately instead of showing stale data.
    }
  }
  const data = await fetchPositionsFull(pc, user, pools)
  positionDiscoveryCache.set(key, { discoveredAt: Date.now(), data })
  return data
}

export function usePositions(user?: Address, options: { refetchInterval?: number | false; poolsRefetchInterval?: number | false } = {}) {
  const pc = usePublicClient({ chainId: CHAIN_ID })
  const pools = usePools({ refetchInterval: options.poolsRefetchInterval })
  return useQuery({
    queryKey: ['positions', user],
    enabled: !!pc && !!user && !!pools.data,
    refetchInterval: options.refetchInterval ?? 15_000,
    queryFn: () => fetchPositions(pc as PublicClient, user!, pools.data!),
  })
}
