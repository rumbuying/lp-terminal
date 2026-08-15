import type { Address, PublicClient } from 'viem'
import { erc20Abi, uniV2PairAbi, v2FarmAbi } from '../abi'
import { CHAIN_ID } from '../config/addresses'
import { mc, ok } from './multicall'
import { isVenuePair, sortTokens, V2_SWEEP_VENUES } from './v2Pairs'
import type { TokenInfo, V2Position } from '../types'

/**
 * v2 LP that a wallet cannot see, because it no longer holds it.
 *
 * Staking into a v2 farm TRANSFERS the LP token, so `pair.balanceOf(user)`
 * returns zero and every wallet-side discovery path — the CREATE2 sweep, a
 * holder-balance API, a subgraph tracking transfers — correctly reports the
 * position as gone. The farm is the only contract that still associates the
 * deposit with its depositor.
 *
 * Its v3 sibling (clFarmAbi) can be walked with ERC-721 enumeration, because an
 * NFT carries identity. A fungible LP token carries none, so this farm keys
 * deposits by POOL INDEX: there is no "which pools is this user in", only
 * `userInfo(pid, user)` asked once per pid, bounded by `poolLength`.
 */
export type V2FarmPool = { pid: number; address: Address; token0: Address; token1: Address }

export type V2Farm = { address: Address; reward: { symbol: string; decimals: number } }

/** A refresh must not replace a previously proved farm position with absence. */
export class V2FarmKnownPositionReadError extends Error {}

/**
 * Which pids hold a genuine home-v2 pair.
 *
 * `lpToken(pid)` is not always a pair. MasterChefV2 carries dummy tokens for its
 * special pools (dCAKEPOOL, dLOTTO) and StableSwap LPs whose reserves this app
 * cannot read; those have no token0()/token1(), so the multicall drops them on
 * its own. CREATE2 settles the rest, because only the home factory can deploy
 * to the address its own tokens hash to. Measured on BSC 2026-08-02: 147 of 187
 * pids verify, 40 fall out, and none fails on the factory check.
 */
export async function loadFarmPools(pc: PublicClient, farm: Address): Promise<V2FarmPool[]> {
  const venue = V2_SWEEP_VENUES.find((v) => v.protocol === 'home')
  if (!venue) return []
  const lenRes = await mc(pc, [{ abi: v2FarmAbi, address: farm, functionName: 'poolLength' }])
  const count = Number(ok<bigint>(lenRes[0]) ?? 0n)
  if (count === 0) return []

  const lpRes = await mc(
    pc,
    Array.from({ length: count }, (_, pid) => ({
      abi: v2FarmAbi,
      address: farm,
      functionName: 'lpToken',
      args: [BigInt(pid)],
    })),
  )
  const known = lpRes
    .map((r, pid) => ({ address: ok<Address>(r), pid }))
    .filter((x): x is { address: Address; pid: number } => !!x.address)

  const tokRes = await mc(
    pc,
    known.flatMap(({ address }) => [
      { abi: uniV2PairAbi, address, functionName: 'token0' },
      { abi: uniV2PairAbi, address, functionName: 'token1' },
    ]),
  )
  const pools: V2FarmPool[] = []
  known.forEach(({ address, pid }, j) => {
    const a = ok<Address>(tokRes[j * 2])
    const b = ok<Address>(tokRes[j * 2 + 1])
    if (!a || !b) return // a dummy token, not a pair
    const [token0, token1] = sortTokens(a, b)
    if (!isVenuePair(venue, address, token0, token1)) return
    pools.push({ pid, address, token0, token1 })
  })
  return pools
}

/**
 * The pid → pair map, resolved once per reconciliation window.
 *
 * A pid's lpToken never changes and the list only grows, so re-deriving it
 * on every position refresh would spend ~370 calls to learn what it already knows. The
 * steady-state cost is then one `userInfo` per previously non-zero pid and
 * nothing else. A farm that gains a pool is picked up by the periodic broad
 * reconciliation without making every position-state read walk the farm.
 */
const FARM_POOLS_TTL_MS = 30 * 60_000
const FARM_USER_RECONCILE_MS = 30 * 60_000

type FarmPoolsCache = { at: number; promise: Promise<V2FarmPool[]> }
type FarmUserCache = { reconciledAt: number; pids: Set<number> }

const farmPoolsCache = new Map<string, FarmPoolsCache>()
const farmUserCache = new Map<string, FarmUserCache>()

const farmKey = (farm: Address) => `${CHAIN_ID}:${farm.toLowerCase()}`
const farmUserKey = (farm: Address, user: Address) =>
  `${farmKey(farm)}:${user.toLowerCase()}`

export function farmPools(pc: PublicClient, farm: Address): Promise<V2FarmPool[]> {
  const key = farmKey(farm)
  const now = Date.now()
  const hit = farmPoolsCache.get(key)
  if (hit && now - hit.at < FARM_POOLS_TTL_MS) return hit.promise

  let promise: Promise<V2FarmPool[]>
  promise = loadFarmPools(pc, farm).catch((e: unknown) => {
    // A failed load must not be cached as "this farm is empty". The identity
    // check avoids deleting a newer entry if a manual reset raced this call.
    if (farmPoolsCache.get(key)?.promise === promise) farmPoolsCache.delete(key)
    throw e
  })
  farmPoolsCache.set(key, { at: now, promise })
  return promise
}

/** drops immutable pid maps and wallet discovery, so the next read reconciles */
export function resetFarmPools(): void {
  farmPoolsCache.clear()
  farmUserCache.clear()
}

/**
 * Drops every wallet's pid discovery while keeping the immutable pid map.
 *
 * The 30-minute reconcile window is the right pace for a quiet wallet, but it
 * is the wrong answer right after THIS wallet moved liquidity: a stake into a
 * pid the cache has not proved yet stays invisible until the window expires.
 * A liquidity invalidation is exactly the moment that assumption broke, so the
 * next read walks the whole farm (~187 userInfo, one multicall) instead of
 * only the previously non-zero pids.
 */
export function invalidateFarmUsers(): void {
  farmUserCache.clear()
}

/**
 * v2 LP the user has staked into a pid-keyed farm.
 *
 * Reports `walletLp: 0n` on purpose: this reads a DEPOSIT, and the balance for
 * the same pair is the wallet reader's answer. Keeping the two disjoint is what
 * lets mergeV2ByPair add them without double counting.
 */
export async function fetchV2FarmPositions(
  pc: PublicClient,
  user: Address,
  farm: V2Farm,
): Promise<{ v2: V2Position[]; tokens: Record<string, TokenInfo> }> {
  const none = { v2: [], tokens: {} }
  const pools = await farmPools(pc, farm.address)
  if (pools.length === 0) return none

  const now = Date.now()
  const userKey = farmUserKey(farm.address, user)
  const cached = farmUserCache.get(userKey)
  const reconcileAll =
    !cached || now - cached.reconciledAt >= FARM_USER_RECONCILE_MS
  // A full farm walk discovers deposits. Between reconciliations, only pids
  // already proved non-zero are state reads; empty wallets therefore cost no
  // farm RPC at all. POSITIONS' 5-minute query lifecycle owns the outer pace.
  const scanPools = reconcileAll
    ? pools
    : pools.filter((pool) => cached.pids.has(pool.pid))
  if (scanPools.length === 0) return none

  const stakeRes = await mc(
    pc,
    scanPools.map((p) => ({
      abi: v2FarmAbi,
      address: farm.address,
      functionName: 'userInfo',
      args: [BigInt(p.pid), user],
    })),
  )
  if (
    cached &&
    scanPools.some(
      (pool, i) => cached.pids.has(pool.pid) && stakeRes[i]?.status !== 'success',
    )
  ) {
    throw new V2FarmKnownPositionReadError('failed to refresh a known farm position')
  }
  const held = scanPools
    .map((pool, i) => ({ pool, stakedLp: ok<readonly bigint[]>(stakeRes[i])?.[0] ?? 0n }))
    .filter(({ stakedLp }) => stakedLp > 0n)

  const nextPids = reconcileAll ? new Set<number>() : new Set(cached.pids)
  scanPools.forEach((pool, i) => {
    // A failed per-pid call is absence of evidence, not evidence of an empty
    // deposit. Preserve a previously known pid and retry it next time.
    if (stakeRes[i]?.status !== 'success') return
    const amount = ok<readonly bigint[]>(stakeRes[i])?.[0] ?? 0n
    if (amount > 0n) nextPids.add(pool.pid)
    else nextPids.delete(pool.pid)
  })
  if (stakeRes.every((row) => row.status === 'success')) {
    farmUserCache.set(userKey, {
      reconciledAt: reconcileAll ? now : cached.reconciledAt,
      pids: nextPids,
    })
  } else if (cached) {
    // Keep the full-reconciliation deadline expired after a partial broad read
    // while retaining every successfully refreshed known pid.
    farmUserCache.set(userKey, { ...cached, pids: nextPids })
  }
  if (held.length === 0) return none

  const det = await mc(pc, [
    ...held.flatMap(({ pool }) => [
      { abi: uniV2PairAbi, address: pool.address, functionName: 'getReserves' },
      { abi: uniV2PairAbi, address: pool.address, functionName: 'totalSupply' },
    ]),
    ...held.map(({ pool }) => ({
      abi: v2FarmAbi,
      address: farm.address,
      functionName: 'pendingCake',
      args: [BigInt(pool.pid), user],
    })),
  ])

  const feeBps = V2_SWEEP_VENUES.find((v) => v.protocol === 'home')?.feeBps ?? 0
  const v2: V2Position[] = []
  held.forEach(({ pool, stakedLp }, j) => {
    const reserves = ok<readonly [bigint, bigint, number]>(det[j * 2])
    const totalSupply = ok<bigint>(det[j * 2 + 1]) ?? 0n
    const reward = ok<bigint>(det[held.length * 2 + j]) ?? 0n
    if (!reserves || totalSupply === 0n) return
    v2.push({
      pool: {
        kind: 'v2',
        protocol: 'home',
        address: pool.address,
        token0: pool.token0,
        token1: pool.token1,
        stable: false,
        reserve0: reserves[0],
        reserve1: reserves[1],
        totalSupply,
        // a ve(3,3) figure the emissions branch reads; this farm has no gauge
        // and pays through `farm.reward` instead, so it stays zero
        gaugeTotalSupply: 0n,
        feeBps,
        gauge: null,
        gaugeAlive: false,
        weight: 0n,
        rewardRate: 0n,
        periodFinish: 0n,
      },
      walletLp: 0n,
      stakedLp,
      earned: 0n,
      claimable0: 0n,
      claimable1: 0n,
      amount0: (stakedLp * reserves[0]) / totalSupply,
      amount1: (stakedLp * reserves[1]) / totalSupply,
      farm: {
        address: farm.address,
        pid: pool.pid,
        reward,
        symbol: farm.reward.symbol,
        decimals: farm.reward.decimals,
      },
    })
  })

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
