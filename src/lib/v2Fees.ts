import type { Address, PublicClient } from 'viem'
import { v2PoolAbi } from '../abi'

export async function previewV2ClaimFees(
  pc: PublicClient,
  pool: Address,
  user: Address,
  fallback: readonly [bigint, bigint],
): Promise<readonly [bigint, bigint]> {
  try {
    const sim = await pc.simulateContract({
      abi: v2PoolAbi,
      address: pool,
      functionName: 'claimFees',
      account: user,
    })
    return sim.result as readonly [bigint, bigint]
  } catch {
    return fallback
  }
}
