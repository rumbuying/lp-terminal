import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const tmp = mkdtempSync(join(tmpdir(), 'lp-terminal-logtail-'))
const previousDb = process.env.INDEXER_DB
process.env.INDEXER_DB = join(tmp, 'catalog.db')

const { logtailWindow } = await import('./logtail')

after(() => {
  if (previousDb === undefined) delete process.env.INDEXER_DB
  else process.env.INDEXER_DB = previousDb
  rmSync(tmp, { recursive: true, force: true })
})

test('a tick that fell behind reads the newest blocks it can, and reports the rest', () => {
  // Healthy: the gap fits under the cap, so the window is an exact continuation
  // and nothing is given up. This is every tick at the default 60s cadence.
  assert.deepEqual(logtailWindow(1_000, 1_600, 5_000), { from: 1_001, dropped: 0 })
  // Exactly at the cap is still a continuation, not a shortfall.
  assert.deepEqual(logtailWindow(1_000, 6_000, 5_000), { from: 1_001, dropped: 0 })

  // Behind. Production's exact shape: LOGTAIL_MS=600000 on a ~10-blocks/second
  // chain is ~6,000 blocks of backlog against a 5,000 cap. It reads the newest
  // 5,000 and gives up 1,000 — where jumping to head gave up all 6,000 and left
  // a one-block window that still logged like a working tail.
  assert.deepEqual(logtailWindow(1_000, 7_000, 5_000), { from: 2_001, dropped: 1_000 })

  // However far behind it gets, one pull is still bounded by the cap: a tick
  // returning from a long outage costs one eth_getLogs, not a replay.
  const long = logtailWindow(1, 1_000_000, 5_000)
  assert.equal(long.from, 995_001)
  assert.equal(1_000_000 - long.from + 1, 5_000)
  assert.equal(long.dropped, 995_000 - 1)

  // First run has no cursor to continue from: start at head, claim nothing was
  // dropped, because nothing was ever owed.
  assert.deepEqual(logtailWindow(0, 9_000, 5_000), { from: 9_000, dropped: 0 })

  // Nothing new, and a head that went backwards on a reorg: `from > head` is
  // the caller's cue to do nothing at all, and neither case invents a shortfall.
  assert.deepEqual(logtailWindow(7_000, 7_000, 5_000), { from: 7_001, dropped: 0 })
  assert.deepEqual(logtailWindow(7_000, 6_990, 5_000), { from: 7_001, dropped: 0 })
})
