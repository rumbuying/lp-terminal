import assert from 'node:assert/strict'
import test from 'node:test'
import { CHANGELOG, type NewsEntry } from '../content/changelog'
import { FRESH_MS, entryTime, freshCount, isFresh } from './news'

const NOW = Date.parse('2026-07-21T09:00:00Z')
const at = (date: string): NewsEntry => ({
  id: date,
  date,
  tag: 'new',
  title: { en: 'x', zh: 'x' },
  items: [],
})

test('an entry stays new for two days, then goes quiet on its own', () => {
  assert.equal(isFresh(at('2026-07-21'), NOW), true)
  assert.equal(isFresh(at('2026-07-20'), NOW), true)
  assert.equal(isFresh(at('2026-07-19'), NOW), false) // 2d 9h old — past the window
  const born = entryTime('2026-07-19')
  assert.equal(isFresh(at('2026-07-19'), born + FRESH_MS - 1), true) // strictly younger counts
  assert.equal(isFresh(at('2026-07-19'), born + FRESH_MS), false)
})

test('a future or malformed date never breaks the dot', () => {
  assert.equal(isFresh(at('2026-12-01'), NOW), true) // written ahead of the ship date
  assert.ok(Number.isNaN(entryTime('not-a-date')))
  assert.equal(isFresh(at('not-a-date'), NOW), false) // no dot, no crash
})

test('freshCount counts only what is inside the window', () => {
  assert.equal(freshCount(NOW, [at('2026-07-21'), at('2026-07-20'), at('2026-07-01')]), 2)
})

test('the changelog holds its invariants', () => {
  assert.ok(CHANGELOG.length > 0)
  const ids = new Set<string>()
  let prev = Infinity
  for (const e of CHANGELOG) {
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/, `${e.id}: date must be ISO YYYY-MM-DD`)
    const ts = entryTime(e.date)
    assert.ok(!Number.isNaN(ts), `${e.id}: unparseable date`)
    assert.ok(ts <= prev, `${e.id}: entries must be listed newest first`)
    prev = ts
    assert.ok(!ids.has(e.id), `${e.id}: duplicate id`)
    ids.add(e.id)
    for (const s of [e.title, ...e.items]) {
      assert.ok(s.en.trim().length > 0, `${e.id}: missing en text`)
      assert.ok(s.zh.trim().length > 0, `${e.id}: missing zh text`)
    }
  }
})
