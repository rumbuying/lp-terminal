import { useState } from 'react'
import { clTokenUsd } from '../lib/apr'
import { fmtNum } from '../lib/format'
import type { ClPool } from '../types'

export type PriceUnit = {
  /** an anchor exists, so the $ toggle has something to offer */
  available: boolean
  /** dollars are on; null while the pool's own quote is showing */
  usd: { exact: boolean } | null
  usdOn: boolean
  toggleUsd: () => void
  /** which orientation the plot and the labels are in */
  flipped: boolean
  toggleFlip: () => void
  /** a displayed price, in whichever unit is on */
  money: (x: number) => string
  /**
   * What `money` multiplied by — 1 while the pool's own quote is showing. An
   * editable bound needs the way BACK: a typed dollar figure is a ratio divided
   * by this, and without it the only inverse is re-deriving the anchor.
   */
  scale: number
}

/**
 * Which unit a price band is read in, and which way round it faces.
 *
 * Two controls that look independent are not: ⇄ picks WHICH token is being
 * priced, $ picks what it is priced IN, and the second one settles the first.
 * An anchor's own dollar price is pinned by definition, so a band drawn in it
 * would collapse onto a point — dollars have to price the token that ISN'T the
 * anchor, which fixes the orientation. While $ is on, ⇄ has nothing left to
 * choose and the caller drops it.
 *
 * `exact` is the difference between the two kinds of dollar reading. Against the
 * $1 stable the pool's own price IS the dollar price. Against WETH the figure
 * rides on a WETH/USD read and moves whenever ETH does while the bounds sit
 * still — callers mark that one.
 */
export function usePriceUnit(args: {
  pool: ClPool | null
  dec0: number
  dec1: number
  upUsd?: number
  wethUsd?: number | null
  /** dollars are the default reading; an order bar keeps its own orientation */
  defaultUsd?: boolean
  defaultFlipped?: boolean
}): PriceUnit {
  const { pool, dec0, dec1 } = args
  const [usdOn, setUsdOn] = useState(args.defaultUsd ?? true)
  const [manualFlip, setManualFlip] = useState(args.defaultFlipped ?? false)

  const px = pool ? clTokenUsd(pool, dec0, dec1, args.upUsd, args.wethUsd) : null
  const usd = usdOn ? px : null
  // the ratio times the anchor's own dollar price, which is 1 against the stable
  const scale = usd ? (usd.anchor === 0 ? usd.p0 : usd.p1) : 1

  return {
    available: !!px,
    usd: usd && { exact: usd.exact },
    usdOn,
    toggleUsd: () => setUsdOn((on) => !on),
    flipped: usd ? usd.anchor === 0 : manualFlip,
    toggleFlip: () => setManualFlip((f) => !f),
    money: (x) => (usd ? `$${fmtNum(x * scale)}` : fmtNum(x)),
    scale,
  }
}
