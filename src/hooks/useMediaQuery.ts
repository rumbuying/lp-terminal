import { useSyncExternalStore } from 'react'

/**
 * A CSS media query, read as React state.
 *
 * Almost every responsive decision in this app belongs in the stylesheet, and
 * stays there. This is for the handful that cannot be: where a layout answer
 * changes not how a node is PAINTED but where it LIVES in the tree — the POOLS
 * trade panel, which is a column beside the market list on a desktop and a
 * dialog portalled to <body> on a phone. `display` cannot move a node between
 * two parents, so the breakpoint has to be legible to JS as well.
 *
 * Queries are cached module-wide: a MediaQueryList per query string, shared by
 * every component asking the same question, so a hundred rows subscribing to
 * one breakpoint cost one listener each rather than one matcher each.
 */
const lists = new Map<string, MediaQueryList>()

function listFor(query: string): MediaQueryList | null {
  if (typeof window === 'undefined' || !window.matchMedia) return null
  let mql = lists.get(query)
  if (!mql) {
    mql = window.matchMedia(query)
    lists.set(query, mql)
  }
  return mql
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = listFor(query)
      if (!mql) return () => {}
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    () => listFor(query)?.matches ?? false,
    // server/no-matchMedia: the desktop layout is the one that degrades
    // gracefully into a narrow window, so it is the safe guess
    () => false,
  )
}

/**
 * Below the width where the market list and the trade panel stop fitting side
 * by side. The number is the same 1200px boundary the stylesheet uses to turn
 * `.market-split` into a row — the two must agree exactly, or there is a band
 * of widths where the panel is neither a column nor a dialog.
 */
export const SPLIT_MIN_WIDTH = 1200

export function useNarrowLayout(): boolean {
  return useMediaQuery(`(max-width: ${SPLIT_MIN_WIDTH - 1}px)`)
}
