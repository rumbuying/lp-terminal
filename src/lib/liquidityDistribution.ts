export const MAX_BITMAP_WORDS = 24
export const DISTRIBUTION_BINS = 72

export type TickLiquidityDelta = {
  tick: number
  liquidityNet: bigint
}

export type DistributionDomain = {
  tickLow: number
  tickHigh: number
  wordLow: number
  wordHigh: number
  clipped: boolean
}

export type LiquidityBin = {
  tickLow: number
  tickHigh: number
  liquidity: number
}

export function floorDiv(value: number, divisor: number): number {
  return Math.floor(value / divisor)
}

/** The bitmap indexes compressed ticks in 256-bit words. Keep RPC work bounded
 * for full-range positions while showing the complete selection for normal
 * concentrated ranges (up to roughly +/-30% even at tick spacing 1). */
export function distributionDomain(
  currentTick: number,
  tickSpacing: number,
  selectedLower: number,
  selectedUpper: number,
  maxWords = MAX_BITMAP_WORDS,
): DistributionDomain {
  const spacing = Math.max(1, Math.abs(tickSpacing))
  const selectedLow = Math.min(currentTick, selectedLower)
  const selectedHigh = Math.max(currentTick, selectedUpper)
  const span = Math.max(spacing * 2, selectedHigh - selectedLow)
  const padding = Math.max(spacing * 2, Math.ceil(span * 0.06 / spacing) * spacing)
  let tickLow = selectedLow - padding
  let tickHigh = selectedHigh + padding
  let wordLow = floorDiv(floorDiv(tickLow, spacing), 256)
  let wordHigh = floorDiv(floorDiv(tickHigh, spacing), 256)
  let clipped = false

  // A bitmap word can cover an enormous price span at high tick spacing.
  // Scan whole words, but keep the visual domain tied to the chosen prices.
  // Full-range positions are capped to about +/-35% around spot.
  const maxVisualSpan = Math.min((maxWords - 1) * 256 * spacing, 6_000)
  if (wordHigh - wordLow + 1 > maxWords || tickHigh - tickLow > maxVisualSpan) {
    clipped = true
    const currentWord = floorDiv(floorDiv(currentTick, spacing), 256)
    const leftWords = Math.floor((maxWords - 1) / 2)
    wordLow = currentWord - leftWords
    wordHigh = wordLow + maxWords - 1
    tickLow = Math.max(currentTick - maxVisualSpan / 2, wordLow * 256 * spacing)
    tickHigh = Math.min(currentTick + maxVisualSpan / 2, (wordHigh + 1) * 256 * spacing)
  }

  return {
    tickLow,
    tickHigh,
    wordLow,
    wordHigh,
    clipped,
  }
}

export function initializedTicksFromBitmap(word: number, bitmap: bigint, tickSpacing: number): number[] {
  const ticks: number[] = []
  const spacing = Math.max(1, Math.abs(tickSpacing))
  for (let bit = 0; bit < 256; bit++) {
    if ((bitmap & (1n << BigInt(bit))) !== 0n) ticks.push((word * 256 + bit) * spacing)
  }
  return ticks
}

/** Reconstructs active liquidity on either side of the live tick by applying
 * liquidityNet when moving upward, and reversing it when moving downward. */
export function buildLiquidityBins(
  currentTick: number,
  currentLiquidity: bigint,
  deltas: readonly TickLiquidityDelta[],
  domain: Pick<DistributionDomain, 'tickLow' | 'tickHigh'>,
  binCount = DISTRIBUTION_BINS,
): LiquidityBin[] {
  const safeBins = Math.max(1, Math.floor(binCount))
  const width = (domain.tickHigh - domain.tickLow) / safeBins
  const sorted = [...deltas].sort((a, b) => a.tick - b.tick)
  const base = Number(currentLiquidity)

  return Array.from({ length: safeBins }, (_, index) => {
    const tickLow = domain.tickLow + index * width
    const tickHigh = tickLow + width
    const center = (tickLow + tickHigh) / 2
    let liquidity = base
    if (center >= currentTick) {
      for (const delta of sorted) {
        if (delta.tick > currentTick && delta.tick <= center) liquidity += Number(delta.liquidityNet)
      }
    } else {
      for (const delta of sorted) {
        if (delta.tick > center && delta.tick <= currentTick) liquidity -= Number(delta.liquidityNet)
      }
    }
    return { tickLow, tickHigh, liquidity: Math.max(0, liquidity) }
  })
}
