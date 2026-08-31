// The v4 pool directory for a chain that has no subgraph.
//
// The Graph path (v4Subgraph.ts) downloads a pinned snapshot and then tails
// PoolManager Initialize logs from it. Here there is no snapshot to pin, so
// the tail IS the directory: one scan from the PoolManager's own deployment
// block forward, using the same adaptive window traversal, the same PoolId
// round-trip verification and the same durable cursor.
//
// What makes that affordable is SCOPE — see v4Scope.ts for the two admission
// rules and what each is for. On Robinhood Chain they reduce 257,283
// initialised pools to roughly 3,700.
//
// TWO GENESIS BLOCKS, and the difference is load-bearing. Launches cannot
// precede the token factory, so the token scan starts there. Pools can, and
// do: v4 was live on this chain 4.5M blocks before any launchpad existed, and
// the connector pools that form half the scope are among the oldest on it.
// Starting the pool scan at the token genesis silently cost 166 of 514
// connector pools — measured, not hypothesised.
//
// Two ordering rules hold the rest together:
//  - tokens are synced to the target block BEFORE pools are scanned to it. A
//    token is always created before any pool that quotes it, so a pool whose
//    token is already recorded is admitted on first sight — and the cursor may
//    move past it exactly once.
//  - the cursor is published only for a completed window prefix, which
//    scanV4Windows already guarantees, so a transient RPC failure resumes
//    where it stopped rather than at genesis.
import { keccak256, numberToHex, toEventSelector, toHex, type Address } from 'viem'
import { scanAdaptiveLogWindows } from './adaptiveLogs'
import { CHAIN, INDEXER_FINALITY_BLOCKS, V4, log } from './config'
import { pc, withRotatingRpcClient } from './rpc'
import {
  insertLaunchpadToken,
  isLaunchpadToken,
  isStockToken,
  kvGet,
  kvSet,
  launchpadTokenCount,
  stockTokenCounts,
  tx,
} from './store'
import { v4DirectoryCore } from './v4Scope'
import {
  scanV4ForToken,
  scanV4Windows,
  V4InitializeBehindCursorError,
} from './v4Subgraph'

/** UERC20Factory's launch event; the token address is its first data word. */
const TOKEN_CREATED = toEventSelector(
  'TokenCreated(address,(string,string,string,bytes))',
)

const positiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

// Deliberately larger than the Graph path's window. A logs-capable provider
// answers a wide range for a single low-volume contract in one request, and
// scanAdaptiveLogWindows halves on rejection anyway — so a generous start
// costs one probe on a strict node and saves thousands of round trips on a
// permissive one, across a chain whose history is tens of millions of blocks.
const RPC_WINDOW_BLOCKS = positiveInt(
  process.env.INDEXER_V4_RPC_WINDOW_BLOCKS,
  500_000,
)

type RawLog = { data: `0x${string}`; blockNumber: `0x${string}` }

/**
 * The directory's settings, with the two addresses they describe.
 *
 * Both ride along already proven non-null, and both are part of the generation
 * below — one that quietly hashed an empty address would collide across two
 * different deployments of this chain.
 *
 * TOKEN_FACTORY comes from `launchpad`, not from `rpcDirectory`, because it is
 * the same contract the interface proves a token's provenance against. Reading
 * it from one place is what keeps the pools this indexes and the rows the
 * interface marks from ever describing different factories.
 */
function rpcDirectory(): {
  POOL_MANAGER: Address
  TOKEN_FACTORY: Address
  tokenGenesisBlock: number
  poolGenesisBlock: number
} {
  if (!V4?.rpcDirectory)
    throw new Error(`${CHAIN.key} has no RPC-sourced Uniswap V4 directory`)
  if (!CHAIN.launchpad)
    throw new Error(
      `${CHAIN.key} declares an RPC-sourced Uniswap V4 directory but no launchpad to scope it to`,
    )
  return {
    POOL_MANAGER: V4.POOL_MANAGER,
    TOKEN_FACTORY: CHAIN.launchpad.tokenFactory,
    ...V4.rpcDirectory,
  }
}

/**
 * This directory's identity, as the generation the API pins a traversal to.
 *
 * The Graph path derives one from the snapshot it downloaded. An RPC directory
 * has no snapshot, but it still needs a generation: `/api/pools` refuses a
 * continuation without one, so leaving it unset breaks "load more" at the
 * second page while the first looks perfectly healthy.
 *
 * It is stable across tails on purpose. Growth alone must NOT change it — the
 * traversal is already fenced by `created_block <= catalogBlock`, so rows the
 * tail appends are invisible to a page in flight. What must change it is a
 * change in what the directory MEANS, and the scope belongs in that list as
 * much as the addresses do: widening the core set makes pools with old
 * creation blocks appear behind an already-issued fence, which is exactly the
 * page-boundary shift a generation exists to catch.
 *
 * A newly PROVEN issued share is that same event, which is why its count is
 * here and the launchpad's is not. A launch is a mint: its pools do not exist
 * yet, so admitting it only ever appends beyond the fence. A share was minted
 * long before anything read its proxy, so admitting it backfills pools with old
 * creation blocks — squarely inside pages already issued.
 */
function directoryGeneration(): string {
  const { POOL_MANAGER, TOKEN_FACTORY, poolGenesisBlock } = rpcDirectory()
  const scope = [...v4DirectoryCore()].sort().join(',')
  return keccak256(
    toHex(
      [
        `${CHAIN.key}:${CHAIN.id}`,
        POOL_MANAGER.toLowerCase(),
        TOKEN_FACTORY.toLowerCase(),
        String(poolGenesisBlock),
        scope,
        `issued:${stockTokenCounts().proven}`,
      ].join('\n'),
    ),
  )
}

/**
 * Admit one newly proven token's history to the directory.
 *
 * The directory is scoped at INGEST, which is what keeps it in the low
 * thousands on a chain with 257,283 Initialize events. The cost of that choice
 * is this function: a token whose origin is proven today had its pools skipped
 * on the day they were created, and nothing would ever look at them again.
 *
 * The alternative — storing every Initialize row and scoping at query time —
 * was measured against and rejected: it would put ~257k rows through the solver
 * adjacency triggers and hand the token-metadata sweep every currency on the
 * chain. Two indexed-topic log queries cost a fraction of that and are exact.
 *
 * The generation moves with the membership count, so a client mid-traversal
 * restarts rather than silently skipping the rows this just inserted behind it.
 */
export async function admitV4Token(token: string): Promise<number> {
  if (!V4?.rpcDirectory) return 0
  const { poolGenesisBlock } = rpcDirectory()
  const stored = Number(kvGet('v4_cursor'))
  const to = Number.isSafeInteger(stored) && stored > 0 ? stored : await finalizedHead()
  const fresh = await scanV4ForToken(token, poolGenesisBlock, to)
  // Unconditionally, even when nothing was found: the SCOPE widened either way,
  // and the generation states what the directory means rather than what it
  // happens to contain.
  kvSet('v4_rpc_generation', directoryGeneration())
  return fresh.length
}

/** The finalized block both scans target; one read, so they cannot disagree. */
async function finalizedHead(): Promise<number> {
  const head = Number(await pc.getBlockNumber()) - INDEXER_FINALITY_BLOCKS
  if (!Number.isSafeInteger(head) || head <= 0)
    throw new Error('invalid finalized target block for the V4 RPC directory')
  return head
}

/**
 * A launch event's token address.
 *
 * Read off the raw word rather than ABI-decoded: the metadata tuple that
 * follows carries a base64 data-URI image, so decoding it would parse
 * megabytes per window to reach a field in front of it.
 */
function launchedToken(row: RawLog): string {
  const word = row.data.slice(2, 66)
  if (word.length !== 64 || !/^0{24}[0-9a-f]{40}$/.test(word.toLowerCase()))
    throw new Error('UERC20Factory TokenCreated has a malformed token address')
  return `0x${word.slice(24)}`.toLowerCase()
}

/** Record every launch up to `target`; returns how many were new. */
export async function syncLaunchpadTokens(target: number): Promise<number> {
  const { TOKEN_FACTORY, tokenGenesisBlock } = rpcDirectory()
  const stored = Number(kvGet('v4_launchpad_cursor'))
  const cursor = Number.isSafeInteger(stored) && stored > 0 ? stored : tokenGenesisBlock - 1
  if (cursor > target)
    throw new Error(
      `launchpad cursor ${cursor} is ahead of finalized head ${target}; refusing a destructive rewind`,
    )
  let added = 0
  await scanAdaptiveLogWindows<RawLog[]>({
    fromBlock: cursor + 1,
    toBlock: target,
    maxWindowBlocks: RPC_WINDOW_BLOCKS,
    fetchWindow: async (lo, hi) =>
      (await withRotatingRpcClient((client) =>
        client.request({
          method: 'eth_getLogs',
          params: [
            {
              address: TOKEN_FACTORY,
              topics: [TOKEN_CREATED],
              fromBlock: numberToHex(lo),
              toBlock: numberToHex(hi),
            },
          ],
        }),
      )) as RawLog[],
    commitWindow: ({ toBlock, rows }) => {
      // Counted inside the transaction and folded in only once it commits: a
      // row that throws mid-window rolls the whole window back, and a total
      // that kept the increments before it would report launches nobody stored.
      let inserted = 0
      tx(() => {
        inserted = 0
        for (const row of rows) {
          const block = Number(row.blockNumber)
          if (!Number.isSafeInteger(block))
            throw new Error('UERC20Factory TokenCreated has an invalid block number')
          if (insertLaunchpadToken(launchedToken(row), block)) inserted++
        }
        kvSet('v4_launchpad_cursor', String(toBlock))
      })
      added += inserted
    },
    onShrink: (windowBlocks) =>
      log(`[catalog] RPC log range rejected; shrinking launchpad window to ${windowBlocks} blocks`),
    singleBlockError:
      'RPC rejects even a one-block launchpad eth_getLogs request; configure a logs-capable indexer RPC',
  })
  return added
}

/**
 * Advance the directory to the finalized head.
 *
 * The same call serves the first run and every later one: with no stored
 * cursor it starts at the launchpad's genesis, and afterwards it resumes.
 * There is no separate bootstrap because there is no snapshot to import.
 */
export async function tailV4Rpc(): Promise<string[]> {
  const { poolGenesisBlock } = rpcDirectory()
  const head = await finalizedHead()

  // Tokens first, and to the same target — a pool is admitted by its token, so
  // scanning pools past a block whose launches are unrecorded would drop them
  // permanently once the cursor moved on.
  const newTokens = await syncLaunchpadTokens(head)
  if (newTokens > 0) log(`[catalog] launchpad: +${newTokens} launched tokens`)

  const stored = Number(kvGet('v4_cursor'))
  const cursor = Number.isSafeInteger(stored) && stored > 0 ? stored : poolGenesisBlock - 1
  if (cursor > head)
    throw new Error(
      `univ4 durable cursor ${cursor} is ahead of finalized head ${head}; refusing a destructive rewind`,
    )
  // Re-read a short overlap so a row committed in a window whose cursor write
  // lost a race is still seen. storeInitialize treats a known row as a replay.
  const from = Math.max(poolGenesisBlock, cursor - 120)
  let fresh: string[]
  try {
    fresh = await scanV4Windows(from, head, cursor)
  } catch (error) {
    // Origin proof is persisted before its targeted historical scan. If that
    // scan suffers a transient RPC failure, the forward overlap will later
    // rediscover the old pool and correctly refuse to mutate behind its fence.
    // Retry only the already-proven origin's bounded, topic-filtered history;
    // arbitrary behind-cursor rows still fail closed above.
    if (!(error instanceof V4InitializeBehindCursorError)) throw error
    const origins = error.currencies.filter(
      (currency) => isLaunchpadToken(currency) || isStockToken(currency),
    )
    if (!origins.length) throw error
    for (const origin of new Set(origins))
      await scanV4ForToken(origin, poolGenesisBlock, cursor)
    kvSet('v4_rpc_generation', directoryGeneration())
    fresh = await scanV4Windows(from, head, cursor)
  }
  tx(() => {
    kvSet('v4_cursor', String(head))
    kvSet('v4_target_block', String(head))
    kvSet('v4_rpc_directory', '1')
    // Its OWN key. `v4_snapshot_generation` is a guarded publish switch for
    // the solver's Graph-snapshot shadow — writing it needs an armed
    // `v4_snapshot_publish_generation` and a validated snapshot row count, and
    // an unarmed write is an ABORT that would fail this whole transaction on
    // every tail. Rewritten each pass so a scope or address change lands on
    // the next one rather than only on a rebuilt database.
    kvSet('v4_rpc_generation', directoryGeneration())
  })
  return fresh
}

/** First-run entry point; the tail is the whole directory, so this is it. */
export async function backfillV4Rpc(): Promise<number> {
  const fresh = await tailV4Rpc()
  kvSet('v4_backfilled', '1')
  log(
    `[catalog] univ4 RPC directory: ${launchpadTokenCount()} launched tokens in scope, +${fresh.length} pools`,
  )
  return fresh.length
}
