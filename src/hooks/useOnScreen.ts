import { useEffect, useState, type RefObject } from 'react'

/**
 * Has this element been scrolled into view yet?
 *
 * Latches ON and never goes back: this gates a network read, and a list you
 * scroll down and back up would otherwise re-arm every card it passed. What it
 * is worth is the first paint — a wallet holding positions in a dozen pools
 * pays for the two or three it can actually see, and pays for the rest only if
 * it goes looking.
 *
 * `rootMargin` runs ahead of the viewport so the fetch starts while the card is
 * still below the fold, and the data is usually there by the time it arrives.
 *
 * Without IntersectionObserver — jsdom, an old engine — it reports true from the
 * start, which degrades to the behaviour of not having gated at all.
 */
export function useOnScreen(ref: RefObject<Element | null>, rootMargin = '300px'): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    if (seen) return
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true)
      },
      { rootMargin },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [ref, rootMargin, seen])
  return seen
}
