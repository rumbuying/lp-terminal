import assert from 'node:assert/strict'
import test from 'node:test'
import { volumeWindowsOf } from './volumeWindows'

test('maps every external rolling window and preserves reported zeroes', () => {
  assert.deepEqual(volumeWindowsOf({ m5: 0, h1: '12.5', h6: 42, h24: '100' }), {
    vol5mUsd: 0,
    vol1hUsd: 12.5,
    vol6hUsd: 42,
    vol24hUsd: 100,
  })
})

test('keeps missing and invalid external windows empty', () => {
  assert.deepEqual(volumeWindowsOf({ m5: null, h1: '', h6: 'bad' }), {
    vol5mUsd: null,
    vol1hUsd: null,
    vol6hUsd: null,
    vol24hUsd: null,
  })
})
