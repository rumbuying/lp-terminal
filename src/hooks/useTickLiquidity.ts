import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import type { PublicClient } from 'viem'
import { clPoolAbi, uniV3PoolAbi } from '../abi'
import { CHAIN_ID } from '../config/addresses'
import { UNI_V4, v4StateViewAbi } from '../lib/uniV4'
import {
  decodeWords,
  tickWordRange,
  wordPosOf,
  compressTick,
  type TickNet,
  type TickWord,
} from '../lib/tickLiq'
import type { ClPool } from '../types'

/**
 * A window wide enough to be worth drawing costs a handful of bitmap words at a
 * 200 tick spacing and a few dozen at a spacing of 1. This caps the second case:
 * a spacing-1 pool asked for ±50% needs ~32 words, so 48 clears every window the
 * chart offers while refusing to turn a mistyped range into a thousand-call read.
 */
const MAX_WORDS = 48

/**
 * Above this many initialised ticks the outermost ones are dropped.
 *
 * Truncation is deliberately outside-in: the walk starts at the current price, so
 * the ticks nearest it decide the part of the chart anyone is actually reading,
 * and what gets lost is the far shelf where the curve is already flat.
 */
const MAX_TICKS = 512

export type TickLiquidity = {
  /** every boundary in the span, with the signed step crossing it applies */
  nets: TickNet[]
  /** the span the boundaries actually cover — whole bitmap words, wider than asked */
  loTick: number
  hiTick: number
  /** the far ends were dropped; the outer edges of the chart understate depth */
  truncated: boolean
}

/**
 * The pool's liquidity distribution around the current price.
 *
 * Two rounds: the bitmap says WHICH ticks hold a position boundary, then one read
 * per boundary says how much it moves. Between them the pool's own `liquidity`
 * anchors the walk, so the curve is the depth a swap would meet rather than an
 * estimate of it.
 *
 * The fetched span is rounded OUT to whole bitmap words and the query is keyed on
 * those words. A word is the smallest thing the bitmap can be asked about, so
 * rounding to it costs nothing — and it means dragging a bound around inside the
 * span it already fetched is answered from cache instead of firing a multicall
 * per pointer move.
 *
 * What comes back is the BOUNDARIES, not the finished curve. The walk that turns
 * them into a curve needs the live tick and the live active liquidity, and those
 * arrive on the selected-pool live feed — folding them into the query key would
 * re-fire both multicalls just to re-derive a shape that had not moved. So the
 * caller runs `buildSegments` itself and re-anchors for free, while the two reads
 * stay cached for as long as the boundaries are good for.
 *
 * Returns null rather than throwing when the reads fail, so a pool whose fork
 * lacks these getters falls back to a bare band instead of taking the panel down
 * with it.
 */
export function useTickLiquidity(
  pool: ClPool | null,
  loTick: number,
  hiTick: number,
  /** false parks the reads — a list gates them on the card being on screen */
  enabled = true,
) {
  const pc = usePublicClient({ chainId: CHAIN_ID })
  const spacing = pool?.tickSpacing ?? 1
  const words = pool ? tickWordRange(loTick, hiTick, spacing) : []

  // clamped around the current tick's word, so trimming an over-wide window
  // keeps the part with the price in it
  const centre = pool ? wordPosOf(compressTick(pool.tick, spacing)) : 0
  const kept =
    words.length <= MAX_WORDS
      ? words
      : words
          .slice()
          .sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre))
          .slice(0, MAX_WORDS)
          .sort((a, b) => a - b)

  const w0 = kept[0] ?? 0
  const w1 = kept[kept.length - 1] ?? 0
  const key = pool ? `${pool.poolId ?? pool.address}:${spacing}:${w0}:${w1}` : ''

  return useQuery<TickLiquidity | null>({
    queryKey: ['tickLiq', CHAIN_ID, key],
    enabled: enabled && !!pc && !!pool && kept.length > 0,
    // boundaries move only when someone mints or burns, which is rare next to a
    // price tick — and the anchor that does move is applied by the caller
    staleTime: 10 * 60_000,
    retry: false,
    queryFn: async (): Promise<TickLiquidity | null> => {
      if (!pool || !pc) return null
      const v4 = pool.protocol === 'univ4'
      if (v4 && (!pool.poolId || !UNI_V4)) return null
      const abi = v4 ? v4StateViewAbi : pool.protocol === 'univ3' ? uniV3PoolAbi : clPoolAbi
      const address = v4 ? UNI_V4!.STATE_VIEW : pool.address

      const bitmaps = (await (pc as PublicClient).multicall({
        contracts: kept.map((wordPos) => ({
          abi,
          address,
          functionName: v4 ? 'getTickBitmap' : 'tickBitmap',
          args: v4 ? [pool.poolId, wordPos] : [wordPos],
        })) as never,
      })) as { status: string; result?: bigint }[]

      // every word failing means this fork has no such getter; the caller draws
      // the plain bar. A few failing is a flaky RPC, and the walk still works
      // over what came back.
      const got: TickWord[] = []
      bitmaps.forEach((r, i) => {
        if (r?.status === 'success' && typeof r.result === 'bigint') {
          got.push({ wordPos: kept[i], word: r.result })
        }
      })
      if (got.length === 0) return null

      const loCov = (w0 << 8) * spacing
      const hiCov = ((w1 << 8) + 256) * spacing

      const all = decodeWords(got, spacing)
      const truncated = all.length > MAX_TICKS
      const ticks = truncated
        ? all
            .slice()
            .sort((a, b) => Math.abs(a - pool.tick) - Math.abs(b - pool.tick))
            .slice(0, MAX_TICKS)
            .sort((a, b) => a - b)
        : all

      // no boundary anywhere in the span: one flat shelf, which the walk
      // produces from an empty list without a second round trip
      if (ticks.length === 0) {
        return { nets: [], loTick: loCov, hiTick: hiCov, truncated: false }
      }

      const res = (await (pc as PublicClient).multicall({
        contracts: ticks.map((tick) => ({
          abi,
          address,
          functionName: v4 ? 'getTickLiquidity' : 'ticks',
          args: v4 ? [pool.poolId, tick] : [tick],
        })) as never,
      })) as { status: string; result?: readonly [bigint, bigint] }[]

      const nets: TickNet[] = []
      res.forEach((r, i) => {
        if (r?.status === 'success' && r.result) {
          nets.push({ tick: ticks[i], liquidityNet: r.result[1] })
        }
      })

      // when truncation dropped the outer boundaries, the walk is only sound
      // between the ticks that survived — report that span, not the whole word
      const lo = truncated ? Math.max(loCov, ticks[0]) : loCov
      const hi = truncated ? Math.min(hiCov, ticks[ticks.length - 1]) : hiCov

      return { nets, loTick: lo, hiTick: hi, truncated }
    },
  })
}
