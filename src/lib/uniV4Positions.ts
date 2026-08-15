import { zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { erc20Abi } from '../abi'
import { CHAIN } from '../config/chains'
import { getAmountsForLiquidity, getSqrtRatioAtTick } from './clmath'
import { clampWidth } from './format'
import { mc, ok, type McRes } from './multicall'
import { deploymentUrl, graphQuery } from './thegraph'
import {
  decodeV4PositionInfo,
  v4FeesOwed,
  v4PoolId,
  v4PoolIdMatches,
  v4PositionKey,
  v4PositionManagerAbi,
  v4StateViewAbi,
  type V4PoolKey,
} from './uniV4'
import type { ClPool, ClPosition, TokenInfo } from '../types'

/**
 * Uniswap v4 LP positions, which no contract on the chain can enumerate.
 *
 * Every other position reader here starts from a wallet: an ERC-721 balance
 * walked by index, an ERC-20 balance, a farm's pid table. v4's PositionManager
 * mints NFTs but implements no enumeration at all — `totalSupply` and
 * `tokenOfOwnerByIndex` both revert — and there is no factory or pool contract
 * to scan from the other side. So the one question that needs an index is
 * asked of one: WHICH token ids might be this wallet's.
 *
 * Nothing else is taken on trust. Ownership is re-read from the
 * PositionManager, so a stale index can miss a position or waste a call, and
 * can never show a wallet something it does not own. The pool key comes from
 * the position itself rather than from a guessed rung — which is load-bearing
 * on v4, where fee is a free field: live BSC positions sit on 599900/11998 and
 * 131100/2622, rungs no ladder would contain.
 */
const V4 = CHAIN.uniV4

export const HAS_V4_POSITIONS = V4 !== null && V4.positionSubgraph !== null

/**
 * An upper bound on ids read per wallet, so one address cannot stall a refresh.
 *
 * The cap is only safe because the query below orders NEWEST FIRST. GraphQL
 * defaults to id order, which for a wallet that has minted thousands of
 * positions returns its oldest — nearly all long since closed — so the whole
 * page read as empty while the wallet held live liquidity. Measured: two BSC
 * wallets with 40+ live recent positions each returned nothing that way.
 *
 * A wallet past this many positions can still have an old live one hidden.
 * That is a bot-scale case, and the alternative is paging thousands of ids
 * through a metered gateway on every wallet.
 */
const MAX_IDS = 200

const idCache = new Map<string, bigint[]>()
const inflight = new Map<string, Promise<bigint[]>>()
/** ERC-20 decimals are amount-encoding identity and do not change per token. */
const verifiedMetadataCache = new Map<string, TokenInfo>()

const walletKey = (user: Address) => `${CHAIN.id}:${user.toLowerCase()}`
const tokenKey = (address: Address) => `${CHAIN.id}:${address.toLowerCase()}`

/**
 * Merge arbitrary display metadata while guaranteeing that V4 metadata which
 * passed the strict chain gate wins every address collision. Key from the
 * TokenInfo address itself so checksum/casing differences cannot dodge that
 * precedence rule.
 */
export function mergeTokenInfoWithVerifiedV4(
  sources: readonly (Readonly<Record<string, TokenInfo>> | undefined)[],
  verifiedV4?: Readonly<Record<string, TokenInfo>>,
): Record<string, TokenInfo> {
  const out: Record<string, TokenInfo> = {}
  for (const source of [...sources, verifiedV4]) {
    for (const token of Object.values(source ?? {}))
      out[token.address.toLowerCase()] = token
  }
  return out
}

function positionCurrencies(positions: readonly ClPosition[]): Address[] {
  return [...new Map(
    positions
      .flatMap((position) => [position.pool.token0, position.pool.token1])
      .map((address) => [address.toLowerCase(), address]),
  ).values()]
}

function tokenInfoFromMetadata(
  address: Address,
  symbolResult: McRes | undefined,
  decimalsResult: McRes | undefined,
): TokenInfo | undefined {
  const rawDecimals = ok<unknown>(decimalsResult)
  const decimals =
    typeof rawDecimals === 'number' || typeof rawDecimals === 'bigint'
      ? Number(rawDecimals)
      : Number.NaN
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) return undefined
  const rawSymbol = ok<unknown>(symbolResult)
  const symbol = typeof rawSymbol === 'string' ? rawSymbol.trim() : ''
  return {
    address,
    symbol: clampWidth(symbol || `${address.slice(0, 6)}…`, 32),
    decimals,
  }
}

function finalizeWithVerifiedMetadata(
  positions: readonly ClPosition[],
  proved: ReadonlyMap<string, TokenInfo>,
): { cl: ClPosition[]; tokens: Record<string, TokenInfo> } {
  const cl = positions.filter(
    (position) =>
      proved.has(position.pool.token0.toLowerCase()) &&
      proved.has(position.pool.token1.toLowerCase()),
  )
  const used = new Set(cl.flatMap((position) => [
    position.pool.token0.toLowerCase(),
    position.pool.token1.toLowerCase(),
  ]))
  const tokens: Record<string, TokenInfo> = {}
  for (const key of used) {
    const token = proved.get(key)
    if (token) tokens[key] = token
  }
  return { cl, tokens }
}

/**
 * Mandatory amount-encoding gate for discovered V4 positions. The matching
 * metadata multicall is ordered (symbol, decimals) for every unique ERC-20.
 * Symbol is optional; decimals must be a valid on-chain uint8 or every position
 * using that currency is omitted. In particular, failure is never guessed as
 * 18 decimals.
 */
export function finalizeV4PositionMetadata(
  positions: readonly ClPosition[],
  meta: readonly McRes[],
): { cl: ClPosition[]; tokens: Record<string, TokenInfo> } {
  const uniq = positionCurrencies(positions)
  const erc = uniq.filter((address) => address !== zeroAddress)
  const proved = new Map<string, TokenInfo>()
  if (uniq.includes(zeroAddress)) {
    proved.set(zeroAddress, {
      address: zeroAddress,
      symbol: CHAIN.nativeCurrency.symbol,
      decimals: CHAIN.nativeCurrency.decimals,
      native: true,
    })
  }
  erc.forEach((address, i) => {
    const token = tokenInfoFromMetadata(address, meta[i * 2], meta[i * 2 + 1])
    if (token) proved.set(address.toLowerCase(), token)
  })
  return finalizeWithVerifiedMetadata(positions, proved)
}

/** drops the cached token-id lists (tests, and a manual refresh) */
export function resetV4IdCache(): void {
  idCache.clear()
  inflight.clear()
}

/** drops immutable token proof cache (tests and explicit diagnostics) */
export function resetV4PositionMetadataCache(): void {
  verifiedMetadataCache.clear()
}

/**
 * Prove amount-encoding metadata once per currency. Pool/fee state stays fresh,
 * but repeated position refreshes no longer ask symbol()/decimals() for tokens
 * whose decimals have already passed the strict on-chain gate.
 */
export async function verifyV4PositionMetadata(
  pc: PublicClient,
  positions: readonly ClPosition[],
): Promise<{ cl: ClPosition[]; tokens: Record<string, TokenInfo> }> {
  const uniq = positionCurrencies(positions)
  const proved = new Map<string, TokenInfo>()
  if (uniq.includes(zeroAddress)) {
    proved.set(zeroAddress, {
      address: zeroAddress,
      symbol: CHAIN.nativeCurrency.symbol,
      decimals: CHAIN.nativeCurrency.decimals,
      native: true,
    })
  }

  const missing: Address[] = []
  for (const address of uniq) {
    if (address === zeroAddress) continue
    const hit = verifiedMetadataCache.get(tokenKey(address))
    if (hit) proved.set(address.toLowerCase(), hit)
    else missing.push(address)
  }
  const meta = await mc(
    pc,
    missing.flatMap((address) => [
      { abi: erc20Abi, address, functionName: 'symbol' },
      { abi: erc20Abi, address, functionName: 'decimals' },
    ]),
  )
  missing.forEach((address, i) => {
    const token = tokenInfoFromMetadata(address, meta[i * 2], meta[i * 2 + 1])
    if (!token) return // failed decimals are never cached, so the next refresh retries
    verifiedMetadataCache.set(tokenKey(address), token)
    proved.set(address.toLowerCase(), token)
  })
  return finalizeWithVerifiedMetadata(positions, proved)
}

/**
 * Token ids the index believes this wallet owns.
 *
 * The positions query owns the five-minute discovery cadence. Each actual
 * query asks the index again so a transaction-triggered invalidation can see a
 * newly minted NFT immediately; the cache is last-good data only, used when
 * the index is temporarily unavailable. Concurrent callers still share one
 * in-flight request.
 *
 * Subgraph entity ids are LOWERCASE; a checksummed address here matches nothing
 * and reads exactly like a wallet holding no positions.
 */
async function fetchTokenIds(user: Address): Promise<bigint[]> {
  if (!V4?.positionSubgraph) return []
  const owner = user.toLowerCase()
  const key = walletKey(user)
  const hit = idCache.get(key)
  const running = inflight.get(key)
  if (running) return running

  const p = (async () => {
    try {
      const data = await graphQuery<{ positions: { tokenId: string }[] }>(
        deploymentUrl(V4.positionSubgraph!),
        `query($owner: String!, $first: Int!) {
          positions(
            first: $first
            where: { owner: $owner }
            orderBy: createdAtTimestamp
            orderDirection: desc
          ) { tokenId }
        }`,
        { owner, first: MAX_IDS },
      )
      const ids = data.positions.map((position) => BigInt(position.tokenId))
      idCache.set(key, ids)
      return ids
    } catch (error) {
      // The fallback lives inside the shared promise so every concurrent caller
      // receives the same last-good result when the index is unavailable.
      if (hit) return hit
      throw error
    }
  })()
  inflight.set(key, p)
  try {
    return await p
  } finally {
    inflight.delete(key)
  }
}

export async function fetchV4Positions(
  pc: PublicClient,
  user: Address,
): Promise<{ cl: ClPosition[]; tokens: Record<string, TokenInfo> }> {
  const none = { cl: [], tokens: {} }
  if (!V4?.positionSubgraph) return none
  const ids = await fetchTokenIds(user)
  if (ids.length === 0) return none

  // pass 1: who owns it, what pool is it in, how much liquidity
  const base = await mc(
    pc,
    ids.flatMap((id) => [
      { abi: v4PositionManagerAbi, address: V4.POSITION_MANAGER, functionName: 'ownerOf', args: [id] },
      { abi: v4PositionManagerAbi, address: V4.POSITION_MANAGER, functionName: 'getPoolAndPositionInfo', args: [id] },
      { abi: v4PositionManagerAbi, address: V4.POSITION_MANAGER, functionName: 'getPositionLiquidity', args: [id] },
    ]),
  )

  type Held = { id: bigint; key: V4PoolKey; poolId: Hex; tickLower: number; tickUpper: number; liquidity: bigint }
  const held: Held[] = []
  ids.forEach((id, j) => {
    const owner = ok<Address>(base[j * 3])
    const pair = ok<readonly [V4PoolKey, bigint]>(base[j * 3 + 1])
    const liquidity = ok<bigint>(base[j * 3 + 2]) ?? 0n
    // the index only nominated this id; the chain decides whose it is
    if (!owner || owner.toLowerCase() !== user.toLowerCase()) return
    if (!pair) return
    const [key, info] = pair
    const { tickLower, tickUpper, poolIdPrefix } = decodeV4PositionInfo(info)
    // a key that does not hash to the recorded pool means it was decoded wrong,
    // and every number derived from it would be quietly about another pool
    if (!v4PoolIdMatches(key, poolIdPrefix)) return
    // an emptied position lingers as an NFT; ~29% of live ids are in that state
    if (liquidity === 0n) return
    held.push({ id, key, poolId: v4PoolId(key), tickLower, tickUpper, liquidity })
  })
  if (held.length === 0) return none

  // pass 2: pool state, plus the two halves of the fee derivation
  const pools = [...new Map(held.map((h) => [h.poolId, h])).values()]
  const state = await mc(pc, [
    ...pools.flatMap((h) => [
      { abi: v4StateViewAbi, address: V4.STATE_VIEW, functionName: 'getSlot0', args: [h.poolId] },
      { abi: v4StateViewAbi, address: V4.STATE_VIEW, functionName: 'getLiquidity', args: [h.poolId] },
    ]),
    ...held.flatMap((h) => [
      {
        abi: v4StateViewAbi,
        address: V4.STATE_VIEW,
        functionName: 'getPositionInfo',
        args: [h.poolId, v4PositionKey(V4.POSITION_MANAGER, h.tickLower, h.tickUpper, h.id)],
      },
      {
        abi: v4StateViewAbi,
        address: V4.STATE_VIEW,
        functionName: 'getFeeGrowthInside',
        args: [h.poolId, h.tickLower, h.tickUpper],
      },
    ]),
  ])

  const poolById = new Map<string, ClPool>()
  pools.forEach((h, i) => {
    const slot0 = ok<readonly [bigint, number, number, number]>(state[i * 2])
    const liquidity = ok<bigint>(state[i * 2 + 1]) ?? 0n
    if (!slot0) return
    poolById.set(h.poolId, {
      kind: 'cl',
      protocol: 'univ4',
      // v4 pools have no contract of their own — the singleton is where this
      // one genuinely lives, and poolId is what tells it from its neighbours
      address: V4.POOL_MANAGER,
      poolId: h.poolId,
      hooks: h.key.hooks,
      token0: h.key.currency0,
      token1: h.key.currency1,
      tickSpacing: h.key.tickSpacing,
      feePpm: h.key.fee,
      lpFeePpm: slot0[3],
      unstakedFeePpm: 0,
      sqrtPriceX96: slot0[0],
      tick: slot0[1],
      liquidity,
      stakedLiquidity: 0n,
      gauge: null,
      gaugeAlive: false,
      weight: 0n,
      rewardRate: 0n,
      periodFinish: 0n,
    })
  })

  const feeBase = pools.length * 2
  const cl: ClPosition[] = []
  held.forEach((h, j) => {
    const pool = poolById.get(h.poolId)
    if (!pool) return
    const info = ok<readonly [bigint, bigint, bigint]>(state[feeBase + j * 2])
    const growth = ok<readonly [bigint, bigint]>(state[feeBase + j * 2 + 1])
    const { fees0, fees1 } =
      info && growth
        ? v4FeesOwed(info[0], growth[0], growth[1], info[1], info[2])
        : { fees0: 0n, fees1: 0n }
    const { amount0, amount1 } = getAmountsForLiquidity(
      pool.sqrtPriceX96,
      getSqrtRatioAtTick(h.tickLower),
      getSqrtRatioAtTick(h.tickUpper),
      h.liquidity,
    )
    cl.push({
      tokenId: h.id,
      pool,
      tickLower: h.tickLower,
      tickUpper: h.tickUpper,
      liquidity: h.liquidity,
      // v4 has no gauge and no farm wired here; staking is not a thing to show
      staked: false,
      amount0,
      amount1,
      fees0,
      fees1,
      earned: 0n,
    })
  })

  // The native currency is named locally; successful ERC-20 decimals proofs
  // are immutable and shared across subsequent wallet-state refreshes.
  return verifyV4PositionMetadata(pc, cl)
}
