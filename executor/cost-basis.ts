import { parseAbiItem, zeroAddress, type Address, type TransactionReceipt } from 'viem'
import type { StrategyConfig, StrategyPositionSnapshot } from '../shared/strategy/types'
import { firstExistingBlock } from '../shared/strategy/cost-basis'
import { clPmAbi, clPoolAbi, uniV3PmAbi, uniV3PoolAbi } from '../src/abi'
import { v4Deployment } from '../src/config/networks'
import { v4PositionManagerAbi, v4StateViewAbi } from '../src/lib/uniV4'
import { publicClient } from './chain'
import { receiptLiquidityFlows, receiptTokenDelta } from './receipts'
import { quoteTurnover } from './risk'

export type OriginalMintCostBasis = {
  kind: 'original_mint'
  tokenId: string
  txHash: string
  blockNumber: string
  observedAt: number
  tick: number
  sqrtPriceX96: string
  amount0: string
  amount1: string
  valueQuoteRaw: string
  openingGasQuoteRaw: string
}

const isV4 = (config: StrategyConfig): boolean => config.protocol === 'univ4'

/** `ownerOf` lives on every position manager; the ABI is what differs. */
function positionManagerAbi(config: StrategyConfig) {
  if (config.protocol === 'up33') return clPmAbi
  if (config.protocol === 'univ4') return v4PositionManagerAbi
  return uniV3PmAbi
}

async function ownerExistsAt(config: StrategyConfig, tokenId: bigint, blockNumber: bigint): Promise<boolean> {
  const abi = positionManagerAbi(config)
  try {
    await publicClient.readContract({ address: config.positionManager, abi, functionName: 'ownerOf', args: [tokenId], blockNumber })
    return true
  } catch {
    return false
  }
}

/** Locate the first block in which the NFT exists without a wide eth_getLogs request. */
async function originalMintBlock(config: StrategyConfig, tokenId: bigint, upperBlock: bigint): Promise<bigint> {
  return firstExistingBlock(upperBlock, (blockNumber) => ownerExistsAt(config, tokenId, blockNumber))
}

/** v4 pool state at the mint block: v4 has no pool contract; ask StateView. */
async function v4Slot0(config: StrategyConfig, blockNumber: bigint): Promise<readonly [bigint, number]> {
  if (!config.poolId) throw new Error('v4 strategy is missing its poolId')
  const slot0 = (await publicClient.readContract({
    address: v4Deployment(config.chainId).STATE_VIEW,
    abi: v4StateViewAbi,
    functionName: 'getSlot0',
    args: [config.poolId],
    blockNumber,
  })) as unknown as readonly [bigint, number, number, number]
  return [slot0[0], slot0[1]]
}

/**
 * The amounts paid into a v4 position's original mint, which no IncreaseLiquidity
 * event records. A native side is the transaction's own value; each ERC-20 side
 * is the owner's net wallet outflow in that receipt.
 */
function v4MintFlows(
  receipt: TransactionReceipt,
  config: StrategyConfig,
  mintTx: { value: bigint } | null,
  tokenId: bigint,
  token0: Address,
  token1: Address,
): { mintedTokenId: bigint; minted0: bigint; minted1: bigint } {
  const paid = (token: Address): bigint =>
    token.toLowerCase() === zeroAddress
      ? (mintTx?.value ?? 0n)
      : -receiptTokenDelta(receipt, token, config.owner)
  return { mintedTokenId: tokenId, minted0: paid(token0), minted1: paid(token1) }
}

/** Reconstruct the actual token amounts paid into the NFT in its mint receipt. */
export async function reconstructOriginalMintCostBasis(
  config: StrategyConfig,
  snapshot: StrategyPositionSnapshot,
  tokenIdRaw: string,
  upperBlockRaw: string,
): Promise<OriginalMintCostBasis> {
  const tokenId = BigInt(tokenIdRaw)
  const mintBlock = await originalMintBlock(config, tokenId, BigInt(upperBlockRaw))
  const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)')
  const logs = await publicClient.getLogs({
    address: config.positionManager,
    event: transfer,
    args: { from: zeroAddress, tokenId },
    fromBlock: mintBlock,
    toBlock: mintBlock,
  })
  const txHash = logs[0]?.transactionHash
  if (!txHash) throw new Error('position mint transaction was not found')
  const [receipt, poolState, block, mintTx] = await Promise.all([
    publicClient.getTransactionReceipt({ hash: txHash }),
    isV4(config)
      ? v4Slot0(config, mintBlock)
      : publicClient.readContract({
          address: config.pool,
          abi: config.protocol === 'up33' ? clPoolAbi : uniV3PoolAbi,
          functionName: 'slot0',
          blockNumber: mintBlock,
        }),
    publicClient.getBlock({ blockNumber: mintBlock }),
    isV4(config) ? publicClient.getTransaction({ hash: txHash }) : Promise.resolve(null),
  ])
  const flows = isV4(config)
    ? v4MintFlows(receipt, config, mintTx, tokenId, snapshot.token0, snapshot.token1)
    : receiptLiquidityFlows(receipt, config.positionManager, tokenId)
  if (flows.mintedTokenId !== tokenId || (flows.minted0 === 0n && flows.minted1 === 0n))
    throw new Error('position mint amounts were not found in the mint receipt')
  const state = poolState as unknown as readonly [bigint, number]
  const value = quoteTurnover(flows.minted0, snapshot.token0 as Address, config, snapshot, state[0])
    + quoteTurnover(flows.minted1, snapshot.token1 as Address, config, snapshot, state[0])
  const openingGas = receipt.gasUsed * receipt.effectiveGasPrice
  return {
    kind: 'original_mint',
    tokenId: tokenId.toString(),
    txHash,
    blockNumber: mintBlock.toString(),
    observedAt: Number(block.timestamp),
    tick: Number(state[1]),
    sqrtPriceX96: state[0].toString(),
    amount0: flows.minted0.toString(),
    amount1: flows.minted1.toString(),
    valueQuoteRaw: value.toString(),
    openingGasQuoteRaw: openingGas.toString(),
  }
}
