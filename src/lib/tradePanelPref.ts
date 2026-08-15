/**
 * Which half of the trade panel opens first — the swap form, or the deposit
 * form — remembered per browser.
 *
 * SWAP is the default because it is what the market list is for: a row is a
 * price, and the first thing anyone does with a price is take it. Providing
 * liquidity is the deliberate second act, and it needs a range chosen before it
 * means anything.
 *
 * But that is a default and not a claim about the user. Somebody who came here
 * to run positions opens ten pools in a row and wants the deposit form on every
 * one of them, so the panel simply remembers whichever tab was last used and
 * opens there next time. No settings screen: the preference IS the last click.
 *
 * A tiny external store rather than component state — the panel remounts on
 * every selection and every tab switch, and the choice has to outlive both.
 */
export type TradeTab = 'swap' | 'liquidity'

const KEY = 'lp.tradeTab.v1'

function stored(): TradeTab {
  try {
    return localStorage.getItem(KEY) === 'liquidity' ? 'liquidity' : 'swap'
  } catch {
    return 'swap' // private mode / storage disabled — the default still holds
  }
}

let current: TradeTab = stored()
const subs = new Set<() => void>()

export const tradePanelTab = {
  get: (): TradeTab => current,
  set(tab: TradeTab) {
    current = tab
    try {
      localStorage.setItem(KEY, tab)
    } catch {
      /* storage unavailable — the choice still holds for this session */
    }
    subs.forEach((f) => f())
  },
  subscribe(f: () => void): () => void {
    subs.add(f)
    return () => subs.delete(f)
  },
}
