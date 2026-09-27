import assert from 'node:assert/strict'
import test from 'node:test'
import type { FablesStrategyConfig } from '../shared/strategy/types'
import { evaluateFablesTrigger } from './fablesTrigger'

const config = {
  revision: 1,
  positionRef: { tickLower: -100, tickUpper: 100 },
  trigger: { confirmationSeconds: 300 },
} as FablesStrategyConfig

test('a returned price cancels Fables boundary confirmation before any exit', () => {
  const first = evaluateFablesTrigger({ config, tick: 100, blockNumber: 10n,
    now: 1_000, claimPaused: false })
  assert.equal(first.state, 'confirming')
  assert.equal(first.monitor.outSince, 1_000)
  const back = evaluateFablesTrigger({ config, prior: first.monitor,
    tick: 99, blockNumber: 11n, now: 1_100, claimPaused: false })
  assert.equal(back.state, 'monitoring')
  assert.equal(back.monitor.outSince, undefined)
  const again = evaluateFablesTrigger({ config, prior: back.monitor,
    tick: 101, blockNumber: 12n, now: 1_200, claimPaused: false })
  assert.equal(again.state, 'confirming')
  assert.equal(again.monitor.outSince, 1_200)
  const ready = evaluateFablesTrigger({ config, prior: again.monitor,
    tick: 101, blockNumber: 13n, now: 1_500, claimPaused: false })
  assert.equal(ready.state, 'ready')
})

test('claim pause prevents the Fables monitor from declaring an executable trigger', () => {
  const paused = evaluateFablesTrigger({ config, tick: 101, blockNumber: 14n,
    now: 2_000, claimPaused: true })
  assert.equal(paused.state, 'paused')
  assert.equal(paused.monitor.outSince, undefined)
})
