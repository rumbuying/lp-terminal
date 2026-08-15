import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { Address, PublicClient } from "viem";
import type { V2Pool } from "../types";

const solverConfig = { solver: false };
const solverEnv = { solverUrl: "https://solver.test" };
let directCalls = 0;
let solverCalls = 0;
let directFailure: Error | null = null;

const directRoute = { protocol: "uniswap", kind: "v2", feePpm: 3_000 } as const;

mock.module("../config/features", { namedExports: { FEATURES: solverConfig } });
mock.module("../config/env", {
  namedExports: {
    ENV: solverEnv,
    zapFee: () => ({
      bps: 0,
      receiver: "0x00000000000000000000000000000000000000fe",
    }),
  },
});
mock.module("../config/wagmi", { namedExports: { wagmiConfig: {} } });
mock.module("../i18n", { namedExports: { t: (key: string) => key } });
mock.module("wagmi/actions", {
  namedExports: {
    readContract: async () => {
      throw new Error("unexpected readContract");
    },
    sendTransaction: async () => {
      throw new Error("unexpected sendTransaction");
    },
    writeContract: async () => {
      throw new Error("unexpected writeContract");
    },
  },
});
mock.module("./directSwap", {
  namedExports: {
    directRouteFeePpm: () => 3_000,
    directRouteLabel: () => "direct",
    isNative: () => false,
    quoteDirectCandidates: async (
      _client: PublicClient,
      _pools: readonly V2Pool[] | null,
      _tokenIn: Address,
      _tokenOut: Address,
      amountIn: bigint,
    ) => {
      directCalls += 1;
      if (directFailure) throw directFailure;
      const best = { route: directRoute, amountOut: amountIn, impactBps: 0 };
      return {
        best,
        byProtocol: { uniswap: best, home: null },
        status: { uniswap: "quoted", home: "absent" },
        midOut: null,
      };
    },
  },
});
mock.module("./solver", {
  namedExports: {
    fetchSolverQuote: async () => {
      solverCalls += 1;
      throw new Error("solver must not be called");
    },
    solverRouteLabel: () => "solver",
    solverVenueFeeBps: () => 0,
  },
});
mock.module("./stake", {
  namedExports: {
    mintedTokenId: () => 0n,
    stakeClNft: async () => false,
    stakeV2Lp: async () => false,
  },
});
mock.module("./swapExec", {
  namedExports: {
    SlippageError: class SlippageError extends Error {},
    executeSolverSwap: async () => null,
    executeSwap: async () => null,
  },
});
mock.module("./tx", {
  namedExports: {
    accountChangedMessage: () => "account changed",
    activeAccountMatches: () => true,
    deadline: () => 0n,
    ensureAllowance: async () => true,
    fetchSqrtPriceX96: async () => 0n,
    invalidateTransactionState: () => {},
    receivedOf: () => 0n,
    step: async () => null,
    shortErr: (error: unknown) => String(error),
  },
});
mock.module("./txlog", { namedExports: { txlog: { push: () => {} } } });
mock.module("./uniV4", {
  namedExports: {
    UNI_V4: null,
    v4IncreasePlan: () => ({ liquidity: 0n, amount0: 0n, amount1: 0n }),
    v4KeyOf: () => null,
    v4NativeSide: () => null,
  },
});
mock.module("./uniV4Write", {
  namedExports: {
    ensureV4CurrencyApproval: async () => false,
    v4Deposit: async () => null,
  },
});

const { planZap } = await import("./zap");

const TOKEN0 = "0x0000000000000000000000000000000000000011" as Address;
const TOKEN1 = "0x0000000000000000000000000000000000000022" as Address;
const pool: V2Pool = {
  kind: "v2",
  protocol: "univ2",
  stable: false,
  address: "0x0000000000000000000000000000000000000033",
  token0: TOKEN0,
  token1: TOKEN1,
  reserve0: 1_000n,
  reserve1: 1_000n,
  totalSupply: 1_000n,
  gaugeTotalSupply: 0n,
  feeBps: 30,
  gauge: null,
  gaugeAlive: false,
  weight: 0n,
  rewardRate: 0n,
  periodFinish: 0n,
};

async function expectDirectOnly(): Promise<void> {
  directCalls = 0;
  solverCalls = 0;
  directFailure = null;
  const plan = await planZap({
    client: {} as PublicClient,
    pools: [pool],
    target: { kind: "v2", pool },
    tokenIn: TOKEN0,
    amountIn: 100n,
  });

  assert.equal(directCalls, 1);
  assert.equal(solverCalls, 0);
  assert.equal(plan.legs.length, 1);
  assert.equal(plan.legs[0]?.via.via, "direct");
}

test("Zap is direct-only when the active chain does not support a solver", async () => {
  solverConfig.solver = false;
  solverEnv.solverUrl = "https://solver.test";
  await expectDirectOnly();
});

test("Zap is direct-only when the solver URL is empty", async () => {
  solverConfig.solver = true;
  solverEnv.solverUrl = "";
  try {
    await expectDirectOnly();
  } finally {
    solverConfig.solver = false;
    solverEnv.solverUrl = "https://solver.test";
  }
});

test("direct-only Zap preserves a direct quote failure", async () => {
  solverConfig.solver = false;
  solverEnv.solverUrl = "https://solver.test";
  directCalls = 0;
  solverCalls = 0;
  const failure = new Error("BSC RPC unavailable");
  directFailure = failure;
  try {
    await assert.rejects(
      planZap({
        client: {} as PublicClient,
        pools: [pool],
        target: { kind: "v2", pool },
        tokenIn: TOKEN0,
        amountIn: 100n,
      }),
      failure,
    );
    assert.equal(directCalls, 1);
    assert.equal(solverCalls, 0);
  } finally {
    directFailure = null;
  }
});
