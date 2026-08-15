import type { Address } from 'viem'

/**
 * The refresh cadence of the positions scan, and what makes it feel instant.
 *
 * Every 30s while the tab is on screen. The interval stops with the last
 * observer (default background behaviour), so a user parked on POOLS costs no
 * RPC at all — and because the scan rides the chain's official public endpoint
 * (lib/publicRpcClient.ts), even an active viewer spends their own IP's
 * allowance, not the terminal's quota.
 *
 * staleTime sits just under the interval: clicking POSITIONS between ticks
 * shows the warm snapshot with no fetch at all; arriving past a tick refetches
 * in the background with the snapshot still on screen. The full-screen
 * "scanning" state is now reachable only on a cold load.
 */
export const POSITION_DISCOVERY_STALE_MS = 25_000
export const POSITION_DISCOVERY_INTERVAL_MS = 30_000

export const POSITION_DISCOVERY_QUERY_POLICY = {
  staleTime: POSITION_DISCOVERY_STALE_MS,
  gcTime: 30 * 60_000,
  refetchInterval: POSITION_DISCOVERY_INTERVAL_MS,
  refetchOnMount: true,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
  retry: false,
} as const

export function positionQueryKey(chainId: number, user?: Address) {
  return ['positions', chainId, user?.toLowerCase() ?? null] as const
}

/** Public pool browsing never opts into wallet-wide discovery by itself. */
export function shouldDiscoverPositionsInPools(onlyMine: boolean): boolean {
  return onlyMine
}
