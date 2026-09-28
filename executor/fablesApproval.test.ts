import assert from 'node:assert/strict'
import test from 'node:test'
import { FABLES_APPROVAL_LIMIT, FABLES_APPROVAL_PAD_BPS, fablesApprovalAmount } from './fablesLimits'

test('a swap approval carries a 5% pad so a small re-plan reuses it', () => {
  const planned = 45_214_839_033_505_622_816n
  const approved = fablesApprovalAmount(planned)
  assert.equal(FABLES_APPROVAL_PAD_BPS, 500n)
  assert.ok(approved > planned)
  // 42.19 PONS covered a later 44.56 PONS plan only after a second approval in
  // production; the pad must cover a move of this size.
  assert.ok(approved >= planned + planned * 400n / 10_000n)
  assert.ok(approved <= planned + planned * 501n / 10_000n)
})

test('the pad rounds up and never shrinks the approved amount', () => {
  assert.equal(fablesApprovalAmount(1n), 2n)
  assert.equal(fablesApprovalAmount(10_000n), 10_500n)
  assert.equal(fablesApprovalAmount(10_001n), 10_502n)
})

test('an unusable approval amount is rejected instead of silently approving zero', () => {
  assert.throws(() => fablesApprovalAmount(0n), /E_FABLES_APPROVAL_AMOUNT/)
  assert.throws(() => fablesApprovalAmount(-1n), /E_FABLES_APPROVAL_AMOUNT/)
})

test('the per-stage budget covers a re-plan plus one router flip', () => {
  // Observed live: one approval per router, then zero-reset plus approve for
  // two raised plans — six consumed before the position could be re-deposited.
  assert.ok(FABLES_APPROVAL_LIMIT >= 8)
})
