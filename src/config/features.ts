import { CHAIN, type ChainConfig } from './chains'

const BUILD_ENV: Record<string, string | undefined> =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {}
const NODE_ENV =
  typeof process !== 'undefined' && process.env
    ? process.env
    : ({} as Record<string, string | undefined>)
export function v2PoolsEnabled(value: string | undefined): boolean {
  return value?.trim() !== '1'
}
const V2_POOLS = v2PoolsEnabled(BUILD_ENV.VITE_DISABLE_V2 ?? NODE_ENV.VITE_DISABLE_V2)

/**
 * What the active chain can actually do.
 *
 * Each flag is derived from the chain config rather than set by hand, so a new
 * chain cannot forget to declare one. Surfaces that read a capability the chain
 * lacks must be gated here, not left to fail at runtime.
 */
export function solverEnabledForChain(
  chain: Pick<ChainConfig, 'solverUrl' | 'solverAllowanceTarget'>,
): boolean {
  return chain.solverUrl !== null && chain.solverAllowanceTarget !== null
}

export const FEATURES = {
  /** V2 catalog, LP discovery and V2-specific UI may be disabled as one mode. */
  v2Pools: V2_POOLS,
  /** ve(3,3): vote weights, gauges, emission APR, the UP token itself */
  emissions: CHAIN.gov !== null,
  /** the split-routing solver — direct routes only when absent */
  solver: solverEnabledForChain(CHAIN),
  /** UP33's v2 subgraph backs volume stats the DexScreener feed cannot supply */
  v2Subgraph: V2_POOLS && CHAIN.goldskySubgraph !== null,
  /**
   * How v2 LP is discovered — the two methods are not interchangeable, and
   * conflating them with the EXPLORER is what hid v2 positions on BSC.
   *
   * A v2 LP token is a plain ERC-20, so it can be found either by asking what
   * a wallet holds or by guessing which pairs to ask about. Blockscout's REST
   * API answers the first question and finds ANY pair; an Etherscan-family
   * explorer has no equivalent, and on BSC no free one exists at all.
   */
  v2PositionsFromExplorer: V2_POOLS && CHAIN.explorer.api === 'blockscout',
  /**
   * The fallback where nothing can be asked: derive candidate pairs by CREATE2
   * and read their balances directly. Coverage is bounded by the candidate
   * list — a pair nobody proposed is a pair nobody checks — which is why this
   * is second choice rather than the default.
   */
  v2PositionsFromSweep: V2_POOLS && CHAIN.v2Sweep.length > 0,
  /**
   * Staked v2 LP read from a pid-keyed farm. Independent of the two flags
   * above: staking transfers the LP away, so NEITHER discovery method can see
   * it — the farm has to be asked directly, by pid.
   */
  v2StakedFromFarm:
    V2_POOLS && CHAIN.homeV2Farm !== null && CHAIN.v2Sweep.some((v) => v.protocol === 'home'),
  /**
   * Uniswap v4 LP positions. Needs BOTH halves: the PositionManager to read
   * from, and an index to enumerate against — v4's PositionManager implements
   * no ERC-721 enumeration, so a chain with v4 deployed but no index (pinned
   * subgraph or the indexer's Transfer replay) can read a position it is
   * handed and can never find one.
   */
  v4Positions:
    CHAIN.uniV4 !== null &&
    (CHAIN.uniV4.positionSubgraph !== null || CHAIN.uniV4.positionRpcIndex !== null),
  /** the BRIDGE tab — hidden entirely where no route model exists */
  bridge: CHAIN.hasBridge,
  /**
   * One-sided home-CL range orders. The current order picker is backed by the
   * enumerable home registry, which exists on Robinhood Chain. Pancake pools
   * are indexer-catalogued and need a separate picker before this can be
   * truthfully exposed on BSC.
   */
  rangeOrders: CHAIN.gov !== null,
} as const
