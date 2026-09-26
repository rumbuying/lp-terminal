import assert from 'node:assert/strict'
import test from 'node:test'
import type { FablesStrategyConfig } from '../shared/strategy/types'
import { evaluateFablesTrigger } from './fablesMonitor'

const config = {
  revision: 1,
  positionRef: { tickLower: -100, tickUpper: 100 },
  trigger: { confirmationSeconds: 300 },
} as FablesStrategyConfig

const evaluate = (tick: number, now: number, prior?: ReturnType<typeof evaluateFablesTrigger>['monitor'], claimPaused = false) =>
  evaluateFablesTrigger({ config, prior, tick, now, claimPaused, blockNumber: BigInt(now) })

test('Fables confirms a sustained boundary without any fee estimate', () => {
  const first = evaluate(100, 1_000)
  assert.equal(first.state, 'confirming')
  const early = evaluate(101, 1_299, first.monitor)
  assert.equal(early.state, 'confirming')
  const ready = evaluate(100, 1_300, early.monitor)
  assert.equal(ready.state, 'ready')
  assert.equal(ready.monitor.outSide, 'upper')
})

test('Fables cancels confirmation when price returns or switches boundary', () => {
  const first = evaluate(100, 1_000)
  const back = evaluate(99, 1_200, first.monitor)
  assert.equal(back.state, 'monitoring')
  assert.equal(back.monitor.outSince, undefined)
  const lower = evaluate(-101, 1_250, first.monitor)
  assert.equal(lower.monitor.outSince, 1_250)
})

test('Fables pause stops a confirmed trigger', () => {
  const first = evaluate(-101, 1_000)
  const paused = evaluate(-101, 1_500, first.monitor, true)
  assert.equal(paused.state, 'paused')
  assert.equal(paused.monitor.error, 'E_FABLES_CLAIM_PAUSED')
})
