// ZAP: single-token add-liquidity. The user funds a position with ONE token
// (or native ETH); we solve how much of it to swap into the counter-token so
// the two piles match the deposit ratio the target needs, swap through the
// best direct Uniswap/UP33 route, then deposit — one flow, N wallet-signed
// txs, halting on any failure (a halt never strands value: every intermediate
// asset is a normal wallet balance).
//
// Split solve: the needed ratio ρ (raw counter-units per raw kept-unit) comes
// from CL band math (or v2 reserves); with quote rate q̂ (counter per swapped
// unit) the swap size is s = A·ρ/(q̂+ρ). q̂ isn't known until we quote, so:
// seed with the spot rate, quote once, re-solve, and re-quote when the answer
// moved — 2 quotes converge well because q̂ varies slowly with s. Residual
// mismatch (price impact shifting the band ratio) surfaces as DUST: a small
// leftover the deposit doesn't pull, which stays in the wallet. Planning uses
// floats (ratios only); every on-chain amount stays bigint.
import {
  zeroAddress,
  type Address,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { readContract, sendTransaction, writeContract } from "wagmi/actions";
import { clPmAbi, uniV2PairAbi, v2RouterAbi, wethAbi } from "../abi";
import { ADDR, CHAIN_ID, NATIVE, UNI } from "../config/addresses";
import { CHAIN } from "../config/chains";
import { FEATURES } from "../config/features";
import { ENV, zapFee } from "../config/env";
import { wagmiConfig } from "../config/wagmi";
import { t } from "../i18n";
import {
  applySlippage,
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getSqrtRatioAtTick,
  minAmountsForLiquidity,
  Q96,
} from "./clmath";
import {
  directRouteFeePpm,
  directRouteLabel,
  isNative,
  quoteDirectCandidates,
  type DirectCandidate,
  type DirectQuotes,
  type DirectRoute,
} from "./directSwap";
import { fmtAmount } from "./format";
import {
  buildClMintCall,
  buildV2AddLiquidityCall,
  clLiquidityNpm,
  v2LiquidityRouter,
  v2UsesRouter02,
} from "./liquidityCalls";
import {
  fetchSolverQuote,
  solverRouteLabel,
  solverVenueFeeBps,
} from "./solver";
import { stakeClNft, stakeV2Lp, mintedTokenId } from "./stake";
import { executeSolverSwap, executeSwap, SlippageError } from "./swapExec";
import { solveSwap, splitOutside } from "./zapMath";
import {
  accountChangedMessage,
  activeAccountMatches,
  deadline,
  ensureAllowance,
  fetchSqrtPriceX96,
  invalidateTransactionState,
  receivedOf,
  step,
  shortErr,
  type StepFailWhy,
} from "./tx";
import { txlog } from "./txlog";
import type { ClPool, Pool, TokenInfo, V2Pool } from "../types";
import { UNI_V4, v4IncreasePlan, v4KeyOf, v4NativeSide } from "./uniV4";
import { ensureV4CurrencyApproval, v4Deposit } from "./uniV4Write";

/** deposit mins: 1% band-edge, same as the PAIR flows (panel copy quotes it) */
export const DEPOSIT_MINS_BPS = 100;

export type ZapTarget =
  | { kind: "v2"; pool: V2Pool }
  | {
      kind: "cl-increase";
      pool: ClPool;
      tickLower: number;
      tickUpper: number;
      tokenId: bigint;
      npm: Address;
    }
  | { kind: "cl-mint"; pool: ClPool; tickLower: number; tickUpper: number };

/** the swap leg's venue: SHEEP CHOICE (solver-routed, fee charged server-side
 *  inside the Settler tx) or a direct route (fee via the router's *WithFee) */
export type ZapSwapVia =
  | { via: "direct"; route: DirectRoute }
  | { via: "solver"; routeLabel: string; venueFeeBps: number };

/** one planned swap: a slice of the input bought into a pool side */
export type ZapLeg = {
  /** true → buys pool.token0; false → pool.token1 */
  buyIs0: boolean;
  swapIn: bigint;
  via: ZapSwapVia;
  estOut: bigint;
  impactBps: number | null;
};

export type ZapPlan = {
  /** what the user selected (NATIVE sentinel allowed) */
  tokenIn: Address;
  /** true when the user's wallet funded the zap with the chain's coin */
  nativeIn: boolean;
  /** token passed to swap execution; native stays native for a native-keyed v4
   *  pool, otherwise it is wrapped before any leg runs */
  swapTokenIn: Address;
  /** whether the first stage turns the whole native input into WNATIVE */
  wrapInput: boolean;
  /** which pool side the input IS — null when it's an outside token */
  inIs0: boolean | null;
  amountIn: bigint;
  /** input deposited as-is, no swap (pool-side input only; 0 otherwise) */
  keep: bigint;
  /** swap legs acquiring whatever the input doesn't cover (0–2) */
  legs: ZapLeg[];
  dep0: bigint;
  dep1: bigint;
  /** CL only: liquidity the planned deposit mints at the planning price */
  liquidity: bigint;
  dust0: bigint;
  dust1: bigint;
  /** worst leg's size impact versus a small executable quote; terminal fee excluded */
  impactBps: number | null;
};
function v4NativeSideOf(pool: Pool): 0 | 1 | null {
  if (pool.kind !== "cl" || pool.protocol !== "univ4") return null;
  const key = v4KeyOf(pool);
  if (!key) throw new Error(t("zap.errV4PoolKey"));
  return v4NativeSide(key);
}

export function zapFundingFor(
  pool: Pool,
  tokenIn: Address,
): {
  nativeIn: boolean;
  wrapInput: boolean;
  swapTokenIn: Address;
  inIs0: boolean | null;
} {
  const nativeSide = v4NativeSideOf(pool);
  const v4NativeInput =
    pool.kind === "cl" &&
    pool.protocol === "univ4" &&
    tokenIn.toLowerCase() === zeroAddress;
  const nativeIn = isNative(tokenIn) || v4NativeInput;
  const wrapperIn = tokenIn.toLowerCase() === ADDR.WNATIVE.toLowerCase();
  const fundsNativeSide = nativeSide !== null && (nativeIn || wrapperIn);
  const wrapInput = nativeIn && !fundsNativeSide;
  let swapTokenIn = tokenIn;
  if (nativeIn) swapTokenIn = wrapInput ? ADDR.WNATIVE : NATIVE;
  const poolInput = fundsNativeSide ? zeroAddress : swapTokenIn;
  const lower = poolInput.toLowerCase();
  let inIs0: boolean | null = null;
  if (lower === pool.token0.toLowerCase()) inIs0 = true;
  else if (lower === pool.token1.toLowerCase()) inIs0 = false;
  return { nativeIn, wrapInput, swapTokenIn, inIs0 };
}

/** Swap into WNATIVE first so the receipt carries an exact Transfer amount;
 * the zap unwraps it before a native-keyed v4 deposit. */
export function zapSwapOutputToken(pool: Pool, buyIs0: boolean): Address {
  const currency = buyIs0 ? pool.token0 : pool.token1;
  return v4NativeSideOf(pool) === (buyIs0 ? 0 : 1) ? ADDR.WNATIVE : currency;
}

export function v4ZapUnwrapAmount(
  plan: ZapPlan,
  pool: Pool,
  sideAmounts: readonly [bigint, bigint],
): bigint {
  const nativeSide = v4NativeSideOf(pool);
  if (nativeSide === null) return 0n;
  let inputSide: 0 | 1 | null = null;
  if (plan.inIs0 === true) inputSide = 0;
  else if (plan.inIs0 === false) inputSide = 1;
  const keptWrapped =
    inputSide === nativeSide &&
    plan.swapTokenIn.toLowerCase() === ADDR.WNATIVE.toLowerCase()
      ? plan.keep
      : 0n;
  return sideAmounts[nativeSide] + keptWrapped;
}

/** needed raw-unit ratio (counter per kept) + spot rate seed, by target */
function needAndSpot(
  target: ZapTarget,
  inIs0: boolean,
): { rho: number; spot: number } {
  const pool = target.pool;
  if (pool.kind === "v2") {
    const r0 = Number(pool.reserve0);
    const r1 = Number(pool.reserve1);
    if (!(r0 > 0) || !(r1 > 0)) throw new Error(t("zap.errNoReserves"));
    const rho = inIs0 ? r1 / r0 : r0 / r1;
    return { rho, spot: rho }; // marginal v2 price == reserve ratio
  }
  const { tickLower, tickUpper } = target as Extract<
    ZapTarget,
    { kind: "cl-mint" | "cl-increase" }
  >;
  const p = Number(pool.sqrtPriceX96) / Number(Q96);
  const a = Number(getSqrtRatioAtTick(tickLower)) / Number(Q96);
  const b = Number(getSqrtRatioAtTick(tickUpper)) / Number(Q96);
  if (!(p > 0)) throw new Error(t("zap.errNoPrice"));
  const spot1per0 = p * p; // raw token1 per raw token0
  const spot = inIs0 ? spot1per0 : 1 / spot1per0;
  if (p <= a) return { rho: inIs0 ? 0 : Infinity, spot }; // band above price: token0 only
  if (p >= b) return { rho: inIs0 ? Infinity : 0, spot }; // band below price: token1 only
  const amt0f = (b - p) / (b * p); // token0 a unit of liquidity holds
  const amt1f = p - a; // token1 a unit of liquidity holds
  const rho1per0 = amt1f / amt0f;
  return { rho: inIs0 ? rho1per0 : 1 / rho1per0, spot };
}

/** the target's raw-unit deposit ratio amt1/amt0 at the current price
 *  (0 → token0 only, ∞ → token1 only) + spot as token1-per-token0 —
 *  needAndSpot with inIs0=true measures exactly this */
function needRatio1Per0(target: ZapTarget): { rho: number; spot: number } {
  return needAndSpot(target, true);
}

/**
 * Best executable quote across venues. A venue whose quote *failed* (reverted /
 * RPC error) only blocks planning when it leaves us with nothing to route
 * through — a dead pool on one venue must never veto a zap another venue can
 * serve. Throws the comparison error only when NO venue produced a usable quote
 * yet at least one failed (so the reason is "quoting broke", not "no pool").
 */
function bestExecutableQuote(quotes: DirectQuotes): DirectCandidate | null {
  if (quotes.best) return quotes.best;
  const failed = (["uniswap", "home"] as const).filter(
    (protocol) => quotes.status[protocol] === "failed",
  );
  if (failed.length > 0)
    throw new Error(t("zap.errQuoteFailed", { protocols: failed.join(" / ") }));
  return null;
}

/**
 * Plan a zap. Throws Error with a human-readable reason when it can't
 * (no route, empty pool, dust amounts). Network: 1–2 direct-route quote rounds.
 */
/** display label for a planned swap leg */
export function zapRouteLabel(swap: ZapSwapVia): string {
  return swap.via === "direct" ? directRouteLabel(swap.route) : swap.routeLabel;
}

/** worst swap-leg venue fee in bps — autoSlippage's volatility prior (0 = no swap) */
export function zapVenueFeeBps(plan: ZapPlan): number {
  let worst = 0;
  for (const leg of plan.legs) {
    const fee =
      leg.via.via === "direct"
        ? directRouteFeePpm(leg.via.route) / 100
        : leg.via.venueFeeBps;
    if (fee > worst) worst = fee;
  }
  return worst;
}

/** one planning-time quote for the swap leg, whichever venue answered best */
type SwapLegQuote = {
  via: ZapSwapVia;
  amountOut: bigint;
  impactBps: number | null;
};

/**
 * Quote the swap leg across BOTH kinds: the solver (SHEEP CHOICE — zap's fee
 * charged server-side via the request's feeBps override) and the direct
 * venues (fee inside the client-side quote). Both amounts are net of the
 * terminal fee, so the comparison is apples-to-apples; the solver wins ties
 * like the SWAP tab. One side failing alone is fine — a total blank rethrows
 * the direct path's (localized) error.
 */
async function quoteSwapLeg(
  client: PublicClient,
  pools: readonly Pool[] | null,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  feeBps: number,
): Promise<SwapLegQuote> {
  const directQuote = quoteDirectCandidates(
    client,
    pools,
    tokenIn,
    tokenOut,
    amountIn,
    feeBps,
  ).then(bestExecutableQuote);

  // A chain without a configured solver is genuinely direct-only. In
  // particular, an empty base URL must never turn into a same-origin /quote.
  if (!FEATURES.solver || ENV.solverUrl.length === 0) {
    const best = await directQuote;
    if (best) {
      return {
        via: { via: "direct", route: best.route },
        amountOut: best.amountOut,
        impactBps: best.impactBps,
      };
    }
    throw new Error(t("zap.errNoRoute"));
  }

  const [direct, solver] = await Promise.allSettled([
    directQuote,
    fetchSolverQuote({ tokenIn, tokenOut, amountIn, slippageBps: 50, feeBps }),
  ]);
  const best = direct.status === "fulfilled" ? direct.value : null;
  const routed = solver.status === "fulfilled" ? solver.value : null;
  if (routed && (!best || routed.amountOutNet >= best.amountOut)) {
    return {
      via: {
        via: "solver",
        routeLabel: `${t("swap.solverRoute")} · ${solverRouteLabel(routed)}`,
        venueFeeBps: solverVenueFeeBps(routed),
      },
      amountOut: routed.amountOutNet,
      impactBps: routed.priceImpactBps,
    };
  }
  if (best)
    return {
      via: { via: "direct", route: best.route },
      amountOut: best.amountOut,
      impactBps: best.impactBps,
    };
  if (direct.status === "rejected") throw direct.reason;
  throw new Error(t("zap.errNoRoute"));
}

export async function planZap(args: {
  client: PublicClient;
  pools: readonly Pool[] | null;
  target: ZapTarget;
  tokenIn: Address; // NATIVE | pool.token0 | pool.token1
  amountIn: bigint;
}): Promise<ZapPlan> {
  const { client, pools, target, tokenIn, amountIn } = args;
  const pool = target.pool;
  if (amountIn <= 0n) throw new Error(t("zap.errAmount"));
  const { nativeIn, wrapInput, swapTokenIn, inIs0 } = zapFundingFor(
    pool,
    tokenIn,
  );

  const feeBps = zapFee().bps;
  const quoteLegs = (
    spec: { buyIs0: boolean; swapIn: bigint }[],
  ): Promise<ZapLeg[]> =>
    Promise.all(
      spec.map(async ({ buyIs0, swapIn }) => {
        const q = await quoteSwapLeg(
          client,
          pools,
          swapTokenIn,
          zapSwapOutputToken(pool, buyIs0),
          swapIn,
          feeBps,
        );
        if (q.amountOut === 0n) throw new Error(t("zap.errZeroQuote"));
        return {
          buyIs0,
          swapIn,
          via: q.via,
          estOut: q.amountOut,
          impactBps: q.impactBps,
        };
      }),
    );

  // --- solve the swap size(s), ≤2 quote rounds across solver + direct venues ---
  let keep = 0n;
  let legs: ZapLeg[] = [];
  if (inIs0 !== null) {
    // pool-side input: keep a slice, swap the rest into the counter token
    const { rho, spot } = needAndSpot(target, inIs0);
    let swapIn = solveSwap(amountIn, rho, spot);
    if (swapIn > 0n && swapIn * 1_000_000n < amountIn) swapIn = 0n; // <0.0001% — not worth a tx
    if (amountIn - swapIn > 0n && (amountIn - swapIn) * 1_000_000n < amountIn)
      swapIn = amountIn;
    if (swapIn > 0n) {
      legs = await quoteLegs([{ buyIs0: !inIs0, swapIn }]);
      const q1 = Number(legs[0].estOut) / Number(swapIn);
      if (!(q1 > 0)) throw new Error(t("zap.errZeroQuote"));
      const s1 = solveSwap(amountIn, rho, q1);
      // re-quote only when the answer moved meaningfully (>0.4% of the input)
      const drift = s1 > swapIn ? s1 - swapIn : swapIn - s1;
      if (drift * 250n > amountIn && s1 > 0n) {
        legs = await quoteLegs([{ buyIs0: !inIs0, swapIn: s1 }]);
      }
    }
    keep = amountIn - (legs[0]?.swapIn ?? 0n);
  } else {
    // outside token: both sides come from swaps, seeded at the pool's own spot
    const { rho, spot } = needRatio1Per0(target);
    legs = await quoteLegs(splitOutside(amountIn, rho, 1 / spot));
    const l0 = legs.find((l) => l.buyIs0);
    const l1 = legs.find((l) => !l.buyIs0);
    if (l0 && l1) {
      // re-solve from the measured leg rates; re-quote both on >0.4% drift
      const r0 = Number(l0.estOut) / Number(l0.swapIn);
      const r1 = Number(l1.estOut) / Number(l1.swapIn);
      const next = splitOutside(amountIn, rho, r0 / r1);
      const s0 = next.find((s) => s.buyIs0)?.swapIn ?? 0n;
      const drift = s0 > l0.swapIn ? s0 - l0.swapIn : l0.swapIn - s0;
      if (drift * 250n > amountIn) legs = await quoteLegs(next);
    }
  }

  // --- planned deposit + dust estimate ---
  const legOut = (is0: boolean) =>
    legs.filter((l) => l.buyIs0 === is0).reduce((sum, l) => sum + l.estOut, 0n);
  const dep0 = (inIs0 === true ? keep : 0n) + legOut(true);
  const dep1 = (inIs0 === false ? keep : 0n) + legOut(false);
  let liquidity = 0n;
  let dust0 = 0n;
  let dust1 = 0n;
  if (pool.kind === "cl") {
    const { tickLower, tickUpper } = target as Extract<
      ZapTarget,
      { kind: "cl-mint" | "cl-increase" }
    >;
    const sqrtA = getSqrtRatioAtTick(tickLower);
    const sqrtB = getSqrtRatioAtTick(tickUpper);
    liquidity =
      pool.protocol === "univ4"
        ? v4IncreasePlan({
            sqrtP: pool.sqrtPriceX96,
            tickLower,
            tickUpper,
            amount0: dep0,
            amount1: dep1,
          })
        : getLiquidityForAmounts(pool.sqrtPriceX96, sqrtA, sqrtB, dep0, dep1);
    if (liquidity === 0n) throw new Error(t("zap.errTooSmall"));
    const pulled = getAmountsForLiquidity(
      pool.sqrtPriceX96,
      sqrtA,
      sqrtB,
      liquidity,
    );
    dust0 = dep0 > pulled.amount0 ? dep0 - pulled.amount0 : 0n;
    dust1 = dep1 > pulled.amount1 ? dep1 - pulled.amount1 : 0n;
  } else {
    const v2 = pool as V2Pool;
    if (dep0 > 0n && dep1 > 0n) {
      const need1 = (dep0 * v2.reserve1) / v2.reserve0;
      if (need1 <= dep1) dust1 = dep1 - need1;
      else dust0 = dep0 - (dep1 * v2.reserve0) / v2.reserve1;
    }
  }

  // worst leg wins; any leg without a probe forces the explicit-slippage path
  let impactBps: number | null = legs.length ? 0 : null;
  for (const leg of legs) {
    if (leg.impactBps === null) {
      impactBps = null;
      break;
    }
    if (impactBps !== null && leg.impactBps > impactBps)
      impactBps = leg.impactBps;
  }

  return {
    tokenIn: nativeIn ? NATIVE : tokenIn,
    nativeIn,
    swapTokenIn,
    wrapInput,
    inIs0,
    amountIn,
    keep,
    legs,
    dep0,
    dep1,
    liquidity,
    dust0,
    dust1,
    impactBps,
  };
}

// ---------------- stages ----------------

type ZapStageKind =
  "wrap" | "swap" | "unwrap" | "approve0" | "approve1" | "deposit" | "stake";
type ZapStage = { kind: ZapStageKind; label: string; leg?: number };

/** a pool that mints stakeable liquidity — up33 with a live gauge */
export function poolStakeable(pool: Pool): boolean {
  return pool.protocol === "home" && !!pool.gauge && !!pool.gaugeAlive;
}

/** a target whose freshly-minted position can be staked (new mint/add, not an
 *  increase — increasing an existing NFT/LP changes nothing about its stake) */
export function stakeableTarget(target: ZapTarget): boolean {
  return target.kind !== "cl-increase" && poolStakeable(target.pool);
}

function depositVerb(target: ZapTarget): string {
  switch (target.kind) {
    case "cl-increase":
      return t("zap.stIncrease", { id: target.tokenId.toString() });
    case "cl-mint":
      return t("zap.stMint");
    case "v2":
      return t("zap.stAddLiquidity");
  }
}

function depositSpender(target: ZapTarget): Address {
  if (target.kind === "v2") {
    return v2LiquidityRouter(target.pool);
  }
  if (target.pool.protocol === "univ4") {
    if (!UNI_V4) throw new Error(t("zap.errV4PoolKey"));
    return UNI_V4.PERMIT2;
  }
  if (target.kind === "cl-increase") return target.npm;
  return clLiquidityNpm(target.pool);
}

/** logical execution sequence for preview + progress UI. `stake` appends the
 *  gauge-stake follow-up when the caller opted in AND the target is stakeable. */
export function zapStages(
  plan: ZapPlan,
  target: ZapTarget,
  tIn: TokenInfo,
  t0: TokenInfo,
  t1: TokenInfo,
  stake = false,
): ZapStage[] {
  const v4 = target.pool.protocol === "univ4";
  let spender = t("zap.spenderNpm");
  if (v4) spender = t("zap.spenderPermit2");
  else if (target.kind === "v2") spender = t("zap.spenderRouter");
  const stages: ZapStage[] = [];
  if (plan.wrapInput)
    stages.push({
      kind: "wrap",
      label: t("zap.stWrap", {
        amt: fmtAmount(plan.amountIn, CHAIN.nativeCurrency.decimals),
        native: CHAIN.nativeCurrency.symbol,
        wrapped: CHAIN.wrappedSymbol,
      }),
    });
  plan.legs.forEach((leg, i) => {
    const tOut = leg.buyIs0 ? t0 : t1;
    stages.push({
      kind: "swap",
      leg: i,
      label: t("zap.stSwap", {
        amt: fmtAmount(leg.swapIn, tIn.decimals),
        sym: plan.wrapInput ? CHAIN.wrappedSymbol : tIn.symbol,
        out: fmtAmount(leg.estOut, tOut.decimals),
        outSym: tOut.symbol,
      }),
    });
  });
  const plannedOut: [bigint, bigint] = [
    plan.legs
      .filter((leg) => leg.buyIs0)
      .reduce((sum, leg) => sum + leg.estOut, 0n),
    plan.legs
      .filter((leg) => !leg.buyIs0)
      .reduce((sum, leg) => sum + leg.estOut, 0n),
  ];
  const unwrap = v4ZapUnwrapAmount(plan, target.pool, plannedOut);
  if (unwrap > 0n)
    stages.push({
      kind: "unwrap",
      label: t("zap.stUnwrap", {
        amt: fmtAmount(unwrap, CHAIN.nativeCurrency.decimals),
        native: CHAIN.nativeCurrency.symbol,
        wrapped: CHAIN.wrappedSymbol,
      }),
    });
  if (plan.dep0 > 0n && !(v4 && target.pool.token0 === zeroAddress))
    stages.push({
      kind: "approve0",
      label: t("zap.stApproveSpender", { sym: t0.symbol, spender }),
    });
  if (plan.dep1 > 0n && !(v4 && target.pool.token1 === zeroAddress))
    stages.push({
      kind: "approve1",
      label: t("zap.stApproveSpender", { sym: t1.symbol, spender }),
    });
  stages.push({ kind: "deposit", label: depositVerb(target) });
  if (stake && stakeableTarget(target))
    stages.push({ kind: "stake", label: t("zap.stStake") });
  return stages;
}

// ---------------- executor ----------------

/** why a run halted, coarse enough for the panel to pick its advice:
 *  'slippage' — the swap leg died against its min-out (raise slippage);
 *  'deposit-moved' — the deposit reverted on its fresh-price mins (just retry);
 *  'other' — rejection / structural abort / anything else (txlog has details) */
export type ZapFailReason = "slippage" | "deposit-moved" | "other";

type ZapRun = {
  ok: boolean;
  failedAt: number | null;
  reason: ZapFailReason | null;
};

/**
 * Execute a planned zap step by step. Re-quotes the swap fresh (the plan's
 * quote is for preview) and deposits the amounts that ACTUALLY arrived, so a
 * stale plan can only halt the flow, never mis-spend. Halts (returns
 * failedAt + reason) on the first failed/rejected tx or violated gate.
 */
export async function executeZap(args: {
  plan: ZapPlan;
  target: ZapTarget;
  user: Address;
  slipBps: number; // swap leg slippage
  stake: boolean; // continue into the gauge-stake follow-up (when target is stakeable)
  tIn: TokenInfo; // what the user funds with (may be outside the pair)
  t0: TokenInfo;
  t1: TokenInfo;
  onStage?: (i: number) => void;
}): Promise<ZapRun> {
  const { plan, target, user, slipBps, tIn, t0, t1 } = args;
  const pool = target.pool;
  const stages = zapStages(plan, target, tIn, t0, t1, args.stake);
  let i = 0;
  let stepWhy: StepFailWhy | null = null;
  const deferDepositInvalidation = args.stake && stakeableTarget(target);
  let depositInvalidationDeferred = false;
  const flushDepositInvalidation = () => {
    if (!depositInvalidationDeferred) return;
    depositInvalidationDeferred = false;
    invalidateTransactionState("liquidity");
  };
  const onFail = (why: StepFailWhy) => {
    stepWhy = why;
  };
  const fail = (reason: ZapFailReason = "other"): ZapRun => ({
    ok: false,
    failedAt: i,
    reason,
  });
  const abort = (msg: string, reason: ZapFailReason = "other"): ZapRun => {
    txlog.push("err", t("zap.halt", { msg }));
    return fail(reason);
  };

  const actualOut: [bigint, bigint] = [0n, 0n];
  let depositRcpt: TransactionReceipt | null = null;

  for (i = 0; i < stages.length; i++) {
    // The plan, recipients and approvals are bound to `user`. Wallets may switch
    // accounts while a previous receipt/RPC is pending, so stop before every
    // subsequent side effect instead of letting Wagmi select the new account.
    if (!activeAccountMatches(user)) {
      flushDepositInvalidation();
      return abort(accountChangedMessage());
    }
    args.onStage?.(i);
    stepWhy = null;
    const st = stages[i];
    switch (st.kind) {
      case "wrap": {
        const h = await step(
          st.label,
          () =>
            writeContract(wagmiConfig, {
              account: user,
              abi: wethAbi,
              address: ADDR.WNATIVE,
              functionName: "deposit",
              value: plan.amountIn,
              chainId: CHAIN_ID,
            }),
          { invalidate: "balances" },
        );
        if (!h) return fail();
        break;
      }
      case "swap": {
        const leg = st.leg === undefined ? undefined : plan.legs[st.leg];
        if (!leg) return abort(t("zap.errNoRoute"));
        const legOutToken = zapSwapOutputToken(pool, leg.buyIs0);
        const inputSymbol = plan.wrapInput ? CHAIN.wrappedSymbol : tIn.symbol;
        let swap;
        try {
          swap =
            leg.via.via === "solver"
              ? await executeSolverSwap({
                  tokenIn: plan.swapTokenIn,
                  tokenOut: legOutToken,
                  amountIn: leg.swapIn,
                  slippageBps: slipBps,
                  minimumAmountOut: applySlippage(leg.estOut, slipBps),
                  sender: user,
                  recipient: user,
                  inputSymbol,
                  label: `${st.label} [${t("swap.solverRoute")}]`,
                  feeBps: zapFee().bps,
                  onStepFail: onFail,
                })
              : await executeSwap({
                  route: leg.via.route,
                  tokenIn: plan.swapTokenIn,
                  tokenOut: legOutToken,
                  amountIn: leg.swapIn,
                  minimumAmountOut: applySlippage(leg.estOut, slipBps),
                  sender: user,
                  recipient: user,
                  inputSymbol,
                  label: `${st.label} [${directRouteLabel(leg.via.route)}]`,
                  fee: zapFee(),
                  onStepFail: onFail,
                });
        } catch (e) {
          return abort(
            (e as Error).message,
            e instanceof SlippageError ? "slippage" : "other",
          );
        }
        // a swap that REVERTED on-chain died on its min-out check — same
        // slippage remedy as the pre-flight gate; a rejection is not advice-worthy
        if (!swap) return fail(stepWhy === "reverted" ? "slippage" : "other");
        if (swap.output.kind !== "erc20")
          return abort(t("zap.haltTokenOut", { addr: legOutToken }));
        actualOut[leg.buyIs0 ? 0 : 1] += swap.output.amount;
        break;
      }
      case "unwrap": {
        const amount = v4ZapUnwrapAmount(plan, pool, actualOut);
        if (amount === 0n) break;
        const h = await step(
          st.label,
          () =>
            writeContract(wagmiConfig, {
              account: user,
              abi: wethAbi,
              address: ADDR.WNATIVE,
              functionName: "withdraw",
              args: [amount],
              chainId: CHAIN_ID,
            }),
          { invalidate: "balances" },
        );
        if (!h) return fail();
        break;
      }
      case "approve0":
      case "approve1": {
        const is0 = st.kind === "approve0";
        const token = is0 ? pool.token0 : pool.token1;
        const sym = is0 ? t0.symbol : t1.symbol;
        const amt = depositAmounts(plan, actualOut)[is0 ? 0 : 1];
        const approved =
          pool.protocol === "univ4"
            ? await ensureV4CurrencyApproval(token, user, amt, sym)
            : await ensureAllowance(
                token,
                user,
                depositSpender(target),
                amt,
                sym,
              );
        if (amt > 0n && !approved) return fail();
        break;
      }
      case "deposit": {
        const [dep0, dep1] = depositAmounts(plan, actualOut);
        if (dep0 === 0n && dep1 === 0n) return abort(t("zap.haltNothing"));
        try {
          depositRcpt = await runDeposit(
            target,
            user,
            dep0,
            dep1,
            st.label,
            t0,
            t1,
            onFail,
            deferDepositInvalidation ? "none" : "liquidity",
          );
        } catch (e) {
          // pre-tx reads (fresh price, router quote) can throw on RPC trouble —
          // that must halt visibly, not escape as an unhandled rejection
          return abort(shortErr(e));
        }
        if (!depositRcpt)
          return fail(stepWhy === "reverted" ? "deposit-moved" : "other");
        depositInvalidationDeferred = deferDepositInvalidation;
        break;
      }
      case "stake": {
        // the position is already live: staking is a best-effort follow-up, not
        // a zap halt — a failure/rejection here just points the user at POSITIONS
        let staked = false;
        try {
          staked = !!depositRcpt && await runStake(target, user, depositRcpt, t0, t1);
        } catch (error) {
          txlog.push("err", `${st.label} — ${shortErr(error)}`);
        } finally {
          if (staked) depositInvalidationDeferred = false;
          else flushDepositInvalidation();
        }
        if (!staked) {
          txlog.push("info", t("zap.stakeHint"), undefined, {
            label: t("zap.stakeHintAction"),
            onClick: () => {
              location.hash = "positions";
            },
          });
        }
        break;
      }
    }
  }

  flushDepositInvalidation();

  // auto-stake off but the pool is stakeable → nudge them to do it from POSITIONS
  if (!args.stake && stakeableTarget(target)) {
    txlog.push("info", t("zap.stakeHint"), undefined, {
      label: t("zap.stakeHintAction"),
      onClick: () => {
        location.hash = "positions";
      },
    });
  }
  return { ok: true, failedAt: null, reason: null };
}

/** stake the just-minted position, reading its id/LP from the deposit receipt */
async function runStake(
  target: ZapTarget,
  user: Address,
  rcpt: TransactionReceipt,
  t0: TokenInfo,
  t1: TokenInfo,
): Promise<boolean> {
  const pool = target.pool;
  if (!pool.gauge) return false;
  if (target.kind === "v2") {
    const lp = receivedOf(rcpt, pool.address, user);
    return stakeV2Lp(
      pool.address,
      pool.gauge,
      lp,
      user,
      `${t0.symbol}/${t1.symbol}`,
    );
  }
  const npm = clLiquidityNpm(target.pool);
  const tokenId = mintedTokenId(rcpt, npm, user);
  if (tokenId === null) return false;
  return stakeClNft(pool.gauge, npm, tokenId, user);
}

/** post-swap deposit amounts: kept side exact, swapped sides = what ACTUALLY arrived */
function depositAmounts(
  plan: ZapPlan,
  actualOut: readonly [bigint, bigint],
): [bigint, bigint] {
  return [
    (plan.inIs0 === true ? plan.keep : 0n) + actualOut[0],
    (plan.inIs0 === false ? plan.keep : 0n) + actualOut[1],
  ];
}

async function runDeposit(
  target: ZapTarget,
  user: Address,
  dep0: bigint,
  dep1: bigint,
  label: string,
  t0: TokenInfo,
  t1: TokenInfo,
  onFail?: (why: StepFailWhy) => void,
  invalidation: "none" | "liquidity" = "liquidity",
): Promise<TransactionReceipt | null> {
  if (target.kind === "v2") {
    const pool = target.pool;
    if (v2UsesRouter02(pool)) {
      // vanilla Router02 has no quote helper — compute the optimal pair from
      // fresh reserves so mins are honest and dust stays in the wallet
      const [r0, r1] = await readContract(wagmiConfig, {
        abi: uniV2PairAbi,
        address: pool.address,
        functionName: "getReserves",
        chainId: CHAIN_ID,
      });
      let d0 = dep0;
      let d1 = dep1;
      if (r0 > 0n && r1 > 0n && dep0 > 0n && dep1 > 0n) {
        const need1 = (dep0 * r1) / r0;
        if (need1 <= dep1) d1 = need1;
        else d0 = (dep1 * r0) / r1;
      }
      const call = buildV2AddLiquidityCall(pool, {
        amount0Desired: d0,
        amount1Desired: d1,
        amount0Min: applySlippage(d0, DEPOSIT_MINS_BPS),
        amount1Min: applySlippage(d1, DEPOSIT_MINS_BPS),
        recipient: user,
        deadline: deadline(),
      });
      const venue = pool.protocol === "univ2" ? "uni v2" : CHAIN.labels.homeV2;
      const h = await step(
        `${label} ${t0.symbol}/${t1.symbol} [${venue}]`,
        () =>
          sendTransaction(wagmiConfig, {
            account: user,
            to: call.address,
            data: call.data,
            chainId: CHAIN_ID,
          }),
        { onFail, invalidate: invalidation },
      );
      return h;
    }
    const quote = await readContract(wagmiConfig, {
      abi: v2RouterAbi,
      address: ADDR.V2_ROUTER,
      functionName: "quoteAddLiquidity",
      args: [
        pool.token0,
        pool.token1,
        pool.stable,
        ADDR.V2_FACTORY,
        dep0,
        dep1,
      ],
      chainId: CHAIN_ID,
    });
    const h = await step(
      `${label} ${t0.symbol}/${t1.symbol}`,
      () =>
        writeContract(wagmiConfig, {
          account: user,
          abi: v2RouterAbi,
          address: ADDR.V2_ROUTER,
          functionName: "addLiquidity",
          args: [
            pool.token0,
            pool.token1,
            pool.stable,
            dep0,
            dep1,
            applySlippage(quote[0], DEPOSIT_MINS_BPS),
            applySlippage(quote[1], DEPOSIT_MINS_BPS),
            user,
            deadline(),
          ],
          chainId: CHAIN_ID,
        }),
      { onFail, invalidate: invalidation },
    );
    return h;
  }

  const pool = target.pool;
  if (pool.protocol === "univ4") {
    return v4Deposit({
      target,
      user,
      amount0: dep0,
      amount1: dep1,
      symbol0: t0.symbol,
      symbol1: t1.symbol,
      label,
      onFail,
    });
  }

  // CL: fresh price + band-edge mins (see minAmountsForLiquidity) — 'PS'-safe
  const sqrtP = await fetchSqrtPriceX96(pool.address);
  const sqrtA = getSqrtRatioAtTick(target.tickLower);
  const sqrtB = getSqrtRatioAtTick(target.tickUpper);
  const liq = getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, dep0, dep1);
  if (liq === 0n) {
    txlog.push("err", t("zap.halt", { msg: t("zap.haltDepositSmall") }));
    return null;
  }
  const mins = minAmountsForLiquidity(
    sqrtP,
    sqrtA,
    sqrtB,
    liq,
    DEPOSIT_MINS_BPS,
  );

  if (target.kind === "cl-increase") {
    const h = await step(
      `${label} (${t0.symbol}/${t1.symbol})`,
      () =>
        writeContract(wagmiConfig, {
          account: user,
          abi: clPmAbi,
          address: target.npm,
          functionName: "increaseLiquidity",
          args: [
            {
              tokenId: target.tokenId,
              amount0Desired: dep0,
              amount1Desired: dep1,
              amount0Min: mins.amount0Min,
              amount1Min: mins.amount1Min,
              deadline: deadline(),
            },
          ],
          chainId: CHAIN_ID,
        }),
      { onFail, invalidate: invalidation },
    );
    return h;
  }

  const call = buildClMintCall(pool, {
    tickLower: target.tickLower,
    tickUpper: target.tickUpper,
    amount0Desired: dep0,
    amount1Desired: dep1,
    amount0Min: mins.amount0Min,
    amount1Min: mins.amount1Min,
    recipient: user,
    deadline: deadline(),
  });
  const h = await step(
    `${label} ${pool.protocol === "univ3" ? "v3" : CHAIN.labels.homeCl} ${t0.symbol}/${t1.symbol} [${target.tickLower},${target.tickUpper}]`,
    () =>
      sendTransaction(wagmiConfig, {
        account: user,
        to: call.address,
        data: call.data,
        chainId: CHAIN_ID,
      }),
    { onFail, invalidate: invalidation },
  );
  return h;
}
