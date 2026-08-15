// Event-driven state refresh. A pool's reserves change only when it emits an
// event, so we don't reread on a timer — we ask the chain which pools changed.
// One eth_getLogs (v2 Sync, v3 Swap/Mint/Burn, any address) since the last block
// we processed yields exactly the pools that traded; we reread only those. Cost
// tracks trading activity, not catalog size — this is what lets the repeating
// census over a multi-million-pool long tail go away.
//
// Two deliberate choices:
//  - reread state, don't apply the logs' own deltas: whatever the chain returns
//    now is the truth, so a reorg needs no unwinding and a missed log self-heals
//    on the pool's next event; fixed top/hot sweeps are the longstop.
//  - fixed cadence rather than browser demand. CDN hits do not reach the
//    indexer, so an HTTP-driven gate cannot be a reliable freshness signal.
import { numberToHex, toEventSelector } from 'viem'
import { TUNE, log } from './config'
import { pc } from './rpc'
import { computeTvlFor, sweepState } from './state'
import { kvGet, kvSet } from './store'

// Deliberately state-change events only. Catalog DISCOVERY (v4 Initialize, a
// launchpad's TokenCreated) does not belong here: the skip above is safe for
// state, which the hot/full sweeps re-derive, but a directory that skipped a
// range would never learn those pools existed. Discovery runs on its own
// cursor-based loop, which cannot skip — see v4Rpc.ts and TUNE.v4TailMs.
export const TOPICS = [
  toEventSelector('Sync(uint112,uint112)'), // univ2 reserves (fires on every mint/burn/swap)
  toEventSelector('Swap(address,address,int256,int256,uint160,uint128,int24)'), // univ3 price + liquidity
  toEventSelector('Mint(address,address,int24,int24,uint128,uint256,uint256)'), // univ3 liquidity add
  toEventSelector('Burn(address,int24,int24,uint128,uint256,uint256)'), // univ3 liquidity remove
]

/**
 * The span one tick reads, and how much of the backlog it gives up.
 *
 * A tick falls behind by configuration rather than by accident: it must cover
 * `LOGTAIL_MS x block rate` blocks, and anything past `logtailMaxBlocks` cannot
 * be read in one pull. The only real question is what to do with the remainder.
 *
 * Reading the NEWEST `maxBlocks` keeps the loss proportional to how far behind
 * the tick is. Jumping to `head` — what this did until 2026-08-12 — gives up
 * the whole span instead: `LOGTAIL_MS=600000` against a 5,000-block cap on a
 * ~10-blocks/second chain left every tick reading exactly one block of 6,000,
 * while the log line still reported pools emitted as though it were working.
 *
 * `dropped` exists so the caller can say so out loud. Being silent about the
 * shortfall is what let that survive in production.
 */
export function logtailWindow(
  cursor: number,
  head: number,
  maxBlocks: number,
): { from: number; dropped: number } {
  if (!cursor) return { from: head, dropped: 0 }
  const from = Math.max(cursor + 1, head - maxBlocks + 1)
  return { from, dropped: Math.max(0, from - cursor - 1) }
}

/** reread every catalog pool that emitted a tracked event since the last run */
export async function logtail(): Promise<void> {
  const head = Number(await pc.getBlockNumber())
  const cursor = Number(kvGet('logtail_block') ?? 0)
  const { from, dropped } = logtailWindow(cursor, head, TUNE.logtailMaxBlocks)
  if (from > head) return
  if (dropped)
    log(
      `[logtail] behind by ${head - cursor} blocks, cap ${TUNE.logtailMaxBlocks}: ` +
        `${dropped} unread (lower LOGTAIL_MS or raise LOGTAIL_MAX_BLOCKS)`,
    )

  const logs = (await pc.request({
    method: 'eth_getLogs',
    params: [{ fromBlock: numberToHex(from), toBlock: numberToHex(head), topics: [TOPICS] }],
  })) as { address: string }[]

  const dirty = [...new Set(logs.map((l) => l.address.toLowerCase()))]
  if (dirty.length) {
    const swept = await sweepState(dirty) // sweepState ignores addresses not in the catalog
    computeTvlFor(dirty)
    log(`[logtail] blocks ${from}-${head}: ${dirty.length} pools emitted, ${swept} in catalog`)
  }
  kvSet('logtail_block', String(head))
}
