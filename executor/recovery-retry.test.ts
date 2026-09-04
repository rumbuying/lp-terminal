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

const advance = async (state: RetryState, code: string, quarantineEligible: boolean, deferQuarantine = false): Promise<RetryStep> => {
  const { nextRecoveryRetryState } = await import('./store')
  const next = nextRecoveryRetryState(state, code, quarantineEligible, deferQuarantine)
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

test('a reverting swap below its slippage cap defers quarantine and backs off slowly', async () => {
  // The live 15:21 CASHCAT shape: revert → revert → … but the escalation
  // ladder (100→200→400→800) still has headroom, so each revert re-quotes at
  // a wider minOut on a slower backoff instead of quarantining in 47 seconds.
  let state: RetryState = { attempts: 0, errorStreak: 0, failStreak: 0, lastError: null }
  for (let index = 1; index <= 3; index += 1) {
    const step = await advance(state, 'E_TX_REVERTED', true, true)
    state = step.state
    assert.equal(step.quarantined, false, `defer must hold at revert #${index}`)
    assert.equal(state.failStreak, index, 'deferred reverts are still execution-grade facts')
    assert.ok(step.delaySeconds >= 30, 'deferred retries back off slower than the 5s/10s/20s ladder')
  }
})

test('once the slippage cap is reached the next revert quarantines immediately', async () => {
  // failStreak already carries three deferred reverts; the cap means widening
  // cannot help anymore, so the next execution-grade failure must quarantine.
  let state: RetryState = { attempts: 3, errorStreak: 3, failStreak: 3, lastError: 'E_TX_REVERTED' }
  const step = await advance(state, 'E_TX_REVERTED', true, false)
  assert.equal(step.quarantined, true)
})

test('defer never masks non-swap execution failures', async () => {
  let state: RetryState = { attempts: 0, errorStreak: 0, failStreak: 0, lastError: null }
  for (let index = 0; index < 2; index += 1) {
    const step = await advance(state, 'E_NONCE', true, false)
    state = step.state
    assert.equal(step.quarantined, false)
  }
  const third = await advance(state, 'E_NONCE', true, false)
  assert.equal(third.quarantined, true, 'without swap escalation headroom the old rules stand')
})

test('swap slippage doubles per consecutive revert and is bounded', async () => {
  const { escalatedSlippageBps, atSlippageCap } = await import('./swap-escalation')
  assert.equal(escalatedSlippageBps(100, 0), 100)
  assert.equal(escalatedSlippageBps(100, 1), 200)
  assert.equal(escalatedSlippageBps(100, 2), 400)
  assert.equal(escalatedSlippageBps(100, 3), 800)
  assert.equal(escalatedSlippageBps(100, 4), 1000, 'capped at SWAP_RECOVERY_MAX_SLIPPAGE_BPS')
  assert.equal(escalatedSlippageBps(100, 12), 1000, 'a long revert history cannot exceed the cap')
  assert.equal(escalatedSlippageBps(2000, 1), 2000, 'an already-wider strategy guard is never narrowed')
  assert.equal(atSlippageCap(100, 3), false, '800 bps still has one widening left')
  assert.equal(atSlippageCap(100, 4), true, 'the ladder cannot widen past the cap')
  assert.equal(atSlippageCap(2000, 0), true, 'a strategy already wider than the cap never defers')
})

test('audit detail serialization redacts credentialed endpoint URLs', async () => {
  const { redactUrls } = await import('./store')
  const detail = JSON.stringify({ code: 'HTTP request failed.\n\nStatus: 403\nURL: https://robinhood-mainnet.g.alchemy.com/v2/alch_secret_key123' })
  const sanitized = redactUrls(detail)
  assert.equal(sanitized.includes('alch_secret_key123'), false)
  assert.ok(sanitized.includes('https://robinhood-mainnet.g.alchemy.com/[redacted]'))
  assert.equal(redactUrls('plain error without urls'), 'plain error without urls')
})

test('scheduleRecoveryRetry defers quarantine while the reverted swap can still widen', async () => {
  const [{ upsertStrategy }, { originalStrategyDraft }, { UNI }] = await Promise.all([
    import('./store'), import('../shared/strategy/schema'), import('../src/config/addresses'),
  ])
  const { db, setJobContext, scheduleRecoveryRetry } = await import('./store')
  const owner = '0x0000000000000000000000000000000000000066' as const
  const base = originalStrategyDraft({
    owner, protocol: 'univ3', pool: '0x0000000000000000000000000000000000000077', positionManager: UNI.V3_NPM,
    riskToken: '0x0000000000000000000000000000000000000088', quoteToken: '0x0000000000000000000000000000000000000099', activeTokenId: '8',
  })
  const strategyId = 'defer-swap-strategy'
  upsertStrategy({ ...base, id: strategyId, name: 'Defer swap strategy', enabled: true })
  const insertJob = (jobId: string) => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`INSERT INTO jobs (id,strategy_id,plan_json,state,created_at,updated_at,recovery_fail_streak) VALUES (?,?,?,?,?,?,0)`)
      .run(jobId, strategyId, '{}', 'recovery', now, now)
  }
  const strategyState = (jobId: string) => {
    const row = db.prepare('SELECT s.state state FROM jobs j JOIN strategies s ON s.id=j.strategy_id WHERE j.id=?').get(jobId) as { state: string }
    return row.state
  }

  // With swap escalation headroom, three consecutive on-chain reverts still
  // do not quarantine — each schedules a slower retry instead.
  insertJob('defer-job')
  setJobContext('defer-job', 'swap_revert_streak', { 0: 1 })
  for (let index = 1; index <= 3; index += 1) {
    const retry = scheduleRecoveryRetry('defer-job', 'E_TX_REVERTED', true)
    assert.equal(retry.quarantined, false, `defer holds at revert #${index}`)
    assert.equal(retry.escalating, true)
    assert.ok(retry.delayMs >= 30_000, 'deferred retries use the slow backoff')
  }
  assert.notEqual(strategyState('defer-job'), 'recovery_quarantined', 'defer must not quarantine')

  // At the cap, widening cannot help: the next revert quarantines. The three
  // deferred reverts already accumulated failStreak, so the cap is the end.
  setJobContext('defer-job', 'swap_revert_streak', { 0: 4 })
  const capped = scheduleRecoveryRetry('defer-job', 'E_TX_REVERTED', true)
  assert.equal(capped.escalating, false)
  assert.equal(capped.quarantined, true, 'past the cap the deferred strikes bite immediately')
  assert.equal(strategyState('defer-job'), 'recovery_quarantined')

  // A revert with no tracked swap streak (e.g. a non-swap step) never defers.
  // jobs.strategy_id is UNIQUE among open jobs, so close the first fixture.
  db.prepare(`UPDATE jobs SET state='completed' WHERE id='defer-job'`).run()
  insertJob('plain-job')
  const plain = scheduleRecoveryRetry('plain-job', 'E_TX_REVERTED', true)
  assert.equal(plain.escalating, false)
  assert.equal(plain.quarantined, false, 'first execution-grade failure still schedules a retry')
})

test.after(() => rmSync(dir, { recursive: true, force: true }))
