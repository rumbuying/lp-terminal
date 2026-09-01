import { encodeFunctionData, type Address, type Hex } from 'viem'
import { clGaugeAbi, clPmAbi, erc20Abi, uniV3PmAbi } from '../src/abi'
import { getLiquidityForAmounts, getSqrtRatioAtTick, minAmountsForLiquidity } from '../src/lib/clmath'
import {
  encodeV4Collect,
  encodeV4Decrease,
  encodeV4Mint,
  permit2Abi,
  v4PositionManagerAbi,
  v4IncreasePlan,
  v4PoolId,
  type V4PoolKey,
} from '../src/lib/uniV4'
import type { StrategyConfig, StrategyPositionSnapshot } from '../shared/strategy/types'

export type ContractCall = { to: Address; data: Hex; value: bigint }
// The v3/up33 builders below must never build for a v4 strategy: v4 has no
// `decreaseLiquidity`/`collect`/`burn`/`multicall` on its PositionManager, and
// its liquidity writes go through `modifyLiquidities` (the v4* builders above).
// Fail loud so a future caller cannot hand v4 a wrong-ABI transaction.
function abiFor(config: StrategyConfig) {
  if (config.protocol === 'univ4') throw new Error('E_V4_USE_V4_BUILDER')
  return config.protocol === 'up33' ? clPmAbi : uniV3PmAbi
}
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 20 * 60)

function v4Key(snapshot: StrategyPositionSnapshot): V4PoolKey {
  if (snapshot.protocol !== 'univ4' || !snapshot.poolId) throw new Error('E_V4_POOL_IDENTITY')
  const key: V4PoolKey = {
    currency0: snapshot.token0,
    currency1: snapshot.token1,
    fee: snapshot.feePpm,
    tickSpacing: snapshot.tickSpacing,
    hooks: snapshot.hooks ?? ('0x0000000000000000000000000000000000000000' as Address),
  }
  if (v4PoolId(key).toLowerCase() !== snapshot.poolId.toLowerCase()) throw new Error('E_V4_POOL_IDENTITY')
  return key
}

export function v4DecreaseCall(config: StrategyConfig, snapshot: StrategyPositionSnapshot): ContractCall {
  const liquidity = BigInt(snapshot.liquidity)
  const mins = config.safeguards.enabled
    ? minAmountsForLiquidity(BigInt(snapshot.sqrtPriceX96), getSqrtRatioAtTick(snapshot.tickLower), getSqrtRatioAtTick(snapshot.tickUpper), liquidity, config.safeguards.maxSlippageBps)
    : { amount0Min: 0n, amount1Min: 0n }
  const call = encodeV4Decrease({ key: v4Key(snapshot), tokenId: BigInt(snapshot.tokenId), liquidity, ...mins })
  return {
    to: config.positionManager,
    data: encodeFunctionData({ abi: v4PositionManagerAbi, functionName: 'modifyLiquidities', args: [call.unlockData, deadline()] }),
    value: call.value,
  }
}

export function v4CollectCall(config: StrategyConfig, snapshot: StrategyPositionSnapshot): ContractCall {
  const call = encodeV4Collect({ key: v4Key(snapshot), tokenId: BigInt(snapshot.tokenId) })
  return { to: config.positionManager, data: encodeFunctionData({ abi: v4PositionManagerAbi, functionName: 'modifyLiquidities', args: [call.unlockData, deadline()] }), value: call.value }
}

export function v4MintCall(args: {
  config: StrategyConfig
  snapshot: StrategyPositionSnapshot
  tickLower: number
  tickUpper: number
  amount0Desired: bigint
  amount1Desired: bigint
  sqrtPriceX96: bigint
}): ContractCall {
  const liquidity = v4IncreasePlan({
    sqrtP: args.sqrtPriceX96,
    tickLower: args.tickLower,
    tickUpper: args.tickUpper,
    amount0: args.amount0Desired,
    amount1: args.amount1Desired,
  })
  if (liquidity <= 0n) throw new Error('E_MINT_ZERO_LIQUIDITY')
  const call = encodeV4Mint({
    key: v4Key(args.snapshot),
    tickLower: args.tickLower,
    tickUpper: args.tickUpper,
    liquidity,
    amount0Max: args.amount0Desired,
    amount1Max: args.amount1Desired,
    owner: args.config.owner,
  })
  return { to: args.config.positionManager, data: encodeFunctionData({ abi: v4PositionManagerAbi, functionName: 'modifyLiquidities', args: [call.unlockData, deadline()] }), value: call.value }
}

export function permit2ApprovalCall(permit2: Address, token: Address, spender: Address, amount: bigint, expiration: number): ContractCall {
  if (amount < 0n || amount >= 1n << 160n) throw new Error('E_PERMIT2_AMOUNT')
  return {
    to: permit2,
    data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [token, spender, amount, expiration] }),
    value: 0n,
  }
}

/** Build only from a fresh snapshot; callers send via the tracked signer. */
export function decreaseCall(config: StrategyConfig, snapshot: StrategyPositionSnapshot): ContractCall {
  const liquidity = BigInt(snapshot.liquidity)
  // A decrease is not a swap: it merely withdraws the position at the pool's
  // inclusion-block price. With guards explicitly disabled, non-zero minima
  // can only turn a fast price move between estimateGas and mining into a
  // needless revert (the original position remains unchanged). Guarded
  // strategies retain their configured band-edge slippage protection.
  const mins = config.safeguards.enabled
    ? minAmountsForLiquidity(BigInt(snapshot.sqrtPriceX96), getSqrtRatioAtTick(snapshot.tickLower), getSqrtRatioAtTick(snapshot.tickUpper), liquidity, config.safeguards.maxSlippageBps)
    : { amount0Min: 0n, amount1Min: 0n }
  return {
    to: config.positionManager,
    data: encodeFunctionData({ abi: abiFor(config), functionName: 'decreaseLiquidity', args: [{ tokenId: BigInt(snapshot.tokenId), liquidity, amount0Min: mins.amount0Min, amount1Min: mins.amount1Min, deadline: deadline() }] } as never),
    value: 0n,
  }
}

export function collectCall(config: StrategyConfig, tokenId: string): ContractCall {
  return {
    to: config.positionManager,
    data: encodeFunctionData({ abi: abiFor(config), functionName: 'collect', args: [{ tokenId: BigInt(tokenId), recipient: config.owner, amount0Max: (1n << 128n) - 1n, amount1Max: (1n << 128n) - 1n }] } as never),
    value: 0n,
  }
}

/** Atomically remove all liquidity and collect it into the owner wallet. */
export function decreaseCollectCall(config: StrategyConfig, snapshot: StrategyPositionSnapshot): ContractCall {
  const decrease = decreaseCall(config, snapshot)
  const collect = collectCall(config, snapshot.tokenId)
  return {
    to: config.positionManager,
    data: encodeFunctionData({ abi: abiFor(config), functionName: 'multicall', args: [[decrease.data, collect.data]] } as never),
    value: 0n,
  }
}

export function burnCall(config: StrategyConfig, tokenId: string): ContractCall {
  return { to: config.positionManager, data: encodeFunctionData({ abi: abiFor(config), functionName: 'burn', args: [BigInt(tokenId)] } as never), value: 0n }
}

/** Exact approval only; never grants unlimited allowance. */
export function exactApprovalCall(token: Address, spender: Address, amount: bigint): ContractCall {
  return { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }), value: 0n }
}

export function unstakeCall(gauge: Address, tokenId: string): ContractCall {
  return { to: gauge, data: encodeFunctionData({ abi: clGaugeAbi, functionName: 'withdraw', args: [BigInt(tokenId)] }), value: 0n }
}

export function nftApprovalCall(positionManager: Address, gauge: Address, tokenId: string): ContractCall {
  return { to: positionManager, data: encodeFunctionData({ abi: clPmAbi, functionName: 'approve', args: [gauge, BigInt(tokenId)] }), value: 0n }
}

export function nftOperatorApprovalCall(positionManager: Address, gauge: Address): ContractCall {
  return { to: positionManager, data: encodeFunctionData({ abi: clPmAbi, functionName: 'setApprovalForAll', args: [gauge, true] }), value: 0n }
}

export function stakeCall(gauge: Address, tokenId: string): ContractCall {
  return { to: gauge, data: encodeFunctionData({ abi: clGaugeAbi, functionName: 'deposit', args: [BigInt(tokenId)] }), value: 0n }
}

/** Mint uses actual post-swap balances; fee and tickSpacing are protocol-specific. */
export function mintCall(args: {
  config: StrategyConfig
  snapshot: StrategyPositionSnapshot
  tickLower: number
  tickUpper: number
  amount0Desired: bigint
  amount1Desired: bigint
  feePpm?: number
  sqrtPriceX96?: bigint
}): ContractCall {
  const { config, snapshot } = args
  if (config.protocol === 'univ4') {
    return v4MintCall({
      config,
      snapshot,
      tickLower: args.tickLower,
      tickUpper: args.tickUpper,
      amount0Desired: args.amount0Desired,
      amount1Desired: args.amount1Desired,
      sqrtPriceX96: args.sqrtPriceX96 ?? BigInt(snapshot.sqrtPriceX96),
    })
  }
  const sqrtPriceX96 = args.sqrtPriceX96 ?? BigInt(snapshot.sqrtPriceX96)
  const sqrtA = getSqrtRatioAtTick(args.tickLower)
  const sqrtB = getSqrtRatioAtTick(args.tickUpper)
  const liquidity = getLiquidityForAmounts(sqrtPriceX96, sqrtA, sqrtB, args.amount0Desired, args.amount1Desired)
  if (liquidity <= 0n) throw new Error('E_MINT_ZERO_LIQUIDITY')
  // Mint calldata is built from fresh balances and a fresh pool snapshot. In
  // unguarded mode, zero minima let the transaction consume the valid token
  // mix at its inclusion block instead of reverting after a volatile tick
  // jump. Desired amounts still cap what the position manager may spend.
  const mins = config.safeguards.enabled
    ? minAmountsForLiquidity(sqrtPriceX96, sqrtA, sqrtB, liquidity, config.safeguards.maxSlippageBps)
    : { amount0Min: 0n, amount1Min: 0n }
  const common = {
    token0: snapshot.token0,
    token1: snapshot.token1,
    tickLower: args.tickLower,
    tickUpper: args.tickUpper,
    amount0Desired: args.amount0Desired,
    amount1Desired: args.amount1Desired,
    amount0Min: mins.amount0Min,
    amount1Min: mins.amount1Min,
    recipient: config.owner,
    deadline: deadline(),
  }
  if (config.protocol === 'up33') {
    return { to: config.positionManager, data: encodeFunctionData({ abi: clPmAbi, functionName: 'mint', args: [{ ...common, tickSpacing: snapshot.tickSpacing, sqrtPriceX96: 0n }] }), value: 0n }
  }
  if (!Number.isInteger(args.feePpm) || !args.feePpm || args.feePpm < 1) throw new Error('E_UNIV3_FEE_REQUIRED')
  return { to: config.positionManager, data: encodeFunctionData({ abi: uniV3PmAbi, functionName: 'mint', args: [{ ...common, fee: args.feePpm }] }), value: 0n }
}
