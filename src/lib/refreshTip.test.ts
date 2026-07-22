import assert from 'node:assert/strict'
import test from 'node:test'
import { en } from '../i18n/en'
import { zh } from '../i18n/zh'

test('generic refresh help stays separate from the solver refresh cap', () => {
  assert.equal(en.swap.refreshTip, 'quotes refresh every {{s}}s — click to refresh now')
  assert.match(en.swap.solverRefreshTip, /3 automatic refreshes/)
  assert.equal(zh.swap.refreshTip, '报价每 {{s}} 秒自动刷新 — 点击立即刷新')
  assert.match(zh.swap.solverRefreshTip, /自动刷新 3 次后暂停/)
})
