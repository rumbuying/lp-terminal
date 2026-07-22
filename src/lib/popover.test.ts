import assert from 'node:assert/strict'
import test from 'node:test'
import { popoverTop } from './popover'

const CARD = 118 // the address card: header + three rows, measured at 390px
const VH = 740 // a phone in portrait

test('drops below the trigger when there is room', () => {
  assert.equal(popoverTop({ top: 200, bottom: 216 }, CARD, VH), 222)
})

// the case that shipped broken: a row near the bottom of the screen put the
// card 103px past the fold, where close-on-scroll made it unreachable
test('flips above the trigger rather than off the bottom', () => {
  const top = popoverTop({ top: 702, bottom: 718 }, CARD, VH)
  assert.equal(top, 702 - CARD - 6)
  assert.ok(top + CARD <= VH, 'card must end above the fold')
  assert.ok(top >= 0, 'and must not start above the top edge')
})

test('clamps when neither side fits', () => {
  // trigger fills the screen: no room below, and above would be off the top
  const top = popoverTop({ top: 4, bottom: 700 }, CARD, VH)
  assert.equal(top, VH - CARD - 8)
  assert.ok(top >= 8)
})

test('a card taller than the viewport still starts on screen', () => {
  assert.equal(popoverTop({ top: 100, bottom: 116 }, 2000, VH), 8)
})

// whatever the trigger, the top edge is always visible — the copy rows below it
// may be cut off on an absurdly short viewport, but the card is never invisible
test('the card always starts inside the viewport', () => {
  for (const vh of [320, 500, 740, 900, 1400])
    for (let y = 0; y < vh; y += 17) {
      const top = popoverTop({ top: y, bottom: y + 16 }, CARD, vh)
      assert.ok(top >= 8, `vh=${vh} y=${y} -> ${top}`)
      assert.ok(top < vh, `vh=${vh} y=${y} -> ${top}`)
    }
})
