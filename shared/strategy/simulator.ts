import type { SimulatorCycle, SimulatorInput, SimulatorResult } from './types'

const EPS = 1e-12

function positionValueRatio(priceRatio: number, lowerPct: number, upperPct: number): number {
  const lo = 1 - lowerPct / 100
  const hi = 1 + upperPct / 100
  if (!(lo > 0 && hi > lo && priceRatio > 0)) throw new Error('invalid simulation range')
  const startX = 1 - 1 / Math.sqrt(hi)
  const startY = 1 - Math.sqrt(lo)
  const start = startX + startY
  let x: number
  let y: number
  if (priceRatio <= lo) {
    x = 1 / Math.sqrt(lo) - 1 / Math.sqrt(hi)
    y = 0
  } else if (priceRatio >= hi) {
    x = 0
    y = Math.sqrt(hi) - Math.sqrt(lo)
  } else {
    x = 1 / Math.sqrt(priceRatio) - 1 / Math.sqrt(hi)
    y = Math.sqrt(priceRatio) - Math.sqrt(lo)
  }
  return (priceRatio * x + y) / start
}

function hitPrice(from: number, to: number, lower: number, upper: number): number | null {
  if (to < lower && from >= lower) return lower
  if (to >= upper && from < upper) return upper
  return null
}

/**
 * Quote-denominated concentrated-LP path simulator. Fees are accrued against
 * live LP principal and immediately parked in quote currency for
 * convert_to_quote; it intentionally has no chain/RPC dependency.
 */
export function simulateStrategy(input: SimulatorInput): SimulatorResult {
  if (!(input.initialValue > 0 && input.startPrice > 0 && input.endPrice > 0 && input.durationDays > 0))
    throw new Error('invalid simulator input')
  const steps = Math.max(60, Math.floor(input.steps ?? 1440))
  const dt = input.durationDays / steps
  const dailyFeeRate = input.aprPct / 100 / 365
  let entryPrice = input.startPrice
  let lpPrincipal = input.initialValue
  let feeCash = 0
  let t = 0
  const cycles: SimulatorCycle[] = []

  const priceAt = (day: number) => input.startPrice + ((input.endPrice - input.startPrice) * day) / input.durationDays
  const valueAt = (p: number) => lpPrincipal * positionValueRatio(p / entryPrice, input.lowerPct, input.upperPct)
  const accrue = (fromPrice: number, toPrice: number, days: number) => {
    if (days <= 0) return
    const average = (valueAt(fromPrice) + valueAt(toPrice)) / 2
    const fee = average * dailyFeeRate * days
    if (input.feeHandling === 'reinvest') lpPrincipal += fee
    else feeCash += fee
  }

  while (t < input.durationDays - EPS) {
    const nextT = Math.min(input.durationDays, t + dt)
    const from = priceAt(t)
    const to = priceAt(nextT)
    const lower = entryPrice * (1 - input.lowerPct / 100)
    const upper = entryPrice * (1 + input.upperPct / 100)
    const hit = hitPrice(from, to, lower, upper)
    if (hit !== null) {
      const frac = Math.abs(to - from) < EPS ? 1 : Math.abs((hit - from) / (to - from))
      const hitT = t + (nextT - t) * frac
      accrue(from, hit, hitT - t)
      const side = hit <= lower ? 'lower' : 'upper'
      const before = valueAt(hit)
      cycles.push({ side, price: hit, atDays: hitT, valueBeforeRecenter: before })
      const action = side === 'lower' ? input.lowerAction : input.upperAction
      if (action === 'recenter' || action === 'skew_recenter') {
        lpPrincipal = before
        entryPrice = hit
        t = hitT
        continue
      }
      if (action === 'hold_quote' || action === 'pause') {
        feeCash += before
        lpPrincipal = 0
        t = input.durationDays
        break
      }
    }
    accrue(from, to, nextT - t)
    t = nextT
  }
  const finalPrice = priceAt(input.durationDays)
  const endingLpValue = lpPrincipal === 0 ? 0 : valueAt(finalPrice)
  const endingValue = endingLpValue + feeCash
  return {
    endingLpValue,
    feesQuote: feeCash,
    endingValue,
    pnlPct: ((endingValue - input.initialValue) / input.initialValue) * 100,
    rebalances: cycles.filter((x) => (x.side === 'lower' ? input.lowerAction : input.upperAction) === 'recenter').length,
    cycles,
  }
}
