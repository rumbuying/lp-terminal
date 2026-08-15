import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

/**
 * A floor under a box whose contents are about to disappear and come back.
 *
 * A quote older than the refresh interval is withheld on purpose — a price
 * from fifteen seconds ago is not a price — so every refresh empties the quote
 * cards for as long as the next answer takes. Emptying them moved the SWAP
 * button 109px up and back once per cycle, measured on the live panel, which
 * on a phone is a button walking away from the thumb already reaching for it.
 *
 * What is held is the SPACE, never the numbers. The withheld quote stays
 * withheld; the box simply keeps the height it had while it last had something
 * real to show, so nothing below it moves.
 *
 * The floor is measured rather than declared because the natural height
 * depends on the route just drawn — a three-hop split is twice the height of a
 * direct swap — and any constant would be wrong for one of them.
 *
 * `subject` is what the floor was measured FOR. A height taken from a
 * three-hop split of 1 BNB says nothing about the next trade the form is
 * pointed at, so naming the subject drops the floor the moment it changes
 * rather than reserving last trade's space for this one.
 */
export function useHeldHeight(
  hold: boolean,
  subject: string,
): {
  ref: (node: HTMLElement | null) => void
  style: CSSProperties | undefined
} {
  // A CALLBACK ref, not a ref object. The box being measured is inside the
  // panel's `amount > 0` branch, so on the render that runs this hook's effect
  // it does not exist yet — a ref object read once on mount reads null, the
  // observer is never attached, and the floor stays 0 forever. Holding the
  // node in state re-runs the effect the moment it appears.
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [floor, setFloor] = useState(0)
  // React's own way to adjust state when an input changes: reset during render,
  // so the stale floor is never painted for even one frame
  const [measuredFor, setMeasuredFor] = useState(subject)
  if (measuredFor !== subject) {
    setMeasuredFor(subject)
    setFloor(0)
  }
  // the observer outlives the render that created it, so it reads the flag
  // through a ref rather than closing over this render's value
  const holding = useRef(hold)
  holding.current = hold

  useLayoutEffect(() => {
    if (!node) return
    const observer = new ResizeObserver(() => {
      // measuring while held would record the floor as the content's height,
      // which is the collapsed height this exists to avoid
      if (holding.current) return
      const height = node.getBoundingClientRect().height
      if (height > 0) setFloor(height)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])

  return { ref: setNode, style: hold && floor > 0 ? { minHeight: floor } : undefined }
}
