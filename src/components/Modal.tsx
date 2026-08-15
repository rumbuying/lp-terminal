import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * A dialog over the terminal.
 *
 * Everything else in this app that overlays (the activity log, the chain list,
 * an address card) hangs off the control that opened it and closes the moment
 * you look elsewhere. This takes the screen instead, for the two things that
 * earn it: a question that has to be answered before the page can do its job
 * (NetworkPrompt), and a form too tall to open in place on a phone (the POOLS
 * trade panel).
 *
 * Portalled to <body>, so no ancestor's `overflow` or stacking context can clip
 * it — `.main` and the tab panels are full of both. It sits under the CRT
 * overlays at 998/999, which are the screen itself and belong on top.
 */
export function Modal({
  title,
  onClose,
  children,
  foot,
  sheet,
  bare,
}: {
  title: string
  /** omit to make the dialog unanswerable except through its own body */
  onClose?: () => void
  children: ReactNode
  foot?: ReactNode
  /**
   * Rise from the bottom edge on a phone rather than floating in the middle.
   *
   * A centred card is the right shape for a question with two buttons. A form
   * is a different object: it is tall, it is scrolled, and it summons a
   * keyboard — and a keyboard takes the bottom half of the screen, which is
   * where a centred card's inputs are. Anchoring to the bottom edge also keeps
   * the list that opened it visible along the top, so the market being traded
   * stays on screen instead of being replaced by the trade.
   */
  sheet?: boolean
  /**
   * Suppress the title bar: the child draws its own head and owns the close.
   *
   * The trade panel's head is not a title — it is the pair's avatars, its
   * copyable addresses, its protocol badge. Rendering a plain string above all
   * of that would state the pair twice and put two ✕ in one corner.
   */
  bare?: boolean
}) {
  const panel = useRef<HTMLDivElement>(null)
  // read through a ref so the effect below can be [] — with onClose in the deps
  // an inline arrow from the caller would re-run it every render, and re-running
  // it steals focus back into the dialog on every keystroke
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    // one class, two jobs: it locks the page behind from scrolling, and App's
    // global tab keys stand down while it is set — [1] must not change the tab
    // underneath an open dialog
    document.body.classList.add('modal-open')
    const restore = document.activeElement as HTMLElement | null
    // focus lands inside, so Esc and Tab belong to the dialog from the first
    // keystroke rather than after the user thinks to click it
    panel.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && close.current) {
        e.stopPropagation()
        close.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.classList.remove('modal-open')
      window.removeEventListener('keydown', onKey)
      restore?.focus?.()
    }
  }, [])

  return createPortal(
    <div
      className={`modal-back${sheet ? ' sheet' : ''}`}
      onClick={() => close.current?.()}
    >
      <div
        className={`modal${sheet ? ' sheet' : ''}${bare ? ' bare' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
        // the backdrop closes on click; a click that lands on the card itself
        // is not a click on the backdrop
        onClick={(e) => e.stopPropagation()}
      >
        {/* the drag affordance of a sheet, without the drag: it says which edge
            this came from and that the backdrop above it is still the page */}
        {sheet && <div className="modal-grip" aria-hidden="true" />}
        {!bare && (
          <div className="modal-hd">
            <span>{title}</span>
            {onClose && (
              <button className="chip" onClick={onClose} aria-label="close">
                ×
              </button>
            )}
          </div>
        )}
        {bare ? children : <div className="modal-body">{children}</div>}
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>,
    document.body,
  )
}
