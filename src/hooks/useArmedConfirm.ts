import { useEffect, useRef, useState } from 'react'

// Long enough to read a percentage and a min-received line, short enough that a
// yes left on screen does not outlive the quote it was given against.
const ARM_MS = 5000

/**
 * A press that only counts the second time.
 *
 * `subject` is what the arming was FOR — the exact thing the first press
 * agreed to. It is compared rather than merely watched: a tolerance that moved
 * on the next quote, or a trade retyped after arming, takes the arming with it,
 * so the second press can only ever confirm what the first press read. Coming
 * back to the same subject arms nothing; the reset is a fresh false, not a
 * lookup that would say yes again.
 *
 * Arming lapses on its own. Someone who armed and walked away returns to a
 * button that asks again, and the lapse costs a press rather than a trade —
 * which is the direction this is allowed to fail in.
 */
export function useArmedConfirm(subject: string): {
  armed: boolean
  arm: () => void
  disarm: () => void
} {
  const [armed, setArmed] = useState(false)
  // React's own way to adjust state when an input changes: reset during render,
  // so a stale yes is never live for even one frame (hooks/useHeldHeight.ts)
  const [armedFor, setArmedFor] = useState(subject)
  if (armedFor !== subject) {
    setArmedFor(subject)
    setArmed(false)
  }

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stop = () => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }
  // a panel closed while armed leaves a timer holding a setState behind it
  useEffect(() => stop, [])

  return {
    armed,
    arm: () => {
      stop()
      setArmed(true)
      timer.current = setTimeout(() => setArmed(false), ARM_MS)
    },
    disarm: () => {
      stop()
      setArmed(false)
    },
  }
}
