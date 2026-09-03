import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'lp-recovery-retry-'))
process.env.LP_EXECUTOR_DATA_DIR = dir
process.env.LP_EXECUTOR_CHAIN_ID = '56'

type RetryState = { attempts: number; errorStreak: number; failStreak: number; lastError: string | null }
type RetryStep = { state: RetryState; quarantined: boolean; delaySeconds: number }

const advance = async (state: RetryState, code: string, quarantineEligible: boolean): Promise<RetryStep> => {
  const { nextRecoveryRetryState } = await import('./store')
  const next = nextRecoveryRetryState(state, code, quarantineEligible)
  return {
    state: { attempts: next.attempts, errorStreak: next.streak, failStreak: next.failStreak, lastError: code },
    quarantined: next.quarantined,
    delaySeconds: next.delaySeconds,
  }
}

test('execution failures accumulate across alternating error codes and quarantine at three', async () => {
  // The live CASHCAT loop: revert → receipt timeout (transient) → revert …
  let state: RetryState = { attempts: 0, errorStreak: 0, failStreak: 0, lastError: null }
  let step = await advance(state, 'E_TX_REVERTED', true)
  state = step.state
  assert.equal(state.failStreak, 1)
  assert.equal(step.quarantined, false)
  step = await advance(state, 'Timed out while waiting for transaction …', false)
  state = step.state
  assert.equal(state.failStreak, 1, 'transient noise neither accumulates nor resets')
  assert.equal(state.errorStreak, 1, 'code alternation must not be required to reach quarantine')
  step = await advance(state, 'E_TX_REVERTED', true)
  state = step.state
  assert.equal(step.quarantined, false)
  step = await advance(state, 'E_TX_REVERTED', true)
  state = step.state
  assert.equal(step.quarantined, true, 'three execution-grade failures quarantine even when codes alternate')
})

test('provider noise alone never quarantines', async () => {
  let state: RetryState = { attempts: 0, errorStreak: 0, failStreak: 0, lastError: null }
  for (let index = 0; index < 10; index += 1) {
    const step = await advance(state, 'HTTP request failed. Status: 403', false)
    state = step.state
    assert.equal(step.quarantined, false)
    assert.equal(state.failStreak, 0)
  }
})

test('identical-code streak still quarantines directly', async () => {
  let state: RetryState = { attempts: 0, errorStreak: 0, failStreak: 0, lastError: null }
  for (let index = 0; index < 2; index += 1) {
    const step = await advance(state, 'E_NONCE', true)
    state = step.state
    assert.equal(step.quarantined, false)
  }
  const third = await advance(state, 'E_NONCE', true)
  assert.equal(third.quarantined, true)
})

test('retry backoff is exponential and capped at five minutes', async () => {
  let state: RetryState = { attempts: 0, errorStreak: 0, failStreak: 0, lastError: null }
  for (let index = 0; index < 8; index += 1) {
    const step = await advance(state, 'E_TX_REVERTED', true)
    state = step.state
    assert.ok(step.delaySeconds <= 300)
  }
  assert.equal(state.attempts, 8)
})

test('swap slippage doubles per consecutive revert and is bounded', async () => {
  const { escalatedSlippageBps } = await import('./swap-escalation')
  assert.equal(escalatedSlippageBps(100, 0), 100)
  assert.equal(escalatedSlippageBps(100, 1), 200)
  assert.equal(escalatedSlippageBps(100, 2), 400)
  assert.equal(escalatedSlippageBps(100, 3), 800)
  assert.equal(escalatedSlippageBps(100, 4), 1000, 'capped at SWAP_RECOVERY_MAX_SLIPPAGE_BPS')
  assert.equal(escalatedSlippageBps(100, 12), 1000, 'a long revert history cannot exceed the cap')
  assert.equal(escalatedSlippageBps(2000, 1), 2000, 'an already-wider strategy guard is never narrowed')
})

test('audit detail serialization redacts credentialed endpoint URLs', async () => {
  const { redactUrls } = await import('./store')
  const detail = JSON.stringify({ code: 'HTTP request failed.\n\nStatus: 403\nURL: https://robinhood-mainnet.g.alchemy.com/v2/alch_secret_key123' })
  const sanitized = redactUrls(detail)
  assert.equal(sanitized.includes('alch_secret_key123'), false)
  assert.ok(sanitized.includes('https://robinhood-mainnet.g.alchemy.com/[redacted]'))
  assert.equal(redactUrls('plain error without urls'), 'plain error without urls')
})

test.after(() => rmSync(dir, { recursive: true, force: true }))
