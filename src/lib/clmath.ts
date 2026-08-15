// Concentrated-liquidity math (Uniswap v3 / Slipstream), BigInt port of TickMath
// + LiquidityAmounts. Validated against live pools by scripts/smoke.ts.

const MAX_UINT256 = (1n << 256n) - 1n
export const Q96 = 1n << 96n
export const MAX_UINT128 = (1n << 128n) - 1n
export const MIN_TICK = -887272
export const MAX_TICK = 887272

export function getSqrtRatioAtTick(tick: number): bigint {
  const absTick = tick < 0 ? -tick : tick
  if (absTick > MAX_TICK) throw new Error(`tick ${tick} out of range`)
  let ratio =
    (absTick & 0x1) !== 0
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n
  if (absTick & 0x2) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n
  if (absTick & 0x4) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n
  if (absTick & 0x8) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n
  if (absTick & 0x10) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n
  if (absTick & 0x20) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n
  if (absTick & 0x40) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n
  if (absTick & 0x80) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n
  if (absTick & 0x100) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n
  if (absTick & 0x200) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n
  if (absTick & 0x400) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n
  if (absTick & 0x800) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n
  if (absTick & 0x1000) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n
  if (absTick & 0x2000) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n
  if (absTick & 0x4000) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n
  if (absTick & 0x8000) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n
  if (absTick & 0x10000) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n
  if (absTick & 0x20000) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n
  if (absTick & 0x40000) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n
  if (absTick & 0x80000) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n
  if (tick > 0) ratio = MAX_UINT256 / ratio
  // Q128.128 -> Q64.96, rounding up
  return (ratio >> 32n) + ((ratio & 0xffffffffn) === 0n ? 0n : 1n)
}

/** amounts of token0/token1 a position of `liquidity` holds at price sqrtP */
export function getAmountsForLiquidity(
  sqrtP: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
  liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA]
  if (liquidity === 0n) return { amount0: 0n, amount1: 0n }
  if (sqrtP <= sqrtA) {
    return { amount0: amount0For(sqrtA, sqrtB, liquidity), amount1: 0n }
  }
  if (sqrtP >= sqrtB) {
    return { amount0: 0n, amount1: amount1For(sqrtA, sqrtB, liquidity) }
  }
  return {
    amount0: amount0For(sqrtP, sqrtB, liquidity),
    amount1: amount1For(sqrtA, sqrtP, liquidity),
  }
}

function amount0For(sqrtA: bigint, sqrtB: bigint, L: bigint): bigint {
  return (L * Q96 * (sqrtB - sqrtA)) / sqrtB / sqrtA
}
function amount1For(sqrtA: bigint, sqrtB: bigint, L: bigint): bigint {
  return (L * (sqrtB - sqrtA)) / Q96
}

/** max liquidity for given amounts (mirror of LiquidityAmounts.getLiquidityForAmounts) */
export function getLiquidityForAmounts(
  sqrtP: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
  amount0: bigint,
  amount1: bigint,
): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA]
  if (sqrtP <= sqrtA) return liquidity0(sqrtA, sqrtB, amount0)
  if (sqrtP >= sqrtB) return liquidity1(sqrtA, sqrtB, amount1)
  const l0 = liquidity0(sqrtP, sqrtB, amount0)
  const l1 = liquidity1(sqrtA, sqrtP, amount1)
  return l0 < l1 ? l0 : l1
}

function liquidity0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  if (sqrtB === sqrtA) return 0n
  return (amount0 * sqrtA * sqrtB) / Q96 / (sqrtB - sqrtA)
}
function liquidity1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  if (sqrtB === sqrtA) return 0n
  return (amount1 * Q96) / (sqrtB - sqrtA)
}

/**
 * Mint/increase preview: given one input amount, derive the other side.
 * Returns null when the entered token is inactive for the chosen range
 * (single-sided range on the other token).
 */
export function previewDeposit(
  sqrtP: bigint,
  tickLower: number,
  tickUpper: number,
  input: bigint,
  inputIsToken0: boolean,
): { amount0: bigint; amount1: bigint; liquidity: bigint } | null {
  const sqrtA = getSqrtRatioAtTick(tickLower)
  const sqrtB = getSqrtRatioAtTick(tickUpper)
  if (sqrtP <= sqrtA) {
    // price below range: token0-only
    if (!inputIsToken0) return null
    const L = liquidity0(sqrtA, sqrtB, input)
    return { amount0: input, amount1: 0n, liquidity: L }
  }
  if (sqrtP >= sqrtB) {
    // price above range: token1-only
    if (inputIsToken0) return null
    const L = liquidity1(sqrtA, sqrtB, input)
    return { amount0: 0n, amount1: input, liquidity: L }
  }
  if (inputIsToken0) {
    const L = liquidity0(sqrtP, sqrtB, input)
    return { amount0: input, amount1: amount1For(sqrtA, sqrtP, L), liquidity: L }
  }
  const L = liquidity1(sqrtA, sqrtP, input)
  return { amount0: amount0For(sqrtP, sqrtB, L), amount1: input, liquidity: L }
}

// ---------- price helpers (float, display only) ----------

/** price of token0 quoted in token1, human units */
export function tickToPrice(tick: number, dec0: number, dec1: number): number {
  return Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1)
}

export function sqrtPriceToPrice(sqrtPriceX96: bigint, dec0: number, dec1: number): number {
  const r = Number(sqrtPriceX96) / 2 ** 96
  return r * r * Math.pow(10, dec0 - dec1)
}

/** human price (token1/token0) -> nearest tick */
export function priceToTick(price: number, dec0: number, dec1: number): number {
  const raw = price / Math.pow(10, dec0 - dec1)
  return Math.round(Math.log(raw) / Math.log(1.0001))
}

export function alignTick(tick: number, spacing: number, mode: 'floor' | 'ceil'): number {
  const q = tick / spacing
  const aligned = (mode === 'floor' ? Math.floor(q) : Math.ceil(q)) * spacing
  return Math.min(Math.max(aligned, Math.ceil(MIN_TICK / spacing) * spacing), Math.floor(MAX_TICK / spacing) * spacing)
}

export function fullRangeTicks(spacing: number): { lower: number; upper: number } {
  return {
    lower: Math.ceil(MIN_TICK / spacing) * spacing,
    upper: Math.floor(MAX_TICK / spacing) * spacing,
  }
}

/** tick delta approximating a +/- pct price band (e.g. 0.10 => ~10%) */
export function tickDeltaForPct(pct: number): number {
  return Math.max(1, Math.round(Math.log(1 + pct) / Math.log(1.0001)))
}

export function applySlippage(x: bigint, bps: number): bigint {
  return (x * BigInt(10_000 - bps)) / 10_000n
}

/**
 * The largest liquidity the given amounts can fund at ANY price the deposit
 * might land on — the off-chain half of a v4 deposit.
 *
 * A v3 NPM derives liquidity from the live price INSIDE `increaseLiquidity`, so
 * the amounts it pulls are capped by the `desired` values the caller passed.
 * v4 takes the liquidity as an input and caps the pull with `amountMax`, which
 * moves the sizing decision off-chain: size at the live price and a move
 * between signing and mining pulls more of one side than the user typed.
 *
 * Sizing at the EDGES of the slippage band instead makes the typed amounts the
 * true ceiling. token0 is dearest at the bottom of the band and token1 at the
 * top, so each side is measured where it binds, and the smaller of the two
 * liquidities is the one both sides can pay for anywhere in between.
 *
 * The band is clamped to the position's own range because cost stops growing
 * there: below the lower tick the deposit is all token0 and its size no longer
 * depends on price, above the upper tick likewise for token1.
 *
 * A position already OUT of range collapses the band to a point, deliberately.
 * Its cost does not move with price while it stays out, and widening the band
 * back across the tick would size a one-sided top-up against a token the caller
 * has not funded — which comes out as "nothing can be deposited" on exactly the
 * out-of-range position this is most often used for. If price does cross in
 * before the transaction lands, the unfunded side's max is zero and the deposit
 * reverts, rather than reaching for a token nobody offered.
 */
export function liquidityForAmountsWithSlippage(
  sqrtP: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
  amount0: bigint,
  amount1: bigint,
  slipBps: number,
): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA]
  const SCALE = 1_000_000_000n
  const up = BigInt(Math.round(Math.sqrt(1 + slipBps / 10_000) * 1e9))
  const dn = BigInt(Math.round(Math.sqrt(Math.max(0, 1 - slipBps / 10_000)) * 1e9))
  let lo = (sqrtP * dn) / SCALE
  let hi = (sqrtP * up) / SCALE
  if (sqrtP <= sqrtA) lo = hi = sqrtA
  else if (sqrtP >= sqrtB) lo = hi = sqrtB
  else {
    if (lo < sqrtA) lo = sqrtA
    if (hi > sqrtB) hi = sqrtB
  }
  // UNBOUNDED stands in for "this side does not bind here" — each edge is asked
  // about one token, and getLiquidityForAmounts returns the min of the two.
  const UNBOUNDED = 1n << 224n
  const l0 = getLiquidityForAmounts(lo, sqrtA, sqrtB, amount0, UNBOUNDED)
  const l1 = getLiquidityForAmounts(hi, sqrtA, sqrtB, UNBOUNDED, amount1)
  return l0 < l1 ? l0 : l1
}

/**
 * Slippage mins for CL liquidity ops. An in-range position's token SPLIT moves
 * much faster than its value (a 1–2% price move can shift one side by 30%+),
 * so flat "amount × (1−slip)" mins revert with 'PS' whenever price drifts.
 * Correct bound: evaluate amounts at the EDGES of the allowed price band —
 * amount0 is worst at price × (1+slip), amount1 at price × (1−slip); any price
 * inside the band then satisfies both mins.
 */
export function minAmountsForLiquidity(
  sqrtP: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
  liquidity: bigint,
  slipBps: number,
): { amount0Min: bigint; amount1Min: bigint } {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA]
  const SCALE = 1_000_000_000n
  const up = BigInt(Math.round(Math.sqrt(1 + slipBps / 10_000) * 1e9))
  const dn = BigInt(Math.round(Math.sqrt(Math.max(0, 1 - slipBps / 10_000)) * 1e9))
  let hi = (sqrtP * up) / SCALE
  let lo = (sqrtP * dn) / SCALE
  if (hi > sqrtB) hi = sqrtB
  if (lo < sqrtA) lo = sqrtA
  return {
    amount0Min: getAmountsForLiquidity(hi, sqrtA, sqrtB, liquidity).amount0,
    amount1Min: getAmountsForLiquidity(lo, sqrtA, sqrtB, liquidity).amount1,
  }
}
