// Event-driven state refresh. A pool's reserves change only when it emits an
// event, so we don't reread on a timer — we ask the chain which pools changed.
// One eth_getLogs (v2 Sync, v3 Swap/Mint/Burn, any address) since the last block
// we processed yields exactly the pools that traded; we reread only those. Cost
// tracks trading activity, not catalog size — this is what lets the 6-hourly
// census over 100k+ dust pools, and the timed hot/active sweeps, go away.
//
// Two deliberate choices:
//  - reread state, don't apply the logs' own deltas: whatever the chain returns
//    now is the truth, so a reorg needs no unwinding and a missed log self-heals
//    on the pool's next event (the daily census is the longstop).
//  - gated on the same POOLS-tab demand signal as the frontpage sweep — the only
//    consumer of fresh state is a watching user, and a getLogs every 12s costs
//    75 CU. Idle → no polling. On resume we jump the cursor to head instead of
//    replaying the idle backlog: freshness wants the current state, not history.
import { numberToHex, toEventSelector } from 'viem'
import { TUNE, log } from './config'
import { pc } from './rpc'
import { computeTvlFor, sweepState } from './state'
import { kvGet, kvSet, poolsHitAgeMs } from './store'

export const TOPICS = [
  toEventSelector('Sync(uint112,uint112)'), // univ2 reserves (fires on every mint/burn/swap)
  toEventSelector('Swap(address,address,int256,int256,uint160,uint128,int24)'), // univ3 price + liquidity
  toEventSelector('Mint(address,address,int24,int24,uint128,uint256,uint256)'), // univ3 liquidity add
  toEventSelector('Burn(address,int24,int24,uint128,uint256,uint256)'), // univ3 liquidity remove
]

/** reread every catalog pool that emitted a tracked event since the last run */
export async function logtail(): Promise<void> {
  if (poolsHitAgeMs() > TUNE.frontpageGateMs) return // nobody watching — don't spend getLogs
  const head = Number(await pc.getBlockNumber())
  const cursor = Number(kvGet('logtail_block') ?? 0)
  const from = cursor && head - cursor <= TUNE.logtailMaxBlocks ? cursor + 1 : head // skip idle backlog
  if (from > head) return

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
