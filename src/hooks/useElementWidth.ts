import { useEffect, useState, type RefObject } from 'react'

/**
 * The element's own width, tracked.
 *
 * A viewport breakpoint answers the wrong question for anything that has to
 * count columns: the same chart is drawn in a 940px expander, in a card whose
 * track shares its row with two prices, and on a phone — three widths that one
 * `max-width` query cannot tell apart, because two of them happen at the same
 * viewport size.
 *
 * Reports 0 until the first observation, which callers should read as "not
 * measured yet" and answer with a default rather than with nothing — the
 * observer fires in the same frame, so a zero is one paint, and rendering
 * emptiness for it would be a flash.
 */
export function useElementWidth(ref: RefObject<Element | null>): number {
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0
      // whole pixels only: a fractional resize would otherwise re-derive the
      // column count on every sub-pixel layout shift
      setW((prev) => (Math.round(next) === Math.round(prev) ? prev : next))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}

/**
 * How many columns fit at a legible pitch, given a measured width.
 *
 * Columns are what makes a distribution read as a distribution — the gaps
 * between them are the thing that says "these are discrete buckets" rather than
 * "this is a shape". Which means the pitch is the constraint and the count is
 * the outcome, not the other way round: hold the count fixed and a narrow
 * screen drives the columns down to a few pixels, where a 1px gap eats a fifth
 * of each one and the only way out is to drop the gap — which is to say, to
 * stop drawing columns at all.
 */
export function binsForWidth(width: number, pitch: number, min: number, max: number, fallback: number) {
  if (!(width > 0)) return fallback
  return Math.max(min, Math.min(max, Math.round(width / pitch)))
}
