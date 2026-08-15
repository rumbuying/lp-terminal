import { parseAbiItem, zeroAddress, type Address } from 'viem'
import type { StrategyConfig, StrategyPositionSnapshot } from '../shared/strategy/types'
import { firstExistingBlock } from '../shared/strategy/cost-basis'
import { clPmAbi, clPoolAbi, uniV3PmAbi, uniV3PoolAbi } from '../src/abi'
import { publicClient } from './chain'
import { receiptLiquidityFlows } from './receipts'
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

async function ownerExistsAt(config: StrategyConfig, tokenId: bigint, blockNumber: bigint): Promise<boolean> {
  const abi = config.protocol === 'up33' ? clPmAbi : uniV3PmAbi
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
  const [receipt, poolState, block] = await Promise.all([
    publicClient.getTransactionReceipt({ hash: txHash }),
    publicClient.readContract({
      address: config.pool,
      abi: config.protocol === 'up33' ? clPoolAbi : uniV3PoolAbi,
      functionName: 'slot0',
      blockNumber: mintBlock,
    }),
    publicClient.getBlock({ blockNumber: mintBlock }),
  ])
  const flows = receiptLiquidityFlows(receipt, config.positionManager, tokenId)
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
