import type { PublicClient } from 'viem'

/**
 * Multicall, read the way this app reads: a failed call is a MISSING answer,
 * never a thrown error.
 *
 * Every discovery path here asks questions it expects some contracts not to
 * answer — a derived pair that was never deployed, a farm pid holding a dummy
 * token, a token with no symbol(). Letting one of those reject would discard
 * the whole batch, so failures stay per-call and the caller decides what an
 * absent answer means.
 */
export type McRes = { status: 'success' | 'failure'; result?: unknown }

export async function mc(pc: PublicClient, contracts: unknown[]): Promise<McRes[]> {
  if (contracts.length === 0) return []
  return (await pc.multicall({ contracts: contracts as never })) as McRes[]
}

export function ok<T>(r: McRes | undefined): T | undefined {
  return r && r.status === 'success' ? (r.result as T) : undefined
}
