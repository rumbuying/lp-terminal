// Remembered preference: after a Zap/Pair into a stakeable pool, continue into
// the stake flow by default. A tiny external store (localStorage-backed) so the
// checkbox reflects toggles made from any add surface — POOLS, POSITIONS, ZAP.
const KEY = 'lp.stakeAfter'
let on = localStorage.getItem(KEY) !== '0' // default on
const subs = new Set<() => void>()

export const autostake = {
  get: (): boolean => on,
  set(value: boolean) {
    on = value
    localStorage.setItem(KEY, value ? '1' : '0')
    subs.forEach((f) => f())
  },
  subscribe(f: () => void): () => void {
    subs.add(f)
    return () => subs.delete(f)
  },
}
