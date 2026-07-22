// Placement for this app's fixed popovers (PairAddrs' address card).
//
// `position: fixed` plus close-on-scroll makes an off-screen card unreachable
// rather than merely awkward: scrolling toward it is what dismisses it. So the
// only acceptable outcome is wholly on screen — prefer below the trigger, flip
// above when the card doesn't fit there, and clamp when neither side fits
// (a viewport shorter than the card, or a trigger pinned to the top edge).

/** vertical position for a `height`-tall card anchored to `trigger` */
export function popoverTop(
  trigger: { top: number; bottom: number },
  height: number,
  viewportH: number,
  gap = 8,
  offset = 6,
): number {
  const below = trigger.bottom + offset
  if (below + height <= viewportH - gap) return below
  const above = trigger.top - height - offset
  if (above >= gap) return above
  return Math.max(gap, viewportH - height - gap)
}
