import { encodeFunctionData, type Address, type Hex } from "viem";
import { clPmAbi, uniV2RouterAbi, uniV3PmAbi, v2RouterAbi } from "../abi";
import { ADDR, UNI } from "../config/addresses";
import { CHAIN } from "../config/chains";
import type { ClPool, V2Pool } from "../types";
import { HOME_CL_FEE_KEYED } from "./homeCl";

export type LiquidityCall = { address: Address; data: Hex };

type V2PoolKey = Pick<V2Pool, "protocol" | "token0" | "token1" | "stable">;

/**
 * Whether this pair uses the constant-product Router02 liquidity surface.
 *
 * `protocol: home` is not enough to choose an ABI: it means Solidly on
 * Robinhood and Pancake v2 on BSC. The chain capability is the discriminator.
 */
export function v2UsesRouter02(pool: Pick<V2Pool, "protocol">): boolean {
  return (
    pool.protocol === "univ2" ||
    (pool.protocol === "home" && CHAIN.homeV2 !== null)
  );
}

export function v2LiquidityRouter(pool: Pick<V2Pool, "protocol">): Address {
  return pool.protocol === "univ2" ? UNI.V2_ROUTER : ADDR.V2_ROUTER;
}

export function v2SupportsClaimFees(pool: Pick<V2Pool, "protocol">): boolean {
  return pool.protocol === "home" && !v2UsesRouter02(pool);
}

export function buildV2AddLiquidityCall(
  pool: V2PoolKey,
  params: {
    amount0Desired: bigint;
    amount1Desired: bigint;
    amount0Min: bigint;
    amount1Min: bigint;
    recipient: Address;
    deadline: bigint;
  },
): LiquidityCall {
  const address = v2LiquidityRouter(pool);
  if (v2UsesRouter02(pool)) {
    return {
      address,
      data: encodeFunctionData({
        abi: uniV2RouterAbi,
        functionName: "addLiquidity",
        args: [
          pool.token0,
          pool.token1,
          params.amount0Desired,
          params.amount1Desired,
          params.amount0Min,
          params.amount1Min,
          params.recipient,
          params.deadline,
        ],
      }),
    };
  }
  return {
    address,
    data: encodeFunctionData({
      abi: v2RouterAbi,
      functionName: "addLiquidity",
      args: [
        pool.token0,
        pool.token1,
        pool.stable,
        params.amount0Desired,
        params.amount1Desired,
        params.amount0Min,
        params.amount1Min,
        params.recipient,
        params.deadline,
      ],
    }),
  };
}

export function buildV2RemoveLiquidityCall(
  pool: V2PoolKey,
  params: {
    liquidity: bigint;
    amount0Min: bigint;
    amount1Min: bigint;
    recipient: Address;
    deadline: bigint;
  },
): LiquidityCall {
  const address = v2LiquidityRouter(pool);
  if (v2UsesRouter02(pool)) {
    return {
      address,
      data: encodeFunctionData({
        abi: uniV2RouterAbi,
        functionName: "removeLiquidity",
        args: [
          pool.token0,
          pool.token1,
          params.liquidity,
          params.amount0Min,
          params.amount1Min,
          params.recipient,
          params.deadline,
        ],
      }),
    };
  }
  return {
    address,
    data: encodeFunctionData({
      abi: v2RouterAbi,
      functionName: "removeLiquidity",
      args: [
        pool.token0,
        pool.token1,
        pool.stable,
        params.liquidity,
        params.amount0Min,
        params.amount1Min,
        params.recipient,
        params.deadline,
      ],
    }),
  };
}

type ClPoolKey = Pick<
  ClPool,
  "protocol" | "token0" | "token1" | "feePpm" | "tickSpacing"
>;

export function clUsesFeeKeyedNpm(pool: Pick<ClPool, "protocol">): boolean {
  return (
    pool.protocol === "univ3" || (pool.protocol === "home" && HOME_CL_FEE_KEYED)
  );
}

export function clLiquidityNpm(pool: Pick<ClPool, "protocol">): Address {
  if (pool.protocol === "univ4")
    throw new Error("Uniswap v4 does not use a v3-family NPM");
  return pool.protocol === "univ3" ? UNI.V3_NPM : ADDR.CL_PM;
}

export function buildClMintCall(
  pool: ClPoolKey,
  params: {
    tickLower: number;
    tickUpper: number;
    amount0Desired: bigint;
    amount1Desired: bigint;
    amount0Min: bigint;
    amount1Min: bigint;
    recipient: Address;
    deadline: bigint;
  },
): LiquidityCall {
  const address = clLiquidityNpm(pool);
  const common = {
    token0: pool.token0,
    token1: pool.token1,
    tickLower: params.tickLower,
    tickUpper: params.tickUpper,
    amount0Desired: params.amount0Desired,
    amount1Desired: params.amount1Desired,
    amount0Min: params.amount0Min,
    amount1Min: params.amount1Min,
    recipient: params.recipient,
    deadline: params.deadline,
  };
  return clUsesFeeKeyedNpm(pool)
    ? {
        address,
        data: encodeFunctionData({
          abi: uniV3PmAbi,
          functionName: "mint",
          args: [{ ...common, fee: pool.feePpm }],
        }),
      }
    : {
        address,
        data: encodeFunctionData({
          abi: clPmAbi,
          functionName: "mint",
          args: [
            { ...common, tickSpacing: pool.tickSpacing, sqrtPriceX96: 0n },
          ],
        }),
      };
}
