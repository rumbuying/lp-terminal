// v4 position OWNERSHIP for a chain with no position subgraph.
//
// The PositionManager mints ERC-721s but implements no enumeration, and this
// chain publishes no subgraph that indexes ownership, so the only way to answer
// "which token ids does this wallet own" is to replay the PositionManager's own
// Transfer logs into an owner-keyed table. That is exactly what the pool
// directory does for Initialize logs — same adaptive windows, same durable
// cursor, same finalized-head discipline. The one difference is what a replay
// is: a Transfer is an UPSERT of an existing row rather than a first-seen
// INSERT, so the tail is idempotent by construction and needs no round-trip
// verification or behind-cursor rejection.
import { numberToHex, toEventSelector } from 'viem'
import { scanAdaptiveLogWindows } from './adaptiveLogs'
import { CHAIN, INDEXER_FINALITY_BLOCKS, V4, log } from './config'
import { pc, withRotatingRpcClient } from './rpc'
import { applyV4Transfer, kvGet, kvSet, tx } from './store'

/** ERC-721 Transfer; all three parameters are indexed, so the log has no data. */
const TRANSFER = toEventSelector('Transfer(address,address,uint256)')

const positiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

// Same generous start as the pool scan: a logs-capable provider answers a wide
// range for a single low-volume contract in one request, and the adaptive
// scanner halves on rejection anyway.
const RPC_WINDOW_BLOCKS = positiveInt(process.env.INDEXER_V4_RPC_WINDOW_BLOCKS, 500_000)

type TransferLog = { topics: `0x${string}`[]; blockNumber: `0x${string}` }

function positionIndex(): { POSITION_MANAGER: `0x${string}`; genesisBlock: number } {
  if (!V4?.positionRpcIndex)
    throw new Error(`${CHAIN.key} has no RPC-sourced Uniswap V4 position index`)
  return { POSITION_MANAGER: V4.POSITION_MANAGER, ...V4.positionRpcIndex }
}

/** An indexed address topic's trailing 20 bytes, lowercased. */
function addressWord(topic: string): string {
  const word = topic.slice(2)
  if (word.length !== 64) throw new Error('malformed Transfer topic')
  return `0x${word.slice(24)}`.toLowerCase()
}

/** The ERC-721 id from a uint256 topic, as a safe JS integer. */
function tokenIdOf(topic: string): number {
  const id = BigInt(topic)
  if (id > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`Transfer tokenId ${topic} exceeds the safe-integer range`)
  return Number(id)
}

/**
 * Replay PositionManager Transfers up to the finalized head. The first run
 * starts at the configured genesis and is the whole history; later runs resume
 * from the durable cursor.
 */
export async function tailV4Positions(): Promise<number> {
  const { POSITION_MANAGER, genesisBlock } = positionIndex()
  const head = Number(await pc.getBlockNumber()) - INDEXER_FINALITY_BLOCKS
  if (!Number.isSafeInteger(head) || head <= 0)
    throw new Error('invalid finalized target block for the V4 position index')
  const stored = Number(kvGet('v4_position_cursor'))
  const cursor = Number.isSafeInteger(stored) && stored > 0 ? stored : genesisBlock - 1
  if (cursor > head)
    throw new Error(
      `univ4 position cursor ${cursor} is ahead of finalized head ${head}; refusing a destructive rewind`,
    )
  let applied = 0
  await scanAdaptiveLogWindows<TransferLog[]>({
    fromBlock: cursor + 1,
    toBlock: head,
    maxWindowBlocks: RPC_WINDOW_BLOCKS,
    fetchWindow: async (lo, hi) =>
      (await withRotatingRpcClient((client) =>
        client.request({
          method: 'eth_getLogs',
          params: [
            {
              address: POSITION_MANAGER,
              topics: [TRANSFER],
              fromBlock: numberToHex(lo),
              toBlock: numberToHex(hi),
            },
          ],
        }),
      )) as TransferLog[],
    commitWindow: ({ toBlock, rows }) => {
      tx(() => {
        for (const row of rows) {
          if (row.topics.length !== 4) throw new Error('malformed Transfer log: expected 4 topics')
          const block = Number(row.blockNumber)
          if (!Number.isSafeInteger(block))
            throw new Error('v4 PositionManager Transfer has an invalid block number')
          // Transfer(address from, address to, uint256 tokenId):
          // topics[1]=from, topics[2]=to, topics[3]=tokenId. Only `to` matters.
          applyV4Transfer(tokenIdOf(row.topics[3]), addressWord(row.topics[2]), block)
        }
        kvSet('v4_position_cursor', String(toBlock))
      })
      applied += rows.length
    },
    onShrink: (windowBlocks) =>
      log(`[catalog] RPC log range rejected; shrinking v4 position window to ${windowBlocks} blocks`),
    singleBlockError:
      'RPC rejects even a one-block v4 PositionManager eth_getLogs request; configure a logs-capable indexer RPC',
  })
  // A completed scan to the finalized head means the replay is caught up. This
  // flag is what the API's readiness gate reads, so the tail sets it too — not
  // just the boot backfill.
  kvSet('v4_positions_backfilled', '1')
  return applied
}

/** First-run entry point; the tail is the whole history, so this is it. */
export async function backfillV4Positions(): Promise<number> {
  const applied = await tailV4Positions()
  kvSet('v4_positions_backfilled', '1')
  log(`[catalog] univ4 position index: ${applied} Transfer events replayed`)
  return applied
}
