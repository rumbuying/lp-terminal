import {
  encodeFunctionData, getAddress, keccak256, zeroAddress,
  type Address, type Hex, type PublicClient,
} from 'viem'
import { erc20Abi } from '../abi'
import { fablesHookAbi, fablesLensAbi } from '../abi/fables'
import {
  FABLES_AUTO_POOL_IDS, FABLES_LENS, FABLES_LENS_CODE_HASH,
  FABLES_REGISTRY, FABLES_REGISTRY_CODE_HASH, fablesHook,
} from '../config/fables'
import { robinhoodConfig } from '../config/chains/robinhood'
import { getAmountsForLiquidity, getLiquidityForAmounts, getSqrtRatioAtTick } from './clmath'
import { fablesRangeId, readFablesPools, readFablesPosition, type FablesPool } from './fables'
import { quoteFablesExit } from './fablesExitQuote'
import { v4StateViewAbi } from './uniV4'

const MAX_UINT128 = (1n << 128n) - 1n
export type FablesCall = {
  to: Address
  data: Hex
  value: bigint
  method: 'withdraw' | 'withdrawAndClaim' | 'claimFees' | 'deposit'
  poolId: Hex
  rangeId: bigint
  observedBlock: bigint
}

function autoPool(pool: FablesPool): void {
  if (!pool.active || !pool.reviewed || !FABLES_AUTO_POOL_IDS.has(pool.id.toLowerCase()))
    throw new Error('E_FABLES_AUTO_POOL_NOT_APPROVED')
}

async function verifyCode(client: PublicClient, address: Address, expected: Hex): Promise<void> {
  const code = await client.getCode({ address })
  if (!code || keccak256(code).toLowerCase() !== expected.toLowerCase())
    throw new Error(`E_FABLES_CODE_CHANGED:${address}`)
}

/** Every signing path repeats the pinned runtime checks. */
async function verifyDeployment(client: PublicClient, hook: Address): Promise<void> {
  if (await client.getChainId() !== 4663) throw new Error('E_FABLES_CHAIN')
  const reviewed = fablesHook(hook)
  if (!reviewed) throw new Error('E_FABLES_HOOK_UNREVIEWED')
  await Promise.all([
    verifyCode(client, FABLES_REGISTRY, FABLES_REGISTRY_CODE_HASH),
    verifyCode(client, FABLES_LENS, FABLES_LENS_CODE_HASH),
    verifyCode(client, hook, reviewed.codeHash),
  ])
}

async function deadlineAt(client: PublicClient, observedBlock: bigint, lifetimeSeconds: number): Promise<bigint> {
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 30 || lifetimeSeconds > 600)
    throw new Error('E_FABLES_DEADLINE')
  const block = await client.getBlock({ blockNumber: observedBlock })
  return block.timestamp + BigInt(lifetimeSeconds)
}

/** Build a full-share exit only after a fresh quote and current bytecode check. */
export async function prepareFablesExitCall(client: PublicClient, args: {
  owner: Address
  hook: Address
  rangeId: bigint
  slippageBps: number
  maxClaimFeeBps: number
  lifetimeSeconds: number
  /** Legacy hooks have no on-chain fee bound on withdraw; require explicit consent. */
  allowLegacyUnboundedFeeExit?: boolean
}): Promise<FablesCall> {
  const quote = await quoteFablesExit(client, args)
  const position = quote.position
  autoPool(position.pool)
  if (!Number.isInteger(args.maxClaimFeeBps) || args.maxClaimFeeBps < 0 || args.maxClaimFeeBps > 10_000
    || quote.maxFeeBpsToPass > args.maxClaimFeeBps)
    throw new Error('E_FABLES_CLAIM_FEE_BOUND')
  if (quote.exitMethod === 'withdraw' && !args.allowLegacyUnboundedFeeExit)
    throw new Error('E_FABLES_LEGACY_FEE_CONSENT')
  await verifyDeployment(client, position.pool.key.hooks)
  const deadline = await deadlineAt(client, position.observedBlock, args.lifetimeSeconds)
  const common = [
    position.pool.key, position.tickLower, position.tickUpper, position.shares,
    getAddress(args.owner), quote.amount0Min, quote.amount1Min, deadline,
  ] as const
  const data = quote.exitMethod === 'withdrawAndClaim'
    ? encodeFunctionData({ abi: fablesHookAbi, functionName: 'withdrawAndClaim',
      args: [...common, quote.maxFeeBpsToPass] })
    : encodeFunctionData({ abi: fablesHookAbi, functionName: 'withdraw', args: common })
  return {
    to: position.pool.key.hooks, data, value: 0n, method: quote.exitMethod,
    poolId: position.pool.id, rangeId: position.rangeId, observedBlock: position.observedBlock,
  }
}

/** Claim accrued fees after a legacy withdrawal, including when shares are zero. */
export async function prepareFablesClaimCall(client: PublicClient, args: {
  owner: Address; hook: Address; rangeId: bigint; maxClaimFeeBps: number
}): Promise<FablesCall> {
  const position = await readFablesPosition(client, args)
  autoPool(position.pool)
  if (position.claimPaused) throw new Error('E_FABLES_CLAIM_PAUSED')
  const [claim] = await client.readContract({
    address: FABLES_LENS, abi: fablesLensAbi, functionName: 'canClaim',
    args: [position.owner, position.pool.key, position.tickLower, position.tickUpper],
    blockNumber: position.observedBlock,
  })
  if (!claim.ok || !claim.rangeExists || claim.paused || !claim.hasClaimable)
    throw new Error('E_FABLES_NO_CLAIM')
  if (!Number.isInteger(args.maxClaimFeeBps) || args.maxClaimFeeBps < 0
    || claim.maxFeeBpsToPass > args.maxClaimFeeBps)
    throw new Error('E_FABLES_CLAIM_FEE_BOUND')
  await verifyDeployment(client, position.pool.key.hooks)
  return {
    to: position.pool.key.hooks,
    data: encodeFunctionData({ abi: fablesHookAbi, functionName: 'claimFees',
      args: [position.pool.key, position.tickLower, position.tickUpper, position.owner, claim.maxFeeBpsToPass] }),
    value: 0n, method: 'claimFees', poolId: position.pool.id,
    rangeId: position.rangeId, observedBlock: position.observedBlock,
  }
}

/**
 * Build a deposit from bounded, cycle-owned budgets after the final swap.
 * The caller must ensure these budgets exclude unrelated wallet funds.
 */
export async function prepareFablesDepositCall(client: PublicClient, args: {
  owner: Address
  poolId: Hex
  tickLower: number
  tickUpper: number
  budget0: bigint
  budget1: bigint
  nativeGasReserve: bigint
  lifetimeSeconds: number
}): Promise<FablesCall & { liquidity: bigint; expected0: bigint; expected1: bigint }> {
  const observedBlock = await client.getBlockNumber()
  const pools = await readFablesPools(client, observedBlock)
  const pool = pools.find(row => row.id.toLowerCase() === args.poolId.toLowerCase())
  if (!pool) throw new Error('E_FABLES_POOL_IDENTITY')
  autoPool(pool)
  if (!Number.isInteger(args.tickLower) || !Number.isInteger(args.tickUpper)
    || args.tickLower >= args.tickUpper
    || args.tickLower % pool.key.tickSpacing !== 0 || args.tickUpper % pool.key.tickSpacing !== 0)
    throw new Error('E_FABLES_TICKS')
  if (args.budget0 < 0n || args.budget1 < 0n || args.budget0 > MAX_UINT128 || args.budget1 > MAX_UINT128
    || args.nativeGasReserve < 0n)
    throw new Error('E_FABLES_BUDGET')
  const deployment = robinhoodConfig.uniV4
  if (!deployment) throw new Error('E_FABLES_V4_DEPLOYMENT')
  const [slot0, wallet0, wallet1] = await Promise.all([
    client.readContract({ address: deployment.STATE_VIEW, abi: v4StateViewAbi,
      functionName: 'getSlot0', args: [pool.id], blockNumber: observedBlock }),
    pool.key.currency0 === zeroAddress
      ? client.getBalance({ address: args.owner, blockNumber: observedBlock })
      : client.readContract({ address: pool.key.currency0, abi: erc20Abi,
        functionName: 'balanceOf', args: [args.owner], blockNumber: observedBlock }),
    client.readContract({ address: pool.key.currency1, abi: erc20Abi,
      functionName: 'balanceOf', args: [args.owner], blockNumber: observedBlock }),
  ])
  if (slot0[0] <= 0n || args.budget0 + (pool.key.currency0 === zeroAddress ? args.nativeGasReserve : 0n) > wallet0
    || args.budget1 > wallet1)
    throw new Error('E_FABLES_WALLET_BUDGET')
  const sqrtA = getSqrtRatioAtTick(args.tickLower)
  const sqrtB = getSqrtRatioAtTick(args.tickUpper)
  const liquidity = getLiquidityForAmounts(slot0[0], sqrtA, sqrtB, args.budget0, args.budget1)
  if (liquidity <= 0n || liquidity > MAX_UINT128) throw new Error('E_FABLES_DEPOSIT_LIQUIDITY')
  const expected = getAmountsForLiquidity(slot0[0], sqrtA, sqrtB, liquidity)
  if (expected.amount0 > args.budget0 || expected.amount1 > args.budget1)
    throw new Error('E_FABLES_DEPOSIT_AMOUNTS')
  await verifyDeployment(client, pool.key.hooks)
  const deadline = await deadlineAt(client, observedBlock, args.lifetimeSeconds)
  return {
    to: pool.key.hooks,
    data: encodeFunctionData({ abi: fablesHookAbi, functionName: 'deposit',
      args: [pool.key, args.tickLower, args.tickUpper, liquidity,
        args.budget0, args.budget1, deadline] }),
    value: pool.key.currency0 === zeroAddress ? args.budget0 : 0n,
    method: 'deposit', poolId: pool.id,
    rangeId: fablesRangeId(pool.id, args.tickLower, args.tickUpper), observedBlock,
    liquidity, expected0: expected.amount0, expected1: expected.amount1,
  }
}
