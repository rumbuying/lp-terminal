import assert from 'node:assert/strict'
import test from 'node:test'
import { stepReduction, emptyReduction, type ReductionObservation } from './emergingReduction'

const HOUR = 3_600 // seconds — the whole pipeline's time base is unix seconds (§3.2)
const obs = (ts: number, residual = 0.004, flow = 0.0005): ReductionObservation => ({
  ts, residualShare: residual, maxSourceHourOutflowShare: flow,
})

test('reduction: 6h of continuous qualification confirms, with started → confirmed events', () => {
  let st = emptyReduction()
  const t0 = 1_000_000
  const r1 = stepReduction(st, obs(t0))
  assert.equal(r1.event, 'started')
  st = r1.state
  for (let h = 1; h < 6; h++) {
    const r = stepReduction(st, obs(t0 + h * HOUR))
    assert.equal(r.event, null)
    st = r.state
  }
  const done = stepReduction(st, obs(t0 + 6 * HOUR))
  assert.equal(done.event, 'confirmed')
  assert.equal(done.state.confirmedAt, t0 + 6 * HOUR)
})

test('reduction: a break inside the window resets the whole window (§5.2)', () => {
  let st = emptyReduction()
  const t0 = 1_000_000
  st = stepReduction(st, obs(t0)).state
  st = stepReduction(st, obs(t0 + 2 * HOUR, 0.008)).state // residual re-rose mid-window
  assert.equal(st.startedAt, null)
  // Qualifying again starts a FRESH window from that ts.
  const fresh = stepReduction(st, obs(t0 + 3 * HOUR))
  assert.equal(fresh.event, 'started')
  assert.equal(fresh.state.startedAt, t0 + 3 * HOUR)
})

test('reduction: a large related-source outflow disqualifies exactly like a re-rise', () => {
  let st = stepReduction(emptyReduction(), obs(0)).state
  const r = stepReduction(st, obs(HOUR, 0.004, 0.002)) // flow 0.2% > 0.1% cap
  assert.equal(r.state.startedAt, null)
  assert.equal(r.event, null)
})

test('reduction: after confirmation a break INVALIDATES; re-qualification starts anew', () => {
  let st = emptyReduction()
  const t0 = 1_000_000
  st = stepReduction(st, obs(t0)).state
  st = stepReduction(st, obs(t0 + 6 * HOUR)).state
  assert.equal(st.confirmedAt, t0 + 6 * HOUR)
  const broken = stepReduction(st, obs(t0 + 7 * HOUR, 0.05))
  assert.equal(broken.event, 'invalidated')
  assert.equal(broken.state.invalidatedAt, t0 + 7 * HOUR)
  assert.equal(broken.state.confirmedAt, null)
  const again = stepReduction(broken.state, obs(t0 + 8 * HOUR))
  assert.equal(again.event, 'started')
  assert.equal(again.state.startedAt, t0 + 8 * HOUR)
})

test('reduction: a confirmed state that stays qualified keeps confirming (idempotent)', () => {
  let st = stepReduction(emptyReduction(), obs(0)).state
  st = stepReduction(st, obs(6 * HOUR)).state
  const again = stepReduction(st, obs(7 * HOUR))
  assert.equal(again.event, null)
  assert.equal(again.state.confirmedAt, 6 * HOUR, 'confirmedAt never moves')
})
