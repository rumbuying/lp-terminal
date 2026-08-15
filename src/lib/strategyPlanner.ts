import type { Address } from 'viem'
import { ADDR, UNI } from '../config/addresses'
import type { ClPosition, TokenInfo } from '../types'
import type { StrategyConfig, StrategyPositionSnapshot } from '../../shared/strategy/types'

const token = (tokens: Record<string, TokenInfo>, address: Address): TokenInfo | undefined => tokens[address.toLowerCase()]

/** Converts the currently rendered chain result into the JSON-safe core snapshot. */
export function snapshotFromPosition(args: {
  config: StrategyConfig
  position: ClPosition
  owner: Address
  tokens: Record<string, TokenInfo>
  blockNumber?: bigint
  observedAt?: number
}): StrategyPositionSnapshot {
  const { position } = args
  const token0 = token(args.tokens, position.pool.token0)
  const token1 = token(args.tokens, position.pool.token1)
  if (!token0 || !token1) throw new Error('token metadata is unavailable; refresh pools and retry')
  return {
    chainId: 4663,
    observedAt: args.observedAt ?? Math.floor(Date.now() / 1000),
    blockNumber: (args.blockNumber ?? 0n).toString(),
    owner: args.owner,
    protocol: position.pool.protocol,
    pool: position.pool.address,
    positionManager: position.pool.protocol === 'up33' ? ADDR.CL_PM : UNI.V3_NPM,
    tokenId: position.tokenId.toString(),
    token0: position.pool.token0,
    token1: position.pool.token1,
    token0Decimals: token0.decimals,
    token1Decimals: token1.decimals,
    tickSpacing: position.pool.tickSpacing,
    feePpm: position.pool.feePpm,
    unstakedFeePpm: position.pool.unstakedFeePpm,
    tick: position.pool.tick,
    sqrtPriceX96: position.pool.sqrtPriceX96.toString(),
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    liquidity: position.liquidity.toString(),
    tokensOwed0: position.fees0.toString(),
    tokensOwed1: position.fees1.toString(),
    staked: position.staked,
    gauge: position.staked ? position.pool.gauge ?? undefined : undefined,
    nftOwner: position.staked ? position.pool.gauge ?? undefined : args.owner,
    rewardOwed: position.staked ? position.earned.toString() : '0',
  }
}
