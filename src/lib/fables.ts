import {
  encodeAbiParameters, getAddress, keccak256, type Address, type Hex, type PublicClient,
} from 'viem'
import { fablesHookAbi, fablesLensAbi, fablesRegistryAbi } from '../abi/fables'
import { FABLES_HOOKS, FABLES_KNOWN_POOL_IDS, FABLES_LENS, FABLES_REGISTRY, fablesHook } from '../config/fables'
import { v4PoolId } from './uniV4'

export type FablesPoolKey = {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}

export type FablesPool = { id: Hex; key: FablesPoolKey; active: boolean; reviewed: boolean }

export function fablesRangeId(poolId: Hex, tickLower: number, tickUpper: number): bigint {
  return BigInt(keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'int24' }, { type: 'int24' }],
    [poolId, tickLower, tickUpper],
  )))
}

export async function readFablesPools(client: PublicClient, blockNumber?: bigint): Promise<FablesPool[]> {
  const rows = await client.readContract({
    address: FABLES_REGISTRY, abi: fablesRegistryAbi, functionName: 'activePools', blockNumber,
  })
  const seen = new Set<string>()
  return rows.map(row => {
    const key: FablesPoolKey = {
      currency0: getAddress(row.key.currency0), currency1: getAddress(row.key.currency1),
      fee: Number(row.key.fee), tickSpacing: Number(row.key.tickSpacing),
      hooks: getAddress(row.key.hooks),
    }
    const id = v4PoolId(key)
    if (id.toLowerCase() !== row.id.toLowerCase()) throw new Error('E_FABLES_POOL_IDENTITY')
    if (seen.has(id.toLowerCase())) throw new Error('E_FABLES_DUPLICATE_POOL')
    seen.add(id.toLowerCase())
    return { id, key, active: row.active,
      reviewed: !!fablesHook(key.hooks) && FABLES_KNOWN_POOL_IDS.has(id.toLowerCase()),
    }
  })
}

export type FablesPosition = {
  owner: Address
  pool: FablesPool
  rangeId: bigint
  tickLower: number
  tickUpper: number
  shares: bigint
  totalShares: bigint
  staked: bigint
  claimable0: bigint
  claimable1: bigint
  amount0: bigint
  amount1: bigint
  tick: number
  sqrtPriceX96: bigint
  inRange: boolean
  claimFeeBps: number
  claimPaused: boolean
  observedBlock: bigint
}

/** Candidate IDs may come from an index; every fact used by the strategy comes from chain reads. */
export async function readFablesPosition(
  client: PublicClient, args: { owner: Address; hook: Address; rangeId: bigint; pools?: readonly FablesPool[]; allowEmpty?: boolean },
): Promise<FablesPosition> {
  if (!fablesHook(args.hook)) throw new Error('E_FABLES_HOOK_UNREVIEWED')
  const observedBlock = await client.getBlockNumber()
  const owner = getAddress(args.owner)
  const hook = getAddress(args.hook)
  const [rangeKey, shares, view, pools] = await Promise.all([
    client.readContract({ address: hook, abi: fablesHookAbi, functionName: 'rangeKey', args: [args.rangeId], blockNumber: observedBlock }),
    client.readContract({ address: hook, abi: fablesHookAbi, functionName: 'balanceOf', args: [owner, args.rangeId], blockNumber: observedBlock }),
    client.readContract({ address: FABLES_LENS, abi: fablesLensAbi, functionName: 'userRanges', args: [hook, owner, [args.rangeId]], blockNumber: observedBlock }),
    args.pools ?? readFablesPools(client, observedBlock),
  ])
  const [rawKey, tickLower, tickUpper, set] = rangeKey
  if (!set || rawKey.hooks.toLowerCase() !== hook.toLowerCase()) throw new Error('E_FABLES_RANGE_IDENTITY')
  const key: FablesPoolKey = {
    currency0: getAddress(rawKey.currency0), currency1: getAddress(rawKey.currency1),
    fee: Number(rawKey.fee), tickSpacing: Number(rawKey.tickSpacing), hooks: hook,
  }
  const poolId = v4PoolId(key)
  if (fablesRangeId(poolId, Number(tickLower), Number(tickUpper)) !== args.rangeId)
    throw new Error('E_FABLES_RANGE_IDENTITY')
  const pool = pools.find(item => item.id.toLowerCase() === poolId.toLowerCase())
  if (!pool || !pool.active || JSON.stringify(pool.key).toLowerCase() !== JSON.stringify(key).toLowerCase())
    throw new Error('E_FABLES_POOL_IDENTITY')
  if (!pool.reviewed) throw new Error('E_FABLES_POOL_UNREVIEWED')
  const row = view[0][0]
  if (!row || !row.keyVerified || row.rangeId !== args.rangeId || row.shares !== shares
    || row.tickLower !== tickLower || row.tickUpper !== tickUpper
    || row.key.currency0.toLowerCase() !== key.currency0.toLowerCase()
    || row.key.currency1.toLowerCase() !== key.currency1.toLowerCase()
    || row.key.fee !== key.fee || row.key.tickSpacing !== key.tickSpacing
    || row.key.hooks.toLowerCase() !== hook.toLowerCase()
    || row.totalShares < shares || row.sqrtPriceX96 <= 0n
    || row.inRange !== (row.tick >= tickLower && row.tick < tickUpper))
    throw new Error('E_FABLES_POSITION_MISMATCH')
  if (!args.allowEmpty && shares === 0n && row.claimable0 === 0n && row.claimable1 === 0n)
    throw new Error('E_FABLES_POSITION_EMPTY')
  return {
    owner, pool, rangeId: args.rangeId, tickLower: Number(tickLower), tickUpper: Number(tickUpper),
    shares, totalShares: row.totalShares, staked: row.staked,
    claimable0: row.claimable0, claimable1: row.claimable1,
    amount0: row.amount0, amount1: row.amount1,
    tick: Number(row.tick), sqrtPriceX96: row.sqrtPriceX96, inRange: row.inRange,
    claimFeeBps: Number(row.effectiveClaimFeeBps), claimPaused: row.claimPaused,
    observedBlock,
  }
}

/** UI read path allows any reviewed hook. Automatic writes have a stricter pool allowlist. */
export function fablesHookSupportsCombinedExit(hook: Address): boolean {
  return !!(FABLES_HOOKS[hook.toLowerCase() as keyof typeof FABLES_HOOKS]?.withdrawAndClaim)
}
