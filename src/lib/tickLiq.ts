/**
 * Where the liquidity actually sits, read off the chain.
 *
 * A CL pool never stores a curve. It stores `liquidity` — how much is active at
 * the price right now — and, at each tick a position starts or ends on, the
 * `liquidityNet` that crossing that tick adds or removes. The distribution is
 * something you RECONSTRUCT: stand at the current price where the pool tells you
 * the exact active amount, then walk outward, applying each boundary as you step
 * over it. That is the same walk a swap does, so what comes out is the depth a
 * trade would really meet rather than a model of it.
 *
 * Finding the boundaries without asking about every tick is what the tick bitmap
 * is for: one 256-bit word marks 256 consecutive tick-spacings, so a window wide
 * enough to be worth drawing costs a handful of words, and the second round then
 * asks only about ticks that are actually initialised. Cost scales with how wide
 * a window is drawn and stays flat in the tick spacing — a 1-spacing pool and a
 * 200-spacing pool cost the same.
 *
 * Everything here is integer arithmetic on the values the chain returned. The
 * float conversion belongs at the very end, in the component that assigns pixels.
 */

/** one bitmap word as returned by `tickBitmap(int16)` */
export type TickWord = { wordPos: number; word: bigint }

/** the second field of `ticks(int24)`, for one initialised tick */
export type TickNet = { tick: number; liquidityNet: bigint }

/** a span of ticks over which the active liquidity is constant */
export type LiqSeg = { lower: number; upper: number; liquidity: bigint }

/**
 * Tick → its index in the bitmap, matching `TickBitmap.position`.
 *
 * The contract truncates the division and then decrements on a negative
 * remainder, which is floor division. Spelled out rather than left to
 * `Math.floor` so it reads against the Solidity it has to agree with — a tick
 * below the current price landing one word off is the kind of error that only
 * shows up as a distribution that is subtly wrong on one side.
 */
export function compressTick(tick: number, spacing: number): number {
  const q = Math.trunc(tick / spacing)
  return tick < 0 && q * spacing !== tick ? q - 1 : q
}

/** the bitmap word a compressed tick lives in (`compressed >> 8`, arithmetic) */
export function wordPosOf(compressed: number): number {
  return compressed >> 8
}

/**
 * Every word position needed to cover [loTick, hiTick] inclusive.
 *
 * Inclusive of both ends deliberately: a boundary sitting exactly on the window
 * edge still steps the liquidity of the last segment drawn.
 */
export function tickWordRange(loTick: number, hiTick: number, spacing: number): number[] {
  const lo = wordPosOf(compressTick(Math.min(loTick, hiTick), spacing))
  const hi = wordPosOf(compressTick(Math.max(loTick, hiTick), spacing))
  const out: number[] = []
  for (let w = lo; w <= hi; w++) out.push(w)
  return out
}

/** the initialised ticks a single bitmap word marks, ascending */
export function decodeWord(wordPos: number, word: bigint, spacing: number): number[] {
  if (word === 0n) return []
  const out: number[] = []
  const base = wordPos << 8
  for (let bit = 0; bit < 256; bit++) {
    if ((word >> BigInt(bit)) & 1n) out.push((base + bit) * spacing)
  }
  return out
}

/** flatten a set of words into one ascending list of initialised ticks */
export function decodeWords(words: TickWord[], spacing: number): number[] {
  return words
    .flatMap((w) => decodeWord(w.wordPos, w.word, spacing))
    .sort((a, b) => a - b)
}

/**
 * The walk: turn boundary deltas into the liquidity standing over each span.
 *
 * `liquidityNet` is signed for a crossing from left to right, so stepping UP over
 * a boundary adds it and stepping DOWN over one subtracts it. The anchor is the
 * span containing the current tick, because that is the single place the pool
 * states the active liquidity outright — every other span is that number plus the
 * boundaries between.
 *
 * Segments are cut to [loTick, hiTick]; the window edges act as boundaries that
 * happen to move nothing, so an edge landing mid-span splits it without changing
 * the liquidity either half reports.
 *
 * A negative running total means a boundary inside the window was missed — the
 * only way that happens is a short read — so it clamps at zero and the chart
 * comes out flat-bottomed instead of inverted.
 */
export function buildSegments(
  nets: TickNet[],
  currentTick: number,
  activeLiquidity: bigint,
  loTick: number,
  hiTick: number,
): LiqSeg[] {
  if (hiTick <= loTick) return []
  const netAt = new Map<number, bigint>()
  for (const n of nets) netAt.set(n.tick, (netAt.get(n.tick) ?? 0n) + n.liquidityNet)

  const inner = [...netAt.keys()].filter((t) => t > loTick && t < hiTick).sort((a, b) => a - b)
  const bounds = [loTick, ...inner, hiTick]
  const n = bounds.length - 1
  if (n < 1) return []

  // the span holding the current price; a price outside the window anchors at
  // the nearer edge, which keeps the shape right even when the caller drew a
  // window the price has since left
  let k = 0
  for (let i = 0; i < n; i++) if (bounds[i] <= currentTick) k = i
  if (currentTick < loTick) k = 0

  const liq = new Array<bigint>(n).fill(0n)
  liq[k] = activeLiquidity
  for (let i = k + 1; i < n; i++) liq[i] = liq[i - 1] + (netAt.get(bounds[i]) ?? 0n)
  for (let i = k - 1; i >= 0; i--) liq[i] = liq[i + 1] - (netAt.get(bounds[i + 1]) ?? 0n)

  return liq.map((l, i) => ({
    lower: bounds[i],
    upper: bounds[i + 1],
    liquidity: l < 0n ? 0n : l,
  }))
}

/**
 * Resample the segments onto `bins` equal-width columns.
 *
 * Each column reports the tick-width-weighted average of what it covers, so a
 * narrow spike inside a wide column is diluted the way it should be — a column
 * claims the average depth across its span, and a spike that fills a twentieth of
 * one is a twentieth as tall. Bin edges are apportioned by rounding the running
 * fraction rather than by a fixed step, so the columns tile the window exactly
 * with no leftover ticks at the right edge.
 */
export function binLiquidity(
  segs: LiqSeg[],
  loTick: number,
  hiTick: number,
  bins: number,
): bigint[] {
  const span = hiTick - loTick
  if (span <= 0 || bins <= 0) return []
  const out: bigint[] = []
  for (let i = 0; i < bins; i++) {
    const a = loTick + Math.round((span * i) / bins)
    const b = loTick + Math.round((span * (i + 1)) / bins)
    const width = b - a
    if (width <= 0) {
      out.push(0n)
      continue
    }
    let acc = 0n
    for (const s of segs) {
      const lo = a > s.lower ? a : s.lower
      const hi = b < s.upper ? b : s.upper
      if (hi > lo) acc += s.liquidity * BigInt(hi - lo)
    }
    out.push(acc / BigInt(width))
  }
  return out
}
