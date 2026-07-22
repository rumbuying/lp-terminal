// Pure zap sizing math — no imports, safe under node:test (zap.ts itself
// pulls wagmi/env and only loads in the browser bundle).

/** pool-side input: how much of A to swap into the counter token so the two
 *  piles match the deposit ratio ρ (counter-per-kept) at rate (counter-per-input) */
export function solveSwap(amountIn: bigint, rho: number, rate: number): bigint {
  if (rho === 0) return 0n
  if (!Number.isFinite(rho)) return amountIn
  const A = Number(amountIn)
  const s = (A * rho) / (rate + rho)
  const sb = BigInt(Math.round(Math.min(Math.max(s, 0), A)))
  return sb > amountIn ? amountIn : sb
}

/**
 * Outside-token split: slice the input A into s0+s1 so the two swap outputs
 * land on the target ratio ρ = amt1/amt0. With leg rates r0 (token0-per-input)
 * and r1 (token1-per-input): s1/s0 = ρ·r0/r1, so s0 = A/(1 + ρ·r0/r1). At fair
 * prices r1/r0 is the pool's own spot (token1-per-token0), which seeds round
 * one without quoting; the planner re-solves from measured leg rates after.
 * Sub-ppm slivers fold into the other leg — not worth a transaction.
 */
export function splitOutside(
  amountIn: bigint,
  rho: number,
  r0OverR1: number,
): { buyIs0: boolean; swapIn: bigint }[] {
  if (rho === 0) return [{ buyIs0: true, swapIn: amountIn }]
  if (!Number.isFinite(rho)) return [{ buyIs0: false, swapIn: amountIn }]
  if (!(r0OverR1 > 0) || !Number.isFinite(r0OverR1)) return [{ buyIs0: true, swapIn: amountIn }]
  const f = 1 / (1 + rho * r0OverR1)
  let s0 = BigInt(Math.round(Number(amountIn) * Math.min(Math.max(f, 0), 1)))
  if (s0 > amountIn) s0 = amountIn
  let s1 = amountIn - s0
  if (s0 > 0n && s0 * 1_000_000n < amountIn) {
    s1 += s0
    s0 = 0n
  }
  if (s1 > 0n && s1 * 1_000_000n < amountIn) {
    s0 += s1
    s1 = 0n
  }
  const spec: { buyIs0: boolean; swapIn: bigint }[] = []
  if (s0 > 0n) spec.push({ buyIs0: true, swapIn: s0 })
  if (s1 > 0n) spec.push({ buyIs0: false, swapIn: s1 })
  return spec
}
