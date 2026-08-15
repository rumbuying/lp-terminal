import assert from 'node:assert/strict'
import test from 'node:test'
import type { Address } from 'viem'
import { CHAIN_ID } from '../config/addresses'
import {
  POSITION_DISCOVERY_INTERVAL_MS,
  POSITION_DISCOVERY_QUERY_POLICY,
  POSITION_DISCOVERY_STALE_MS,
  positionQueryKey,
  shouldDiscoverPositionsInPools,
} from './positionLifecycle'

test('positions discovery is chain scoped, account normalized, and ticks at thirty seconds', () => {
  const user = '0x0000000000000000000000000000000000000aBc' as Address
  assert.deepEqual(positionQueryKey(CHAIN_ID, user), [
    'positions',
    CHAIN_ID,
    user.toLowerCase(),
  ])
  // staleTime sits under the interval: a tab click between ticks is instant,
  // one past a tick refetches in the background with the snapshot still shown.
  assert.equal(POSITION_DISCOVERY_INTERVAL_MS, 30_000)
  assert.equal(POSITION_DISCOVERY_STALE_MS, 25_000)
  assert.deepEqual(POSITION_DISCOVERY_QUERY_POLICY, {
    staleTime: 25_000,
    gcTime: 30 * 60_000,
    refetchInterval: 30_000,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: false,
  })
})

test('POOLS only requests positions after the user enables MY POOLS', () => {
  assert.equal(shouldDiscoverPositionsInPools(false), false)
  assert.equal(shouldDiscoverPositionsInPools(true), true)
})
