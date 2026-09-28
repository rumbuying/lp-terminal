import { type Address, type PublicClient } from 'viem'
import { fablesLensAbi } from '../abi/fables'
import { FABLES_LENS } from '../config/fables'
import { fablesHookSupportsCombinedExit, readFablesPosition, type FablesPosition } from './fables'

const MAX_UINT128 = (1n << 128n) - 1n

export type FablesExitQuote = {
  position: FablesPosition
  principal0: bigint
  principal1: bigint
  amount0Min: bigint
  amount1Min: bigint
  claimable0: bigint
  claimable1: bigint
  maxFeeBpsToPass: number
  exitMethod: 'withdraw' | 'withdrawAndClaim'
}

/**
 * Read-only exit preflight. This estimates only principal output and checks the
 * fee bound currently required for claiming; it never forecasts dynamic LP fees.
 * Transaction construction must re-read this after the trigger is confirmed.
 */
export async function quoteFablesExit(
  client: PublicClient,
  args: { owner: Address; hook: Address; rangeId: bigint; slippageBps: number },
): Promise<FablesExitQuote> {
  if (!Number.isInteger(args.slippageBps) || args.slippageBps < 0 || args.slippageBps > 5_000)
    throw new Error('E_FABLES_SLIPPAGE')
  const position = await readFablesPosition(client, args)
  if (position.shares <= 0n || position.shares > MAX_UINT128)
    throw new Error('E_FABLES_SHARES_NOT_WITHDRAWABLE')
  if (position.staked > 0n) throw new Error('E_FABLES_STAKED_UNSUPPORTED')
  if (position.claimPaused) throw new Error('E_FABLES_CLAIM_PAUSED')
  const key = position.pool.key
  const [quote, claim] = await Promise.all([
    client.readContract({
      address: FABLES_LENS, abi: fablesLensAbi, functionName: 'quoteWithdraw',
      args: [position.owner, key, position.tickLower, position.tickUpper, position.shares],
      blockNumber: position.observedBlock,
    }),
    client.readContract({
      address: FABLES_LENS, abi: fablesLensAbi, functionName: 'canClaim',
      args: [position.owner, key, position.tickLower, position.tickUpper],
      blockNumber: position.observedBlock,
    }),
  ])
  const w = quote[0]
  const c = claim[0]
  if (!w.ticksValid || !w.rangeExists || !w.sufficientShares || w.rangeId !== position.rangeId
    || w.shares !== position.shares || w.staked !== 0n || w.claimPaused
    || !c.rangeExists || c.paused || w.effectiveClaimFeeBps !== c.effectiveClaimFeeBps)
    throw new Error('E_FABLES_EXIT_QUOTE_MISMATCH')
  if (w.amount0 > MAX_UINT128 || w.amount1 > MAX_UINT128)
    throw new Error('E_FABLES_PRINCIPAL_EXCEEDS_UINT128')
  const bps = BigInt(10_000 - args.slippageBps)
  return {
    position,
    principal0: w.amount0,
    principal1: w.amount1,
    amount0Min: (w.amount0 * bps) / 10_000n,
    amount1Min: (w.amount1 * bps) / 10_000n,
    claimable0: w.claimable0,
    claimable1: w.claimable1,
    maxFeeBpsToPass: Number(c.maxFeeBpsToPass),
    exitMethod: fablesHookSupportsCombinedExit(position.pool.key.hooks) ? 'withdrawAndClaim' : 'withdraw',
  }
}
