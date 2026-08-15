// Validates a chain config against the live chain — run it after editing
// config/chains/, and before pointing a deployment at a new one:
//
//   CHAIN=bsc npx tsx scripts/chain-check.ts
//
// The release boundary is deliberately asymmetric: every identity, ABI and
// route used for execution is required and fails closed. DexScreener is only a
// display-price cross-check; an unavailable third party warns but cannot turn a
// working on-chain BSC release red.
import {
  createPublicClient,
  defineChain,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  parseUnits,
  toFunctionSelector,
  zeroAddress,
  type Address,
} from "viem";
import {
  ADDR,
  CHAIN_ID,
  CONNECTORS,
  DEFAULT_BUY,
  GOV,
  NATIVE,
  UNI,
} from "../src/config/addresses";
import { CHAIN } from "../src/config/chains";
import { FEATURES } from "../src/config/features";
import { clFarmAbi, uniV2PairAbi, uniV3PmAbi, v2FarmAbi } from "../src/abi";
import {
  directRouteLabel,
  quoteDirectCandidates,
  quoteDirectRoute,
  type DirectRoute,
} from "../src/lib/directSwap";
import {
  v4PoolId,
  v4PoolKey,
  v4PositionManagerAbi,
  v4StateViewAbi,
} from "../src/lib/uniV4";
import { isVenuePair, sortTokens, V2_SWEEP_VENUES } from "../src/lib/v2Pairs";
import {
  addressInSlot,
  probeStockToken,
  readStockIssuer,
} from "../src/lib/stockToken";
import { readLaunchpadToken } from "../src/lib/launchpadToken";
import { provesLauncher } from "../src/lib/launcherProvenance";
import {
  assessDisplayPriceMark,
  requiredCheck,
  resolveRpcUrl,
  summarizeReleaseChecks,
  type ReleaseCheck,
} from "./chain-check-policy";

// RPC is an operator secret. It is consumed only as the transport URL and is
// never interpolated into normal output; the public endpoint remains the local
// default for contributors without production credentials.
const rpcUrl = resolveRpcUrl(CHAIN.publicRpc, process.env.RPC);
const chain = defineChain({
  id: CHAIN.id,
  name: CHAIN.name,
  nativeCurrency: CHAIN.nativeCurrency,
  rpcUrls: { default: { http: [CHAIN.publicRpc] } },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});
const pc = createPublicClient({
  chain,
  transport: http(rpcUrl, { batch: true }),
});

const checks: ReleaseCheck[] = [];
const report = (result: ReleaseCheck) => {
  checks.push(result);
  const status = result.ok
    ? "  ok  "
    : result.severity === "required"
      ? "  FAIL"
      : "  WARN";
  console.log(
    `${status} ${result.label}${result.detail ? ` — ${result.detail}` : ""}`,
  );
};
const check = (label: string, ok: boolean, detail = "") => {
  report(requiredCheck(label, ok, detail));
};

const probeDirectRoutes = async (
  label: string,
  routes: readonly DirectRoute[],
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  outputDecimals: number,
) => {
  const results = await Promise.allSettled(
    routes.map((route) =>
      quoteDirectRoute(pc as never, route, tokenIn, tokenOut, amountIn, 0),
    ),
  );
  const quotes = results.flatMap((result, index) =>
    result.status === "fulfilled"
      ? [{ route: routes[index], amountOut: result.value.amountOut }]
      : [],
  );
  check(
    `${label} returns a real quote`,
    quotes.length > 0,
    quotes.length === 0
      ? `0/${routes.length} configured routes quoted`
      : `${quotes.length}/${routes.length}: ${quotes
          .map(
            ({ route, amountOut }) =>
              `${directRouteLabel(route)} -> ${formatUnits(amountOut, outputDecimals)}`,
          )
          .join(", ")}`,
  );
};

async function main() {
console.log(`== ${CHAIN.name} (${CHAIN.key}, id ${CHAIN.id}) config check ==`);
console.log(`   features: ${JSON.stringify(FEATURES)}`);

if (CHAIN.key === "bsc") {
  check(
    "BSC release enables the chain-bound Rust solver",
    FEATURES.solver &&
      CHAIN.solverUrl === "https://lp-terminal.xyz/_chain/bsc/solver",
  );
  check(
    "BSC solver uses the reviewed AllowanceHolder",
    CHAIN.solverAllowanceTarget?.toLowerCase() ===
      "0x0000000000001ff3684f28c67538d4d072c22734",
  );
}

const id = await pc.getChainId();
check(`chainId == ${CHAIN_ID}`, id === CHAIN_ID, String(id));

// every configured contract must actually have code
const contracts: [string, `0x${string}`][] = [
  ["addr.CL_FACTORY", ADDR.CL_FACTORY],
  ["addr.CL_PM", ADDR.CL_PM],
  ["addr.CL_SWAP_ROUTER", ADDR.CL_SWAP_ROUTER],
  ["addr.CL_QUOTER", ADDR.CL_QUOTER],
  ["addr.V2_FACTORY", ADDR.V2_FACTORY],
  ["addr.V2_ROUTER", ADDR.V2_ROUTER],
  ["addr.WNATIVE", ADDR.WNATIVE],
  ["addr.STABLE", ADDR.STABLE],
  ["uni.V3_FACTORY", UNI.V3_FACTORY],
  ["uni.V3_NPM", UNI.V3_NPM],
  ["uni.V3_QUOTER", UNI.V3_QUOTER],
  ["uni.V3_SWAP_ROUTER", UNI.V3_SWAP_ROUTER],
  ["uni.V2_FACTORY", UNI.V2_FACTORY],
  ["uni.V2_ROUTER", UNI.V2_ROUTER],
  ["defaultBuy", DEFAULT_BUY],
  ...(CHAIN.homeV2
    ? ([["homeV2.SWAP_ROUTER", CHAIN.homeV2.SWAP_ROUTER]] as [
        string,
        `0x${string}`,
      ][])
    : []),
  ...(CHAIN.uniV4
    ? (
        [
          "POOL_MANAGER",
          "STATE_VIEW",
          "QUOTER",
          "UNIVERSAL_ROUTER",
          "PERMIT2",
        ] as const
      ).map((k) => [`uniV4.${k}`, CHAIN.uniV4![k]] as [string, `0x${string}`])
    : []),
  ...(GOV
    ? (Object.entries(GOV) as [string, `0x${string}`][]).map(
        ([k, a]) => [`gov.${k}`, a] as [string, `0x${string}`],
      )
    : []),
  ...CONNECTORS.map(
    (c, i) => [`connectors[${i}]`, c] as [string, `0x${string}`],
  ),
];
const codes = await Promise.all(
  contracts.map(([, a]) => pc.getCode({ address: a })),
);
for (const [i, [label, addr]] of contracts.entries()) {
  const len = (codes[i]?.length ?? 2) - 2;
  check(`${label} has code`, len > 0, `${addr} ${len / 2}B`);
}

// A v2 fee is compiled into the pair, so ASK rather than assume: getAmountOut
// is pure and encodes the fee exactly. Pancake charges 25 bps where Uniswap
// charges 30, and a route carrying the wrong one nets out the wrong minimum.
const v2FeeAbi = parseAbi([
  "function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) pure returns (uint256)",
]);
const measureV2FeePpm = async (
  router: `0x${string}`,
): Promise<number | null> => {
  const unit = 10n ** 18n;
  const reserve = 10n ** 30n; // deep enough that price impact rounds away
  try {
    const out = await pc.readContract({
      abi: v2FeeAbi,
      address: router,
      functionName: "getAmountOut",
      args: [unit, reserve, reserve],
    });
    return Math.round(Number(((unit - out) * 1_000_000n) / unit));
  } catch {
    return null;
  }
};
const uniV2Fee = await measureV2FeePpm(UNI.V2_ROUTER);
check(
  "uni v2 router charges the 3000 ppm the router encoder assumes",
  uniV2Fee === 3000,
  `measured ${uniV2Fee} ppm`,
);
if (CHAIN.homeV2) {
  const homeV2Fee = await measureV2FeePpm(ADDR.V2_ROUTER);
  check(
    `homeV2.feePpm matches the router (${CHAIN.homeV2.feePpm})`,
    homeV2Fee === CHAIN.homeV2.feePpm,
    `measured ${homeV2Fee} ppm`,
  );
  // The executing router must be the venue's own, wired to the venue's factory —
  // a SwapRouter02 pointed at someone else's pairs would quote here and revert there.
  const smart = await pc
    .readContract({
      abi: parseAbi(["function factoryV2() view returns (address)"]),
      address: CHAIN.homeV2.SWAP_ROUTER,
      functionName: "factoryV2",
    })
    .catch(() => null);
  check(
    "homeV2.SWAP_ROUTER.factoryV2() == addr.V2_FACTORY",
    smart?.toLowerCase() === ADDR.V2_FACTORY.toLowerCase(),
    `${smart}`,
  );
  // Liquidity writes use the plain venue Router02, not the SmartRouter above.
  // Prove the capability that selects the frontend ABI: Pancake exposes the
  // canonical 8/7-argument add/remove selectors and not Solidly's quote helper.
  const v2Code = (
    (await pc.getCode({ address: ADDR.V2_ROUTER })) ?? "0x"
  ).toLowerCase();
  const v2Has = (sig: string) =>
    v2Code.includes(toFunctionSelector(sig as `${string}(${string})`).slice(2));
  check(
    "home v2 liquidity router exposes Router02 add/remove, not Solidly quoteAddLiquidity",
    v2Has(
      "addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)",
    ) &&
      v2Has(
        "removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)",
      ) &&
      !v2Has("quoteAddLiquidity(address,address,bool,address,uint256,uint256)"),
  );
}

if (CHAIN.homeCl.keyedBy === "fee") {
  // A fee-keyed NPM takes Uniswap-v3's mint tuple. Slipstream's superficially
  // similar tuple inserts tickSpacing and sqrtPriceX96 and has another selector.
  const npmCode = (
    (await pc.getCode({ address: ADDR.CL_PM })) ?? "0x"
  ).toLowerCase();
  const npmHas = (sig: string) =>
    npmCode.includes(
      toFunctionSelector(sig as `${string}(${string})`).slice(2),
    );
  check(
    "home CL NPM exposes fee-keyed mint and rejects the Slipstream mint shape",
    npmHas(
      "mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))",
    ) &&
      !npmHas(
        "mint((address,address,int24,int24,int24,uint256,uint256,uint256,uint256,address,uint256,uint160))",
      ),
  );
}

if (CHAIN.homeClFarm) {
  const farm = CHAIN.homeClFarm;
  // A farm wired to a different position manager would enumerate token ids
  // that mean nothing when read back through addr.CL_PM.
  const npm = await pc
    .readContract({
      abi: clFarmAbi,
      address: farm.address,
      functionName: "nonfungiblePositionManager",
    })
    .catch(() => null);
  check(
    "homeClFarm.nonfungiblePositionManager() == addr.CL_PM",
    npm?.toLowerCase() === ADDR.CL_PM.toLowerCase(),
    `${npm}`,
  );
  // and it must actually hold positions — a farm holding none would look
  // exactly like a farm we are failing to read
  const held = await pc
    .readContract({
      abi: uniV3PmAbi,
      address: ADDR.CL_PM,
      functionName: "balanceOf",
      args: [farm.address],
    })
    .catch(() => 0n);
  check(
    "homeClFarm holds position NFTs (these are invisible without the farm pass)",
    held > 0n,
    `${held} NFTs`,
  );
}

if (CHAIN.homeV2Farm) {
  const farm = CHAIN.homeV2Farm;
  const venue = V2_SWEEP_VENUES.find((v) => v.protocol === "home");
  const count = Number(
    await pc
      .readContract({
        abi: v2FarmAbi,
        address: farm.address,
        functionName: "poolLength",
      })
      .catch(() => 0n),
  );
  check("homeV2Farm.poolLength() responds", count > 0, `${count} pids`);

  if (count > 0 && venue) {
    const lp = await pc.multicall({
      contracts: Array.from({ length: count }, (_, pid) => ({
        abi: v2FarmAbi,
        address: farm.address,
        functionName: "lpToken",
        args: [BigInt(pid)],
      })),
    });
    const named = lp
      .map((r) =>
        r.status === "success" ? (r.result as unknown as Address) : null,
      )
      .filter((a): a is Address => !!a);
    const t01 = await pc.multicall({
      contracts: named.flatMap((address) => [
        { abi: uniV2PairAbi, address, functionName: "token0" } as const,
        { abi: uniV2PairAbi, address, functionName: "token1" } as const,
      ]),
    });
    // The whole reader rests on this: an lpToken that is a pair must be one the
    // HOME factory deployed. A single wrong-factory match would mean the
    // init-code hash is wrong and every derived address is fiction.
    const verified: Address[] = [];
    let wrongFactory = 0;
    named.forEach((address, j) => {
      const a =
        t01[j * 2].status === "success"
          ? (t01[j * 2].result as unknown as Address)
          : null;
      const b =
        t01[j * 2 + 1].status === "success"
          ? (t01[j * 2 + 1].result as unknown as Address)
          : null;
      if (!a || !b) return; // dummy token or a StableSwap LP, correctly ignored
      const [token0, token1] = sortTokens(a, b);
      if (isVenuePair(venue, address, token0, token1)) verified.push(address);
      else wrongFactory++;
    });
    check(
      "every farm lpToken that is a pair derives from the home v2 factory",
      wrongFactory === 0 && verified.length > 0,
      `${verified.length} verified, ${wrongFactory} wrong-factory, ${named.length - verified.length - wrongFactory} not pairs`,
    );
    // LP still custodied here is money no wallet balance can see. Counted over
    // the VERIFIED pairs only, so the number means what the label says — the
    // dummy tokens answer balanceOf too, and counting them would inflate it.
    const custodied = await pc.multicall({
      contracts: verified.map(
        (address) =>
          ({
            abi: uniV2PairAbi,
            address,
            functionName: "balanceOf",
            args: [farm.address],
          }) as const,
      ),
    });
    const holding = custodied.filter(
      (r) => r.status === "success" && (r.result as bigint) > 0n,
    ).length;
    check(
      "homeV2Farm still custodies LP (invisible to every wallet-side reader)",
      holding > 0,
      `${holding} of ${verified.length} verified pairs`,
    );
  }
}

if (CHAIN.uniV4) {
  const v4 = CHAIN.uniV4;
  // the read lens must be looking at the singleton we think it is
  const pm = await pc
    .readContract({
      abi: v4StateViewAbi,
      address: v4.STATE_VIEW,
      functionName: "poolManager",
    })
    .catch(() => null);
  check(
    "uniV4.STATE_VIEW.poolManager() == uniV4.POOL_MANAGER",
    pm?.toLowerCase() === v4.POOL_MANAGER.toLowerCase(),
    `${pm}`,
  );
  // The position reader walks ids from an index and reads them here, so a
  // PositionManager wired to a different singleton would decode pool keys that
  // hash to pools this chain's StateView has never heard of.
  const posMgr = await pc
    .readContract({
      abi: v4PositionManagerAbi,
      address: v4.POSITION_MANAGER,
      functionName: "poolManager",
    })
    .catch(() => null);
  check(
    "uniV4.POSITION_MANAGER.poolManager() == uniV4.POOL_MANAGER",
    posMgr?.toLowerCase() === v4.POOL_MANAGER.toLowerCase(),
    `${posMgr}`,
  );
  // And the reason an index is needed at all. If a future deployment DOES
  // enumerate, the subgraph dependency can be dropped — so this asserts the
  // absence rather than assuming it forever.
  const enumerable = await pc
    .readContract({
      abi: parseAbi([
        "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
      ]),
      address: v4.POSITION_MANAGER,
      functionName: "tokenOfOwnerByIndex",
      args: [v4.POSITION_MANAGER, 0n],
    })
    .then(() => true)
    .catch(() => false);
  check(
    "uniV4 PositionManager still has no ERC-721 enumeration (why discovery needs an index)",
    !enumerable,
    enumerable
      ? "tokenOfOwnerByIndex ANSWERS — positionSubgraph may no longer be required"
      : "absent, as expected",
  );
  // The two things every v4 WRITE depends on. `modifyLiquidities` is the only
  // entrypoint the liquidity actions go through, and `permit2` is the contract
  // the manager pulls ERC-20 through — approving a different one leaves both
  // legs looking done while settlement reverts.
  const pmCode = (
    (await pc.getCode({ address: v4.POSITION_MANAGER })) ?? "0x"
  ).toLowerCase();
  check(
    "uniV4.POSITION_MANAGER exposes modifyLiquidities (the only liquidity write)",
    pmCode.includes(
      toFunctionSelector("modifyLiquidities(bytes,uint256)").slice(2),
    ),
    "selector 0xdd46508f",
  );
  const pmPermit2 = await pc
    .readContract({
      abi: v4PositionManagerAbi,
      address: v4.POSITION_MANAGER,
      functionName: "permit2",
    })
    .catch(() => null);
  check(
    "uniV4.POSITION_MANAGER.permit2() == uniV4.PERMIT2",
    pmPermit2?.toLowerCase() === v4.PERMIT2.toLowerCase(),
    `${pmPermit2}`,
  );
  // WHICH swap struct the router decodes is a version question, and getting it
  // wrong shifts every field after amountOutMinimum without failing loudly.
  // v4-periphery added per-hop slippage — and the error selectors that came
  // with it — in the same change, so their presence in the bytecode is what
  // says which struct this deployment wants. The config declares it; this
  // asserts the declaration against the router itself.
  const code = (
    (await pc.getCode({ address: v4.UNIVERSAL_ROUTER })) ?? "0x"
  ).toLowerCase();
  const has = (sig: string) =>
    code.includes(toFunctionSelector(sig as `${string}(${string})`).slice(2));
  const perHopOnChain = has("V4TooLittleReceivedPerHopSingle(uint256,uint256)");
  check(
    "uniV4.perHopSlippage matches the swap struct the deployed router decodes",
    has("V4TooLittleReceived(uint256,uint256)") &&
      perHopOnChain === v4.perHopSlippage,
    `config ${v4.perHopSlippage ? "per-hop" : "pre-per-hop"}, router ${
      perHopOnChain ? "per-hop" : "pre-per-hop"
    }`,
  );
  // and the probe must actually find pools — a silent zero here would look
  // exactly like a chain with no v4 liquidity
  const found: string[] = [];
  for (const { fee, tickSpacing } of v4.rungs) {
    for (const [label, a] of [
      ["native", zeroAddress as `0x${string}`],
      ["wrapped", ADDR.WNATIVE],
    ] as const) {
      const id = v4PoolId(v4PoolKey(a, ADDR.STABLE, fee, tickSpacing));
      const slot0 = await pc
        .readContract({
          abi: v4StateViewAbi,
          address: v4.STATE_VIEW,
          functionName: "getSlot0",
          args: [id],
        })
        .catch(() => null);
      if (slot0 && slot0[0] !== 0n)
        found.push(`${label} ${fee}/${tickSpacing}`);
    }
  }
  check(
    `uniV4 probe finds initialised ${CHAIN.stable.symbol} pools`,
    found.length > 0,
    found.join(", "),
  );
}

// The BSC release advertises five direct execution families. Probe each one
// independently against the chain's deepest common market: otherwise the two
// protocol-level status fields below can be green while one family is dead and
// a sibling route wins. Empty config ladders deliberately fail (0/0); the gate
// never invents a fallback tier or silently substitutes a different venue.
if (CHAIN.key === "bsc") {
  const stableIn = parseUnits("1000", CHAIN.stable.decimals);
  const nativeIn = parseUnits("1", CHAIN.nativeCurrency.decimals);
  const pancakeV2Routes: DirectRoute[] = CHAIN.homeV2
    ? [
        {
          protocol: "home",
          kind: "v2",
          feePpm: CHAIN.homeV2.feePpm,
        },
      ]
    : [];
  const pancakeV3Routes: DirectRoute[] =
    CHAIN.homeCl.keyedBy === "fee"
      ? CHAIN.homeCl.fees.map((feePpm) => ({
          protocol: "home",
          kind: "cl",
          keyedBy: "fee",
          feePpm,
        }))
      : [];
  const uniV4Routes: DirectRoute[] =
    CHAIN.uniV4?.rungs.map(({ fee, tickSpacing }) => ({
      protocol: "uniswap",
      kind: "v4",
      feePpm: fee,
      tickSpacing,
    })) ?? [];

  await probeDirectRoutes(
    "Uniswap V2 USDT/WBNB",
    [{ protocol: "uniswap", kind: "v2", feePpm: 3000 }],
    ADDR.STABLE,
    ADDR.WNATIVE,
    stableIn,
    CHAIN.nativeCurrency.decimals,
  );
  await probeDirectRoutes(
    "Uniswap V3 USDT/WBNB",
    CHAIN.uniV3Fees.map((feePpm) => ({
      protocol: "uniswap",
      kind: "v3",
      feePpm,
    })),
    ADDR.STABLE,
    ADDR.WNATIVE,
    stableIn,
    CHAIN.nativeCurrency.decimals,
  );
  await probeDirectRoutes(
    "Pancake V2 USDT/WBNB",
    pancakeV2Routes,
    ADDR.STABLE,
    ADDR.WNATIVE,
    stableIn,
    CHAIN.nativeCurrency.decimals,
  );
  await probeDirectRoutes(
    "Pancake V3 USDT/WBNB",
    pancakeV3Routes,
    ADDR.STABLE,
    ADDR.WNATIVE,
    stableIn,
    CHAIN.nativeCurrency.decimals,
  );
  await probeDirectRoutes(
    "Uniswap V4 native BNB/USDT",
    uniV4Routes,
    NATIVE,
    ADDR.STABLE,
    nativeIn,
    CHAIN.stable.decimals,
  );
}

// the real quoting path, fee-free: 1000 of the stable into the default buy side
const amountIn = parseUnits("1000", CHAIN.stable.decimals);
const q = await quoteDirectCandidates(
  pc as never,
  [],
  ADDR.STABLE,
  DEFAULT_BUY,
  amountIn,
  0,
);
console.log(`   direct status: ${JSON.stringify(q.status)}`);
if (CHAIN.key === "bsc") {
  check(
    "Uniswap direct quote path responds on-chain",
    q.status.uniswap === "quoted",
    q.status.uniswap,
  );
  check(
    "PancakeSwap direct quote path responds on-chain",
    q.status.home === "quoted",
    q.status.home,
  );
}
// every venue that answered, not just the winner — a venue quoting a price far
// from its neighbour is how a wrong quoter or fee ladder shows itself
for (const [venue, cand] of Object.entries(q.byProtocol)) {
  if (!cand) continue;
  const out = Number(formatUnits(cand.amountOut, 18));
  console.log(
    `   ${venue.padEnd(8)} $${(1000 / out).toFixed(2)}  ${directRouteLabel(cand.route)}  ${JSON.stringify(cand.route)}`,
  );
}
if (q.best) {
  const out = Number(formatUnits(q.best.amountOut, 18));
  const implied = 1000 / out;
  console.log(`   best route: ${JSON.stringify(q.best.route)}`);
  console.log(
    `   1000 ${CHAIN.stable.symbol} -> ${out.toFixed(6)} units  (implied $${implied.toFixed(2)} each)`,
  );

  try {
    const response = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${DEFAULT_BUY}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const ds = (await response.json()) as {
      pairs?: {
        chainId?: string;
        priceUsd?: string;
        liquidity?: { usd?: number };
      }[];
    };
    const pairs = (ds.pairs ?? []).filter(
      (p) => p.chainId === CHAIN.slugs.dexscreener,
    );
    pairs.sort(
      (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
    );
    report(assessDisplayPriceMark(implied, { mark: Number(pairs[0]?.priceUsd) }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    report(assessDisplayPriceMark(implied, { unavailable: detail }));
  }
} else {
  check(
    `direct route found for ${CHAIN.stable.symbol} -> defaultBuy`,
    false,
    "no candidate",
  );
}

// ---- launchpad launchers ----
//
// The launcher list decides which markets wear a SALE mark and which release
// filter they answer to, and it goes stale the quiet way: the launchpad deploys
// a new LiquidityLauncher, every sale from that day forward reads as a bare
// mint, and nothing errors. It happened once already — v2 shipped at one address
// and was redeployed to a vanity address fourteen hours later, both live.
//
// So the grouping is re-derived from the chain rather than trusted: addresses in
// one release must run the SAME code (or they are not one generation), and two
// releases must not (or the split is a fiction the UI is presenting as fact).
if (CHAIN.launchpad) {
  const pad = CHAIN.launchpad;
  const launchers = pad.releases.flatMap((r) => r.launchers.length);
  console.log(
    `\n-- ${pad.label} launchers (${launchers.reduce((a, b) => a + b, 0)} across ${pad.releases.length} releases) --`,
  );
  const factoryCode = await pc.getCode({ address: pad.tokenFactory });
  check(
    "the token factory has code",
    !!factoryCode && factoryCode !== "0x",
    pad.tokenFactory,
  );

  const codehashes = new Map<string, string>();
  for (const release of pad.releases) {
    const seen = new Set<string>();
    for (const { address: launcher, deployTx } of release.launchers) {
      const code = (await pc.getCode({ address: launcher })) ?? "0x";
      check(
        `${release.short}: ${launcher} has code`,
        code !== "0x",
        `${(code.length - 2) / 2}B`,
      );
      // The provenance re-proof, from RPC and nothing else. Bytecode is free to
      // redeploy and a name is free to claim, so neither says whose launcher
      // this is; the deployer's signature over the salt that produced the
      // address does, and it keeps saying it on every run.
      const tx = await pc.getTransaction({ hash: deployTx });
      const proof = provesLauncher({
        address: launcher,
        tx: { from: tx.from, to: tx.to, input: tx.input },
        deployer: pad.deployer,
        create2Factory: pad.create2Factory,
      });
      check(
        `${release.short}: ${launcher} was deployed by the launchpad's own deployer`,
        proof.ok,
        proof.ok ? deployTx : proof.reason,
      );
      if (code !== "0x") seen.add(keccak256(code));
    }
    check(
      `${release.short}: its ${release.launchers.length} launcher(s) run one bytecode`,
      seen.size === 1,
      seen.size === 1 ? [...seen][0] : `${seen.size} distinct codehashes`,
    );
    for (const hash of seen) {
      const claimed = codehashes.get(hash);
      check(
        `${release.short}: its bytecode is not another release's`,
        claimed === undefined,
        claimed === undefined ? "" : `identical to ${claimed}`,
      );
      codehashes.set(hash, release.short);
    }
  }
  // A launcher must never be mistaken for one of its own tokens: it is the
  // `creator` of thousands of them, so a prover that reached for the creator
  // instead of the factory's CREATE2 derivation would mark the launcher itself.
  for (const release of pad.releases)
    for (const { address: launcher } of release.launchers) {
      const proof = await readLaunchpadToken(pc as never, launcher, pad);
      check(`${release.short}: ${launcher} does not prove out as a token`, proof === null);
    }
}

// ---- tokenized-equity issuer anchors ----
//
// The mark on a stock token is only as good as the two constants behind it, and
// both can go stale without anything breaking loudly: an issuer that ships a
// new proxy shape, or moves a beacon, simply stops matching — and every one of
// its tokens silently loses its mark and starts looking exactly like the
// impersonators trading beside it. That is the failure this exists to catch,
// so it is REQUIRED rather than a warning, and it re-derives both halves from
// the chain rather than re-reading the config back to itself.
if (CHAIN.stockIssuers.length > 0) {
  console.log(`\n-- tokenized-equity issuers (${CHAIN.stockIssuers.length}) --`);
  for (const anchor of CHAIN.stockIssuers) {
    const { witness, issuer } = anchor;
    // Through the SHIPPING probe, not a second copy of it: this check is only
    // worth anything if it reads the chain the way the browser does, and a
    // hand-rolled slot decode here could agree with the config while the app
    // disagreed with both.
    const probe = await probeStockToken(pc as never, witness.address, [anchor]);
    const codehashOk = probe.codehash === anchor.proxyCodehash.toLowerCase();
    const anchored = addressInSlot(probe.slots[anchor.slot.toLowerCase()]);

    check(
      `${issuer}: ${witness.symbol} runs the recorded proxy bytecode`,
      codehashOk,
      codehashOk
        ? ""
        : `witness codehash ${probe.codehash ?? "none"} != ${anchor.proxyCodehash}`,
    );
    check(
      `${issuer}: ${witness.symbol} is bound to the recorded anchor`,
      anchored === anchor.anchor.toLowerCase(),
      anchored === anchor.anchor.toLowerCase()
        ? ""
        : `slot names ${anchored ?? "nobody"} != ${anchor.anchor}`,
    );
    // The anchor must be a live contract: a beacon with no code answers
    // `implementation()` with a revert, which would brick every proxy under it.
    const anchorCode = await pc.getCode({ address: anchor.anchor });
    check(
      `${issuer}: anchor ${anchor.anchor} has code`,
      !!anchorCode && anchorCode !== "0x",
    );
  }
  // Nothing the chain itself uses may be mistaken for an equity — the stable is
  // what a mark would misrepresent most expensively.
  for (const [label, address] of [
    ["WNATIVE", ADDR.WNATIVE],
    ["STABLE", ADDR.STABLE],
  ] as const) {
    const issuer = await readStockIssuer(pc as never, address, CHAIN.stockIssuers);
    check(`${label} is not claimed by any stock issuer`, issuer === null, issuer ?? "");
  }
}

// ---- reserved symbols ----
//
// A wrong address here is worse than a missing one, and in two directions at
// once: the real token starts being flagged as a lookalike and hidden from the
// landing page, while whatever is at the recorded address gets treated as
// genuine. Both halves are asserted from the token itself rather than trusted.
if (CHAIN.knownTokens.length > 0) {
  console.log(`\n-- reserved symbols (${CHAIN.knownTokens.length}) --`);
  const erc20 = parseAbi([
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
  ]);
  for (const known of CHAIN.knownTokens) {
    // The native coin has no contract to ask; what must hold is that the
    // sentinel matches the one the rest of the app resolves NATIVE to, since a
    // drift there would make the coin fail to own its own symbol.
    if (known.address.toLowerCase() === NATIVE.toLowerCase()) {
      check(
        `${known.symbol} is the native coin`,
        known.symbol === CHAIN.nativeCurrency.symbol &&
          known.decimals === CHAIN.nativeCurrency.decimals,
        `${known.symbol}/${known.decimals} vs nativeCurrency ${CHAIN.nativeCurrency.symbol}/${CHAIN.nativeCurrency.decimals}`,
      );
      continue;
    }
    const [symbol, decimals] = await Promise.all([
      pc
        .readContract({ abi: erc20, address: known.address, functionName: "symbol" })
        .catch(() => null),
      pc
        .readContract({ abi: erc20, address: known.address, functionName: "decimals" })
        .catch(() => null),
    ]);
    check(
      `${known.symbol} at ${known.address} reports its own symbol and decimals`,
      symbol === known.symbol && decimals === known.decimals,
      symbol === known.symbol && decimals === known.decimals
        ? ""
        : `chain says ${symbol ?? "?"}/${decimals ?? "?"}, config says ${known.symbol}/${known.decimals}`,
    );
  }
  // Reserving one symbol twice would make array order decide which address is
  // "real" and silently strand the other — cheap to assert, impossible to spot.
  const symbols = CHAIN.knownTokens.map((k) => k.symbol.toLowerCase());
  check(
    "no symbol is reserved twice",
    new Set(symbols).size === symbols.length,
    symbols.filter((s, i) => symbols.indexOf(s) !== i).join(", "),
  );
  // The addresses the terminal itself routes through must be the reserved ones
  // wherever their symbol is reserved at all — otherwise the app would trade
  // through a token its own UI flags as a lookalike.
  for (const [label, address, symbol] of [
    ["WNATIVE", ADDR.WNATIVE, CHAIN.wrappedSymbol],
    ["STABLE", ADDR.STABLE, CHAIN.stable.symbol],
  ] as const) {
    const reserved = CHAIN.knownTokens.find(
      (k) => k.symbol.toLowerCase() === symbol.toLowerCase(),
    );
    const agrees =
      reserved === undefined ||
      reserved.address.toLowerCase() === address.toLowerCase();
    check(
      `${label} is the ${symbol} this chain reserves`,
      agrees,
      agrees ? "" : `reserved ${reserved!.address} != configured ${address}`,
    );
  }
}

const summary = summarizeReleaseChecks(checks);
console.log(
  summary.failures === 0
    ? `\n== all required checks passed${summary.warnings ? ` (${summary.warnings} warning)` : ""} ==`
    : `\n== ${summary.failures} FAILED${summary.warnings ? `, ${summary.warnings} warning` : ""} ==`,
);
process.exit(summary.exitCode);
}

void main().catch((error: unknown) => {
  // Provider errors commonly embed the request URL, including its API key. Do
  // not print arbitrary error text or stacks at this boundary.
  const kind = error instanceof Error ? error.name : "unknown error";
  console.error(`chain-check aborted during a required check (${kind}); RPC URL redacted`);
  process.exit(1);
});
