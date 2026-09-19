// Shadow-position replay driver (docs/EMERGING-POOL-LP-PRD.zh-CN.md §7.1,
// EMG-C00): replays a tracked pool's canonical event history through the pure
// engine and returns the shadow position's cash ledger.
//
// First adapter scope (§2/§7.1): official Uniswap v3 static-fee pools only.
// UP33 carries an unstaked levy and dynamic fees; v4 events on this chain are
// stored raw — both need their own proven adapters before any replay can
// claim verified numbers, and this driver says `unsupported` rather than
// approximating (§7.1: 动态费用历史缺失即 unsupported，禁止用当前费率回填).
//
// Fidelity markers (§7.1):
//   - integrity 'exact'    — the event history starts at the pool's first
//     mint (full reconstruction) and every Swap's end-state liquidity matched
//     the walk; fees are replay figures against real history.
//   - integrity 'mismatch' — a walk diverged from an event's own word: the
//     pool's history has a hole; numbers are NOT usable and the pool's
//     dataQuality drops until the gap is repaired.
//   - 'unsupported'        — venue/raw-events/no-history: no numbers at all.
// Shadow caps (§7.1: virtual L ≤ 1% of entry-side active L, capital ≤ 0.5%
// of exit depth) are enforced by the experiment runner, not here; this driver
// reports the entry-side figures the caps are computed from.
import { getSqrtRatioAtTick } from '../src/lib/clmath'
import { applyMint, applyBurn, applySwap, enterPosition, exitPosition, initState } from './emergingReplayCore'
import { listEmergingPoolEvents, type EmergingChainEventRow } from './emergingStore'
import { db } from './store'

export type ShadowLedger = {
  poolKey: string
  integrity: 'exact' | 'mismatch' | 'unsupported'
  unsupportedReason: string | null
  swapsReplayed: number
  entryActiveLiquidity: bigint | null
  fees0: bigint
  fees1: bigint
  principal0: bigint
  principal1: bigint
  exit: 'range-exit' | 'end-of-history' | null
}

const feeQ = db.prepare(`SELECT fee_ppm, proto FROM pools WHERE address = ?`)

export function replayShadowPosition(poolKey: string, args: {
  tickLower: number
  tickUpper: number
  liquidity: bigint
  /** enter as of the Nth swap (0 = before the first observed swap) */
  entryAfterSwaps?: number
}): ShadowLedger {
  const venueRow = feeQ.get(poolKey.split(':')[2]) as { fee_ppm: number; proto: string } | undefined
  if (!venueRow || venueRow.proto !== 'univ3')
    return unsupported(poolKey, 'venue is not an official static-fee v3 pool')
  const feePpm = venueRow.fee_ppm

  const events = listEmergingPoolEvents(poolKey, 0, Number.MAX_SAFE_INTEGER) as EmergingChainEventRow[]
  if (!events.length) return unsupported(poolKey, 'no canonical events recorded')
  if (events[0].kind !== 'mint')
    return unsupported(poolKey, 'history does not start at the pool\u2019s first mint')
  let sawSwap = false
  for (const e of events) {
    if (e.kind === 'swap') { sawSwap = true; break }
    if (e.kind === 'mint' || e.kind === 'burn') continue
    return unsupported(poolKey, `unexpected pre-swap event kind ${e.kind}`)
  }
  if (!sawSwap) return unsupported(poolKey, 'no swaps recorded — nothing to attribute')

  const s = initState()
  enterPosition(s, args.tickLower, args.tickUpper, args.liquidity)
  const entryAfterSwaps = args.entryAfterSwaps ?? 0
  let swapsSeen = 0
  let entered = false
  let entryActiveLiquidity: bigint | null = null
  let fees0 = 0n
  let fees1 = 0n
  let exit: ShadowLedger['exit'] = null
  let principal0 = 0n
  let principal1 = 0n

  for (const e of events) {
    const p = JSON.parse(e.payload) as Record<string, string>
    if (e.kind === 'mint') {
      applyMint(s, Number(p.tickLower), Number(p.tickUpper), BigInt(p.amount))
      continue
    }
    if (e.kind === 'burn') {
      applyBurn(s, Number(p.tickLower), Number(p.tickUpper), BigInt(p.amount))
      continue
    }
    if (e.kind !== 'swap') continue
    if (!entered && swapsSeen >= entryAfterSwaps) {
      // A shadow position whose entry lies in the observed history enters
      // with the pool already priced; one registered before the first swap
      // rides the bootstrap (its entry price is the first swap's own).
      entered = true
    }
    swapsSeen++
    if (!entered) continue
    if (entryActiveLiquidity === null) entryActiveLiquidity = BigInt(e.payload ? (JSON.parse(e.payload) as { liquidity: string }).liquidity : '0')
    const r = applySwap(s, {
      amount0: p.amount0, amount1: p.amount1,
      sqrtPriceX96: p.sqrtPriceX96, liquidity: p.liquidity, tick: Number(p.tick),
    }, feePpm)
    fees0 += r.fee0
    fees1 += r.fee1
    if (r.reconstructedLiquidity !== BigInt(p.liquidity)) {
      return {
        poolKey, integrity: 'mismatch', unsupportedReason: null,
        swapsReplayed: swapsSeen, entryActiveLiquidity,
        fees0: 0n, fees1: 0n, principal0: 0n, principal1: 0n, exit: null,
      }
    }
    // Exit the moment price leaves the position's range (§7.2's range-exit).
    const sqrtB = getSqrtRatioAtTick(args.tickUpper)
    const sqrtA = getSqrtRatioAtTick(args.tickLower)
    if (s.sqrtP >= sqrtB || s.sqrtP < sqrtA) {
      const out = exitPosition(s)
      principal0 = out.amount0
      principal1 = out.amount1
      exit = 'range-exit'
      break
    }
  }
  if (entered && exit === null) {
    const out = exitPosition(s)
    principal0 = out.amount0
    principal1 = out.amount1
    exit = 'end-of-history'
  }
  return {
    poolKey, integrity: 'exact', unsupportedReason: null,
    swapsReplayed: swapsSeen, entryActiveLiquidity,
    fees0, fees1, principal0, principal1, exit,
  }
}

function unsupported(poolKey: string, reason: string): ShadowLedger {
  return {
    poolKey, integrity: 'unsupported', unsupportedReason: reason,
    swapsReplayed: 0, entryActiveLiquidity: null,
    fees0: 0n, fees1: 0n, principal0: 0n, principal1: 0n, exit: null,
  }
}
