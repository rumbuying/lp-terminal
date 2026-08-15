import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAccount } from "wagmi";
import { readContract, sendTransaction, writeContract } from "wagmi/actions";
import { parseUnits } from "viem";
import {
  clGaugeAbi,
  clPmAbi,
  v2GaugeAbi,
  v2PoolAbi,
  v2RouterAbi,
  wethAbi,
} from "../../abi";
import { ADDR, CHAIN_ID, EXPLORER, NATIVE, UNI } from "../../config/addresses";
import { CHAIN } from "../../config/chains";
import { FEATURES } from "../../config/features";
import { wagmiConfig } from "../../config/wagmi";
import {
  MAX_UINT128,
  applySlippage,
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getSqrtRatioAtTick,
  minAmountsForLiquidity,
  previewDeposit,
} from "../../lib/clmath";
import { largestFundable } from "../../lib/clDeposit";
import { fmtApr } from "../../lib/apr";
import { fmtAmount, fmtNum, fmtUsd, shortAddr } from "../../lib/format";
import { effectiveClFeePpm, poolIdentity } from "../../lib/poolIdentity";
import {
  buildV2RemoveLiquidityCall,
  v2LiquidityRouter,
  v2SupportsClaimFees,
  v2UsesRouter02,
} from "../../lib/liquidityCalls";
import {
  limitFillFrac,
  limitSideFor,
  limitTagOf,
  untagLimit,
} from "../../lib/limit";
import {
  compareClPositionDisplay,
  clPosMetrics,
  v2PosMetrics,
  type ClMetrics,
  type Earning,
} from "../../lib/posmetrics";
import type { PoolStat } from "../../lib/poolstats";
import {
  deadline,
  ensureAllowance,
  fetchSqrtPriceX96,
  invalidateTransactionState,
  offerSwapClaimedUp,
  step,
} from "../../lib/tx";
import { stakeClNft, stakeV2Lp } from "../../lib/stake";
import { txlog } from "../../lib/txlog";
import { tokenOf, usePools } from "../../hooks/usePools";
import { useBalances } from "../../hooks/useBalances";
import { usePositions } from "../../hooks/usePositions";
import { usePoolStats } from "../../hooks/usePoolStats";
import { useUniPoolStats } from "../../hooks/useUniPoolStats";
import { useUpPrice } from "../../hooks/useUpPrice";
import { useLiveSlot0, type LiveSlot0 } from "../../hooks/useLiveSlot0";
import type { Address } from "viem";
import type {
  ClPosition,
  Pool,
  PoolsData,
  TokenInfo,
  V2Position,
} from "../../types";
import { DexScreenerLink } from "../DexScreenerLink";
import {
  UNI_V4,
  V4_DEPOSIT_BAND_BPS,
  v4BalanceAddress,
  v4HasHooks,
  v4IncreasePlan,
} from "../../lib/uniV4";
import { v4Collect, v4Decrease, v4Increase } from "../../lib/uniV4Write";
import { Flash } from "../Flash";
import { PairAddrs } from "../PairAddrs";
import { useStockIssuerPair } from "../../hooks/useStockIssuers";
import { ProtoBadge } from "../ProtoBadge";
import { LiquidityRange } from "../LiquidityRange";
import { RangeBar } from "../RangeBar";
import { ZapPanel } from "../ZapPanel";
import { FundSwitch } from "./PoolsTab";
import { activateOnKey, AmountRow, Badge, Btn, Stat } from "../ui";

const SLIP_BPS = 100; // 1% mins on liquidity ops

export function PositionsTab() {
  const { t } = useTranslation();
  const { address: user } = useAccount();
  const pools = usePools();
  const positions = usePositions(user);
  const stats = usePoolStats(); // up33 pool 24h stats + the WETH/USD anchor
  const upPrice = useUpPrice();
  const [claimBusy, setClaimBusy] = useState(false);

  // Indexer stats for every catalog-backed pool the user is LPing. On BSC that
  // includes Pancake v2/v3 rows mapped into the home protocol slot.
  const uniAddrs = useMemo(
    () => [
      ...new Set([
        ...(positions.data?.cl ?? [])
          .filter(
            (p) =>
              p.pool.protocol === "univ3" ||
              (p.pool.protocol === "home" && CHAIN.homeCl.keyedBy === "fee"),
          )
          .map((p) => p.pool.address),
        ...(positions.data?.v2 ?? [])
          .filter((p) => p.pool.protocol === "univ2" || v2UsesRouter02(p.pool))
          .map((p) => p.pool.address),
      ]),
    ],
    [positions.data],
  );
  const uniStats = useUniPoolStats(uniAddrs);

  // pools hosting range orders get a fast (4s) slot0 feed so fill % feels live.
  // limit tags are keyed by tokenId, which is only unique per NPM — they are
  // minted via the UP33 CL_PM, so never attribute them to univ3 positions.
  const orderPools = useMemo(() => {
    const set = new Set<Address>();
    for (const p of positions.data?.cl ?? [])
      if (p.pool.protocol === "home" && limitTagOf(p.tokenId))
        set.add(p.pool.address);
    return [...set];
  }, [positions.data]);
  const live = useLiveSlot0(orderPools);
  const liveOf = (p: ClPosition): LiveSlot0 | undefined =>
    live.data?.[p.pool.address.toLowerCase()];
  const statOf = (pool: Pool): PoolStat | undefined =>
    stats.data?.byPool[pool.address.toLowerCase()] ??
    uniStats.data?.[pool.address.toLowerCase()];

  const claimables = useMemo(() => {
    const cl =
      positions.data?.cl.filter(
        (p) => p.staked && p.earned > 0n && p.pool.gauge,
      ) ?? [];
    const v2 =
      positions.data?.v2.filter((p) => p.earned > 0n && p.pool.gauge) ?? [];
    return { cl, v2, count: cl.length + v2.length };
  }, [positions.data]);

  if (!user)
    return (
      <div className="dim">
        {t("pos.connectPrompt")} <a href="#pools">{t("pos.browsePools")}</a>
      </div>
    );
  // The positions query is GATED on pools.data — so a pools failure would
  // otherwise present as an eternal scan, the one loading state that is a lie.
  if (pools.isError)
    return (
      <div className="red">
        {t("pools.scanFailed", { err: String(pools.error) })}
      </div>
    );
  if (positions.isLoading || !pools.data)
    return (
      <div className="dim">
        {t("pos.scanning")}
        <span className="spin">▮</span>
      </div>
    );
  if (positions.isError)
    return (
      <div className="red">
        {t("pos.scanFailed", { err: String(positions.error) })}
      </div>
    );

  const data = positions.data!;
  const pendingUp =
    data.cl.reduce((a, x) => a + x.earned, 0n) +
    data.v2.reduce((a, x) => a + x.earned, 0n);
  const upUsd = upPrice.data;
  const wethUsd = stats.data?.wethUsd;

  // portfolio roll-up: value / uncollected fees / UP accrual rate. Uses the
  // cached positions snapshot (cards refine with the fast feed where they have it)
  const tokAll: Record<string, TokenInfo> = {
    ...pools.data.tokens,
    ...data.tokens,
  };
  // full per-position metrics (not just value): the pool-group headers roll
  // these up. Snapshot-priced like the portfolio totals above — cards refine
  // with the live feed where they have one.
  const clM = new Map<ClPosition, ClMetrics | null>();
  const v2Val = new Map<V2Position, number | null>();
  let lpValue = 0;
  let unpriced = 0;
  let feesUsdTotal = 0;
  let upPerDayTotal = 0;
  for (const p of data.cl) {
    const t0 = tokAll[p.pool.token0.toLowerCase()];
    const t1 = tokAll[p.pool.token1.toLowerCase()];
    if (!t0 || !t1) {
      unpriced++;
      clM.set(p, null);
      continue;
    }
    const m = clPosMetrics({
      pos: p,
      amount0: p.amount0,
      amount1: p.amount1,
      tick: liveOf(p)?.tick ?? p.pool.tick,
      dec0: t0.decimals,
      dec1: t1.decimals,
      stat: statOf(p.pool),
      upUsd,
      wethUsd,
    });
    clM.set(p, m);
    if (m.valueUsd === null) unpriced++;
    else lpValue += m.valueUsd + (m.feesUsd ?? 0);
    if (m.feesUsd) feesUsdTotal += m.feesUsd;
    if (m.earning.kind === "emissions") upPerDayTotal += m.earning.upPerDay;
  }
  for (const p of data.v2) {
    const t0 = tokAll[p.pool.token0.toLowerCase()];
    const t1 = tokAll[p.pool.token1.toLowerCase()];
    if (!t0 || !t1) {
      unpriced++;
      v2Val.set(p, null);
      continue;
    }
    const m = v2PosMetrics({
      pos: p,
      dec0: t0.decimals,
      dec1: t1.decimals,
      stat: statOf(p.pool),
      upUsd,
      wethUsd,
    });
    v2Val.set(p, m.valueUsd);
    if (m.valueUsd === null) unpriced++;
    else lpValue += m.valueUsd + (m.feesUsd ?? 0);
    if (m.feesUsd) feesUsdTotal += m.feesUsd;
    if (m.staked?.kind === "emissions") upPerDayTotal += m.staked.upPerDay;
  }
  const pendingUpUsd =
    upUsd !== undefined ? (Number(pendingUp) / 1e18) * upUsd : null;
  // rewards = claimable UP emissions + uncollected fees: positions with no
  // emissions at all (uniswap, unstaked up33) still surface their harvest here
  const rewardsUsd = (pendingUpUsd ?? 0) + feesUsdTotal;

  // Protocol and value define the order; staking/unstaking must not move a card.
  const clSorted = [...data.cl].sort((a, b) =>
    compareClPositionDisplay(
      a,
      b,
      clM.get(a)?.valueUsd ?? null,
      clM.get(b)?.valueUsd ?? null,
    ),
  );
  const v2Sorted = [...data.v2].sort(
    (a, b) => (v2Val.get(b) ?? -1) - (v2Val.get(a) ?? -1),
  );
  // bucket same-pool CL positions (multiple NFTs, staked + wallet) under one
  // expandable header; single-position pools stay flat. v2 is one card per
  // pool already, so it never groups.
  const clGroups = groupByPool(clSorted);
  // a range order is SUPPOSED to sit out of range — don't count it as an anomaly
  const outOfRange = data.cl.filter((x) => {
    if (x.pool.protocol === "home" && limitTagOf(x.tokenId)) return false;
    const tick = liveOf(x)?.tick ?? x.pool.tick;
    return tick < x.tickLower || tick >= x.tickUpper;
  }).length;

  // range orders placed via SWAP → LIMIT (tagged locally, UP33-minted only)
  const orders = data.cl
    .map((p) => ({
      p,
      tag: p.pool.protocol === "home" ? limitTagOf(p.tokenId) : null,
    }))
    .filter(
      (
        x,
      ): x is {
        p: ClPosition;
        tag: NonNullable<ReturnType<typeof limitTagOf>>;
      } => !!x.tag && x.p.liquidity > 0n,
    );
  const ordersFilled = orders.filter(
    (x) =>
      limitFillFrac(
        limitSideFor(x.p.pool, x.tag.sell),
        liveOf(x.p)?.sqrtPriceX96 ?? x.p.pool.sqrtPriceX96,
        getSqrtRatioAtTick(x.p.tickLower),
        getSqrtRatioAtTick(x.p.tickUpper),
      ) >= 0.999,
  ).length;

  const claimAll = async () => {
    setClaimBusy(true);
    let changed = false;
    try {
      for (const p of claimables.cl) {
        const h = await step(
          t("pos.stClaim", { id: p.tokenId.toString() }),
          () =>
            writeContract(wagmiConfig, {
              abi: clGaugeAbi,
              address: p.pool.gauge!,
              functionName: "getReward",
              args: [p.tokenId],
              chainId: CHAIN_ID,
            }),
          {
            invalidate: "none",
            onSuccess: (receipt) => {
              changed = true;
              offerSwapClaimedUp(user)(receipt);
            },
          },
        );
        if (!h) return;
      }
      for (const p of claimables.v2) {
        const t0 = tokenOf(pools.data, p.pool.token0);
        const t1 = tokenOf(pools.data, p.pool.token1);
        const h = await step(
          t("pos.stClaimV2", { pair: `${t0.symbol}/${t1.symbol}` }),
          () =>
            writeContract(wagmiConfig, {
              abi: v2GaugeAbi,
              address: p.pool.gauge!,
              functionName: "getReward",
              args: [user],
              chainId: CHAIN_ID,
            }),
          {
            invalidate: "none",
            onSuccess: (receipt) => {
              changed = true;
              offerSwapClaimedUp(user)(receipt);
            },
          },
        );
        if (!h) return;
      }
    } finally {
      if (changed) invalidateTransactionState("liquidity");
      setClaimBusy(false);
    }
  };

  if (data.cl.length === 0 && data.v2.length === 0)
    return data.failedSources.length > 0 ? (
      // A failed reader answering empty is not an empty wallet — say which
      // half of the sky fell instead of asserting "no positions".
      <div className="amber">
        {t("pos.sourcesPartialEmpty", {
          list: data.failedSources.join(", "),
        })}
      </div>
    ) : (
      <div className="dim">
        {t("pos.empty", { addr: user.slice(0, 8) })}{" "}
        <a href="#pools">{t("pos.emptyCta")}</a>
        {FEATURES.v2PositionsFromSweep && (
          <div className="mono-sm">{t("pos.v2SweptBound")}</div>
        )}
      </div>
    );

  // PENDING REWARDS breakdown, in harvest order: UP emissions · uncollected
  // fees · accrual rate · claim action. Assembled as parts so the separator
  // never dangles (fees-only wallets, unclaimable-but-accruing edge cases).
  const rewardsParts: ReactNode[] = [];
  if (pendingUp > 0n)
    rewardsParts.push(
      <span>
        {fmtAmount(pendingUp, 18)} UP
        {pendingUpUsd !== null && pendingUpUsd > 0.01
          ? ` ≈ ${fmtUsd(pendingUpUsd)}`
          : ""}
      </span>,
    );
  if (feesUsdTotal > 0.01)
    rewardsParts.push(
      <span>{t("pos.lpValueFees", { usd: fmtUsd(feesUsdTotal) })}</span>,
    );
  if (upPerDayTotal > 0)
    rewardsParts.push(
      <span>
        {t("pos.upPerDay", { n: fmtNum(upPerDayTotal, 3) })}
        {upUsd !== undefined
          ? ` ${t("pos.upPerDayUsd", { usd: fmtUsd(upPerDayTotal * upUsd) })}`
          : ""}
      </span>,
    );
  if (claimables.count > 0)
    rewardsParts.push(
      <Btn busy={claimBusy} onClick={claimAll}>
        {t("pos.claimAll", { n: claimables.count })}
      </Btn>,
    );

  return (
    <div>
      {data.failedSources.length > 0 && (
        <div className="amber mono-sm" style={{ marginBottom: 8 }}>
          {t("pos.sourcesPartial", { list: data.failedSources.join(", ") })}
        </div>
      )}
      <div className="grid2">
        <Stat
          k={t("pos.lpValue")}
          v={
            lpValue > 0 ? (
              <Flash v={lpValue}>
                <span>{fmtUsd(lpValue)}</span>
              </Flash>
            ) : (
              "—"
            )
          }
          sub={`${t("pos.lpValueSub", {
            cl: data.cl.length,
            v2: data.v2.length,
            staked: data.cl.filter((p) => p.staked).length,
          })}${unpriced > 0 ? ` · ${t("pos.lpValueUnpriced", { n: unpriced })}` : ""}`}
        />
        <Stat
          k={t("pos.pendingRewards")}
          v={
            rewardsUsd > 0.01 ? (
              <Flash v={rewardsUsd} arrow>
                <span>{fmtUsd(rewardsUsd)}</span>
              </Flash>
            ) : pendingUp > 0n ? (
              // UP accrued but unpriceable — show the raw amount rather than $0
              <Flash v={Number(pendingUp)} arrow>
                <span>{fmtAmount(pendingUp, 18)} UP</span>
              </Flash>
            ) : (
              "—"
            )
          }
          sub={
            rewardsParts.length > 0
              ? rewardsParts.map((el, i) => (
                  <span key={i}>
                    {i > 0 && " · "}
                    {el}
                  </span>
                ))
              : t("pos.nothingClaimable")
          }
        />
        <Stat
          k={t("pos.rangeStatus")}
          v={
            outOfRange > 0 ? (
              <span className="red">
                {t("pos.outOfRangeN", { n: outOfRange })}
              </span>
            ) : (
              <span className="green">{t("pos.allInRange")}</span>
            )
          }
          sub={`${t("pos.rangeStatusSub")}${orders.length > 0 ? ` · ${t("pos.ordersNotCounted")}` : ""}`}
        />
        {orders.length > 0 && (
          <Stat
            k={t("pos.rangeOrders")}
            v={t("pos.ordersOpen", { n: orders.length })}
            sub={
              ordersFilled > 0 ? (
                <span className="green">
                  {t("pos.ordersFilled", { n: ordersFilled })}
                </span>
              ) : (
                t("pos.ordersNone")
              )
            }
          />
        )}
      </div>

      <div className="section-title">
        {t("pos.sectionCl", { n: data.cl.length })}
      </div>
      {data.cl.length === 0 && (
        <div className="dim">
          {t("pos.noCl")} <a href="#pools">{t("pos.noClCta")}</a>
        </div>
      )}
      {clGroups.map((g) =>
        g.length === 1 ? (
          // tokenIds are only unique per NPM — prefix the protocol in the key
          <ClCard
            key={`${g[0].pool.protocol}-${g[0].tokenId}`}
            pos={g[0]}
            data={pools.data!}
            xtokens={data.tokens}
            user={user}
            live={liveOf(g[0])}
            stat={statOf(g[0].pool)}
            upUsd={upUsd}
            wethUsd={wethUsd}
          />
        ) : (
          <ClPoolGroup
            key={poolIdentity(g[0].pool)}
            positions={g}
            metricsOf={(p) => clM.get(p)}
            data={pools.data!}
            xtokens={data.tokens}
            user={user}
            liveOf={liveOf}
            statOf={statOf}
            upUsd={upUsd}
            wethUsd={wethUsd}
          />
        ),
      )}
      <div className="section-title">
        {t("pos.sectionV2", { n: data.v2.length })}
        {/* Where v2 LP is found by SWEEPING derived pairs, an empty answer means
            "none among the pairs we asked about" — a pair nobody proposed is a
            pair nobody checks. The count needs that qualifier standing next to
            it, because a wallet holding LP in an unlisted pair reads a truthful
            "0" and concludes it owns nothing. */}
        {FEATURES.v2PositionsFromSweep && (
          <span className="hint mono-sm" data-tip={t("pos.v2SweptTip")}>
            {t("pos.v2Swept")}
          </span>
        )}
      </div>
      {data.v2.length === 0 && (
        <div className="dim">
          {t("pos.noV2")} <a href="#pools">{t("pos.noV2Cta")}</a>
          {FEATURES.v2PositionsFromSweep && (
            <div className="mono-sm">{t("pos.v2SweptBound")}</div>
          )}
        </div>
      )}
      {v2Sorted.map((p) => (
        <V2Card
          key={p.pool.address}
          pos={p}
          data={pools.data!}
          xtokens={data.tokens}
          user={user}
          stat={statOf(p.pool)}
          upUsd={upUsd}
          wethUsd={wethUsd}
        />
      ))}
    </div>
  );
}

// ---------------- CL ----------------

export function ClCard({
  pos,
  data,
  xtokens,
  user,
  live,
  stat,
  upUsd,
  wethUsd,
  nested,
}: {
  pos: ClPosition;
  data: PoolsData;
  xtokens: Record<string, TokenInfo>;
  user: `0x${string}`;
  live?: LiveSlot0;
  stat?: PoolStat;
  upUsd?: number;
  wethUsd?: number | null;
  /** rendered inside a ClPoolGroup: the pair title / protocol / pool-type
      badges live in the group head, so drop them from the card head here */
  nested?: boolean;
}) {
  const { t } = useTranslation();
  const t0 =
    xtokens[pos.pool.token0.toLowerCase()] ?? tokenOf(data, pos.pool.token0);
  const t1 =
    xtokens[pos.pool.token1.toLowerCase()] ?? tokenOf(data, pos.pool.token1);
  // A v4 position may hold the chain's coin, which the pool key names
  // `address(0)`. The issuer proof reads a contract's bytecode, and there is no
  // contract at the zero address — so ask about the coin instead of spending a
  // probe on nothing. `PairAddrs` below still gets the raw currencies: they are
  // what the pool is keyed on.
  const [issuer0, issuer1] = useStockIssuerPair(
    v4BalanceAddress(pos.pool.token0),
    v4BalanceAddress(pos.pool.token1),
  );
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<null | "inc" | "dec">(null);
  const [armed, setArmed] = useState(false);

  /**
   * Which manager minted this NFT. Token ids are unique only PER MANAGER, so
   * the explorer link, the approvals and the writes all have to agree on it.
   *
   * The v3-family managers differ by address alone — their write entrypoints
   * are signature-identical, which is why one `clPmAbi` drives both. v4's does
   * not belong to that family: it takes a single `modifyLiquidities` call
   * carrying an encoded action list, so its writes route through lib/uniV4Write
   * instead. Everything else on this card is shared.
   */
  const isV4 = pos.pool.protocol === "univ4";
  const npm = isV4
    ? (UNI_V4?.POSITION_MANAGER ?? ADDR.CL_PM)
    : pos.pool.protocol === "univ3"
      ? UNI.V3_NPM
      : ADDR.CL_PM;

  // prefer the fast slot0 feed (range-order pools) over the shared pool snapshot
  const curTick = live?.tick ?? pos.pool.tick;
  const curSqrtP = live?.sqrtPriceX96 ?? pos.pool.sqrtPriceX96;
  const sqrtA = getSqrtRatioAtTick(pos.tickLower);
  const sqrtB = getSqrtRatioAtTick(pos.tickUpper);
  const held =
    live && pos.liquidity > 0n
      ? getAmountsForLiquidity(curSqrtP, sqrtA, sqrtB, pos.liquidity)
      : { amount0: pos.amount0, amount1: pos.amount1 };

  // range-order bookkeeping (placed via SWAP → LIMIT on this frontend; tags
  // are tokenId-keyed and UP33-minted, so never read them for univ3 ids)
  const limitTag =
    pos.pool.protocol === "home" ? limitTagOf(pos.tokenId) : null;
  const limitFill = limitTag
    ? limitFillFrac(
        limitSideFor(pos.pool, limitTag.sell),
        curSqrtP,
        sqrtA,
        sqrtB,
      )
    : 0;

  const m = clPosMetrics({
    pos,
    amount0: held.amount0,
    amount1: held.amount1,
    tick: curTick,
    dec0: t0.decimals,
    dec1: t1.decimals,
    stat,
    upUsd,
    wethUsd,
  });

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const withdrawClick = () => {
    if (!armed) {
      setArmed(true);
      setTimeout(() => setArmed(false), 3000);
      return;
    }
    setArmed(false);
    void decrease(100);
  };

  const stake = () =>
    run(async () => {
      if (pos.pool.gauge) await stakeClNft(pos.pool.gauge, npm, pos.tokenId, user);
    });

  // CLGauge.withdraw auto-claims accrued UP, so the swap offer applies here too
  const unstake = () =>
    run(() =>
      step(
        t("pos.stUnstake", { id: pos.tokenId.toString() }),
        () =>
          writeContract(wagmiConfig, {
            abi: clGaugeAbi,
            address: pos.pool.gauge!,
            functionName: "withdraw",
            args: [pos.tokenId],
            chainId: CHAIN_ID,
          }),
        { onSuccess: offerSwapClaimedUp(user) },
      ),
    );

  const claim = () =>
    run(() =>
      step(
        t("pos.stClaim", { id: pos.tokenId.toString() }),
        () =>
          writeContract(wagmiConfig, {
            abi: clGaugeAbi,
            address: pos.pool.gauge!,
            functionName: "getReward",
            args: [pos.tokenId],
            chainId: CHAIN_ID,
          }),
        { onSuccess: offerSwapClaimedUp(user) },
      ),
    );

  const collect = () =>
    run(() =>
      // v4 has no `collect` at all — the same action list that changes
      // liquidity settles the fees, so collecting is a decrease of zero
      isV4
        ? v4Collect(pos, user)
        : step(t("pos.stCollect", { id: pos.tokenId.toString() }), () =>
            writeContract(wagmiConfig, {
              abi: clPmAbi,
              address: npm,
              functionName: "collect",
              args: [
                {
                  tokenId: pos.tokenId,
                  recipient: user,
                  amount0Max: MAX_UINT128,
                  amount1Max: MAX_UINT128,
                },
              ],
              chainId: CHAIN_ID,
            }),
          ),
    );

  const decrease = (pct: number) =>
    run(async () => {
      // one transaction on v4: its action list pays out principal AND fees
      // together, so there is no collect to follow it with
      if (isV4) {
        if (await v4Decrease(pos, pct, SLIP_BPS, user)) setPanel(null);
        return;
      }
      const liq = (pos.liquidity * BigInt(Math.round(pct * 100))) / 10_000n;
      if (liq === 0n) {
        txlog.push("err", t("pos.stNothingRemove"));
        return;
      }
      // fresh price + band-edge mins: in-range token split is far more volatile
      // than value, flat mins on a cached price revert with 'PS'
      const sqrtP = await fetchSqrtPriceX96(pos.pool.address);
      const { amount0Min, amount1Min } = minAmountsForLiquidity(
        sqrtP,
        getSqrtRatioAtTick(pos.tickLower),
        getSqrtRatioAtTick(pos.tickUpper),
        liq,
        SLIP_BPS,
      );
      const ok1 = await step(
        t("pos.stDecrease", { id: pos.tokenId.toString(), pct }),
        () =>
          writeContract(wagmiConfig, {
            abi: clPmAbi,
            address: npm,
            functionName: "decreaseLiquidity",
            args: [
              {
                tokenId: pos.tokenId,
                liquidity: liq,
                amount0Min,
                amount1Min,
                deadline: deadline(),
              },
            ],
            chainId: CHAIN_ID,
          }),
        { invalidate: "none" },
      );
      if (!ok1) return;
      const collected = await step(t("pos.stCollectAll", { id: pos.tokenId.toString() }), () =>
        writeContract(wagmiConfig, {
          abi: clPmAbi,
          address: npm,
          functionName: "collect",
          args: [
            {
              tokenId: pos.tokenId,
              recipient: user,
              amount0Max: MAX_UINT128,
              amount1Max: MAX_UINT128,
            },
          ],
          chainId: CHAIN_ID,
        }),
      );
      if (!collected) invalidateTransactionState("liquidity");
      if (pct === 100) untagLimit(pos.tokenId); // range order closed
      setPanel(null);
    });

  const gaugeOk = !!pos.pool.gauge && pos.pool.gaugeAlive;
  const hasFees = pos.fees0 > 0n || pos.fees1 > 0n;

  return (
    <div className="card">
      <div className="card-head">
        {!nested && (
          <>
            <PairAddrs
              className="card-title"
              sym0={t0.symbol}
              sym1={t1.symbol}
              token0={pos.pool.token0}
              token1={pos.pool.token1}
              issuer0={issuer0}
              issuer1={issuer1}
              pool={pos.pool.address}
              poolId={isV4 ? pos.pool.poolId : undefined}
              hooks={isV4 ? pos.pool.hooks : undefined}
            />
            <ProtoBadge proto={pos.pool.protocol} />
            {/* every other CL pool IS a contract, so its address is what
                DexScreener indexes. A v4 pool lives inside the singleton and
                `address` carries that singleton, which would link every v4
                position to the same wrong page — so it links by poolId or not
                at all. */}
            {!isV4 && <DexScreenerLink pool={pos.pool.address} />}
            <Badge tone="cyan">
              CL {(effectiveClFeePpm(pos.pool) / 10_000).toFixed(2)}% · ts
              {pos.pool.tickSpacing}
            </Badge>
          </>
        )}
        <a
          className="dim mono-sm"
          href={CHAIN.explorer.nft(npm, pos.tokenId)}
          target="_blank"
          rel="noreferrer"
        >
          #{pos.tokenId.toString()}↗
        </a>
        {pos.staked ? (
          <Badge tone="green">{t("pos.staked")}</Badge>
        ) : (
          <Badge tone="amber">{t("pos.wallet")}</Badge>
        )}
        {limitTag && (
          <Badge tone="cyan">
            {t("pos.limitBadge", {
              sell: limitTag.sellSym,
              buy: limitTag.buySym,
            })}
          </Badge>
        )}
        <div className="card-actions">
          {pos.staked ? (
            // Both actions are GAUGE calls. A farm-staked position (Pancake's
            // MasterChefV3) has no gauge, and harvesting or withdrawing it goes
            // through the farm instead — until that exists it is shown but not
            // acted on, which still beats the position being invisible.
            pos.pool.gauge && (
              <>
                <Btn
                  busy={busy}
                  onClick={claim}
                  disabled={pos.earned === 0n}
                  title={t("pos.claimUpTip")}
                >
                  {t("pos.claimUp")}
                </Btn>
                <Btn
                  busy={busy}
                  onClick={unstake}
                  tone="ghost"
                  title={t("pos.unstakeTip")}
                >
                  {t("pos.unstake")}
                </Btn>
              </>
            )
          ) : (
            // v4 lands here too: it has no gauge, so `gaugeOk` already drops
            // the one action it cannot do, and the rest route by `isV4`
            <>
              {gaugeOk && pos.liquidity > 0n && (
                <Btn busy={busy} onClick={stake} title={t("pos.stakeTip")}>
                  {t("pos.stake")}
                </Btn>
              )}
              <Btn
                busy={busy}
                onClick={collect}
                disabled={!hasFees}
                title={t("pos.collectFeesTip")}
              >
                {t("pos.collectFees")}
              </Btn>
              <Btn
                busy={busy}
                onClick={() => setPanel(panel === "inc" ? null : "inc")}
                tone="ghost"
                disabled={pos.liquidity === 0n && !hasFees}
                title={t("pos.incTip")}
              >
                {t("pos.inc")}
              </Btn>
              <Btn
                busy={busy}
                onClick={() => setPanel(panel === "dec" ? null : "dec")}
                tone="ghost"
                disabled={pos.liquidity === 0n}
              >
                {t("pos.dec")}
              </Btn>
              <Btn
                busy={busy}
                onClick={withdrawClick}
                tone="danger"
                disabled={pos.liquidity === 0n}
                title={t("pos.withdrawTip")}
              >
                {armed ? t("pos.withdrawConfirm") : t("pos.withdraw")}
              </Btn>
            </>
          )}
        </div>
      </div>

      <div className="pmetrics mono-sm">
        <PCell
          k={t("pos.value")}
          v={
            m.valueUsd !== null ? (
              <Flash v={m.valueUsd}>
                <b>{fmtUsd(m.valueUsd)}</b>
              </Flash>
            ) : (
              <span className="dim">{t("pos.noAnchor")}</span>
            )
          }
          subs={[
            <Flash v={Number(held.amount0)}>
              <span>
                {fmtAmount(held.amount0, t0.decimals)} {t0.symbol}
              </span>
            </Flash>,
            <Flash v={Number(held.amount1)}>
              <span>
                {fmtAmount(held.amount1, t1.decimals)} {t1.symbol}
              </span>
            </Flash>,
          ]}
        />
        {pos.staked && pos.farm ? (
          // A farm reward is its own token, so it is named rather than assumed
          // to be UP — and it carries no USD line, since the terminal has no
          // price anchor for it.
          <PCell
            k={t("pos.pendingFarmK")}
            v={
              <Flash v={Number(pos.farm.reward)} arrow>
                <span>
                  {fmtAmount(pos.farm.reward, pos.farm.decimals)}{" "}
                  {pos.farm.symbol}
                </span>
              </Flash>
            }
          />
        ) : pos.staked ? (
          <PCell
            k={t("pos.pendingUpK")}
            v={
              <Flash v={Number(pos.earned)} arrow>
                <span>{fmtAmount(pos.earned, 18)} UP</span>
              </Flash>
            }
            subs={
              upUsd !== undefined && pos.earned > 0n
                ? [
                    <span className="amber">
                      ≈ {fmtUsd((Number(pos.earned) / 1e18) * upUsd)}
                    </span>,
                  ]
                : undefined
            }
          />
        ) : (
          <PCell
            k={t("pos.fees")}
            tip={pos.pool.protocol === "home" ? t("pos.levyNote") : undefined}
            v={
              m.feesUsd !== null && m.feesUsd > 0.01 ? (
                <span className="amber">≈ {fmtUsd(m.feesUsd)}</span>
              ) : (
                <span className="dim">{hasFees ? "…" : "—"}</span>
              )
            }
            subs={
              hasFees
                ? [
                    `${fmtAmount(pos.fees0, t0.decimals)} ${t0.symbol}`,
                    `${fmtAmount(pos.fees1, t1.decimals)} ${t1.symbol}`,
                  ]
                : undefined
            }
          />
        )}
        {!limitTag && <EarnCell e={m.earning} label={t("pos.earning")} />}
      </div>

      <RangeBar
        tickLower={pos.tickLower}
        tickUpper={pos.tickUpper}
        tick={curTick}
        sqrtPriceX96={curSqrtP}
        dec0={t0.decimals}
        dec1={t1.decimals}
        sym0={t0.symbol}
        sym1={t1.symbol}
        order={
          limitTag
            ? {
                fillFrac: limitFill,
                sellSym: limitTag.sellSym,
                buySym: limitTag.buySym,
              }
            : undefined
        }
        /* the band is fixed, so what changed since mint is how crowded it got —
           the reads wait until the card has been scrolled to */
        pool={pos.pool}
        upUsd={upUsd}
        wethUsd={wethUsd}
      />

      {limitTag && !pos.staked && pos.liquidity > 0n && (
        <div className="form-row">
          <span
            className={`mono-sm ${limitFill >= 0.999 ? "green" : limitFill > 0 ? "amber" : "dim"}`}
          >
            {t("pos.orderRow", {
              sell: limitTag.sellSym,
              buy: limitTag.buySym,
            })}
          </span>
          <Btn
            busy={busy}
            tone={limitFill >= 0.999 ? "default" : "ghost"}
            onClick={() => decrease(100)}
          >
            {limitFill >= 0.999
              ? t("pos.orderLockIn", { sym: limitTag.buySym })
              : limitFill > 0
                ? t("pos.orderClose")
                : t("pos.orderCancel", { sym: limitTag.sellSym })}
          </Btn>
        </div>
      )}

      {panel === "inc" && !pos.staked && (
        <IncreasePanel
          pos={pos}
          npm={npm}
          t0sym={t0.symbol}
          t1sym={t1.symbol}
          dec0={t0.decimals}
          dec1={t1.decimals}
          user={user}
          busy={busy}
          run={run}
          sqrtP={curSqrtP}
          tick={curTick}
          held={held}
          isOrder={!!limitTag}
          upUsd={upUsd}
          wethUsd={wethUsd}
        />
      )}
      {panel === "dec" && !pos.staked && (
        <div className="expander">
          <div className="form-row">
            <span className="lbl">{t("pos.remove")}</span>
            {[25, 50, 75, 100].map((p) => (
              <Btn key={p} busy={busy} onClick={() => decrease(p)} tone="ghost">
                {p}%
              </Btn>
            ))}
            <span className="dim mono-sm">
              {t(isV4 ? "pos.removeHintV4" : "pos.removeHint", {
                slip: SLIP_BPS / 100,
              })}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- CL pool group (same-pool aggregation) ----------------

/** bucket positions by executable pool identity, preserving sorted order */
function groupByPool(list: ClPosition[]): ClPosition[][] {
  const m = new Map<string, ClPosition[]>();
  for (const p of list) {
    // Every v4 pool shares PoolManager, so its bytes32 PoolId is the only key
    // that keeps unrelated positions from collapsing into one aggregate card.
    const k = poolIdentity(p.pool);
    const g = m.get(k);
    if (g) g.push(p);
    else m.set(k, [p]);
  }
  return [...m.values()];
}

type ClAgg = {
  value: number | null; // Σ underlying USD, excl fees — matches each card's "value"
  feesUsd: number;
  pendingUp: bigint;
  upPerDay: number; // emissions UP/day
  usdPerDay: number; // emissions $ + fee $ (only what we can price)
  aprPct: number | null; // value-weighted blend of every position's daily yield
  stakedSharePct: number; // Σ staked liquidity / this pool's staked liquidity
  stakedCount: number;
  count: number;
};

/** roll a same-pool group up to the numbers its header shows */
function aggregateClGroup(
  positions: ClPosition[],
  metricsOf: (p: ClPosition) => ClMetrics | null | undefined,
): ClAgg {
  let value: number | null = null;
  let feesUsd = 0;
  let pendingUp = 0n;
  let upPerDay = 0;
  let usdPerDay = 0;
  let stakedLiq = 0;
  let stakedCount = 0;
  for (const p of positions) {
    pendingUp += p.earned;
    if (p.staked) {
      stakedCount++;
      stakedLiq += Number(p.liquidity);
    }
    const m = metricsOf(p);
    if (!m) continue;
    if (m.valueUsd !== null) value = (value ?? 0) + m.valueUsd;
    if (m.feesUsd) feesUsd += m.feesUsd;
    if (m.earning.kind === "emissions") {
      upPerDay += m.earning.upPerDay;
      if (m.earning.usdPerDay !== null) usdPerDay += m.earning.usdPerDay;
    } else if (m.earning.kind === "fees") {
      usdPerDay += m.earning.usdPerDay;
    }
  }
  const denom = Number(positions[0].pool.stakedLiquidity);
  return {
    value,
    feesUsd,
    pendingUp,
    upPerDay,
    usdPerDay,
    aprPct:
      value !== null && value > 0 ? ((usdPerDay * 365) / value) * 100 : null,
    stakedSharePct: denom > 0 ? (stakedLiq / denom) * 100 : 0,
    stakedCount,
    count: positions.length,
  };
}

/** aggregated earning cell for a pool group (mirrors EarnCell vocabulary) */
function ClAggEarnCell({ agg, label }: { agg: ClAgg; label: string }) {
  const { t } = useTranslation();
  if (agg.upPerDay <= 0 && agg.usdPerDay <= 0)
    return (
      <PCell k={label} v={<span className="dim">{t("pos.groupIdle")}</span>} />
    );
  const emit =
    agg.upPerDay > 0 ? t("pos.earnEmit", { n: fmtNum(agg.upPerDay, 3) }) : null;
  const subs: ReactNode[] = [];
  if (agg.aprPct !== null && emit) subs.push(emit);
  if (agg.usdPerDay > 0)
    subs.push(t("pos.earnUsdDay", { usd: fmtUsd(agg.usdPerDay) }));
  return (
    <PCell
      k={label}
      v={
        <span>
          <span className="green">● </span>
          {agg.aprPct !== null ? (
            <b>{t("pos.earnApr", { apr: fmtApr(agg.aprPct) })}</b>
          ) : (
            emit
          )}
        </span>
      }
      subs={subs}
    />
  );
}

/** expandable header over 2+ positions in one pool (default expanded). The
    aggregate is computed from metricsOf; the child cards refine themselves. */
export function ClPoolGroup(props: {
  positions: ClPosition[];
  metricsOf: (p: ClPosition) => ClMetrics | null | undefined;
  data: PoolsData;
  xtokens: Record<string, TokenInfo>;
  user: `0x${string}`;
  liveOf: (p: ClPosition) => LiveSlot0 | undefined;
  statOf: (pool: Pool) => PoolStat | undefined;
  upUsd?: number;
  wethUsd?: number | null;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const { positions, data, xtokens } = props;
  const agg = aggregateClGroup(positions, props.metricsOf);
  const pool = positions[0].pool;
  const t0 = xtokens[pool.token0.toLowerCase()] ?? tokenOf(data, pool.token0);
  const t1 = xtokens[pool.token1.toLowerCase()] ?? tokenOf(data, pool.token1);
  // see ClCard: a v4 native side is `address(0)`, and the proof reads bytecode
  const [issuer0, issuer1] = useStockIssuerPair(
    v4BalanceAddress(pool.token0),
    v4BalanceAddress(pool.token1),
  );
  const share = (s: number) => (s < 0.01 ? "<0.01%" : s.toFixed(2) + "%");
  return (
    <div className="pool-group">
      <div
        className={`pool-group-head${open ? " is-open" : ""}`}
        // no role="button": PairAddrs below carries its own controls, and a
        // button would swallow them. Focusable, with the state said out loud.
        tabIndex={0}
        aria-expanded={open}
        onKeyDown={activateOnKey(() => setOpen(!open))}
        onClick={() => {
          if (window.getSelection()?.toString()) return; // a drag-select is a copy, not a toggle
          setOpen(!open);
        }}
      >
        <div className="pg-title">
          <span className="pg-caret">{open ? "▾" : "▸"}</span>
          <PairAddrs
            className="card-title"
            sym0={t0.symbol}
            sym1={t1.symbol}
            token0={pool.token0}
            token1={pool.token1}
            issuer0={issuer0}
            issuer1={issuer1}
            pool={pool.address}
            poolId={pool.protocol === "univ4" ? pool.poolId : undefined}
            hooks={pool.protocol === "univ4" ? pool.hooks : undefined}
          />
          <ProtoBadge proto={pool.protocol} />
          {pool.protocol !== "univ4" && <DexScreenerLink pool={pool.address} />}
          <Badge tone="cyan">
            CL {(effectiveClFeePpm(pool) / 10_000).toFixed(2)}% · ts
            {pool.tickSpacing}
          </Badge>
          <span className="dim mono-sm">
            {t("pos.groupPositions", { n: agg.count })}
            {agg.stakedCount > 0
              ? ` · ${t("pos.groupStakedN", { n: agg.stakedCount })}`
              : ""}
          </span>
        </div>
        <div className="pmetrics compact mono-sm pg-agg">
          <PCell
            k={t("pos.value")}
            v={
              agg.value !== null ? (
                <Flash v={agg.value}>
                  <b>{fmtUsd(agg.value)}</b>
                </Flash>
              ) : (
                <span className="dim">{t("pos.noAnchor")}</span>
              )
            }
            subs={
              agg.feesUsd > 0.01
                ? [
                    <span className="amber">
                      {t("pos.lpValueFees", { usd: fmtUsd(agg.feesUsd) })}
                    </span>,
                  ]
                : undefined
            }
          />
          {agg.pendingUp > 0n && (
            <PCell
              k={t("pos.pendingUpK")}
              v={`${fmtAmount(agg.pendingUp, 18)} UP`}
              subs={
                props.upUsd !== undefined
                  ? [
                      <span className="amber">
                        ≈ {fmtUsd((Number(agg.pendingUp) / 1e18) * props.upUsd)}
                      </span>,
                    ]
                  : undefined
              }
            />
          )}
          <ClAggEarnCell agg={agg} label={t("pos.earning")} />
          {agg.stakedSharePct > 0 && (
            <PCell
              k={t("pos.groupStakedShare")}
              v={share(agg.stakedSharePct)}
            />
          )}
        </div>
      </div>
      {open && (
        <div className="pool-group-body">
          {positions.map((p) => (
            <ClCard
              key={`${p.pool.protocol}-${p.tokenId}`}
              pos={p}
              data={data}
              xtokens={xtokens}
              user={props.user}
              live={props.liveOf(p)}
              stat={props.statOf(p.pool)}
              upUsd={props.upUsd}
              wethUsd={props.wethUsd}
              nested
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function IncreasePanel(props: {
  pos: ClPosition;
  npm: Address; // position manager the NFT lives in (protocol-resolved)
  t0sym: string;
  t1sym: string;
  dec0: number;
  dec1: number;
  user: `0x${string}`;
  busy: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  sqrtP: bigint; // live-aware current price (falls back to the shared pool snapshot)
  tick: number;
  held: { amount0: bigint; amount1: bigint };
  isOrder: boolean;
  /** anchors for the dollar reading — the pool supplies whichever side these don't */
  upUsd?: number;
  wethUsd?: number | null;
}) {
  const { pos, dec0, dec1, sqrtP } = props;
  const { t } = useTranslation();
  const isV4 = pos.pool.protocol === "univ4";
  const hookedV4 = v4HasHooks(pos.pool);
  const [fund, setFund] = useState<"pair" | "zap">(hookedV4 ? "pair" : "zap");
  const [a0, setA0] = useState("");
  const [a1, setA1] = useState("");
  // a v4 currency may be the coin itself, which has no balanceOf to call
  const addr0 = v4BalanceAddress(pos.pool.token0);
  const addr1 = v4BalanceAddress(pos.pool.token1);
  // A v3-family pool names the chain's coin by its wrapper, and pair mode
  // pulls exactly that ERC-20. Read the native balance alongside so a wallet
  // holding the coin can wrap just the shortfall instead of reverting STF.
  const wrapped0 = addr0.toLowerCase() === ADDR.WNATIVE.toLowerCase();
  const wrapped1 = addr1.toLowerCase() === ADDR.WNATIVE.toLowerCase();
  const bal = useBalances(
    props.user,
    wrapped0 || wrapped1 ? [addr0, addr1, NATIVE] : [addr0, addr1],
  );
  // the native side keeps gas back, so MAX still leaves a fundable balance
  const spendable = (a: Address, b?: bigint) =>
    b === undefined
      ? undefined
      : a === NATIVE
        ? b > CHAIN.gasBuffer
          ? b - CHAIN.gasBuffer
          : 0n
        : b;
  const rawBal0 = bal.data?.[addr0.toLowerCase()];
  const rawBal1 = bal.data?.[addr1.toLowerCase()];
  const bal0 = spendable(addr0, rawBal0);
  const bal1 = spendable(addr1, rawBal1);
  const rawNative = bal.data?.[NATIVE.toLowerCase()];
  // the coin the wallet can spare after gas — the wrap budget for a short side
  const nativeSpare =
    rawNative !== undefined
      ? rawNative > CHAIN.gasBuffer
        ? rawNative - CHAIN.gasBuffer
        : 0n
      : undefined;

  const below = props.tick < pos.tickLower; // token0-only
  const above = props.tick >= pos.tickUpper; // token1-only
  const sqrtA = getSqrtRatioAtTick(pos.tickLower);
  const sqrtB = getSqrtRatioAtTick(pos.tickUpper);

  const link = (v: string, editedIs0: boolean) => {
    if (editedIs0) setA0(v);
    else setA1(v);
    try {
      const amt = parseUnits(v === "" ? "0" : v, editedIs0 ? dec0 : dec1);
      const prev = previewDeposit(
        sqrtP,
        pos.tickLower,
        pos.tickUpper,
        amt,
        editedIs0,
      );
      if (!prev) return;
      if (editedIs0)
        setA1(prev.amount1 === 0n ? "0" : trimZeros(fmt(prev.amount1, dec1)));
      else
        setA0(prev.amount0 === 0n ? "0" : trimZeros(fmt(prev.amount0, dec0)));
    } catch {
      /* partial input */
    }
  };

  /* MAX on a pair deposit means the largest top-up the WALLET can fund, not
     the whole of one balance — filling one side to the brim and deriving the
     other lands over the second balance more often than not, and the note
     saying so used to be the end of the road. It is now the way out of it. */
  const takeMax = (limit0?: bigint, limit1?: bigint) => {
    const p = largestFundable(sqrtP, pos.tickLower, pos.tickUpper, limit0, limit1);
    setA0(p.amount0 === 0n ? "0" : trimZeros(fmt(p.amount0, dec0)));
    setA1(p.amount1 === 0n ? "0" : trimZeros(fmt(p.amount1, dec1)));
  };

  const amt0 = safeParse(a0, dec0);
  const amt1 = safeParse(a1, dec1);

  /**
   * What the deposit will actually do with the typed amounts.
   *
   * v3 sizes the liquidity on-chain from the live price, so the typed amounts
   * cap the pull for free. v4 takes the liquidity as an input, so it is sized
   * here against the whole slippage band instead — slightly less liquidity than
   * the live price alone would buy, in exchange for the typed amounts being a
   * hard ceiling on the spend.
   */
  const sim = useMemo(() => {
    if (amt0 === 0n && amt1 === 0n) return null;
    const liq = isV4
      ? v4IncreasePlan({
          sqrtP,
          tickLower: pos.tickLower,
          tickUpper: pos.tickUpper,
          amount0: amt0,
          amount1: amt1,
        })
      : getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, amt0, amt1);
    if (liq === 0n) return null;
    const pull = getAmountsForLiquidity(sqrtP, sqrtA, sqrtB, liq);
    const growPct =
      pos.liquidity > 0n ? Number((liq * 10_000n) / pos.liquidity) / 100 : null;
    return { liq, pull, growPct };
  }, [
    isV4,
    amt0,
    amt1,
    sqrtP,
    sqrtA,
    sqrtB,
    pos.tickLower,
    pos.tickUpper,
    pos.liquidity,
  ]);

  // what the typed amount needs beyond the wrapper already held (max one side
  // can be the wrapper in a pool, so at most one of these is nonzero)
  const short0 =
    wrapped0 && rawBal0 !== undefined && amt0 > rawBal0 ? amt0 - rawBal0 : 0n;
  const short1 =
    wrapped1 && rawBal1 !== undefined && amt1 > rawBal1 ? amt1 - rawBal1 : 0n;
  const wrapTotal = short0 + short1;
  const cover0 = (bal0 ?? 0n) + (wrapped0 ? (nativeSpare ?? 0n) : 0n);
  const cover1 = (bal1 ?? 0n) + (wrapped1 ? (nativeSpare ?? 0n) : 0n);
  const over0 = bal0 !== undefined && amt0 > cover0;
  const over1 = bal1 !== undefined && amt1 > cover1;

  /* A balance that has not been read yet is passed on as undefined — read as
     zero it would bind, and one tap would empty the top-up. */
  const fitToBalances = () =>
    takeMax(
      bal0 === undefined ? undefined : cover0,
      bal1 === undefined ? undefined : cover1,
    );

  const increaseV3 = async () => {
    if (
      amt0 > 0n &&
      !(await ensureAllowance(
        pos.pool.token0,
        props.user,
        props.npm,
        amt0,
        props.t0sym,
      ))
    )
      return false;
    if (
      amt1 > 0n &&
      !(await ensureAllowance(
        pos.pool.token1,
        props.user,
        props.npm,
        amt1,
        props.t1sym,
      ))
    )
      return false;
    // fresh price + band-edge mins (see minAmountsForLiquidity) — avoids 'PSC' reverts
    const fresh = await fetchSqrtPriceX96(pos.pool.address);
    const liq = getLiquidityForAmounts(fresh, sqrtA, sqrtB, amt0, amt1);
    const mins = minAmountsForLiquidity(fresh, sqrtA, sqrtB, liq, SLIP_BPS);
    return !!(await step(
      t("zap.stIncrease", { id: pos.tokenId.toString() }),
      () =>
        writeContract(wagmiConfig, {
          abi: clPmAbi,
          address: props.npm,
          functionName: "increaseLiquidity",
          args: [
            {
              tokenId: pos.tokenId,
              amount0Desired: amt0,
              amount1Desired: amt1,
              amount0Min: mins.amount0Min,
              amount1Min: mins.amount1Min,
              deadline: deadline(),
            },
          ],
          chainId: CHAIN_ID,
        }),
    ));
  };

  const increase = () =>
    props.run(async () => {
      if (amt0 === 0n && amt1 === 0n) return;
      // Both deposit paths below pull the pool's exact currencies. A wallet
      // holding the chain's coin instead of its wrapper would revert at the
      // pull (STF on v3, Permit2 on v4), so wrap just the shortfall first —
      // never the whole typed amount, the wrapper already held is spent too.
      if (wrapTotal > 0n) {
        const wrapped = short0 > 0n ? props.t0sym : props.t1sym;
        const ok = await step(
          t("add.stWrap", {
            amt: fmtAmount(wrapTotal, CHAIN.nativeCurrency.decimals),
            native: CHAIN.nativeCurrency.symbol,
            wrapped,
          }),
          () =>
            writeContract(wagmiConfig, {
              account: props.user,
              abi: wethAbi,
              address: ADDR.WNATIVE,
              functionName: "deposit",
              value: wrapTotal,
              chainId: CHAIN_ID,
            }),
          { invalidate: "balances" },
        );
        if (!ok) return;
      }
      const ok = isV4
        ? await v4Increase({
            pos,
            user: props.user,
            amount0: amt0,
            amount1: amt1,
            symbol0: props.t0sym,
            symbol1: props.t1sym,
          })
        : await increaseV3();
      if (ok) {
        setA0("");
        setA1("");
      }
    });

  if (fund === "zap")
    return (
      <div className="expander">
        <FundSwitch
          fund={fund}
          onFund={setFund}
          zapDisabled={hookedV4}
          zapDisabledTip={hookedV4 ? t("add.mintHintV4Hooks") : undefined}
        />
        <ZapPanel
          target={{
            kind: "cl-increase",
            pool: pos.pool,
            tickLower: pos.tickLower,
            tickUpper: pos.tickUpper,
            tokenId: pos.tokenId,
            npm: props.npm,
          }}
          t0={{ address: pos.pool.token0, symbol: props.t0sym, decimals: dec0 }}
          t1={{ address: pos.pool.token1, symbol: props.t1sym, decimals: dec1 }}
        />
        {props.isOrder && (
          <div className="dim mono-sm">{t("zap.orderGrows")}</div>
        )}
      </div>
    );

  const gasNote = t("pos.incNativeGas", {
    amt: fmtAmount(CHAIN.gasBuffer, CHAIN.nativeCurrency.decimals),
    sym: CHAIN.nativeCurrency.symbol,
  });
  const note0 = above
    ? t("add.aboveNote")
    : over0
      ? t("add.overFit")
      : short0 > 0n
        ? t("add.wrapNote", {
            amt: fmtAmount(short0, CHAIN.nativeCurrency.decimals),
            native: CHAIN.nativeCurrency.symbol,
            wrappedShort: props.t0sym,
          })
        : addr0 === NATIVE
          ? gasNote
          : undefined;
  const note1 = below
    ? t("add.belowNote")
    : over1
      ? t("add.overFit")
      : short1 > 0n
        ? t("add.wrapNote", {
            amt: fmtAmount(short1, CHAIN.nativeCurrency.decimals),
            native: CHAIN.nativeCurrency.symbol,
            wrappedShort: props.t1sym,
          })
        : addr1 === NATIVE
          ? gasNote
          : undefined;

  return (
    <div className="expander">
      {/* The band cannot move — it was fixed at mint — so this draws without
          handles. What it adds over the range bar on the card above is the
          DEPTH: topping up a band that the rest of the pool has crowded into
          buys a smaller share of the same fees than the tick numbers suggest. */}
      <div title={t("pos.incRangeSd")}>
        <LiquidityRange
          pool={pos.pool}
          tickLower={pos.tickLower}
          tickUpper={pos.tickUpper}
          tick={props.tick}
          sqrtPriceX96={sqrtP}
          dec0={dec0}
          dec1={dec1}
          sym0={props.t0sym}
          sym1={props.t1sym}
          upUsd={props.upUsd}
          wethUsd={props.wethUsd}
        />
      </div>
      <FundSwitch
        fund={fund}
        onFund={setFund}
        zapDisabled={hookedV4}
        zapDisabledTip={hookedV4 ? t("add.mintHintV4Hooks") : undefined}
      />
      {hookedV4 && (
        <div className="amber mono-sm">{t("add.mintHintV4Hooks")}</div>
      )}
      <AmountRow
        sym={props.t0sym}
        value={a0}
        onChange={(v) => link(v, true)}
        bal={bal0}
        dec={dec0}
        onMax={() => takeMax(bal0, bal1)}
        maxTip={t("add.maxTip")}
        disabled={above}
        note={note0}
        onNote={over0 && !above ? fitToBalances : undefined}
      />
      <AmountRow
        sym={props.t1sym}
        value={a1}
        onChange={(v) => link(v, false)}
        bal={bal1}
        dec={dec1}
        onMax={() => takeMax(bal0, bal1)}
        maxTip={t("add.maxTip")}
        disabled={below}
        note={note1}
        onNote={over1 && !below ? fitToBalances : undefined}
      />
      <div className="spec">
        <div className="spec-hd">{t("pos.incBtn")}</div>
        {/* the range row is gone: the chart above states the band, and its
            missing handles state that the band is fixed better than a sentence
            about it did — the sentence itself is that chart's title */}
        <div className="spec-row">
          <span className="sk">{t("pos.incSize")}</span>
          <span className="sv">{t("pos.incSizeAny")}</span>
          <span className="sd">
            {below || above ? t("pos.incSizeSdSingle") : t("pos.incSizeSd")}
          </span>
        </div>
        {sim && (
          <>
            <div className="spec-row">
              <span className="sk">{t("pos.incPulls")}</span>
              <span className="sv">
                {fmtAmount(sim.pull.amount0, dec0)} {props.t0sym} +{" "}
                {fmtAmount(sim.pull.amount1, dec1)} {props.t1sym}
              </span>
              <span className="sd">
                {t(isV4 ? "pos.incPullsSdV4" : "pos.incPullsSd")}
              </span>
            </div>
            <div className="spec-row">
              <span className="sk">{t("pos.incNew")}</span>
              <span className="sv">
                {fmtAmount(props.held.amount0 + sim.pull.amount0, dec0)}{" "}
                {props.t0sym} +{" "}
                {fmtAmount(props.held.amount1 + sim.pull.amount1, dec1)}{" "}
                {props.t1sym}
              </span>
              <span className="sd">
                {sim.growPct === null
                  ? t("pos.incNewReseed")
                  : t("pos.incNewGrow", {
                      pct:
                        sim.growPct >= 100
                          ? sim.growPct.toFixed(0)
                          : sim.growPct.toFixed(1),
                    })}
              </span>
            </div>
          </>
        )}
        <div className="spec-row">
          <span className="sk">{t("pos.incFees")}</span>
          <span className="sv">
            {t(isV4 ? "pos.incFeesAppliedV4" : "pos.incFeesKept")}
          </span>
          <span className="sd">
            {t(isV4 ? "pos.incFeesSdV4" : "pos.incFeesSd")}
          </span>
        </div>
        {props.isOrder && (
          <div className="spec-row">
            <span className="sk">{t("pos.incOrder")}</span>
            <span className="sv">{t("pos.incOrderGrows")}</span>
            <span className="sd">{t("pos.incOrderSd")}</span>
          </div>
        )}
      </div>
      <div className="form-row">
        <Btn
          busy={props.busy}
          onClick={increase}
          disabled={!sim || over0 || over1}
        >
          {t("pos.incBtn")}
        </Btn>
        <span className="dim mono-sm">
          {t(isV4 ? "pos.incMinsV4" : "pos.incMins", {
            slip: (isV4 ? V4_DEPOSIT_BAND_BPS : SLIP_BPS) / 100,
          })}
        </span>
      </div>
    </div>
  );
}

// ---------------- v2 ----------------

export function V2Card({
  pos,
  data,
  xtokens = {},
  user,
  stat,
  upUsd,
  wethUsd,
}: {
  pos: V2Position;
  data: PoolsData;
  /** metadata for pair tokens outside the UP33 registry (univ2 pairs) */
  xtokens?: Record<string, TokenInfo>;
  user: `0x${string}`;
  stat?: PoolStat;
  upUsd?: number;
  wethUsd?: number | null;
}) {
  const { t } = useTranslation();
  const t0 =
    xtokens[pos.pool.token0.toLowerCase()] ?? tokenOf(data, pos.pool.token0);
  const t1 =
    xtokens[pos.pool.token1.toLowerCase()] ?? tokenOf(data, pos.pool.token1);
  const [issuer0, issuer1] = useStockIssuerPair(
    pos.pool.token0,
    pos.pool.token1,
  );
  const [busy, setBusy] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const m = v2PosMetrics({
    pos,
    dec0: t0.decimals,
    dec1: t1.decimals,
    stat,
    upUsd,
    wethUsd,
  });

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const stakeAll = () =>
    run(async () => {
      if (pos.pool.gauge)
        await stakeV2Lp(
          pos.pool.address,
          pos.pool.gauge,
          pos.walletLp,
          user,
          `${t0.symbol}/${t1.symbol}`,
        );
    });

  const unstakeAll = () =>
    run(() =>
      step(t("pos.stUnstakeLp", { pair: `${t0.symbol}/${t1.symbol}` }), () =>
        writeContract(wagmiConfig, {
          abi: v2GaugeAbi,
          address: pos.pool.gauge!,
          functionName: "withdraw",
          args: [pos.stakedLp],
          chainId: CHAIN_ID,
        }),
      ),
    );

  const claimUp = () =>
    run(() =>
      step(
        t("pos.stClaimPair", { pair: `${t0.symbol}/${t1.symbol}` }),
        () =>
          writeContract(wagmiConfig, {
            abi: v2GaugeAbi,
            address: pos.pool.gauge!,
            functionName: "getReward",
            args: [user],
            chainId: CHAIN_ID,
          }),
        { onSuccess: offerSwapClaimedUp(user) },
      ),
    );

  const claimFees = () => {
    if (!v2SupportsClaimFees(pos.pool)) return;
    return run(() =>
      step(
        t("pos.stClaimPoolFees", { pair: `${t0.symbol}/${t1.symbol}` }),
        () =>
          writeContract(wagmiConfig, {
            abi: v2PoolAbi,
            address: pos.pool.address,
            functionName: "claimFees",
            chainId: CHAIN_ID,
          }),
      ),
    );
  };

  const remove = (pct: number) =>
    run(async () => {
      const lp = (pos.walletLp * BigInt(Math.round(pct * 100))) / 10_000n;
      if (lp === 0n) {
        txlog.push("err", t("pos.stNoWalletLp"));
        return;
      }
      if (v2UsesRouter02(pos.pool)) {
        // the vanilla router has no quoteRemoveLiquidity — mins come from the
        // pro-rata reserve share, same tolerance as the up33 path
        const expect0 = (lp * pos.pool.reserve0) / pos.pool.totalSupply;
        const expect1 = (lp * pos.pool.reserve1) / pos.pool.totalSupply;
        const router = v2LiquidityRouter(pos.pool);
        if (!(await ensureAllowance(pos.pool.address, user, router, lp, "LP")))
          return;
        const call = buildV2RemoveLiquidityCall(pos.pool, {
          liquidity: lp,
          amount0Min: applySlippage(expect0, SLIP_BPS),
          amount1Min: applySlippage(expect1, SLIP_BPS),
          recipient: user,
          deadline: deadline(),
        });
        await step(
          t("pos.stRemoveLp", { pct, pair: `${t0.symbol}/${t1.symbol}` }),
          () =>
            sendTransaction(wagmiConfig, {
              to: call.address,
              data: call.data,
              chainId: CHAIN_ID,
            }),
        );
        setRemoveOpen(false);
        return;
      }
      const quote = await readContract(wagmiConfig, {
        abi: v2RouterAbi,
        address: ADDR.V2_ROUTER,
        functionName: "quoteRemoveLiquidity",
        args: [
          pos.pool.token0,
          pos.pool.token1,
          pos.pool.stable,
          ADDR.V2_FACTORY,
          lp,
        ],
        chainId: CHAIN_ID,
      });
      if (
        !(await ensureAllowance(
          pos.pool.address,
          user,
          ADDR.V2_ROUTER,
          lp,
          "LP",
        ))
      )
        return;
      const call = buildV2RemoveLiquidityCall(pos.pool, {
        liquidity: lp,
        amount0Min: applySlippage(quote[0], SLIP_BPS),
        amount1Min: applySlippage(quote[1], SLIP_BPS),
        recipient: user,
        deadline: deadline(),
      });
      await step(
        t("pos.stRemoveLp", { pct, pair: `${t0.symbol}/${t1.symbol}` }),
        () =>
          sendTransaction(wagmiConfig, {
            to: call.address,
            data: call.data,
            chainId: CHAIN_ID,
          }),
      );
      setRemoveOpen(false);
    });

  const gaugeOk = !!pos.pool.gauge && pos.pool.gaugeAlive;
  const hasFees =
    v2SupportsClaimFees(pos.pool) &&
    (pos.claimable0 > 0n || pos.claimable1 > 0n);

  return (
    <div className="card">
      <div className="card-head">
        <PairAddrs
          className="card-title"
          sym0={t0.symbol}
          sym1={t1.symbol}
          token0={pos.pool.token0}
          token1={pos.pool.token1}
          issuer0={issuer0}
          issuer1={issuer1}
          pool={pos.pool.address}
        />
        {/* no ProtoBadge on this card — the cyan badge below is the v2 identity,
            so the DS jump keeps its slot right of the marks */}
        <DexScreenerLink pool={pos.pool.address} />
        <Badge tone="cyan">
          {pos.pool.protocol === "univ2"
            ? "uni v2"
            : pos.pool.stable
              ? "v2 stable"
              : "v2 volatile"}{" "}
          · {(pos.pool.feeBps / 100).toFixed(2)}%
        </Badge>
        <a
          className="dim mono-sm"
          href={`${EXPLORER}/address/${pos.pool.address}`}
          target="_blank"
          rel="noreferrer"
        >
          {shortAddr(pos.pool.address)}↗
        </a>
        <div className="card-actions">
          {gaugeOk && pos.walletLp > 0n && (
            <Btn busy={busy} onClick={stakeAll}>
              {t("pos.v2StakeAll")}
            </Btn>
          )}
          {/* Both actions below are GAUGE calls. LP staked into a pid-keyed farm
              (Pancake's MasterChefV2) has no gauge to withdraw from — that path
              takes (pid, amount) on the farm — so it is shown and not offered
              an action that would revert. Same contract the CL card keeps. */}
          {pos.stakedLp > 0n && pos.pool.gauge && (
            <Btn busy={busy} onClick={unstakeAll} tone="ghost">
              {t("pos.v2UnstakeAll")}
            </Btn>
          )}
          {pos.earned > 0n && (
            <Btn busy={busy} onClick={claimUp}>
              {t("pos.claimUp")}
            </Btn>
          )}
          {hasFees && (
            <Btn busy={busy} onClick={claimFees}>
              {t("pos.v2ClaimFees")}
            </Btn>
          )}
          {pos.walletLp > 0n && (
            <Btn
              busy={busy}
              onClick={() => setRemoveOpen(!removeOpen)}
              tone="danger"
            >
              {t("pos.remove")}
            </Btn>
          )}
        </div>
      </div>

      <div className="pmetrics mono-sm">
        <PCell
          k={t("pos.value")}
          v={
            m.valueUsd !== null ? (
              <b>{fmtUsd(m.valueUsd)}</b>
            ) : (
              <span className="dim">{t("pos.noAnchor")}</span>
            )
          }
          subs={[
            `${fmtAmount(pos.amount0, t0.decimals)} ${t0.symbol}`,
            `${fmtAmount(pos.amount1, t1.decimals)} ${t1.symbol}`,
          ]}
        />
        <PCell
          k={t("pos.v2Lp")}
          v={fmtAmount(pos.stakedLp + pos.walletLp, 18)}
          subs={[
            pos.farm
              ? t("pos.v2StakedFarm", { n: fmtAmount(pos.stakedLp, 18) })
              : t("pos.v2Staked", { n: fmtAmount(pos.stakedLp, 18) }),
            t("pos.v2Wallet", { n: fmtAmount(pos.walletLp, 18) }),
          ]}
        />
        {pos.earned > 0n && (
          <PCell
            k={t("pos.pendingUpK")}
            v={`${fmtAmount(pos.earned, 18)} UP`}
            subs={
              upUsd !== undefined
                ? [
                    <span className="amber">
                      ≈ {fmtUsd((Number(pos.earned) / 1e18) * upUsd)}
                    </span>,
                  ]
                : undefined
            }
          />
        )}
        {pos.farm && pos.farm.reward > 0n && (
          // A farm reward is its own token, named rather than assumed to be UP,
          // and with no USD line because the terminal has no anchor for it.
          <PCell
            k={t("pos.pendingFarmK")}
            v={`${fmtAmount(pos.farm.reward, pos.farm.decimals)} ${pos.farm.symbol}`}
          />
        )}
        {hasFees && (
          <PCell
            k={t("pos.v2Claimable")}
            v={
              m.feesUsd !== null && m.feesUsd > 0.01 ? (
                <span className="amber">≈ {fmtUsd(m.feesUsd)}</span>
              ) : (
                <span className="dim">…</span>
              )
            }
            subs={[
              `${fmtAmount(pos.claimable0, t0.decimals)} ${t0.symbol}`,
              `${fmtAmount(pos.claimable1, t1.decimals)} ${t1.symbol}`,
            ]}
          />
        )}
        {m.staked && (
          <EarnCell
            e={m.staked}
            v2
            label={m.wallet ? t("pos.earningStaked") : t("pos.earning")}
          />
        )}
        {m.wallet && (
          <EarnCell
            e={m.wallet}
            v2
            label={m.staked ? t("pos.earningWallet") : t("pos.earning")}
          />
        )}
      </div>

      {removeOpen && (
        <div className="expander">
          <div className="form-row">
            <span className="lbl">{t("pos.remove")}</span>
            {[25, 50, 75, 100].map((p) => (
              <Btn key={p} busy={busy} onClick={() => remove(p)} tone="ghost">
                {p}%
              </Btn>
            ))}
            <span className="dim mono-sm">
              {t("pos.v2RemoveOf")}
              {pos.stakedLp > 0n
                ? ` ${pos.farm ? t("pos.v2RemoveFarmNote") : t("pos.v2RemoveStakedNote")}`
                : ""}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- helpers ----------------

/** one metrics cell: small uppercase label, prominent primary value, dim
 *  stacked sub-lines. The card body and group header both speak this. */
function PCell(props: {
  k: ReactNode;
  tip?: string;
  v: ReactNode;
  subs?: ReactNode[];
}) {
  return (
    <div className="pcell">
      <span className="k" title={props.tip}>
        {props.k}
      </span>
      <span className="v">{props.v}</span>
      {props.subs?.map((s, i) => (
        <span key={i} className="sub">
          {s}
        </span>
      ))}
    </div>
  );
}

/** "what is this position earning right now" as a cell: primary = APR (or the
 *  colored idle/stalled state), subs = accrual rates. Color carries STATE only
 *  (green dot = actively earning, red = stalled, amber = paused); the
 *  pool-share detail lives in the label tooltip. */
function EarnCell({
  e,
  v2,
  label,
}: {
  e: Earning;
  v2?: boolean;
  label: string;
}) {
  const { t } = useTranslation();
  const share = (s: number) => (s < 0.01 ? "<0.01%" : s.toFixed(2) + "%");
  switch (e.kind) {
    case "emissions": {
      const emit = t("pos.earnEmit", { n: fmtNum(e.upPerDay, 3) });
      const subs: ReactNode[] = e.aprPct !== null ? [emit] : [];
      if (e.usdPerDay !== null)
        subs.push(t("pos.earnUsdDay", { usd: fmtUsd(e.usdPerDay) }));
      return (
        <PCell
          k={label}
          tip={
            v2
              ? t("pos.earnShareGauge", { share: share(e.sharePct) })
              : t("pos.earnShareStaked", { share: share(e.sharePct) })
          }
          v={
            <span>
              <span className="green">● </span>
              {e.aprPct !== null ? (
                <b>{t("pos.earnApr", { apr: fmtApr(e.aprPct) })}</b>
              ) : (
                emit
              )}
            </span>
          }
          subs={subs}
        />
      );
    }
    case "emissions-idle":
      return (
        <PCell
          k={label}
          tip={
            e.reason === "out-of-range" ? t("pos.earnOutStakedTip") : undefined
          }
          v={
            e.reason === "out-of-range" ? (
              <span className="red">● {t("pos.earnOutStaked")}</span>
            ) : (
              <span className="amber">● {t("pos.earnEnded")}</span>
            )
          }
        />
      );
    case "fees": {
      const subs: ReactNode[] = [
        t("pos.earnUsdDay", { usd: fmtUsd(e.usdPerDay) }),
      ];
      if (!v2) subs.push(t("pos.earnWhileInRange"));
      return (
        <PCell
          k={label}
          tip={
            v2
              ? t("pos.earnSharePool", { share: share(e.sharePct) })
              : t("pos.earnShareActive", { share: share(e.sharePct) })
          }
          v={
            <span>
              <span className="green">● </span>
              <b>
                {t("pos.earnFeeApr")} {fmtApr(e.aprPct)}
              </b>
            </span>
          }
          subs={subs}
        />
      );
    }
    case "fees-unknown":
      return (
        <PCell
          k={label}
          v={<span className="dim">{t("pos.earnUnknown")}</span>}
        />
      );
    case "out-of-range":
      return (
        <PCell
          k={label}
          v={<span className="red">● {t("pos.earnOut")}</span>}
        />
      );
    case "empty":
      return (
        <PCell
          k={label}
          v={<span className="dim">{t("pos.earnEmpty")}</span>}
        />
      );
  }
}

import { formatUnits } from "viem";

function fmt(v: bigint, dec: number): string {
  return formatUnits(v, dec);
}
function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
function safeParse(s: string, dec: number): bigint {
  try {
    return parseUnits(s === "" ? "0" : s, dec);
  } catch {
    return 0n;
  }
}
