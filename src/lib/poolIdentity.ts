import type { ClPool, Pool } from '../types'

/**
 * Stable table/map identity for every pool family.
 *
 * A v4 pool has no address of its own: every row shares PoolManager, while the
 * bytes32 PoolId distinguishes state. Address remains the right identity for
 * every other family.
 */
export function poolIdentity(pool: Pool): string {
  return (pool.kind === 'cl' && pool.poolId ? pool.poolId : pool.address).toLowerCase()
}

/**
 * Merge pool feeds without duplicating a v4 row. Later feeds win so a held-v4
 * row freshly read from StateView can replace the catalog's cached snapshot.
 * Map insertion order is retained, preserving the catalog's ranking.
 */
export function mergePoolsByIdentity(...feeds: readonly (readonly Pool[])[]): Pool[] {
  const byId = new Map<string, Pool>()
  for (const feed of feeds) for (const pool of feed) byId.set(poolIdentity(pool), pool)
  return [...byId.values()]
}

/** Current fee used for display/APR; PoolKey identity remains `feePpm`. */
export function effectiveClFeePpm(pool: ClPool): number {
  return pool.protocol === 'univ4' ? (pool.lpFeePpm ?? pool.feePpm) : pool.feePpm
}

export function effectivePoolFeePpm(pool: Pool): number {
  return pool.kind === 'v2' ? pool.feeBps * 100 : effectiveClFeePpm(pool)
}

