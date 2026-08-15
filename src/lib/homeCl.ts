import {
  clFactoryAbi,
  clPmAbi,
  clPoolAbi,
  quoterAbi,
  uniV3FactoryAbi,
  uniV3PmAbi,
  uniV3PoolAbi,
  uniV3QuoterAbi,
} from '../abi'
import { CHAIN } from '../config/chains'

/**
 * The home DEX's concentrated-liquidity leg comes in two shapes, and this is
 * the only place that knows which one this build talks to.
 *
 * Both are Uniswap v3 forks with identical core math, and they differ in ONE
 * thing: what identifies a pool within a token pair. Slipstream (UP33 on
 * Robinhood) keys pools by TICK SPACING and carries the fee as separate pool
 * state; Pancake v3 keys them by FEE TIER exactly as Uniswap does. That single
 * difference changes four ABIs — `factory.getPool`'s third argument, the fifth
 * field `positions()` returns, `mint`'s params, and the quoter's struct — so
 * they are selected together here rather than branched at each call site.
 *
 * Everything else is shared: increase/decrease/collect/burn/balanceOf are
 * signature-identical across all three protocols, so clPmAbi's fragments drive
 * them everywhere (uniV3PmAbi deliberately does not redeclare them).
 */
export const HOME_CL_FEE_KEYED = CHAIN.homeCl.keyedBy === 'fee'

/** the fee ladder discovery probes; empty when pools are enumerated on-chain */
export const HOME_CL_FEES: readonly number[] =
  CHAIN.homeCl.keyedBy === 'fee' ? CHAIN.homeCl.fees : []

export const homeClFactoryAbi = HOME_CL_FEE_KEYED ? uniV3FactoryAbi : clFactoryAbi
export const homeClPoolAbi = HOME_CL_FEE_KEYED ? uniV3PoolAbi : clPoolAbi
export const homeClQuoterAbi = HOME_CL_FEE_KEYED ? uniV3QuoterAbi : quoterAbi
/** read/decode side of the position manager — `positions()` differs by shape */
export const homeClPmReadAbi = HOME_CL_FEE_KEYED ? uniV3PmAbi : clPmAbi
/** write side shared by every shape: increase/decrease/collect/burn/approve */
export const homeClPmWriteAbi = clPmAbi

/**
 * The pool key for a given pool, in whichever unit this chain's home DEX uses.
 * Feed it to getPool, the quoter struct and mint — never mix the two units.
 */
export function homeClPoolKey(pool: { tickSpacing: number; feePpm: number }): number {
  return HOME_CL_FEE_KEYED ? pool.feePpm : pool.tickSpacing
}
