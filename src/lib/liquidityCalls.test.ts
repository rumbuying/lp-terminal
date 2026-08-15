import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData, type Address } from "viem";
import { clPmAbi, uniV2RouterAbi, uniV3PmAbi, v2RouterAbi } from "../abi";
import { ADDR } from "../config/addresses";
import { CHAIN } from "../config/chains";
import {
  buildClMintCall,
  buildV2AddLiquidityCall,
  buildV2RemoveLiquidityCall,
  clUsesFeeKeyedNpm,
  v2UsesRouter02,
} from "./liquidityCalls";

const token0 = "0x0000000000000000000000000000000000000010" as Address;
const token1 = "0x0000000000000000000000000000000000000020" as Address;
const user = "0x0000000000000000000000000000000000000030" as Address;

const homeV2 = { protocol: "home", token0, token1, stable: false } as const;
const homeCl = {
  protocol: "home",
  token0,
  token1,
  feePpm: 2_500,
  tickSpacing: 50,
} as const;

const pancakeTest = CHAIN.key === "bsc" ? test : test.skip;
const slipstreamTest = CHAIN.homeV2 === null ? test : test.skip;

pancakeTest(
  "Pancake v2 add/remove use Router02 selectors and the official v2 router",
  () => {
    assert.equal(v2UsesRouter02(homeV2), true);
    const add = buildV2AddLiquidityCall(homeV2, {
      amount0Desired: 11n,
      amount1Desired: 22n,
      amount0Min: 10n,
      amount1Min: 20n,
      recipient: user,
      deadline: 99n,
    });
    assert.equal(add.address.toLowerCase(), ADDR.V2_ROUTER.toLowerCase());
    assert.equal(add.data.slice(0, 10), "0xe8e33700");
    const decodedAdd = decodeFunctionData({
      abi: uniV2RouterAbi,
      data: add.data,
    });
    assert.equal(decodedAdd.functionName, "addLiquidity");
    assert.deepEqual(decodedAdd.args, [
      token0,
      token1,
      11n,
      22n,
      10n,
      20n,
      user,
      99n,
    ]);

    const remove = buildV2RemoveLiquidityCall(homeV2, {
      liquidity: 7n,
      amount0Min: 5n,
      amount1Min: 6n,
      recipient: user,
      deadline: 100n,
    });
    assert.equal(remove.address.toLowerCase(), ADDR.V2_ROUTER.toLowerCase());
    assert.equal(remove.data.slice(0, 10), "0xbaa2abde");
    const decodedRemove = decodeFunctionData({
      abi: uniV2RouterAbi,
      data: remove.data,
    });
    assert.equal(decodedRemove.functionName, "removeLiquidity");
    assert.deepEqual(decodedRemove.args, [
      token0,
      token1,
      7n,
      5n,
      6n,
      user,
      100n,
    ]);
  },
);

pancakeTest("Pancake v3 mint uses the fee-keyed NPM tuple", () => {
  assert.equal(clUsesFeeKeyedNpm(homeCl), true);
  const call = buildClMintCall(homeCl, {
    tickLower: -100,
    tickUpper: 100,
    amount0Desired: 11n,
    amount1Desired: 22n,
    amount0Min: 10n,
    amount1Min: 20n,
    recipient: user,
    deadline: 99n,
  });
  assert.equal(call.address.toLowerCase(), ADDR.CL_PM.toLowerCase());
  assert.equal(call.data.slice(0, 10), "0x88316456");
  const decoded = decodeFunctionData({ abi: uniV3PmAbi, data: call.data });
  assert.equal(decoded.functionName, "mint");
  assert.equal(decoded.args[0].fee, 2_500);
  assert.equal(decoded.args[0].tickLower, -100);
  assert.equal(decoded.args[0].tickUpper, 100);
  assert.equal("tickSpacing" in decoded.args[0], false);
  assert.equal("sqrtPriceX96" in decoded.args[0], false);
});

slipstreamTest(
  "tick-spacing home venues keep their Solidly/Slipstream calldata",
  () => {
    assert.equal(v2UsesRouter02(homeV2), false);
    const add = buildV2AddLiquidityCall(homeV2, {
      amount0Desired: 11n,
      amount1Desired: 22n,
      amount0Min: 10n,
      amount1Min: 20n,
      recipient: user,
      deadline: 99n,
    });
    assert.equal(
      decodeFunctionData({ abi: v2RouterAbi, data: add.data }).functionName,
      "addLiquidity",
    );

    assert.equal(clUsesFeeKeyedNpm(homeCl), false);
    const mint = buildClMintCall(homeCl, {
      tickLower: -100,
      tickUpper: 100,
      amount0Desired: 11n,
      amount1Desired: 22n,
      amount0Min: 10n,
      amount1Min: 20n,
      recipient: user,
      deadline: 99n,
    });
    assert.equal(mint.data.slice(0, 10), "0xb5007d1f");
    const decoded = decodeFunctionData({ abi: clPmAbi, data: mint.data });
    assert.equal(decoded.functionName, "mint");
    assert.equal(decoded.args[0].tickSpacing, 50);
    assert.equal(decoded.args[0].sqrtPriceX96, 0n);
  },
);
