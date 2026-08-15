import { encodeFunctionData, type Address, type Hex } from 'viem'
import { clGaugeAbi, clPmAbi, erc20Abi, uniV3PmAbi } from '../src/abi'
import { getLiquidityForAmounts, getSqrtRatioAtTick, minAmountsForLiquidity } from '../src/lib/clmath'
import type { StrategyConfig, StrategyPositionSnapshot } from '../shared/strategy/types'

export type ContractCall = { to: Address; data: Hex; value: bigint }
const abiFor = (config: StrategyConfig) => (config.protocol === 'up33' ? clPmAbi : uniV3PmAbi)
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 20 * 60)

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
