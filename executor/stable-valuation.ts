import { parseAbiItem, type Address } from 'viem'
import { uniV3PoolAbi } from '../src/abi'
import { ADDR, UNI } from '../src/config/addresses'
import { publicClient } from './chain'
import { quoteKyber } from './kyber'

const Q192 = 1n << 192n
const HISTORY_WINDOW_BLOCKS = 100_000n
const HISTORY_WINDOWS = 12
const low = (value: string) => value.toLowerCase()

const swapEvent = parseAbiItem(
  'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
)

const historicalSqrtCache = new Map<string, Promise<bigint>>()

/** WETH is token0 and USDG is token1 in the canonical anchor pool. */
export function wethValueUsdgAtSqrt(amountWethRaw: bigint, sqrtPriceX96: bigint): bigint {
  if (amountWethRaw <= 0n) return 0n
  return (amountWethRaw * sqrtPriceX96 * sqrtPriceX96) / Q192
}

export function usdgValueWethAtSqrt(amountUsdgRaw: bigint, sqrtPriceX96: bigint): bigint {
  if (amountUsdgRaw <= 0n || sqrtPriceX96 <= 0n) return 0n
  return (amountUsdgRaw * Q192) / (sqrtPriceX96 * sqrtPriceX96)
}

async function currentWethSqrtPrice(): Promise<bigint> {
  const slot0 = await publicClient.readContract({
    address: UNI.V3_WETH_USDG_POOL,
    abi: uniV3PoolAbi,
    functionName: 'slot0',
  })
  return slot0[0]
}

export async function currentUsdgValueInWeth(amountUsdgRaw: bigint): Promise<bigint> {
  return usdgValueWethAtSqrt(amountUsdgRaw, await currentWethSqrtPrice())
}

async function historicalWethSqrtPrice(blockNumber: bigint): Promise<bigint> {
  const key = blockNumber.toString()
  const existing = historicalSqrtCache.get(key)
  if (existing) return existing
  const pending = (async () => {
    // Historical eth_call is unavailable on some production RPCs, while old
    // logs remain queryable. The latest Swap at or before the baseline is the
    // exact slot0 price that remained active at that block.
    let toBlock = blockNumber
    for (let index = 0; index < HISTORY_WINDOWS && toBlock >= 0n; index++) {
      const fromBlock = toBlock >= HISTORY_WINDOW_BLOCKS ? toBlock - HISTORY_WINDOW_BLOCKS + 1n : 0n
      const logs = await publicClient.getLogs({
        address: UNI.V3_WETH_USDG_POOL,
        event: swapEvent,
        fromBlock,
        toBlock,
      })
      const latest = logs.at(-1)
      if (latest?.args.sqrtPriceX96 !== undefined) return latest.args.sqrtPriceX96
      if (fromBlock === 0n) break
      toBlock = fromBlock - 1n
    }
    throw new Error('stable baseline price unavailable')
  })().catch((error) => {
    historicalSqrtCache.delete(key)
    throw error
  })
  historicalSqrtCache.set(key, pending)
  return pending
}

/** Mark a quote-token amount in 6-decimal USDG at the current market. */
export async function quoteValueInUsdg(amountQuoteRaw: bigint, quoteToken: Address): Promise<bigint> {
  if (amountQuoteRaw <= 0n) return 0n
  if (low(quoteToken) === low(ADDR.USDG)) return amountQuoteRaw
  if (low(quoteToken) === low(ADDR.WETH)) return wethValueUsdgAtSqrt(amountQuoteRaw, await currentWethSqrtPrice())
  return BigInt((await quoteKyber(quoteToken, ADDR.USDG, amountQuoteRaw)).routeSummary.amountOut)
}

/** Recover a strategy-start USDG mark without substituting today's price. */
export async function historicalQuoteValueInUsdg(
  amountQuoteRaw: bigint,
  quoteToken: Address,
  blockNumber: bigint,
): Promise<bigint> {
  if (amountQuoteRaw <= 0n) return 0n
  if (low(quoteToken) === low(ADDR.USDG)) return amountQuoteRaw
  if (low(quoteToken) !== low(ADDR.WETH)) throw new Error('historical stable mark unsupported for quote token')
  return wethValueUsdgAtSqrt(amountQuoteRaw, await historicalWethSqrtPrice(blockNumber))
}
