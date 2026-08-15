import type { Address, Hex } from "viem";

export type TokenInfo = {
  address: Address;
  symbol: string;
  decimals: number;
  native?: boolean;
};

export type PoolBase = {
  address: Address;
  token0: Address;
  token1: Address;
  gauge: Address | null;
  gaugeAlive: boolean;
  weight: bigint; // Voter vote weight for this pool
  rewardRate: bigint; // UP wei/s while periodFinish in future
  periodFinish: bigint;
};

/** which DEX a pool/position belongs to (POOLS/POSITIONS handle all of them) */
export type LpProtocol = "home" | "univ3" | "univ2" | "univ4";

export type V2Pool = PoolBase & {
  kind: "v2";
  /**
   * `home` means the selected chain's home venue, not one fixed ABI: UP33 is
   * Solidly-style while Pancake v2 is constant-product Router02. Use the chain
   * capability helpers when choosing calldata. `univ2` is official Uniswap v2.
   */
  protocol: "home" | "univ2";
  stable: boolean;
  reserve0: bigint;
  reserve1: bigint;
  totalSupply: bigint;
  gaugeTotalSupply: bigint; // staked LP total in the gauge
  feeBps: number; // 1 = 0.01%
};

export type ClPool = PoolBase & {
  kind: "cl";
  protocol: "home" | "univ3" | "univ4";
  tickSpacing: number;
  /**
   * Fee field in the pool key. For v4 this is identity, so a dynamic-fee pool
   * carries the 0x800000 flag here rather than its current trading fee.
   */
  feePpm: number; // 1e6 = 100% for ordinary/static pools
  /** v4 only: current effective LP fee read from StateView.getSlot0(). */
  lpFeePpm?: number;
  unstakedFeePpm: number;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  stakedLiquidity: bigint;
  /**
   * v4 only: the pool's real identity.
   *
   * A v4 pool has no contract of its own — one singleton holds every pool and
   * names them by the hash of their key — so `address` carries that singleton
   * (which is where the pool genuinely lives, and what an explorer link should
   * point at) and this carries what actually distinguishes one pool from the
   * next. Anything keying a map by `address` therefore collides across v4
   * pools and must key by this instead.
   */
  poolId?: Hex;
  /** v4 only: the pool's hook contract, zero address when it has none */
  hooks?: Address;
};

export type Pool = V2Pool | ClPool;

export type Protocol = {
  weekly: bigint;
  epochCount: number;
  activePeriod: number;
  totalWeight: bigint;
  capMode: number | null;
  blockNumber: bigint;
};

export type PoolsData = {
  pools: Pool[];
  tokens: Record<string, TokenInfo>; // key: lowercase address
  protocol: Protocol;
};

export type ClPosition = {
  tokenId: bigint;
  pool: ClPool;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  staked: boolean;
  amount0: bigint; // current underlying at pool price
  amount1: bigint;
  fees0: bigint; // uncollected fees (wallet positions only)
  fees1: bigint;
  earned: bigint; // pending UP (staked positions only)
  /**
   * Pending reward from a CL FARM, on a chain that stakes into one rather than
   * into ve(3,3) gauges (PancakeSwap's CAKE).
   *
   * Deliberately NOT folded into `earned`: the portfolio roll-up sums `earned`
   * across every position and labels the total UP, so a farm reward landing
   * there would be displayed as an emissions token it has nothing to do with.
   * Self-describing because the token differs per chain.
   */
  farm?: { reward: bigint; symbol: string; decimals: number };
};

export type V2Position = {
  pool: V2Pool;
  walletLp: bigint;
  stakedLp: bigint;
  earned: bigint; // pending UP from gauge
  claimable0: bigint; // unstaked LP fees
  claimable1: bigint;
  // underlying for wallet+staked LP at current reserves
  amount0: bigint;
  amount1: bigint;
  /**
   * Where `stakedLp` is staked, when it is a pid-keyed FARM rather than a
   * ve(3,3) gauge (PancakeSwap's MasterChefV2).
   *
   * Load-bearing for the card, which otherwise reads `pool.gauge` to decide how
   * to unstake — a farm withdrawal takes `(pid, amount)` and the gauge is null,
   * so a position with this set must never be offered the gauge path. Same
   * reason `reward` stays out of `earned`: that total is labelled UP.
   */
  farm?: {
    address: Address;
    pid: number;
    reward: bigint;
    symbol: string;
    decimals: number;
  };
};

/** a discovery reader that answered nothing because IT failed, not because the
 *  wallet is empty — the positions page warns rather than asserting absence */
export type PositionSourceId =
  | 'univ3'
  | 'homeCl'
  | 'homeClFarm'
  | 'univ2'
  | 'v2Sweep'
  | 'v2Farm'
  | 'univ4'

export type PositionsData = {
  cl: ClPosition[];
  v2: V2Position[];
  /** metadata for position tokens outside the UP33 pool registry (univ3 pairs) */
  tokens: Record<string, TokenInfo>;
  /** readers that degraded to empty this refresh; empty when everything answered */
  failedSources: PositionSourceId[];
};
