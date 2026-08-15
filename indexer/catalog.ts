// Pool catalog. Direct factory enumeration/logs are independent completeness
// roots where available. Pancake V3's historical completeness root is its
// pinned Graph snapshot; on-chain factory reads prove each imported row is
// authentic but cannot prove that the candidate set omitted no real pools.
//
//   univ3: BSC bootstraps from a canonical block-hash-pinned The Graph snapshot,
//          verifies every row against the official factory, then tails
//          PoolCreated over RPC.
//          Blockscout chains retain their log backfill and use the same RPC tail.
//   pancakev3: BSC follows the same verified Graph snapshot + RPC-tail model.
//   v2:    each official factory keeps an allPairs array. BSC Pancake V2 uses a
//          block/hash/count-pinned Ankr log snapshot for its first 2.6M rows,
//          then the same allPairs cursor as every other V2 venue for live tail.
import { parseAbiItem, toEventSelector } from 'viem'
import { uniV2FactoryAbi, uniV2PairAbi } from '../src/abi'
import { scanAdaptiveLogWindows } from './adaptiveLogs'
import {
  BLOCKSCOUT,
  CHAIN,
  ADDR,
  INDEXER_FINALITY_BLOCKS,
  log,
  PANCAKE_V3_START_BLOCK,
  sleep,
  UNI,
  UNI_V3_START_BLOCK,
} from './config'
import { mc, ok, pc, withRotatingRpcClient } from './rpc'
import { insertPool, kvGet, kvSet, tx } from './store'
import {
  hasCompletePancakeV3GraphSnapshot,
  importBscPancakeV3Snapshot,
} from './pancakeV3Subgraph'
import { hasCompleteV3GraphSnapshot, importBscV3Snapshot } from './v3Subgraph'
import { ensureBscPancakeV2AdvancedSnapshot } from './pancakeV2Advanced'

const POOL_CREATED = parseAbiItem(
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
)
const POOL_CREATED_TOPIC = toEventSelector(POOL_CREATED)

const positiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

// BSC RPC only scans the short post-snapshot tail. The 1,000-block cap matches
// common BSC providers; concurrency fans that bounded tail across dedicated
// indexer endpoints. Other providers/operators can override both values.
const V3_RPC_WINDOW_BLOCKS = positiveInt(
  process.env.INDEXER_BACKFILL_WINDOW_BLOCKS,
  CHAIN.id === 56 ? 1_000 : 9_001,
)
const V3_RPC_CONCURRENCY = positiveInt(
  process.env.INDEXER_BACKFILL_CONCURRENCY,
  CHAIN.id === 56 ? 8 : 1,
)
// Discovery writes every row, but callers only need a bounded set for the
// immediate metadata/state refresh. This prevents a first Pancake V2 import
// from retaining millions of address strings in V8 at once.
const V2_FRESH_ADDRESS_LIMIT = positiveInt(
  process.env.INDEXER_CATALOG_FRESH_ADDRESS_LIMIT,
  1_000,
)

const hexInt = (x: string | number) => (typeof x === 'number' ? x : parseInt(x, 16))
const addrOfTopic = (t: string) => ('0x' + t.slice(-40)).toLowerCase()

async function bsJson(url: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'up33-lp-indexer/0.1' },
      })
      const text = await r.text()
      if (text.trim()) return JSON.parse(text)
    } catch {
      /* retry below */
    }
    await sleep(1_200 * (i + 1))
  }
  throw new Error('blockscout: no response after retries')
}

type BsLog = { topics: string[]; data: string; blockNumber: string }

type V3Venue = {
  label: 'univ3' | 'pancakev3'
  factory: `0x${string}`
  startBlock: number
  cursorKey: string
  targetKey: string
}

const UNI_V3_VENUE: V3Venue = {
  label: 'univ3',
  factory: UNI.V3_FACTORY,
  startBlock: UNI_V3_START_BLOCK,
  cursorKey: 'v3_cursor',
  targetKey: 'v3_target_block',
}

const PANCAKE_V3_VENUE: V3Venue = {
  label: 'pancakev3',
  factory: ADDR.CL_FACTORY,
  startBlock: PANCAKE_V3_START_BLOCK,
  cursorKey: 'pancake_v3_cursor',
  targetKey: 'pancake_v3_target_block',
}

const nondecreasingBlock = (key: string, next: number): number => {
  const stored = Number(kvGet(key))
  return Number.isSafeInteger(stored) && stored >= 0 ? Math.max(stored, next) : next
}

/**
 * One-time catalog bootstrap. BSC MUST import The Graph's block-pinned catalog,
 * prove its count and every pool against the official factory, then use RPC
 * only for the post-snapshot tail. Other chains retain the Blockscout/RPC path.
 */
export async function backfillV3(): Promise<number> {
  const targetBlock = Math.max(
    UNI_V3_START_BLOCK,
    Number(await pc.getBlockNumber()) - INDEXER_FINALITY_BLOCKS,
  )
  kvSet('v3_target_block', String(targetBlock))

  if (CHAIN.id === 56) {
    let added = 0
    // Re-prove completed Graph seeds against the current RPC canonical chain
    // before either venue is allowed to extend its durable cursor.
    if (!(await hasCompleteV3GraphSnapshot())) {
      const snapshot = await importBscV3Snapshot(targetBlock)
      added += snapshot.added
      log(
        `[catalog] univ3 The Graph snapshot: ${snapshot.downloaded} pools at blk ${snapshot.block}`,
      )
    }
    // This awaits a fresh RPC canonical-hash check even for a completed seed.
    // A mismatch/error fails boot before tailV3 can extend an orphan snapshot.
    if (!(await hasCompletePancakeV3GraphSnapshot())) {
      const snapshot = await importBscPancakeV3Snapshot(targetBlock)
      added += snapshot.added
      log(
        `[catalog] pancakev3 The Graph snapshot: ${snapshot.downloaded} pools at blk ${snapshot.block}`,
      )
    }
    const fresh = await tailV3()
    kvSet('v3_backfilled', '1')
    kvSet('pancake_v3_backfilled', '1')
    return added + fresh.length
  }

  // A completed seed is only complete at its snapshot head. On every restart,
  // overlap the durable cursor and catch up to the current finalized head
  // before the process can advertise readiness.
  if (kvGet('v3_backfilled') === '1') return (await tailV3()).length
  // A fresh non-BSC database starts at the official factory deployment block.
  // Also clamp old/partially-created cursors so an accidental `0` never turns
  // into a 100m-block historical scan.
  const storedCursor = Number(kvGet('v3_cursor'))
  let cursor = Math.max(
    UNI_V3_START_BLOCK,
    Number.isSafeInteger(storedCursor) && storedCursor >= 0 ? storedCursor : UNI_V3_START_BLOCK,
  )
  let added = 0
  let flakes = 0
  // INDEXER_BACKFILL=rpc skips Blockscout entirely — useful when it throttles
  // (observed 2026-07-16: page pace degraded 1min → 6min mid-backfill). With a
  // private RPC the windowed scan is deterministic (~770 windows for full
  // history) and resumes from the same cursor.
  const useRpcBackfill = process.env.INDEXER_BACKFILL === 'rpc' || CHAIN.explorer.api !== 'blockscout'
  if (useRpcBackfill) {
    const reason = process.env.INDEXER_BACKFILL === 'rpc' ? 'INDEXER_BACKFILL=rpc' : `${CHAIN.explorer.name} has no Blockscout log API`
    log(`[catalog] v3 backfill via RPC windows from blk ${cursor} (${reason})`)
    added = (await scanV3Windows(cursor, targetBlock, UNI_V3_VENUE)).length
    kvSet('v3_cursor', String(targetBlock))
    kvSet('v3_backfilled', '1')
    return added
  }
  for (;;) {
    const j = await bsJson(
      `${BLOCKSCOUT}/api?module=logs&action=getLogs&fromBlock=${cursor}&toBlock=${targetBlock}&address=${UNI.V3_FACTORY}&topic0=${POOL_CREATED_TOPIC}`,
    ).catch(() => ({ status: '0', message: 'no response' }) as Record<string, unknown>)
    if (j.status !== '1') {
      if (/no records/i.test(String(j.message))) break
      if (++flakes >= 6) {
        // Blockscout is down/unhappy — finish the remaining range over RPC
        log(`[catalog] blockscout flaking ("${j.message}") — RPC-window fallback from blk ${cursor}`)
        added += (await scanV3Windows(cursor, targetBlock, UNI_V3_VENUE)).length
        kvSet('v3_cursor', String(targetBlock))
        break
      }
      await sleep(2_000 * flakes)
      continue
    }
    flakes = 0
    const logs = j.result as BsLog[]
    tx(() => {
      for (const l of logs) {
        // topics: [sig, token0, token1, fee]; data: [tickSpacing:int24, pool:address]
        const tickSpacing = Number(BigInt.asIntN(24, BigInt('0x' + l.data.slice(2, 66))))
        if (
          insertPool({
            address: addrOfTopic(l.data.slice(66, 130)),
            proto: 'univ3',
            token0: addrOfTopic(l.topics[1]),
            token1: addrOfTopic(l.topics[2]),
            feePpm: hexInt(l.topics[3]),
            tickSpacing,
            createdBlock: hexInt(l.blockNumber),
          })
        )
          added++
      }
    })
    const last = hexInt(logs[logs.length - 1].blockNumber)
    kvSet('v3_cursor', String(last))
    log(`[catalog] v3 backfill +${added} pools (cursor blk ${last})`)
    if (logs.length < 1000) break
    cursor = last // overlap the last block; PK dedupes
    await sleep(300)
  }
  kvSet('v3_backfilled', '1')
  return added
}

/**
 * Windowed RPC getLogs scan. Providers can advertise smaller ranges; every
 * successful window checkpoints its cursor. On BSC this is only the bounded
 * finalized tail after a verified The Graph snapshot, never full history.
 */
async function scanV3Windows(
  from: number,
  to: number,
  venue: V3Venue = UNI_V3_VENUE,
): Promise<string[]> {
  const fresh: string[] = []
  let logged = 0
  await scanAdaptiveLogWindows({
    fromBlock: from,
    toBlock: to,
    maxWindowBlocks: V3_RPC_WINDOW_BLOCKS,
    concurrency: V3_RPC_CONCURRENCY,
    fetchWindow: (lo, hi) =>
      withRotatingRpcClient((client) =>
        client.getLogs({
          address: venue.factory,
          event: POOL_CREATED,
          fromBlock: BigInt(lo),
          toBlock: BigInt(hi),
        }),
      ),
    commitWindow: ({ toBlock: hi, rows: logs }) => {
      tx(() => {
        for (const l of logs) {
          const a = l.args
          if (!a.pool || !a.token0 || !a.token1 || a.fee === undefined || a.tickSpacing === undefined) continue
          if (
            insertPool({
              address: a.pool.toLowerCase(),
              proto: venue.label,
              token0: a.token0,
              token1: a.token1,
              feePpm: a.fee,
              tickSpacing: a.tickSpacing,
              createdBlock: Number(l.blockNumber),
            })
          )
            fresh.push(a.pool.toLowerCase())
        }
        // The overlap can be wider than a provider-shrunk window. Never move
        // the published complete prefix backwards while replaying that overlap.
        kvSet(venue.cursorKey, String(nondecreasingBlock(venue.cursorKey, hi)))
      })
      if (to - from > 100_000 && ++logged % 100 === 0)
        log(`[catalog] ${venue.label} rpc scan blk ${hi}/${to} (+${fresh.length})`)
    },
    onShrink: (windowBlocks) =>
      log(
        `[catalog] RPC log range rejected; shrinking ${venue.label} window to ${windowBlocks} blocks`,
      ),
    singleBlockError:
      'RPC rejects even a one-block eth_getLogs request; configure a logs-capable indexer RPC',
  })
  return fresh
}

/** RPC tail from the stored cursor to head; returns newly added pool addresses */
async function tailV3Venue(venue: V3Venue, finalizedHead: number): Promise<string[]> {
  const head = Math.max(venue.startBlock, finalizedHead)
  const storedCursor = Number(kvGet(venue.cursorKey))
  const from = Math.max(
    venue.startBlock,
    (Number.isSafeInteger(storedCursor) && storedCursor >= 0 ? storedCursor : head - 2_000) - 120,
  ) // overlap without ever scanning before the factory existed
  const fresh = await scanV3Windows(from, head, venue)
  tx(() => {
    kvSet(venue.cursorKey, String(nondecreasingBlock(venue.cursorKey, head)))
    kvSet(venue.targetKey, String(nondecreasingBlock(venue.targetKey, head)))
  })
  return fresh
}

/** RPC tail from every supported V3 venue's cursor to finalized head. */
export async function tailV3(): Promise<string[]> {
  const finalizedHead =
    Number(await pc.getBlockNumber()) - INDEXER_FINALITY_BLOCKS
  const venues = [
    UNI_V3_VENUE,
    ...(CHAIN.id === 56 ? [PANCAKE_V3_VENUE] : []),
  ]
  const fresh: string[] = []
  for (const venue of venues)
    fresh.push(...(await tailV3Venue(venue, finalizedHead)))
  return fresh
}

/**
 * One v2 venue's catalog sync (backfill == tail). A batch is published with
 * its durable cursor in one SQLite transaction only after every allPairs and
 * token read resolved. A partial multicall response therefore publishes and
 * advances nothing from that batch; the next tick retries the exact indices.
 * `added` remains exact while `fresh` is deliberately bounded for memory.
 */
async function syncV2Venue(venue: {
  label: 'univ2' | 'pancakev2'
  factory: `0x${string}`
  feePpm: number
  countKey: string
  factoryCountKey: string
}): Promise<V2SyncResult> {
  const count = Number(
    await pc.readContract({
      abi: uniV2FactoryAbi,
      address: venue.factory,
      functionName: 'allPairsLength',
    }),
  )
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error(`${venue.label} factory returned invalid allPairsLength`)
  const storedCount = Number(kvGet(venue.countKey))
  let known = Number.isSafeInteger(storedCount) && storedCount >= 0 ? storedCount : 0
  if (known > count) {
    throw new Error(
      `${venue.label} durable cursor ${known} is ahead of factory allPairsLength ${count}; refusing a destructive rewind`,
    )
  }
  if (count === known) {
    kvSet(venue.factoryCountKey, String(count))
    return { added: 0, fresh: [] }
  }
  const fresh: string[] = []
  let added = 0
  while (known < count) {
    const n = Math.min(2_000, count - known) // 2k pairs per round = 5 + 10 aggregates
    const idx = Array.from({ length: n }, (_, i) => known + i)
    const pairRes = await mc(
      idx.map((i) => ({
        abi: uniV2FactoryAbi,
        address: venue.factory,
        functionName: 'allPairs',
        args: [BigInt(i)],
      })),
    )
    const pairs = idx.map((_, i) => ok<string>(pairRes[i]))
    if (pairs.some((pair) => !pair)) break
    const resolvedPairs = pairs as string[]
    const tokRes = await mc(
      resolvedPairs.flatMap((p) => [
        { abi: uniV2PairAbi, address: p as `0x${string}`, functionName: 'token0' },
        { abi: uniV2PairAbi, address: p as `0x${string}`, functionName: 'token1' },
      ]),
    )
    const tokens = resolvedPairs.map((_, i) => [
      ok<string>(tokRes[i * 2]),
      ok<string>(tokRes[i * 2 + 1]),
    ] as const)
    if (tokens.some(([token0, token1]) => !token0 || !token1)) break

    tx(() => {
      for (let i = 0; i < resolvedPairs.length; i++) {
        const [token0, token1] = tokens[i] as readonly [string, string]
        if (
          insertPool({
            address: resolvedPairs[i].toLowerCase(),
            proto: venue.label,
            token0,
            token1,
            feePpm: venue.feePpm,
            pairIndex: known + i,
          })
        ) {
          added++
          if (fresh.length < V2_FRESH_ADDRESS_LIMIT)
            fresh.push(resolvedPairs[i].toLowerCase())
        }
      }
      known += resolvedPairs.length
      kvSet(venue.countKey, String(known))
      // `factoryCountKey` is the published complete prefix, not an in-flight
      // upstream target. Advance it only with the verified rows and cursor.
      kvSet(venue.factoryCountKey, String(known))
    })
    if (known < count) log(`[catalog] ${venue.label} sync ${known}/${count}`)
  }
  if (known !== count) {
    throw new Error(
      `${venue.label} catalog sync incomplete: durable cursor ${known}/${count}; refusing to mark the index ready`,
    )
  }
  return { added, fresh }
}

export type V2SyncResult = { added: number; fresh: string[] }

/**
 * Sync every v2 venue supported by this chain. Existing Uniswap deployments
 * keep their original v2_count/v2_factory_count keys byte-for-byte; BSC adds
 * an independent Pancake cursor so either factory can resume without replaying
 * or claiming completion for the other.
 */
export async function syncV2(): Promise<V2SyncResult> {
  const venues = [
    {
      label: 'univ2' as const,
      factory: UNI.V2_FACTORY,
      feePpm: 3_000,
      countKey: 'v2_count',
      factoryCountKey: 'v2_factory_count',
    },
    ...(CHAIN.id === 56
      ? [{
          label: 'pancakev2' as const,
          factory: ADDR.V2_FACTORY,
          feePpm: 2_500,
          countKey: 'pancake_v2_count',
          factoryCountKey: 'pancake_v2_factory_count',
        }]
      : []),
  ]
  const result: V2SyncResult = { added: 0, fresh: [] }
  for (const venue of venues) {
    if (venue.label === 'pancakev2') {
      const snapshot = await ensureBscPancakeV2AdvancedSnapshot(
        V2_FRESH_ADDRESS_LIMIT - result.fresh.length,
      )
      result.added += snapshot.added
      const remaining = V2_FRESH_ADDRESS_LIMIT - result.fresh.length
      if (remaining > 0) result.fresh.push(...snapshot.fresh.slice(0, remaining))
    }
    const delta = await syncV2Venue(venue)
    result.added += delta.added
    const remaining = V2_FRESH_ADDRESS_LIMIT - result.fresh.length
    if (remaining > 0) result.fresh.push(...delta.fresh.slice(0, remaining))
  }
  return result
}
