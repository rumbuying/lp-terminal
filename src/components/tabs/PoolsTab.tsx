import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Trans, useTranslation } from "react-i18next";
import { useAccount } from "wagmi";
import { readContract, sendTransaction, writeContract } from "wagmi/actions";
import {
  formatUnits,
  parseUnits,
  zeroAddress,
  type TransactionReceipt,
} from "viem";
import { v2RouterAbi, wethAbi } from "../../abi";
import {
  ADDR,
  CHAIN_ID,
  NATIVE,
  UNI,
  WEEK,
} from "../../config/addresses";
import { CHAIN } from "../../config/chains";
import {
  STOCK_ISSUERS,
  type StockIssuerId,
} from "../../config/chains/stockIssuers";
import { FEATURES } from "../../config/features";
import { wagmiConfig } from "../../config/wagmi";
import {
  alignTick,
  applySlippage,
  fullRangeTicks,
  getLiquidityForAmounts,
  getSqrtRatioAtTick,
  minAmountsForLiquidity,
  sqrtPriceToPrice,
  tickDeltaForPct,
} from "../../lib/clmath";
import {
  largestFundable,
  pairFrom,
  pairLiquidity,
  refitToBand,
  type Pair,
} from "../../lib/clDeposit";
import {
  emitAprOf,
  feeAprOf,
  feesOf,
  fmtApr,
  simulateClAdd,
  simulateV2Add,
  stakedShareOf,
  volumeOf,
  volumeWindowLabel,
  type VolumeWindow,
} from "../../lib/apr";
import {
  clampWidth,
  displayWidth,
  fmtAmount,
  fmtCompact,
  fmtCompactAmount,
  fmtNum,
  fmtUsd,
  nowSec,
  shortAddr,
} from "../../lib/format";
import {
  effectiveClFeePpm,
  mergePoolsByIdentity,
  poolIdentity,
} from "../../lib/poolIdentity";
import { poolStatWithFallback } from "../../lib/poolStatFallback";
import { pairSquats } from "../../lib/knownToken";
import { orientPair, pairSide } from "../../lib/pairSide";
import {
  takeRecommendationPrefill,
  type RecommendationPrefill,
} from "../../lib/recommendationPrefill";
import { tradePanelTab, type TradeTab } from "../../lib/tradePanelPref";
import { shouldDiscoverPositionsInPools } from "../../lib/positionLifecycle";
import {
  buildClMintCall,
  buildV2AddLiquidityCall,
  clLiquidityNpm,
  v2LiquidityRouter,
  v2UsesRouter02,
} from "../../lib/liquidityCalls";
import type { V23CatalogFilter } from "../../lib/uniIndex";
import { HAS_V4_POOL_CATALOG, v4PoolStats } from "../../lib/uniV4Pools";
import {
  deadline,
  ensureAllowance,
  fetchSqrtPriceX96,
  invalidateTransactionState,
  receivedOf,
  step,
} from "../../lib/tx";
import { txlog } from "../../lib/txlog";
import { autostake } from "../../lib/autostake";
import { poolStakeable } from "../../lib/zap";
import { stakeClNft, stakeV2Lp, mintedTokenId } from "../../lib/stake";
import { v4BalanceAddress, v4HasHooks, v4IncreasePlan } from "../../lib/uniV4";
import { mergeTokenInfoWithVerifiedV4 } from "../../lib/uniV4Positions";
import { v4Deposit } from "../../lib/uniV4Write";
import { useBalances } from "../../hooks/useBalances";
import { usePositions } from "../../hooks/usePositions";
import { useDsFallbackStats, usePoolStats } from "../../hooks/usePoolStats";
import { useUpPrice } from "../../hooks/useUpPrice";
import type { PoolStat } from "../../lib/poolstats";
import { poolTypeLabel, tokenOf, usePools } from "../../hooks/usePools";
import { useUniPools } from "../../hooks/useUniPools";
import { useUniV4Pools } from "../../hooks/useUniV4Pools";
import {
  useStockIssuerPair,
  useStockIssuers,
  type StockIssuerMap,
} from "../../hooks/useStockIssuers";
import {
  useLaunchpadPair,
  useLaunchpadTokens,
  type LaunchpadTokenMap,
} from "../../hooks/useLaunchpadTokens";
import { usePoolGroups } from "../../hooks/usePoolGroups";
import { useNarrowLayout } from "../../hooks/useMediaQuery";
import type { PoolGroup, PoolGroupSort } from "../../lib/poolGroups";
import type { LaunchpadReleaseId } from "../../config/chains/launchpad";
import type { ClPool, Pool, PoolsData, TokenInfo, V2Pool } from "../../types";
import { AddStats } from "../AddStats";
import { DexScreenerLink } from "../DexScreenerLink";
import { Flash } from "../Flash";
import { Modal } from "../Modal";
import { PairAddrs, SYMBOL_COLUMNS } from "../PairAddrs";
import { ProtoBadge } from "../ProtoBadge";
import { SquatBadge, TokenSymbol } from "../TokenIdentity";
import { LaunchpadBadge } from "../LaunchpadBadge";
import { PairAvatars, TokenAvatar } from "../TokenAvatar";
import { SwapTab } from "./SwapTab";
import { LiquidityRange } from "../LiquidityRange";
import { StakeAfterToggle } from "../StakeAfterToggle";
import { ZapPanel } from "../ZapPanel";
import { AmountRow, Btn, NumInput, activateOnKey, rowToggleProps } from "../ui";

const SLIP_BPS = 100;

type SortKey = "vol" | "fees24" | "tvl" | "feeApr" | "rewards" | null;

/**
 * What the market list is filtered BY — which is now a question about the
 * assets, not about the venue.
 *
 * The chips above this table used to name protocols: UNI V2, UNI V3, PANCAKE.
 * That was the right question when the terminal's job was to find every pool on
 * a chain, and it is the wrong one now: nobody arrives wanting "a v3 pool", they
 * arrive wanting a market in something. Which factory minted the pool is still
 * on every row (ProtoBadge) and still decides how a deposit is built — it is
 * just not what a landing page should be sorted into.
 *
 * Both alternatives to ALL are PROVEN properties of the token, read off the
 * chain: the launchpad's CREATE2 derivation (lib/launchpadToken.ts) and the
 * issuer's proxy anchor (lib/stockToken.ts). A chain that can prove neither
 * shows the chips it can, and a chain that can prove nothing shows no chips at
 * all rather than an inert row of them.
 */
type MarketFilter =
  | "all"
  | "launchpad"
  | `launchpad:${LaunchpadReleaseId}`
  | `stock:${StockIssuerId}`;

/**
 * The origin a chip is asking the CATALOG about, or null when it is not asking.
 *
 * ALL is a flat list of markets and has no origin to group by. A release
 * sub-chip narrows to a launcher generation, which the catalog cannot yet tell
 * apart — the proof is a CREATE2 derivation the browser does — so it asks for
 * the launchpad and the client narrows the answer, which is the same shape the
 * flat list always used.
 */
function originOf(market: MarketFilter): string | null {
  if (market.startsWith("launchpad")) return "launchpad";
  if (market.startsWith("stock:")) return market;
  return null;
}

/**
 * The column the CATALOG can rank whole tokens by, for the column this table is
 * sorted on.
 *
 * Every key but REWARDS maps across, because every one of them is derivable
 * from figures the group aggregate already holds. Rewards is not: emissions
 * belong to one pool's gauge, and a token is not one pool — so that header
 * stops offering a sort while the rows are tokens, rather than highlighting and
 * reordering nothing.
 */
function groupSortOf(sort: SortKey): PoolGroupSort {
  return sort === "vol" || sort === "feeApr" ? sort : sort === "fees24" ? "fees" : "tvl";
}

/** whether a column can be sorted on while the rows are tokens, not pools */
const GROUPED_SORTABLE: ReadonlySet<Exclude<SortKey, null>> = new Set([
  "tvl",
  "vol",
  "fees24",
  "feeApr",
]);

const LAUNCHPAD = CHAIN.launchpad;
/** the release sub-filters, in the config's oldest-first order */
const LAUNCHPAD_RELEASES = LAUNCHPAD?.releases ?? [];
/* A grouped row names ONE token where a pool row names two, so it may spend
   what a whole pair spends and still leave the column exactly as wide. */
const GROUP_NAME_COLUMNS = SYMBOL_COLUMNS * 2;
// A chain that reserves no symbol has nothing to contradict, so the control and
// the filter behind it are absent rather than present-and-inert.
const HAS_KNOWN_TOKENS = CHAIN.knownTokens.length > 0;

/** the issuers this chain can actually prove, in config order, deduplicated */
const CHAIN_ISSUERS: StockIssuerId[] = [
  ...new Set(CHAIN.stockIssuers.map((a) => a.issuer)),
];

/**
 * Whether a v4 row has to prove where it came from before it is listed.
 *
 * On a chain whose v4 markets ARE the launchpad's, an unproven v4 row is a pool
 * somebody opened directly against the singleton — permissionless, unpriced and
 * indistinguishable from the deep ones by name alone. Those are held back until
 * the rest of the v4 surface is worth browsing on its own terms. The pool is not
 * hidden from anyone who knows it: a searched address still reaches it, exactly
 * like the dust and squat filters, and holding a position in one always wins.
 */
const V4_NEEDS_LAUNCHPAD = LAUNCHPAD !== null;

/**
 * The equity issuer this pool is a market IN, if either side proves one.
 *
 * Either side, because the pair is symmetric and a stock token can be quoted in
 * anything — including, on a chain with two issuers, another stock token. The
 * first proven side answers, which is enough for a filter that asks "is this an
 * X market" rather than "which of the two is X".
 */
function issuerOf(pool: Pool, proven: StockIssuerMap): StockIssuerId | null {
  return (
    proven.get(v4BalanceAddress(pool.token0).toLowerCase()) ??
    proven.get(v4BalanceAddress(pool.token1).toLowerCase()) ??
    null
  );
}

/**
 * The launcher generation this pool is a market for, if either side proves one.
 *
 * Either side and first-proven-wins, exactly like `issuerOf` — a launchpad token
 * is quoted in something, and on this chain it is increasingly quoted in another
 * launchpad token. A side minted straight off the factory proves a launchpad but
 * no generation, so it answers null and lands in the parent chip only.
 */
function releaseOf(pool: Pool, proven: LaunchpadTokenMap): LaunchpadReleaseId | null {
  return (
    proven.get(v4BalanceAddress(pool.token0).toLowerCase())?.release ??
    proven.get(v4BalanceAddress(pool.token1).toLowerCase())?.release ??
    null
  );
}

// Top-level tabs unmount; retain only the browsing choices for this session.
let rememberedSort: SortKey = "vol";
let rememberedMarket: MarketFilter = "all";
let rememberedVolumeWindow: VolumeWindow = "h24";
const VOLUME_WINDOWS: readonly VolumeWindow[] = ["m5", "h1", "h6", "h24"];

export function PoolsTab() {
  const { t } = useTranslation();
  // Too narrow for the two panes to sit side by side. Above this the panel is a
  // column; below it the panel is a sheet, and the market list keeps the page.
  const sheet = useNarrowLayout();
  const pools = usePools();
  const stats = usePoolStats();
  const upPrice = useUpPrice();
  const { address: user } = useAccount();
  // Recommendations cross a top-level tab boundary. Consume the one-shot
  // handoff exactly once when POOLS mounts, then use the canonical pool
  // identity (PoolId for v4, contract address otherwise) for both catalog
  // lookup and selection.
  const [recommendation] = useState<RecommendationPrefill | null>(() =>
    takeRecommendationPrefill(),
  );
  const recommendationId = (
    recommendation?.poolId ?? recommendation?.pool ?? ""
  ).toLowerCase();
  const [q, setQ] = useState(recommendationId); // one input: filters home locally + queries both catalogs
  // The row the trade panel is pointed at, by pool identity rather than by
  // object: the catalog re-fetches underneath this and hands back a new object
  // for the same pool, and a selection that broke on a refresh would clear the
  // form mid-trade.
  const [openId, setOpenId] = useState<string | null>(recommendationId || null);
  const [sort, setSortState] = useState<SortKey>(rememberedSort);
  const [volumeWindow, setVolumeWindowState] = useState<VolumeWindow>(rememberedVolumeWindow);
  const [onlyMine, setOnlyMine] = useState(false);
  // Pool browsing is public data. The expensive wallet-wide position scan is
  // activated only when the user explicitly asks for MY POOLS; a fresh result
  // left by POSITIONS can still render immediately from the shared query cache.
  const positions = usePositions(user, {
    enabled: shouldDiscoverPositionsInPools(onlyMine),
  });
  const [market, setMarketState] = useState<MarketFilter>(rememberedMarket);
  const [uniQuery, setUniQuery] = useState(recommendationId); // '' = useful catalog front pages; text/address/id = indexed search
  const [hideDust, setHideDust] = useState(!recommendation); // most long-tail factory catalogs are <$1k dust
  // Pools whose token wears a name belonging to another contract. Hidden by
  // default because a landing page sorted by volume is exactly where a
  // "USDC/WBNB" row that is not USDC does its work — but only hidden, never
  // dropped: the count below says how many went, the chip brings them back,
  // and searching reaches them regardless.
  const [hideSquat, setHideSquat] = useState(true);
  // APR explainer popover, anchored under the ⓘ that opened it (fixed: the
  // sticky thead is its own stacking context, so the pop must live outside)
  const [aprInfo, setAprInfo] = useState<{ top: number; right: number } | null>(
    null,
  );
  // Every venue is fetched, always. The chips no longer name one, and narrowing
  // the catalog query by protocol would now be answering a question nobody
  // asked — a market in a token is a market wherever the pool happens to live.
  const indexProto: V23CatalogFilter | undefined = undefined;
  const wantsV23 = true;
  const wantsV4 = HAS_V4_POOL_CATALOG;
  const uni = useUniPools(
    uniQuery,
    // Dust is a landing-page preference, never a search constraint. Otherwise
    // an exact authentic address with state not yet priced would disappear.
    hideDust && !uniQuery ? 1_000 : 0,
    indexProto,
    wantsV23,
  );
  const v4 = useUniV4Pools(uniQuery, wantsV4);
  // An origin chip is a question about the CATALOG — which tokens did this
  // launcher mint, which shares did this issuer sign — and the catalog answers
  // it directly. A typed query is the other kind of question ("find me this
  // one"), which the flat list above already answers, so grouping stands down.
  const origin = originOf(market);
  const originLabel = market.startsWith("stock:")
    ? (STOCK_ISSUERS[market.slice("stock:".length) as StockIssuerId]?.label ?? market)
    : (LAUNCHPAD?.label ?? market);
  // Grouping is the default wherever it is meaningful, and meaningful means an
  // origin chip: those are the only rows that ARE a token. FLAT turns it off
  // for someone comparing individual markets rather than issuers.
  const [flat, setFlat] = useState(false);
  const grouping = origin !== null && !q.trim() && !flat;
  const groups = usePoolGroups(origin, groupSortOf(sort), hideDust ? 1_000 : 0, grouping);
  // Group totals come from the server's 24H aggregate. Flat rows carry every
  // rolling window, so only they follow the user's window switch.
  const effectiveVolumeWindow: VolumeWindow = grouping ? "h24" : volumeWindow;
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const v4Stats = useMemo(
    () => v4PoolStats(v4.data, stats.data?.wethUsd),
    [v4.data, stats.data?.wethUsd],
  );
  const catalogPools = useMemo(
    () => [...(uni.data?.pools ?? []), ...(v4.data?.pools ?? [])],
    [uni.data, v4.data],
  );
  const filterRef = useRef<HTMLInputElement>(null);
  const setSort = (next: SortKey) => {
    rememberedSort = next;
    setSortState(next);
  };
  const setVolumeWindow = (next: VolumeWindow) => {
    rememberedVolumeWindow = next;
    setVolumeWindowState(next);
  };
  const setMarket = (next: MarketFilter) => {
    rememberedMarket = next;
    setMarketState(next);
  };

  // typing filters the local list instantly; the catalog query follows 350ms behind
  useEffect(() => {
    const id = setTimeout(() => setUniQuery(q.trim()), 350);
    return () => clearTimeout(id);
  }, [q]);

  useEffect(() => {
    if (recommendation) tradePanelTab.set("liquidity");
  }, [recommendation]);

  useEffect(() => {
    if (!user) setOnlyMine(false);
  }, [user]);

  // "/" focuses the filter — terminal habit
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return;
      if (e.key === "/") {
        e.preventDefault();
        filterRef.current?.focus();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const heldV4Pools = useMemo(() => {
    const byId = new Map<string, ClPool>();
    for (const pos of positions.data?.cl ?? [])
      if (pos.pool.protocol === "univ4")
        byId.set(poolIdentity(pos.pool), pos.pool);
    return [...byId.values()];
  }, [positions.data]);

  const mySet = useMemo(() => {
    const s = new Set<string>();
    positions.data?.cl.forEach((p) => s.add(poolIdentity(p.pool)));
    positions.data?.v2.forEach((p) => s.add(poolIdentity(p.pool)));
    return s;
  }, [positions.data]);

  // stats resolve in three layers: home primary (dexscreener CL + optional v2
  // subgraph) → self-hosted uniswap catalogs (including v4 raw accounting) → dexscreener
  // backstop for rows still missing a number (geckoterminal only tracks its
  // listed subset — measured 53 of the top-200 TVL rows). Field-level merge so
  // the indexer's chain-derived TVL keeps priority over dexscreener's estimate.
  const dsFallbackAddrs = useMemo(() => {
    if (!stats.data) return []; // wait for the primary pass — else the first render batches the whole catalog
    const byPool = stats.data.byPool;
    const uniStats = uni.data?.stats;
    const out: string[] = [];
    for (const p of [...(pools.data?.pools ?? []), ...catalogPools]) {
      // Every v4 row lives at PoolManager; that singleton is not a DexScreener
      // pair address, and batching it would collide every v4 pool into one row.
      if (p.protocol === "univ4") continue;
      const a = p.address.toLowerCase();
      const s = byPool[a] ?? uniStats?.[a];
      if (!s || s.vol24hUsd == null || s.liqUsd == null) out.push(a);
      if (out.length >= 90) break; // 3 batched calls — rows past the cap keep their "—"
    }
    return out;
  }, [pools.data, catalogPools, uni.data, stats.data]);
  const dsFb = useDsFallbackStats(dsFallbackAddrs);
  const mergedStats = useMemo(() => {
    const byPool = stats.data?.byPool;
    const uniStats = uni.data?.stats;
    // The grouped catalog is keyed the way pools are identified — PoolId for
    // v4, address otherwise — so its figures drop straight in.
    const out: Record<string, PoolStat> = { ...groups.data?.stats };
    for (const p of [
      ...(pools.data?.pools ?? []),
      ...catalogPools,
      ...heldV4Pools,
    ]) {
      const a = p.address.toLowerCase();
      const id = poolIdentity(p);
      const base =
        p.protocol === "univ4" ? v4Stats[id] : (byPool?.[a] ?? uniStats?.[a]);
      const fb = p.protocol === "univ4" ? undefined : dsFb.data?.[a];
      const s = poolStatWithFallback(base, fb);
      if (s) out[id] = s;
    }
    return out;
  }, [
    pools.data,
    catalogPools,
    heldV4Pools,
    uni.data,
    v4Stats,
    stats.data,
    dsFb.data,
    groups.data,
  ]);
  const statOf = (p: Pool) => mergedStats[poolIdentity(p)];

  // The indexer supplies the v4 directory; held rows still come last so their
  // freshly chain-read StateView snapshot replaces a cached catalog row.
  const data: PoolsData | null = useMemo(
    () =>
      pools.data
        ? {
            ...pools.data,
            // Position discovery may contribute metadata for held-only pools,
            // but the V4 catalog's strict chain proof must win any shared-token
            // collision.
            tokens: mergeTokenInfoWithVerifiedV4(
              [
                pools.data.tokens,
                uni.data?.tokens,
                positions.data?.tokens,
                groups.data?.tokens,
              ],
              v4.data?.tokens,
            ),
          }
        : null,
    [pools.data, uni.data, positions.data, v4.data, groups.data],
  );

  // Two passes, because the second one needs the chain's answer about the first.
  // CANDIDATES is everything the browsing filters keep — search, dust, squats,
  // MY POOLS — and it is also exactly the set whose tokens are worth asking the
  // launchpad factory about. The market filter then runs over that answer.
  const { candidates, squatHidden } = useMemo(() => {
    if (!data || !pools.data) return { candidates: [] as Pool[], squatHidden: 0 };
    let hidden = 0;
    const kept = mergePoolsByIdentity(
      pools.data.pools,
      catalogPools,
      heldV4Pools,
    ).filter((p) => {
      const id = poolIdentity(p);
      if (onlyMine && !mySet.has(id)) return false;
      // A side wearing a name that belongs to another contract on this chain.
      // Same two exemptions the dust filter earns, for the same reasons: a HELD
      // pool is never hidden from its owner whatever we think of its tokens, and
      // a typed query is a request for a specific thing rather than a browse —
      // paste the squatting token's address and you still find it.
      if (
        HAS_KNOWN_TOKENS &&
        hideSquat &&
        !q.trim() &&
        !mySet.has(id) &&
        pairSquats(
          CHAIN.knownTokens,
          tokenOf(data, p.token0),
          tokenOf(data, p.token1),
        )
      ) {
        hidden++;
        return false;
      }
      // v2/v3 dust is filtered server-side. V4 TVL is recomputed locally from the
      // indexer's raw token amounts and trusted BNB/USDT anchors, so its threshold
      // belongs here. Never hide a held row: it remains the fault-tolerant entry point.
      if (
        hideDust &&
        !q.trim() &&
        p.protocol === "univ4" &&
        !mySet.has(id) &&
        (mergedStats[id]?.liqUsd ?? 0) < 1_000
      )
        return false;
      const localQuery = q.trim().toLowerCase();
      if (!localQuery || localQuery === "*") return true;
      // Catalog rows already arrived query-matched. Home and held-v4 rows did not.
      if (p.protocol !== "home" && p.protocol !== "univ4") return true;
      const sym0 = tokenOf(data, p.token0).symbol.toLowerCase();
      const sym1 = tokenOf(data, p.token1).symbol.toLowerCase();
      const compactQuery = localQuery.replace(/\s+/g, "");
      const labels =
        `${sym0}/${sym1} ${sym1}/${sym0} ${p.token0} ${p.token1} ${poolTypeLabel(p)} ${id}`.toLowerCase();
      return labels.includes(compactQuery);
    });
    if (!sort) return { candidates: kept, squatHidden: hidden };
    const stat = (p: Pool) => mergedStats[poolIdentity(p)];
    const sorted = [...kept].sort((a, b) => {
      if (sort === "vol")
        return (volumeOf(stat(b), effectiveVolumeWindow) ?? -1) - (volumeOf(stat(a), effectiveVolumeWindow) ?? -1);
      if (sort === "fees24")
        return (feesOf(b, stat(b), effectiveVolumeWindow) ?? -1) - (feesOf(a, stat(a), effectiveVolumeWindow) ?? -1);
      if (sort === "tvl") return (stat(b)?.liqUsd ?? -1) - (stat(a)?.liqUsd ?? -1);
      if (sort === "feeApr")
        return (feeAprOf(b, stat(b), effectiveVolumeWindow) ?? -1) - (feeAprOf(a, stat(a), effectiveVolumeWindow) ?? -1);
      return (
        (emitAprOf(b, stat(b), upPrice.data) ?? -1) -
        (emitAprOf(a, stat(a), upPrice.data) ?? -1)
      );
    });
    return { candidates: sorted, squatHidden: hidden };
  }, [
    data,
    pools.data,
    catalogPools,
    heldV4Pools,
    mySet,
    onlyMine,
    hideSquat,
    hideDust,
    q,
    sort,
    mergedStats,
    upPrice.data,
    effectiveVolumeWindow,
  ]);

  // Which tokens the launchpad factory gets asked about. Scoped, because the
  // answer costs a batched read per token: the v4 rows always (their listing
  // depends on it), and every row only while the user is actually asking for
  // the launchpad's markets. An address already answered is never re-read —
  // the proof is a property of deployed code and cached for the session.
  const launchpadProbe = useMemo(() => {
    if (!LAUNCHPAD) return [];
    const addrs: string[] = [];
    for (const p of candidates)
      if (market.startsWith("launchpad") || p.protocol === "univ4")
        addrs.push(v4BalanceAddress(p.token0), v4BalanceAddress(p.token1));
    // A grouped row IS a token, so it is asked about directly rather than
    // through the pairs underneath it — one read per row instead of two, and
    // the claim the row makes is about the token anyway.
    if (grouping && market.startsWith("launchpad"))
      for (const g of groups.data?.groups ?? []) addrs.push(g.token);
    return addrs;
  }, [candidates, market, grouping, groups.data]);
  const {
    proven: launchpadTokens,
    pending: launchpadPending,
    unread: launchpadUnread,
  } = useLaunchpadTokens(launchpadProbe);

  // The same shape for the issuer proof. Every rendered row already asks about
  // its own pair (PoolRow), so this adds queries only for the rows a stock
  // filter is about to remove — and those share the cache with the rows it keeps.
  const stockProbe = useMemo(() => {
    if (!market.startsWith("stock:")) return [];
    const addrs: string[] = [];
    // Grouped, the question is about the row's own token; flat, it is about
    // both sides of every candidate pair.
    if (grouping) for (const g of groups.data?.groups ?? []) addrs.push(g.token);
    else
      for (const p of candidates)
        addrs.push(v4BalanceAddress(p.token0), v4BalanceAddress(p.token1));
    return addrs;
  }, [candidates, market, grouping, groups.data]);
  const stockIssuers = useStockIssuers(stockProbe);

  // The grouped rows, narrowed the way the flat list is. The catalog groups by
  // origin, and a release sub-chip is a finer question than the origin — so the
  // server answers "launchpad" and the client keeps only the generation the chip
  // names, exactly the division of labour the flat list has always used. A token
  // whose proof is still in flight drops out until it lands, the same behaviour
  // flat rows have under the same chip.
  const visibleGroups = useMemo(() => {
    const all = groups.data?.groups ?? [];
    if (!market.startsWith("launchpad:")) return all;
    const release = market.slice("launchpad:".length);
    return all.filter(
      (g) => launchpadTokens.get(g.token.toLowerCase())?.release === release,
    );
  }, [groups.data, market, launchpadTokens]);

  const list = useMemo(
    () =>
      candidates.filter((p) => {
        const a0 = v4BalanceAddress(p.token0).toLowerCase();
        const a1 = v4BalanceAddress(p.token1).toLowerCase();
        const fromLaunchpad = launchpadTokens.has(a0) || launchpadTokens.has(a1);
        // held rows and searched rows are never withheld — same exemptions the
        // dust and squat filters make, and for the same reason. A side whose
        // proof could not be READ joins them: the rule below excludes on the
        // absence of proof, and a dropped packet is not a measurement.
        const exempt =
          mySet.has(poolIdentity(p)) ||
          !!q.trim() ||
          launchpadUnread.has(a0) ||
          launchpadUnread.has(a1);
        if (V4_NEEDS_LAUNCHPAD && p.protocol === "univ4" && !fromLaunchpad && !exempt)
          return false;
        if (market === "all") return true;
        // The chip is the opposite kind of rule — it INCLUDES on proof — so an
        // unread side stays out of it rather than being waved through.
        if (market === "launchpad") return fromLaunchpad;
        // A release sub-chip narrows that to the generation that ran the sale.
        // Bare mints prove a launchpad and no generation, so they answer null
        // and stay in the parent chip, which is the honest place for them.
        if (market.startsWith("launchpad:"))
          return releaseOf(p, launchpadTokens) === market.slice("launchpad:".length);
        const issuer = market.slice("stock:".length) as StockIssuerId;
        return issuerOf(p, stockIssuers) === issuer;
      }),
    [candidates, launchpadTokens, launchpadUnread, market, mySet, q, stockIssuers],
  );

  // The trade panel follows the selection, and the selection survives a catalog
  // refresh because it is held by identity. A row filtered away takes the panel
  // with it rather than leaving a form pointed at something off-screen.
  //
  // Grouped, the rows on screen are the ones inside the OPEN group, and those
  // are not in `list` at all — it is the flat catalog's filter output. Looking
  // only there would let a click select a market the panel then refuses to
  // show, which is the one thing a selector must never do. Looking in EVERY
  // group is the opposite failure: switching open group A→B never passes
  // through null, so the panel would stay pointed at a pool in a group that
  // has since collapsed.
  const selected = useMemo(() => {
    const visible = grouping
      ? ((groups.data?.groups ?? []).find(
          (g) => g.token.toLowerCase() === openGroup,
        )?.pools ?? [])
      : list;
    return visible.find((p) => poolIdentity(p) === openId) ?? null;
  }, [grouping, groups.data, list, openGroup, openId]);

  /**
   * Put the row that opened the sheet at the top of what is left of the list.
   *
   * The strip above a sheet is a few rows tall, and the tap that filled it
   * usually landed well below the fold — so the market on screen behind the
   * form was some other market, which is worse than showing none. Folding the
   * filters away moves everything up as well, and this runs after that, so the
   * two settle together rather than one correcting the other.
   *
   * The header is sticky and overlaps whatever sits under it, so the row is
   * parked below it rather than at the wrap's own top edge.
   */
  useEffect(() => {
    if (!sheet || !openId) return;
    // `is-open` is also the open GROUP's header, which sorts first in the
    // document — matching that one would park the reader on a group heading
    // while the pool they picked sat somewhere below it
    const row = document.querySelector<HTMLElement>(
      ".market-col tr.is-open:not(.group-row)",
    );
    const wrap = row?.closest<HTMLElement>(".tbl-wrap");
    if (!row || !wrap) return;
    const head = wrap.querySelector<HTMLElement>("thead");
    wrap.scrollTop +=
      row.getBoundingClientRect().top -
      wrap.getBoundingClientRect().top -
      (head?.getBoundingClientRect().height ?? 0);
  }, [sheet, openId]);

  // Collapsing a group takes the panel with it, for the same reason: the row
  // the form is pointed at is no longer on screen.
  useEffect(() => {
    if (!grouping || openGroup !== null) return;
    setOpenId(null);
  }, [grouping, openGroup]);

  if (pools.isLoading)
    return (
      <div className="dim">
        {t("pools.loading")}
        <span className="spin">▮</span>
      </div>
    );
  if (pools.isError || !data)
    return (
      <div className="red">
        {t("pools.scanFailed", { err: String(pools.error) })}
      </div>
    );

  const totalWeight = data.protocol.totalWeight;
  const th = (
    key: Exclude<SortKey, null>,
    label: string,
    extra = "",
    sub?: string,
    info = false,
  ) => {
    // Grouped, the rows are tokens, and a token has no gauge — so REWARDS has
    // nothing to rank. It stops being a control rather than staying one that
    // highlights and reorders nothing, which is what every other column here
    // used to do before the catalog learned to sort them.
    const sortable = !grouping || GROUPED_SORTABLE.has(key);
    return (
    <th
      className={`num ${sortable ? "sortable" : ""} ${extra} ${sortable && sort === key ? "on" : ""}`}
      onClick={sortable ? () => setSort(sort === key ? null : key) : undefined}
      tabIndex={sortable ? 0 : undefined}
      onKeyDown={
        sortable ? activateOnKey(() => setSort(sort === key ? null : key)) : undefined
      }
      title={sortable ? t("pools.sortTip") : t("pools.sortUngroupable")}
    >
      {label}
      {sortable && sort === key ? " ▼" : ""}
      {/* the space is load-bearing: JSX eats the newline, and without a break
          opportunity this inline-block cannot wrap — on a 320px phone it hung
          4px past the table and put the sideways scrollbar back */}
      {info && " "}
      {info && (
        <button
          className="info-btn"
          title={t(
            FEATURES.emissions ? "pools.footnoteTip" : "pools.footnoteTipFees",
          )}
          onClick={(e) => {
            e.stopPropagation(); // the th click sorts
            if (aprInfo) {
              setAprInfo(null);
              return;
            }
            const r = e.currentTarget.getBoundingClientRect();
            setAprInfo({
              top: r.bottom + 6,
              right: Math.max(8, window.innerWidth - r.right - 4),
            });
          }}
        >
          ⓘ
        </button>
      )}
      {/* mobile stacks a second metric into this column; name it in the header */}
      {sub && <span className="cell-sub show-m">{sub}</span>}
    </th>
    );
  };

  return (
    /* Two panes, one act. The market list answers "what is worth trading" and
       the panel answers "then do it" — and they are read against each other, so
       a row that has to be expanded in place (which is what this table used to
       do) puts the form where the comparison used to be.

       Under the split width there is no second pane to put it in. The panel
       used to stack ABOVE the list there, which cost a phone the whole page:
       selecting a row pushed all 200 markets below the fold, and the form the
       tap produced was itself below the search box and the filter chips, so the
       thing that just happened was off-screen in both directions. It opens as a
       sheet over the list instead — the row stays lit underneath, the backdrop
       and Esc put it away, and nothing about the page behind it moves. */
    <div
      className={`tab-fill market-split${selected && !sheet ? " has-trade" : ""}`}
    >
      {/* Behind an open sheet, the strip of page left showing is what says the
          list is still there — so it has to be the LIST. Unclassed, the 235px
          on offer went to a search box, a filter strip and a line of catalog
          tallies, and not one market row: the reader was looking at the
          questions they had already answered. Those fold away while the sheet
          is up and come back with it. */}
      <div className={`market-col${sheet && selected ? " behind-sheet" : ""}`}>
        <div className="form-row market-filters">
          <input
            ref={filterRef}
            id="pool-search"
            className="input"
            placeholder={t("pools.searchPlaceholder")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {/* One strip, so a phone can scroll it sideways as a single object
              rather than wrapping it into two and three rows of 44px targets —
              which was 128px of a 844px screen spent before the first market.
              On a desktop the strip wraps exactly the way these chips always
              did, because it is still a flex row inside a flex row. */}
          <div className="chip-strip">
            {/* ALL is always offered; the other two exist only where the chain can
                prove the thing they claim. On a chain that can prove neither, this
                row is the search box and the browsing toggles, and nothing else. */}
            <button
              className={`chip ${market === "all" ? "on" : ""}`}
              onClick={() => setMarket("all")}
              title={t("pools.marketAllTip")}
            >
              {t("pools.marketAll")}
            </button>
            {LAUNCHPAD && (
              <button
                className={`chip brand pad ${market.startsWith("launchpad") ? "on" : ""}`}
                // Cyan is what its ◈ wears on every row it selects, so the chip
                // and its rows are visibly the same claim. Filled when active —
                // an outline says "a control", a fill says "this is what you are
                // looking at", and that is the question the row of chips answers.
                // Its resting border is cyan too (in .chip.pad), so it sits in the
                // same visual class as the issuer chip beside it rather than
                // looking like one of the hide-toggles further along.
                style={
                  market.startsWith("launchpad")
                    ? { background: "var(--cyan)", borderColor: "var(--cyan)", color: "var(--bg)" }
                    : undefined
                }
                onClick={() => setMarket("launchpad")}
                title={t("pools.marketLaunchpadTip", { pad: LAUNCHPAD.label })}
              >
                <span aria-hidden="true">◈</span>
                {LAUNCHPAD.label}
              </button>
            )}
            {/* The release sub-filters, shown only once the launchpad is the
                subject — they narrow an answer rather than offering a new one, and
                a chain with a single generation has nothing to narrow. The parent
                chip stays lit throughout: picking V2 is still asking for launchpad
                markets, and it is also how you get back to all of them. */}
            {LAUNCHPAD &&
              LAUNCHPAD_RELEASES.length > 1 &&
              market.startsWith("launchpad") &&
              LAUNCHPAD_RELEASES.map((release) => (
                <button
                  key={release.id}
                  className={`chip sub ${market === `launchpad:${release.id}` ? "on" : ""}`}
                  onClick={() =>
                    setMarket(
                      market === `launchpad:${release.id}` ? "launchpad" : `launchpad:${release.id}`,
                    )
                  }
                  title={t("pools.marketLaunchpadReleaseTip", {
                    pad: LAUNCHPAD.label,
                    release: release.short,
                  })}
                >
                  {release.short}
                </button>
              ))}
            {CHAIN_ISSUERS.map((issuer) => {
              const brand = STOCK_ISSUERS[issuer];
              const on = market === `stock:${issuer}`;
              return (
                <button
                  key={issuer}
                  className={`chip brand ${on ? "on" : ""}`}
                  // The issuer's own color, the same one its ▣ mark wears on every
                  // row — so the chip and what it selects are visibly one thing.
                  // Filled when active, matching the launchpad chip: these two are
                  // the row's identity filters and they answer the same question,
                  // so they should not answer it in two different visual languages.
                  style={
                    on
                      ? { background: brand.color, borderColor: brand.color, color: "#000" }
                      : { borderColor: brand.line }
                  }
                  onClick={() => setMarket(`stock:${issuer}`)}
                  title={t("pools.marketStockTip", { issuer: brand.label })}
                >
                  <span aria-hidden="true">▣</span>
                  {brand.short}
                </button>
              );
            })}
            {origin !== null && !q.trim() && (
              <button
                className={`chip ${flat ? "on" : ""}`}
                onClick={() => setFlat((value) => !value)}
                title={t("pools.groupUngroupedTip")}
              >
                {t("pools.groupUngrouped")}
              </button>
            )}
            {!grouping && VOLUME_WINDOWS.map((window) => (
              <button
                key={window}
                className={`chip ${volumeWindow === window ? "on" : ""}`}
                onClick={() => setVolumeWindow(window)}
                title={t("pools.volumeWindowTip", { window: volumeWindowLabel(window) })}
              >
                {volumeWindowLabel(window)}
              </button>
            ))}
            <button
              className={`chip ${hideDust ? "on" : ""}`}
              onClick={() => setHideDust(!hideDust)}
              title={t("pools.hideDustTip")}
            >
              {t("pools.hideDust")}
            </button>
            {HAS_KNOWN_TOKENS && (
              <button
                className={`chip ${hideSquat ? "on" : ""}`}
                onClick={() => setHideSquat(!hideSquat)}
                title={t("pools.hideSquatTip")}
              >
                {t("pools.hideSquat")}
              </button>
            )}
            {user && (
              <button
                className={`chip ${onlyMine ? "on" : ""}`}
                onClick={() => setOnlyMine((value) => !value)}
                title={positions.isError ? String(positions.error) : undefined}
              >
                {t("pools.mine", { n: mySet.size })}
                {onlyMine && positions.isFetching && <span className="spin"> ▮</span>}
              </button>
            )}
          </div>
        </div>
        <div className="form-row market-stat">
          <span className="dim mono-sm">
            {grouping
              ? t("pools.groupCount", { n: groups.data?.count ?? 0 })
              : t("pools.statShown", { n: list.length })}
            {grouping && groups.isFetching && <span className="spin"> ▮</span>}
            {grouping && groups.isError && (
              <span className="red">
                {" "}
                · {t("pools.groupScanFailed", { err: String(groups.error).slice(0, 60) })}
              </span>
            )}
            {/* Never a silent truncation: a filter that removes rows says how
                many, so "nothing here" can be told apart from "hidden". */}
            {squatHidden > 0 && (
              <span className="red" title={t("pools.hideSquatTip")}>
                {" "}
                · {t("pools.statSquatHidden", { n: squatHidden })}
              </span>
            )}
            {/* A filter that hides rows must not let "still asking the chain"
                render as "nothing here" — the two are the same empty table. */}
            {LAUNCHPAD && launchpadPending > 0 && (
              <>
                {" "}
                · {t("pools.statProving", { pad: LAUNCHPAD.label })}
                <span className="spin">▮</span>
              </>
            )}
            {/* The catalog tallies — how big the index is, how much of it
                matched, how much is loaded. On a phone they were three wrapped
                lines of telemetry sitting above the markets they count, so they
                wait for a screen with room. What stays on every screen is what
                changes a decision: the number of rows shown, a scan that failed,
                a fallback that is serving, and a spinner while any of it moves. */}
            <span className="hide-m">
              {FEATURES.emissions ? (
                <>
                  {" "}
                  ·{" "}
                  {t("pools.statHome", {
                    proto: CHAIN.labels.home.toLowerCase(),
                    n: pools.data?.pools.length ?? 0,
                  })}
                </>
              ) : null}
              {wantsV23 && (
                <>
                  {" "}
                  ·{" "}
                  {/* the chips no longer narrow the catalog, so both venues are
                      always in the count unless the fallback path is serving it */}
                  {uni.data?.source === "fallback" || FEATURES.emissions
                    ? t("pools.statUniswap")
                    : t("pools.statBoth", {
                        proto: CHAIN.labels.home.toLowerCase(),
                      })}{" "}
                  {uni.isLoading ? (
                    <span className="spin">▮</span>
                  ) : uni.data?.source === "index" ? (
                    <>
                      {t("pools.statCatalog", {
                        n: uni.data.indexed.toLocaleString("en-US"),
                      })}{" "}
                      ·{" "}
                      {t("pools.statMatch", {
                        // A capped count is a floor. Rendering it bare would
                        // print "5,000" for a search that matched 298,448.
                        n: `${uni.data.total.toLocaleString("en-US")}${
                          uni.data.totalCapped ? "+" : ""
                        }`,
                      })}{" "}
                      ·{" "}
                      {t("pools.statLoaded", {
                        n: uni.data.pools.length.toLocaleString("en-US"),
                      })}
                    </>
                  ) : uni.data ? (
                    <>{t("pools.statTop", { n: uni.data.pools.length })}</>
                  ) : (
                    "—"
                  )}
                </>
              )}
              {wantsV4 && (
                <>
                  {" "}
                  · {t("pools.statV4")}{" "}
                  {v4.isLoading ? (
                    <span className="spin">▮</span>
                  ) : v4.data ? (
                    <>
                      {t("pools.statV4Loaded", {
                        n: v4.data.indexed.toLocaleString("en-US"),
                      })}
                      {uniQuery && (
                        <>
                          {" "}
                          ·{" "}
                          {t("pools.statMatch", {
                            n: `${v4.data.matched.toLocaleString("en-US")}${
                              v4.data.source === "fallback" && v4.data.capped
                                ? "+"
                                : ""
                            }`,
                          })}
                        </>
                      )}
                    </>
                  ) : (
                    "—"
                  )}
                </>
              )}
              {stats.isLoading && (
                <>
                  {" "}
                  · {t("pools.statVol")}
                  <span className="spin">▮</span>
                </>
              )}
              {wantsV23 && uni.isFetching && !uni.isLoading && (
                <span className="spin"> ▮</span>
              )}
              {wantsV4 && v4.isFetching && !v4.isLoading && (
                <span className="spin"> ▮</span>
              )}
            </span>
            {/* the whole of that signal, in the one character a phone can spare
                — the tallies above carry their own spinners on a wide screen */}
            {((wantsV23 && uni.isFetching) ||
              (wantsV4 && v4.isFetching) ||
              stats.isLoading) && <span className="spin show-m"> ▮</span>}
            {wantsV23 && uni.isError && (
              <span className="red">
                {" "}
                ·{" "}
                {t("pools.uniScanFailed", {
                  err: String(uni.error).slice(0, 60),
                })}
              </span>
            )}
            {wantsV4 && v4.isError && (
              <span className="red"> · {t("pools.v4ScanFailed")}</span>
            )}
            {wantsV4 && v4.data?.source === "fallback" && (
              <span className="amber"> · {t("pools.v4FallbackNote")}</span>
            )}
            {wantsV23 && uni.data?.source === "fallback" && (
              <span className="amber">
                {" "}
                · {t("pools.fallbackNote")}
                {uni.data.dropped > 0 ? (
                  <> · {t("pools.spoofDropped", { n: uni.data.dropped })}</>
                ) : (
                  ""
                )}
              </span>
            )}
          </span>
        </div>
        {/* Its own row, because on a phone it belongs at the END of the list.
            "Load more" above the table asks for the next page of something the
            reader has not started reading — and it cost 62px of the screen the
            first page was supposed to occupy. CSS orders it under the table
            there; on a wide screen it stays beside the counters it extends. */}
        <div className="form-row market-more">
          {grouping && groups.hasNextPage && (
            <button
              className="chip"
              disabled={groups.isFetchingNextPage}
              onClick={() => void groups.fetchNextPage()}
            >
              {groups.isFetchingNextPage
                ? t("pools.groupLoadingMore")
                : t("pools.groupLoadMore")}
            </button>
          )}
          {!grouping && wantsV23 && uni.hasNextPage && (
            <button
              className="chip"
              disabled={uni.isFetchingNextPage}
              onClick={() => void uni.fetchNextPage()}
              title={t("pools.uniLoadMoreTip")}
            >
              {uni.isFetchingNextPage
                ? t("pools.uniLoadingMore")
                : t("pools.uniLoadMore")}
            </button>
          )}
          {!grouping && wantsV4 && v4.hasNextPage && (
            <button
              className="chip"
              disabled={v4.isFetchingNextPage}
              onClick={() => void v4.fetchNextPage()}
              title={t("pools.v4LoadMoreTip")}
            >
              {v4.isFetchingNextPage
                ? t("pools.v4LoadingMore")
                : t("pools.v4LoadMore")}
            </button>
          )}
        </div>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("pools.thPair")}</th>
                {/* mobile keeps two stacked columns: TVL/VOL and FEE APR/REWARDS.
                    PRICE/RESERVES is the widest cell in the table and the first to
                    go: below a laptop it was pushing TVL and VOL off the right
                    edge, and its content ("24.9M CASHCAT + 12.4 WETH") has no
                    natural width bound. */}
                <th className="hide-t">{t("pools.thPrice")}</th>
                {th("tvl", t("pools.thTvl"), "", t("pools.thVolWindow", { window: volumeWindowLabel(effectiveVolumeWindow) }))}
                {th("vol", t("pools.thVolWindow", { window: volumeWindowLabel(effectiveVolumeWindow) }), "hide-m")}
                {th("fees24", t("pools.thFeesWindow", { window: volumeWindowLabel(effectiveVolumeWindow) }), "hide-m")}
                {/* REWARDS is an emissions column: on a chain with no ve(3,3) it can
                    only ever hold a dash, in the table's widest layout. Gone with the
                    same flag that hides the epoch, the gauges and the vote share. */}
                {th(
                  "feeApr",
                  t("pools.thFeeAprWindow", { window: volumeWindowLabel(effectiveVolumeWindow) }),
                  "",
                  FEATURES.emissions ? t("pools.thRewards") : undefined,
                  true,
                )}
                {FEATURES.emissions &&
                  th("rewards", t("pools.thRewards"), "hide-m")}
              </tr>
            </thead>
            <tbody>
              {/* A chip whose membership is empty renders one honest line rather
                  than a blank table. It reads the same before the origin sweep
                  has confirmed anything and after it has confirmed nothing,
                  because from here those two are the same observation. A FAILED
                  sweep is not an observation at all — the red scan line above
                  already says what happened, and "nothing here yet" would be a
                  lie next to it. */}
              {grouping &&
                !groups.isLoading &&
                !groups.isError &&
                !visibleGroups.length && (
                <tr>
                  <td className="dim mono-sm" colSpan={FEATURES.emissions ? 7 : 6}>
                    {t("pools.groupEmpty", { origin: originLabel })}
                  </td>
                </tr>
              )}
              {grouping
                ? visibleGroups.map((g) => {
                    const key = g.token.toLowerCase();
                    const open = openGroup === key;
                    return (
                      <Fragment key={key}>
                        <GroupRow
                          g={g}
                          data={data}
                          issuer={stockIssuers.get(key) ?? null}
                          launchpad={launchpadTokens.get(key)?.release ?? null}
                          proven={
                            // The chip names ONE issuer: a token the browser
                            // proved to be another issuer's share is not proof
                            // of this row's claim, the way it is not membership
                            // in the flat list's filter.
                            market.startsWith("stock:")
                              ? stockIssuers.get(key) ===
                                market.slice("stock:".length)
                              : launchpadTokens.has(key)
                          }
                          open={open}
                          onToggle={() => setOpenGroup(open ? null : key)}
                        />
                        {open &&
                          g.pools.map((p) => {
                            const id = poolIdentity(p);
                            return (
                              <PoolRow
                                key={id}
                                p={p}
                                data={data}
                                stat={statOf(p)}
                                upUsd={upPrice.data}
                                totalWeight={totalWeight}
                                mine={mySet.has(id)}
                                open={openId === id}
                                volumeWindow={effectiveVolumeWindow}
                                nested
                                onToggle={() => setOpenId(openId === id ? null : id)}
                              />
                            );
                          })}
                      </Fragment>
                    );
                  })
                : list.map((p) => {
                    const id = poolIdentity(p);
                    return (
                      <PoolRow
                        key={id}
                        p={p}
                        data={data}
                        stat={statOf(p)}
                        upUsd={upPrice.data}
                        totalWeight={totalWeight}
                        mine={mySet.has(id)}
                        open={openId === id}
                        volumeWindow={effectiveVolumeWindow}
                        onToggle={() => setOpenId(openId === id ? null : id)}
                      />
                    );
                  })}
            </tbody>
          </table>
        </div>
      </div>
      {/* The pane is empty until a row is picked, and says so rather than
          opening a form on a pool nobody chose — the swap side would have to
          invent a market, and the deposit side a range.

          Deliberately NOT keyed on the pool. Moving between rows should
          re-point the swap form, not rebuild it: a chosen slippage and a live
          quote survive the move, the way they would if the user had changed the
          buy token by hand. The deposit form inside IS keyed — its range and
          amounts belong to one pool and nothing else. */}
      {!sheet && (
        <div className="trade-col">
          {selected ? (
            <TradePanel
              pool={selected}
              data={data}
              stat={statOf(selected)}
              upUsd={upPrice.data}
              wethUsd={stats.data?.wethUsd}
              volumeWindow={effectiveVolumeWindow}
              recommendation={
                poolIdentity(selected) === recommendationId
                  ? recommendation
                  : null
              }
              onClose={() => setOpenId(null)}
            />
          ) : (
            <div className="trade-empty dim mono-sm">
              {t("pools.tradePickRow")}
            </div>
          )}
        </div>
      )}
      {/* `bare`, because the panel's own head is the pair — its avatars, its
          copyable addresses, its protocol badge — and a dialog title bar above
          that would name the market twice and stack two ✕ in one corner. */}
      {sheet && selected && (
        <Modal
          sheet
          bare
          title={`${tokenOf(data, selected.token0).symbol}/${tokenOf(data, selected.token1).symbol}`}
          onClose={() => setOpenId(null)}
        >
          <TradePanel
            pool={selected}
            data={data}
            stat={statOf(selected)}
            upUsd={upPrice.data}
            wethUsd={stats.data?.wethUsd}
            volumeWindow={effectiveVolumeWindow}
            recommendation={
              poolIdentity(selected) === recommendationId
                ? recommendation
                : null
            }
            onClose={() => setOpenId(null)}
          />
        </Modal>
      )}
      {aprInfo && (
        <>
          <div className="tsel-backdrop" onClick={() => setAprInfo(null)} />
          <div
            className="info-pop"
            style={{ top: aprInfo.top, right: aprInfo.right }}
          >
            <Trans
              i18nKey={
                FEATURES.emissions ? "pools.footnote" : "pools.footnoteFees"
              }
              components={[<b key="0" />, <b key="1" />]}
            />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One token whose origin the chain proved, and everything it trades in.
 *
 * The row is the TOKEN, not a pool. A tokenized share spreads across fee tiers
 * and protocols, so a flat list buries the same company under six rows of
 * itself and the reader has to add them up to know what it is worth. Opening it
 * is what shows the individual markets — which is also the only place a trade
 * can be made, because a trade happens in a pool.
 *
 * The catalog decided which tokens belong here; this row does NOT take that on
 * trust. `proven` is the browser's own read of the chain, and a row it could
 * not confirm carries no mark and says so. It is still shown: an RPC hiccup is
 * not evidence a share is fake, and hiding a real market on that basis would be
 * the worse error of the two.
 */
function GroupRow(props: {
  g: PoolGroup;
  data: PoolsData;
  issuer: StockIssuerId | null;
  launchpad: LaunchpadReleaseId | null;
  proven: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const { g, data } = props;
  const token = tokenOf(data, g.token);
  const protocols = [...new Set(g.pools.map((p) => p.protocol))];
  // A group's fee APR is the same ratio a pool's is, over the token's whole
  // book. It is only honest where the fee itself is: a token whose markets are
  // mostly hooked has most of its fees unstated, so the ratio would be too.
  const feeApr =
    g.fees24hUsd != null && g.tvlUsd != null && g.tvlUsd > 0
      ? ((g.fees24hUsd * 365) / g.tvlUsd) * 100
      : null;
  const partialFees = g.fees24hUsd != null && g.feePools < g.poolCount;
  const release = LAUNCHPAD_RELEASES.find((r) => r.id === props.launchpad)?.short ?? null;

  return (
    <tr
      className={`rowhover group-row${props.open ? " is-open" : ""}`}
      // stays a row — a data table that renames its rows "button" loses the
      // structure that makes it navigable
      {...rowToggleProps(props.open, props.onToggle)}
    >
      <td>
        <div className="pair-line">
          <span className="group-caret" aria-hidden="true">
            {props.open ? "▾" : "▸"}
          </span>
          <TokenAvatar
            symbol={token.symbol}
            address={g.token}
            issuer={props.issuer}
            target
          />
          <span
            className="pair-name"
            // the clipped name is unreadable otherwise: a group row has no
            // address card behind it to open, the way a pool row does
            title={
              displayWidth(token.symbol) > GROUP_NAME_COLUMNS
                ? token.symbol
                : undefined
            }
          >
            <TokenSymbol
              symbol={token.symbol}
              address={g.token}
              issuer={props.issuer}
              max={GROUP_NAME_COLUMNS}
            />
          </span>
          {/* The absence of a mark is the warning, so an unconfirmed row has to
              say which kind of absence it is: measured-and-not-this-issuer, or
              not measured at all. */}
          {!props.proven && (
            <span className="amber mono-sm" title={t("pools.groupUnverifiedTip")}>
              {t("pools.groupUnverified")}
            </span>
          )}
        </div>
        <div className="pair-sub">
          <span className="cyan">
            {t("pools.groupMarkets", { n: g.poolCount })}
          </span>
          {/* Which launcher generation ran the sale. A bare mint proves a
              launchpad and no generation, so it says nothing rather than
              guessing one. */}
          {release && (
            <>
              {" · "}
              <span title={LAUNCHPAD?.label}>{release}</span>
            </>
          )}
          {protocols.length > 0 && (
            <>
              {" · "}
              {protocols.map((proto) => (
                <ProtoBadge key={proto} proto={proto} mini />
              ))}
            </>
          )}
          {g.poolCount > g.pools.length && (
            <>
              {" · "}
              <span className="dim">
                {t("pools.groupShowingTop", { n: g.pools.length })}
              </span>
            </>
          )}
        </div>
      </td>
      <td className="mono-sm hide-t dim">{shortAddr(g.token)}</td>
      <td className="num">
        {g.tvlUsd != null && g.tvlUsd > 0 ? (
          <>
            <span className="hide-m">{fmtUsd(g.tvlUsd)}</span>
            <span className="show-m">${fmtCompact(g.tvlUsd)}</span>
          </>
        ) : (
          <span className="dim">—</span>
        )}
        <span className="cell-sub show-m">
          {g.vol24hUsd != null ? `$${fmtCompact(g.vol24hUsd)}` : "—"}
        </span>
      </td>
      <td className="num hide-m">
        {g.vol24hUsd != null ? fmtUsd(g.vol24hUsd) : <span className="dim">—</span>}
      </td>
      <td className="num hide-m">
        {g.fees24hUsd != null ? (
          <span
            className="amber"
            title={
              partialFees
                ? t("pools.groupFeesPartialTip", {
                    counted: g.feePools,
                    total: g.poolCount,
                  })
                : undefined
            }
          >
            {fmtUsd(g.fees24hUsd)}
            {partialFees && "*"}
          </span>
        ) : (
          <span className="dim">—</span>
        )}
      </td>
      <td className="num" title={t("pools.feeAprTip")}>
        {feeApr != null ? fmtApr(feeApr) : <span className="dim">—</span>}
        {FEATURES.emissions && <span className="cell-sub show-m">—</span>}
      </td>
      {FEATURES.emissions && <td className="num hide-m dim">—</td>}
    </tr>
  );
}

function PoolRow(props: {
  p: Pool;
  data: PoolsData;
  stat?: PoolStat;
  upUsd?: number;
  totalWeight: bigint;
  mine: boolean;
  /** the row the trade panel is pointed at */
  open: boolean;
  volumeWindow: VolumeWindow;
  /** a market shown inside its token's group, indented under it */
  nested?: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const { p, data, totalWeight, stat } = props;
  const t0 = tokenOf(data, p.token0);
  const t1 = tokenOf(data, p.token1);
  // A v4 pool holds the chain's coin as `address(0)`; every list that can say
  // anything about a token — the reserved symbols, the issuer anchors, the
  // launchpad factory — is keyed on the sentinel. Normalise once, here, so a
  // native side is looked up as the coin rather than as an unknown contract.
  const addr0 = v4BalanceAddress(p.token0);
  const addr1 = v4BalanceAddress(p.token1);
  const [issuer0, issuer1] = useStockIssuerPair(addr0, addr1);
  const [pad0, pad1] = useLaunchpadPair(addr0, addr1);
  const squats = pairSquats(CHAIN.knownTokens, t0, t1);
  // which side is the market and which is the money — the pictures lead with
  // the one the row is about, and the trade panel buys that one
  const side = pairSide(addr0, addr1);
  const avatars = orientPair(
    { symbol: t0.symbol, address: addr0, issuer: issuer0, launchpad: pad0 },
    { symbol: t1.symbol, address: addr1, issuer: issuer1, launchpad: pad1 },
    side,
  );
  const feePct =
    p.kind === "v2" ? p.feeBps / 100 : effectiveClFeePpm(p) / 10_000;
  const emitting = p.periodFinish > BigInt(nowSec());
  const upWk = emitting ? p.rewardRate * BigInt(WEEK) : 0n;
  const votePct =
    totalWeight > 0n
      ? Number((p.weight * 1_000_000n) / totalWeight) / 10_000
      : 0;
  const volume = volumeOf(stat, props.volumeWindow);
  const fees = feesOf(p, stat, props.volumeWindow);
  const feeApr = feeAprOf(p, stat, props.volumeWindow);
  const emitApr = emitAprOf(p, stat, props.upUsd);
  const stakedPct = stakedShareOf(p) * 100;
  let kindLabel: string;
  if (p.kind === "v2") {
    if (p.protocol === "univ2") kindLabel = "uniswap v2";
    else
      kindLabel = `${CHAIN.labels.homeV2.toLowerCase()} ${p.stable ? "stable" : "volatile"}`;
  } else if (p.protocol === "univ4")
    kindLabel = `uniswap v4 ts${p.tickSpacing}`;
  else if (p.protocol === "univ3") kindLabel = `uniswap v3 ts${p.tickSpacing}`;
  else kindLabel = `${CHAIN.labels.homeCl.toLowerCase()} ts${p.tickSpacing}`;
  let feeTip: string | undefined;
  if (p.protocol !== "home" && (p.kind === "v2" || FEATURES.emissions))
    feeTip = t(p.kind === "v2" ? "pools.feeTipUniV2" : "pools.feeTipUniV3");

  return (
    <>
      <tr
        className={`rowhover${props.mine ? " is-mine" : ""}${props.open ? " is-open" : ""}${props.nested ? " is-nested" : ""}`}
        // the row is the selector, and opens the trade panel below it
        {...rowToggleProps(props.open, props.onToggle)}
      >
        <td title={props.mine ? t("pools.mineDotTip") : undefined}>
          <div className="pair-line">
            {/* Which token this row IS. A pair label names two things and
                emphasises neither, and on a chain where twenty contracts share
                one ticker the symbol is the least reliable half of it. */}
            <PairAvatars target={avatars.target} quote={avatars.quote} />
            <PairAddrs
              className="pair-name"
              sym0={t0.symbol}
              sym1={t1.symbol}
              token0={p.token0}
              token1={p.token1}
              issuer0={issuer0}
              issuer1={issuer1}
              pool={p.address}
              poolId={p.protocol === "univ4" ? p.poolId : undefined}
              hooks={p.protocol === "univ4" ? p.hooks : undefined}
            />
            {/* every protocol gets its mark, UP33 included — it was the unmarked
                default back when this table was UP33-only, but in a three-protocol
                list "no badge" is not an identity. POSITIONS already badges all three. */}
            <ProtoBadge proto={p.protocol} mini />
            {/* Provenance rides the row ITSELF, at glyph weight and always —
                selecting a row is not a question about where a token came from,
                and a mark you have to click for is not a mark. Carries the
                generation in its styling and its tooltip; navigates nowhere. */}
            {pad0 && <LaunchpadBadge token={pad0} compact />}
            {pad1 && <LaunchpadBadge token={pad1} compact />}
            {p.protocol !== "univ4" && <DexScreenerLink pool={p.address} />}
          </div>
          <div className="pair-sub">
            <span className="cyan">{kindLabel}</span>
            {" · "}
            <span title={feeTip}>{feePct.toFixed(feePct < 0.1 ? 3 : 2)}%</span>
            {p.protocol === "univ4" && p.poolId && (
              <>
                {" · "}
                <span title={p.poolId}>
                  {t("pools.addrPoolId")} {shortAddr(p.poolId)}
                </span>
                {" · "}
                <span
                  className={v4HasHooks(p) ? "amber" : undefined}
                  title={p.hooks}
                >
                  {t("pools.addrHooks")}{" "}
                  {p.hooks && p.hooks !== zeroAddress
                    ? shortAddr(p.hooks)
                    : t("pools.addrNoHooks")}
                </span>
              </>
            )}
            {/* a killed gauge still matters (staking there earns nothing) — the
                healthy/no-gauge states were the noise and are gone */}
            {p.protocol === "home" && p.gauge && !p.gaugeAlive && (
              <>
                {" · "}
                <span className="red">{t("pools.killed")}</span>
              </>
            )}
          </div>
          {/* A squat chip shows whether or not the row is selected: an unhidden
              squatting row is one the user asked to see, and the name it is
              wearing is the reason it was hidden in the first place.
              NOTHING here is keyed on selection any more. Growing a row on
              click moved every row below it, and what grew into the gap was two
              outbound links — so a click meant to pick a market to trade
              offered leaving for the issuer's site or the launchpad's instead.
              The marks that belong on a row now sit in the pair line above,
              always visible and inert; the filter chips are where the launchpad
              and the issuer are named. */}
          {squats && (
            <div className="pair-stock">
              <SquatBadge symbol={t0.symbol} address={p.token0} />
              <SquatBadge symbol={t1.symbol} address={p.token1} />
            </div>
          )}
        </td>
        <td className="mono-sm hide-t">
          {p.kind === "v2" ? (
            <>
              {fmtCompactAmount(p.reserve0, t0.decimals)}{" "}
              {clampWidth(t0.symbol, SYMBOL_COLUMNS)} +{" "}
              {fmtCompactAmount(p.reserve1, t1.decimals)}{" "}
              {clampWidth(t1.symbol, SYMBOL_COLUMNS)}
            </>
          ) : (
            <PxCell
              sqrtPriceX96={p.sqrtPriceX96}
              d0={t0.decimals}
              d1={t1.decimals}
              s0={t0.symbol}
              s1={t1.symbol}
            />
          )}
        </td>
        <td className="num">
          <Flash v={stat?.liqUsd}>
            {stat?.liqUsd != null && stat.liqUsd > 0 ? (
              <>
                <span className="hide-m">{fmtUsd(stat.liqUsd)}</span>
                {/* phone columns: $2.8M, not $2,844,349 */}
                <span className="show-m">${fmtCompact(stat.liqUsd)}</span>
              </>
            ) : (
              <span className="dim">—</span>
            )}
          </Flash>
          {/* phone: VOL 24H stacks under TVL */}
          <span className="cell-sub show-m">
            {volume != null ? `$${fmtCompact(volume)}` : "—"}
          </span>
        </td>
        <td className="num hide-m">
          <Flash v={volume}>
            {volume != null ? (
              fmtUsd(volume)
            ) : (
              <span className="dim">—</span>
            )}
          </Flash>
        </td>
        <td className="num hide-m">
          {fees != null ? (
            <span className="amber">{fmtUsd(fees)}</span>
          ) : (
            <span className="dim">—</span>
          )}
        </td>
        <td className="num" title={t("pools.feeAprWindowTip", { window: volumeWindowLabel(props.volumeWindow) })}>
          {feeApr != null ? fmtApr(feeApr) : <span className="dim">—</span>}
          {/* phone: reward APR stacks under fee APR — and only where rewards are
              a thing, or the phone grows a second line of dashes */}
          {FEATURES.emissions && (
            <span className="cell-sub show-m">
              {p.protocol === "home" && emitApr != null ? (
                <span className="green">{fmtApr(emitApr)}</span>
              ) : (
                "—"
              )}
            </span>
          )}
        </td>
        {FEATURES.emissions && (
          <td className="num hide-m" title={t("pools.rewardsTip")}>
            {p.protocol === "home" ? (
              <>
                {emitApr != null ? (
                  <span className="green">{fmtApr(emitApr)}</span>
                ) : (
                  <span className="dim">—</span>
                )}
                {/* Emissions detail — weekly UP, vote share, staked share —
                    used to ride a protocol filter that no longer exists. The
                    selected row is where it belongs anyway: it is detail about
                    ONE pool, and it is now shown for the pool being looked at
                    rather than for every row of a filtered page. */}
                {props.open && (
                  <span className="cell-sub">
                    {upWk > 0n
                      ? t("pools.upWk", { n: fmtCompactAmount(upWk, 18) })
                      : t("pools.noEmissions")}
                    {votePct > 0
                      ? ` · ${t("pools.vote", { n: votePct.toFixed(2) })}`
                      : ""}
                    {stakedPct > 0
                      ? ` · ${t("pools.stakedPct", { n: stakedPct.toFixed(0) })}`
                      : ""}
                  </span>
                )}
              </>
            ) : (
              <span className="dim">—</span>
            )}
          </td>
        )}
      </tr>
    </>
  );
}

/**
 * The pane beside the market list: what to do about the row that was picked.
 *
 * Two tabs and a deliberate order. SWAP first, because a market list is a list
 * of prices and taking one is the ordinary reason to click a row — and because
 * the swap here is NOT a trade against this pool. It goes through the same
 * solver and the same direct venues the full SWAP tab uses, so the row names
 * the asset and the router still decides where the size goes; a row with a
 * thin pool and a deep one elsewhere fills at the deep one. LIQUIDITY is the
 * second act, and that one IS about this pool specifically.
 *
 * Which tab opens is remembered (lib/tradePanelPref.ts), so a session spent
 * providing liquidity stops reopening on the swap form.
 */
function TradePanel(props: {
  pool: Pool;
  data: PoolsData;
  stat?: PoolStat;
  upUsd?: number;
  wethUsd?: number | null;
  volumeWindow: VolumeWindow;
  recommendation?: RecommendationPrefill | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { pool, data } = props;
  const tab = useSyncExternalStore(
    tradePanelTab.subscribe,
    tradePanelTab.get,
    () => "swap" as TradeTab,
  );
  const t0 = tokenOf(data, pool.token0);
  const t1 = tokenOf(data, pool.token1);
  // see PoolRow: a v4 native side is `address(0)` in the pool key and the
  // sentinel everywhere a token can be looked up, quoted or spent
  const addr0 = v4BalanceAddress(pool.token0);
  const addr1 = v4BalanceAddress(pool.token1);
  const [issuer0, issuer1] = useStockIssuerPair(addr0, addr1);
  const [pad0, pad1] = useLaunchpadPair(addr0, addr1);
  const side = pairSide(addr0, addr1);
  const tokens = orientPair(
    { ...t0, address: addr0 },
    { ...t1, address: addr1 },
    side,
  );
  const keyAddrs = orientPair(pool.token0, pool.token1, side);
  // Issuer only. The launchpad proof still rides `avatars` below, which is what
  // puts a token's own picture on it — the panel no longer carries a mark row.
  const marks = orientPair({ issuer: issuer0 }, { issuer: issuer1 }, side);
  const avatars = orientPair(
    { symbol: t0.symbol, address: addr0, issuer: issuer0, launchpad: pad0 },
    { symbol: t1.symbol, address: addr1, issuer: issuer1, launchpad: pad1 },
    side,
  );
  // The buy side, described from the pool's own token metadata rather than
  // looked up in the swap token list: a launchpad token minted this morning is
  // in no catalog yet, and a market that cannot be named cannot be traded.
  //
  // `native` is carried, not dropped: the swap form decides balances, the gas
  // buffer, wrap/unwrap and whether a value is sent from that one flag, and a
  // v4 coin side arriving without it would be quoted as if it were an ERC-20.
  const market: TokenInfo = {
    address: tokens.target.address,
    symbol: tokens.target.symbol,
    decimals: tokens.target.decimals,
    native: tokens.target.address.toLowerCase() === NATIVE.toLowerCase(),
  };

  const TABS: { id: TradeTab; label: string }[] = [
    { id: "swap", label: t("pools.tabSwap") },
    { id: "liquidity", label: t("pools.tabLiquidity") },
  ];

  return (
    <div className="trade-panel">
      <div className="trade-head">
        <PairAvatars target={avatars.target} quote={avatars.quote} size={22} />
        <span className="trade-pair">
          <PairAddrs
            className="pair-name"
            sym0={tokens.target.symbol}
            sym1={tokens.quote.symbol}
            /* the card is the pool's identifiers, so it shows the currencies
               as the POOL KEY holds them — `address(0)` for a v4 native side,
               which is what hashes to this PoolId */
            token0={keyAddrs.target}
            token1={keyAddrs.quote}
            issuer0={marks.target.issuer}
            issuer1={marks.quote.issuer}
            pool={pool.address}
            poolId={pool.protocol === "univ4" ? pool.poolId : undefined}
            hooks={pool.protocol === "univ4" ? pool.hooks : undefined}
          />
          <ProtoBadge proto={pool.protocol} mini />
        </span>
        <span className="fill" />
        {pool.protocol !== "univ4" && <DexScreenerLink pool={pool.address} />}
        <button
          className="trade-x"
          onClick={props.onClose}
          title={t("pools.tradeCloseTip")}
        >
          ✕
        </button>
      </div>
      {/* No mark row here either. This panel opens BECAUSE a row was clicked,
          so anything outbound in it is a link the click did not ask for, and
          the panel's one job is the trade. The pair line above already carries
          the provenance glyph. */}
      <div className="trade-tabs">
        {TABS.map((x) => (
          <button
            key={x.id}
            className={`tab ${tab === x.id ? "active" : ""}`}
            onClick={() => tradePanelTab.set(x.id)}
          >
            {x.label}
          </button>
        ))}
      </div>
      {tab === "swap" ? (
        <SwapTab market={market} embedded />
      ) : pool.kind === "v2" ? (
        <AddV2
          key={poolIdentity(pool)}
          pool={pool}
          data={data}
          stat={props.stat}
          upUsd={props.upUsd}
          volumeWindow={props.volumeWindow}
        />
      ) : (
        <AddCl
          key={poolIdentity(pool)}
          pool={pool}
          data={data}
          stat={props.stat}
          upUsd={props.upUsd}
          wethUsd={props.wethUsd}
          volumeWindow={props.volumeWindow}
          recommendedPct={props.recommendation?.pct}
          recommendedCapitalUsd={props.recommendation?.capitalUsd}
          recommendedTicks={
            props.recommendation
              ? {
                  lower: props.recommendation.tickLower,
                  upper: props.recommendation.tickUpper,
                }
              : undefined
          }
          recommendationStatus={props.recommendation?.status}
        />
      )}
    </div>
  );
}

/** pool price, auto-oriented so the number is >= 1 (small prices flip quote/base) */
function PxCell(props: {
  sqrtPriceX96: bigint;
  d0: number;
  d1: number;
  s0: string;
  s1: string;
}) {
  const px = sqrtPriceToPrice(props.sqrtPriceX96, props.d0, props.d1);
  // absurd magnitudes = pool initialized at a nonsense price (usually zero liquidity)
  if (!Number.isFinite(px) || px <= 1e-15 || px >= 1e15)
    return <span className="dim">—</span>;
  const flip = px < 1;
  // the unit label is two more stranger-set names, in the column immediately
  // right of the pair — it widens this one exactly the way they widen that one
  const s0 = clampWidth(props.s0, SYMBOL_COLUMNS);
  const s1 = clampWidth(props.s1, SYMBOL_COLUMNS);
  return (
    <>
      <Flash v={flip ? 1 / px : px}>
        <span>{fmtNum(flip ? 1 / px : px)}</span>
      </Flash>{" "}
      <span className="dim" title={`${props.s1}/${props.s0}`}>
        {flip ? `${s0}/${s1}` : `${s1}/${s0}`}
      </span>
    </>
  );
}

// ---------------- add liquidity: v2 ----------------

export function AddV2({
  pool,
  data,
  stat,
  upUsd,
  volumeWindow = "h24",
}: {
  pool: V2Pool;
  data: PoolsData;
  stat?: PoolStat;
  upUsd?: number;
  volumeWindow?: VolumeWindow;
}) {
  const { t } = useTranslation();
  const { address: user } = useAccount();
  const t0 = tokenOf(data, pool.token0);
  const t1 = tokenOf(data, pool.token1);
  const [fund, setFund] = useState<"pair" | "zap">("zap");
  const [a0, setA0] = useState("");
  const [a1, setA1] = useState("");
  const [busy, setBusy] = useState(false);
  // A v2 pool names the chain's coin by its wrapper, and pair mode pulls
  // exactly that ERC-20. Read the native balance alongside so a wallet holding
  // the coin can wrap just the shortfall instead of reverting STF.
  const wrapped0 = pool.token0.toLowerCase() === ADDR.WNATIVE.toLowerCase();
  const wrapped1 = pool.token1.toLowerCase() === ADDR.WNATIVE.toLowerCase();
  const bal = useBalances(
    user,
    wrapped0 || wrapped1
      ? [pool.token0, pool.token1, NATIVE]
      : [pool.token0, pool.token1],
  );
  const rawBal0 = bal.data?.[pool.token0.toLowerCase()];
  const rawBal1 = bal.data?.[pool.token1.toLowerCase()];
  const rawNative = bal.data?.[NATIVE.toLowerCase()];
  // the coin the wallet can spare after gas — the wrap budget for a short side
  const nativeSpare =
    rawNative !== undefined
      ? rawNative > CHAIN.gasBuffer
        ? rawNative - CHAIN.gasBuffer
        : 0n
      : undefined;
  const amt0 = safeParse(a0, t0.decimals);
  const amt1 = safeParse(a1, t1.decimals);
  // what the typed amount needs beyond the wrapper already held (max one side
  // can be the wrapper in a pool, so at most one of these is nonzero)
  const short0 =
    wrapped0 && rawBal0 !== undefined && amt0 > rawBal0 ? amt0 - rawBal0 : 0n;
  const short1 =
    wrapped1 && rawBal1 !== undefined && amt1 > rawBal1 ? amt1 - rawBal1 : 0n;
  const wrapTotal = short0 + short1;
  const cover0 = (rawBal0 ?? 0n) + (wrapped0 ? (nativeSpare ?? 0n) : 0n);
  const cover1 = (rawBal1 ?? 0n) + (wrapped1 ? (nativeSpare ?? 0n) : 0n);
  const over0 = rawBal0 !== undefined && amt0 > cover0;
  const over1 = rawBal1 !== undefined && amt1 > cover1;

  const link = (v: string, is0: boolean) => {
    if (is0) setA0(v);
    else setA1(v);
    if (pool.reserve0 === 0n || pool.reserve1 === 0n) return;
    try {
      const amt = parseUnits(
        v === "" ? "0" : v,
        is0 ? t0.decimals : t1.decimals,
      );
      if (is0) {
        const other = (amt * pool.reserve1) / pool.reserve0;
        setA1(trim(formatUnits(other, t1.decimals)));
      } else {
        const other = (amt * pool.reserve0) / pool.reserve1;
        setA0(trim(formatUnits(other, t0.decimals)));
      }
    } catch {
      /* partial input */
    }
  };

  const sim = useMemo(
    () =>
      simulateV2Add({
        pool,
        amount0h: Number(a0) || 0,
        amount1h: Number(a1) || 0,
        dec0: t0.decimals,
        dec1: t1.decimals,
        stat,
        upUsd,
        volumeWindow,
      }),
    [pool, a0, a1, t0.decimals, t1.decimals, stat, upUsd, volumeWindow],
  );

  const uni2 = pool.protocol === "univ2";
  const router02 = v2UsesRouter02(pool);
  const router = v2LiquidityRouter(pool);

  const add = async () => {
    if (!user) return;
    const stakeAfter = autostake.get(); // captured at click, like the zap flow
    const deferInvalidation = stakeAfter && poolStakeable(pool) && !!pool.gauge;
    setBusy(true);
    try {
      if (amt0 === 0n || amt1 === 0n) return;
      // The router pulls the pool's exact ERC-20s and nothing else. A wallet
      // holding the chain's coin instead of its wrapper would revert STF at
      // the pull, so wrap just the shortfall first — never the whole typed
      // amount, the wrapper the wallet already holds is spent too.
      if (wrapTotal > 0n) {
        const wrapped = short0 > 0n ? t0.symbol : t1.symbol;
        const ok = await step(
          t("add.stWrap", {
            amt: fmtAmount(wrapTotal, CHAIN.nativeCurrency.decimals),
            native: CHAIN.nativeCurrency.symbol,
            wrapped,
          }),
          () =>
            writeContract(wagmiConfig, {
              account: user,
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
      if (!(await ensureAllowance(pool.token0, user, router, amt0, t0.symbol)))
        return;
      if (!(await ensureAllowance(pool.token1, user, router, amt1, t1.symbol)))
        return;
      let rcpt: TransactionReceipt | null;
      if (router02) {
        // vanilla Router02: no on-chain quote helper — amounts are already
        // reserve-ratio-linked by the UI, the router pins the optimal ratio
        // and the mins bound the drift since linking
        const call = buildV2AddLiquidityCall(pool, {
          amount0Desired: amt0,
          amount1Desired: amt1,
          amount0Min: applySlippage(amt0, SLIP_BPS),
          amount1Min: applySlippage(amt1, SLIP_BPS),
          recipient: user,
          deadline: deadline(),
        });
        rcpt = await step(
          t("add.stepAddV2", { pair: `${t0.symbol}/${t1.symbol}` }),
          () =>
            sendTransaction(wagmiConfig, {
              to: call.address,
              data: call.data,
              chainId: CHAIN_ID,
            }),
          { invalidate: deferInvalidation ? "none" : "liquidity" },
        );
      } else {
        const quote = await readContract(wagmiConfig, {
          abi: v2RouterAbi,
          address: ADDR.V2_ROUTER,
          functionName: "quoteAddLiquidity",
          args: [
            pool.token0,
            pool.token1,
            pool.stable,
            ADDR.V2_FACTORY,
            amt0,
            amt1,
          ],
          chainId: CHAIN_ID,
        });
        rcpt = await step(
          t("add.stepAdd", { pair: `${t0.symbol}/${t1.symbol}` }),
          () =>
            writeContract(wagmiConfig, {
              abi: v2RouterAbi,
              address: ADDR.V2_ROUTER,
              functionName: "addLiquidity",
              args: [
                pool.token0,
                pool.token1,
                pool.stable,
                amt0,
                amt1,
                applySlippage(quote[0], SLIP_BPS),
                applySlippage(quote[1], SLIP_BPS),
                user,
                deadline(),
              ],
              chainId: CHAIN_ID,
            }),
          { invalidate: deferInvalidation ? "none" : "liquidity" },
        );
      }
      // up33 v2 with a live gauge + pref on → stake the freshly minted LP
      // (uniswap v2 has no gauge, so poolStakeable gates it out cleanly)
      if (rcpt && deferInvalidation && pool.gauge) {
        let staked = false;
        try {
          const lp = receivedOf(rcpt, pool.address, user);
          if (lp > 0n)
            staked = await stakeV2Lp(
              pool.address,
              pool.gauge,
              lp,
              user,
              `${t0.symbol}/${t1.symbol}`,
            );
        } finally {
          if (!staked) invalidateTransactionState("liquidity");
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="expander">
      <FundSwitch fund={fund} onFund={setFund} />
      {fund === "zap" ? (
        <ZapPanel
          target={{ kind: "v2", pool }}
          t0={t0}
          t1={t1}
          stat={stat}
          upUsd={upUsd}
          volumeWindow={volumeWindow}
        />
      ) : (
        <>
          <AmountRow
            sym={t0.symbol}
            value={a0}
            onChange={(v) => link(v, true)}
            bal={rawBal0}
            dec={t0.decimals}
            onMax={(v) => link(v, true)}
            note={
              over0
                ? t("common.exceedsBalance")
                : short0 > 0n
                  ? t("add.wrapNote", {
                      amt: fmtAmount(short0, CHAIN.nativeCurrency.decimals),
                      native: CHAIN.nativeCurrency.symbol,
                      wrappedShort: t0.symbol,
                    })
                  : undefined
            }
          />
          <AmountRow
            sym={t1.symbol}
            value={a1}
            onChange={(v) => link(v, false)}
            bal={rawBal1}
            dec={t1.decimals}
            onMax={(v) => link(v, false)}
            note={
              over1
                ? t("common.exceedsBalance")
                : short1 > 0n
                  ? t("add.wrapNote", {
                      amt: fmtAmount(short1, CHAIN.nativeCurrency.decimals),
                      native: CHAIN.nativeCurrency.symbol,
                      wrappedShort: t1.symbol,
                    })
                  : undefined
            }
          />
          <AddStats sim={sim} emitless={uni2} volumeWindow={volumeWindow} />
          <div className="form-row">
            {/* where the LP token lands and what the mins are is reference, not
                instruction — it belongs to the button that does it, not to a
                line of prose sitting beside the button on every render */}
            <Btn
              busy={busy}
              onClick={add}
              disabled={!user || over0 || over1}
              title={`${t("add.v2Hint", { slip: SLIP_BPS / 100 })} · ${
                uni2
                  ? t("add.v2HintUni")
                  : t(FEATURES.emissions ? "add.v2HintUp33" : "add.v2HintHome")
              }`}
            >
              {t("add.addLiquidity")}
            </Btn>
            {poolStakeable(pool) && <StakeAfterToggle disabled={busy} />}
          </div>
        </>
      )}
    </div>
  );
}

/** PAIR = supply both tokens yourself · ZAP = fund with one token, the
 *  terminal swaps the right slice into the counter-token first */
export function FundSwitch(props: {
  fund: "pair" | "zap";
  onFund: (f: "pair" | "zap") => void;
  zapDisabled?: boolean;
  zapDisabledTip?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="form-row">
      <span className="lbl">{t("add.fund")}</span>
      <div className="seg">
        <button
          className={props.fund === "zap" ? "on" : ""}
          onClick={() => props.onFund("zap")}
          disabled={props.zapDisabled}
          title={props.zapDisabledTip ?? t("add.fundZapTip")}
        >
          {t("add.fundZap")}
        </button>
        <button
          className={props.fund === "pair" ? "on" : ""}
          onClick={() => props.onFund("pair")}
          title={t("add.fundPairTip")}
        >
          {t("add.fundPair")}
        </button>
      </div>
    </div>
  );
}

// ---------------- add liquidity: CL ----------------

// Five, not seven. ±2% sat between ±1 and ±5 and ±30 beside ±20, so two of the
// chips were only ever a rounding of a neighbour — and MORE's `± % …` reaches
// any width exactly, which is what someone who cares about the difference
// between 20% and 30% is going to type anyway.
//
// The `%` is carried separately because a phone drops it. Five segments in a
// row all ending in the same character is a column of noise, and ± before a
// bare number inside a control labelled RANGE is already a percent — this is
// the same reasoning that took the sign and the unit out of the numbers and
// put them in the label, one step further.
const PRESETS = [
  { id: "p05", label: "±0.5", pct: 0.005 },
  { id: "p1", label: "±1", pct: 0.01 },
  { id: "p5", label: "±5", pct: 0.05 },
  { id: "p10", label: "±10", pct: 0.1 },
  { id: "p20", label: "±20", pct: 0.2 },
] as const;

type RangeMode =
  | (typeof PRESETS)[number]["id"]
  | "full"
  | "pct"
  | "above"
  | "below"
  | "ticks";

/**
 * Ways to a band that a preset cannot reach, and the ONLY things left behind
 * MORE.
 *
 * PRICE used to be a fourth: two inputs for the two numbers the chart was
 * already printing under itself. Those numbers are the inputs now (see
 * LiquidityRange), which is one control where there were two — and the two
 * could disagree, since typing prices left the chart's own band untouched
 * until the mode was re-entered.
 *
 * What is left is genuinely not on the chart. A ONE-SIDED band is a different
 * shape, not a different width; a custom % is a width no chip rounds to; and
 * TICKS is the contract's own unit, for someone matching an existing position
 * exactly.
 */
const ADV_MODES = ["pct", "above", "below", "ticks"] as const;
type AdvMode = (typeof ADV_MODES)[number];
/** the three that carry an inline field, so hiding the row would hide the value */
const ADV_WITH_INPUT: RangeMode[] = ["pct", "above", "below"];

function symRange(tick: number, pct: number, spacing: number) {
  const d = tickDeltaForPct(pct);
  const lower = alignTick(tick - d, spacing, "floor");
  let upper = alignTick(tick + d, spacing, "ceil");
  if (upper <= lower) upper = lower + spacing;
  return { lower, upper };
}

export function AddCl({
  pool,
  data,
  stat,
  upUsd,
  wethUsd,
  volumeWindow = "h24",
  recommendedPct,
  recommendedCapitalUsd,
  recommendedTicks,
  recommendationStatus,
}: {
  pool: ClPool;
  data: PoolsData;
  stat?: PoolStat;
  upUsd?: number;
  wethUsd?: number | null;
  volumeWindow?: VolumeWindow;
  recommendedPct?: number;
  recommendedCapitalUsd?: number;
  recommendedTicks?: { lower: number; upper: number };
  recommendationStatus?: "recommended" | "observed";
}) {
  const { t } = useTranslation();
  const { address: user } = useAccount();
  const t0 = tokenOf(data, pool.token0);
  const t1 = tokenOf(data, pool.token1);
  const hookedV4 = v4HasHooks(pool);
  const [fund, setFund] = useState<"pair" | "zap">(hookedV4 ? "pair" : "zap");
  const recommendedPreset = PRESETS.find(
    (preset) =>
      Math.abs(preset.pct * 100 - (recommendedPct ?? -1)) < 1e-9,
  );
  const [mode, setMode] = useState<RangeMode>(
    recommendedTicks
      ? "ticks"
      : (recommendedPreset?.id ?? (recommendedPct ? "pct" : "p10")),
  );
  const [advOpen, setAdvOpen] = useState(false);
  const [pctStr, setPctStr] = useState(
    recommendedPct ? String(recommendedPct) : "10",
  );
  const [custom, setCustom] = useState<{ lower: string; upper: string }>({
    lower: recommendedTicks ? String(recommendedTicks.lower) : "",
    upper: recommendedTicks ? String(recommendedTicks.upper) : "",
  });
  const [a0, setA0] = useState("");
  const [a1, setA1] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!recommendedTicks) return;
    setCustom({
      lower: String(recommendedTicks.lower),
      upper: String(recommendedTicks.upper),
    });
    setMode("ticks");
    setAdvOpen(true);
  }, [recommendedTicks?.lower, recommendedTicks?.upper]);
  const addr0 = v4BalanceAddress(pool.token0);
  const addr1 = v4BalanceAddress(pool.token1);
  // A v3-family pool names the chain's coin by its wrapper, and pair mode
  // pulls exactly that ERC-20. Read the native balance alongside so a wallet
  // holding the coin can wrap just the shortfall instead of reverting STF.
  const wrapped0 = addr0.toLowerCase() === ADDR.WNATIVE.toLowerCase();
  const wrapped1 = addr1.toLowerCase() === ADDR.WNATIVE.toLowerCase();
  const bal = useBalances(
    user,
    wrapped0 || wrapped1 ? [addr0, addr1, NATIVE] : [addr0, addr1],
  );
  const rawBal0 = bal.data?.[addr0.toLowerCase()];
  const rawBal1 = bal.data?.[addr1.toLowerCase()];
  let bal0 = rawBal0;
  let bal1 = rawBal1;
  if (addr0 === NATIVE && rawBal0 !== undefined)
    bal0 = rawBal0 > CHAIN.gasBuffer ? rawBal0 - CHAIN.gasBuffer : 0n;
  if (addr1 === NATIVE && rawBal1 !== undefined)
    bal1 = rawBal1 > CHAIN.gasBuffer ? rawBal1 - CHAIN.gasBuffer : 0n;
  const rawNative = bal.data?.[NATIVE.toLowerCase()];
  // the coin the wallet can spare after gas — the wrap budget for a short side
  const nativeSpare =
    rawNative !== undefined
      ? rawNative > CHAIN.gasBuffer
        ? rawNative - CHAIN.gasBuffer
        : 0n
      : undefined;
  const amt0 = safeParse(a0, t0.decimals);
  const amt1 = safeParse(a1, t1.decimals);
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
  let mintHint = t("add.mintHintUni");
  if (pool.protocol === "home")
    mintHint = t(FEATURES.emissions ? "add.mintHintUp33" : "add.mintHintHome");
  else if (pool.protocol === "univ4") mintHint = t("add.mintHintV4");

  const ticks = useMemo(() => {
    const s = pool.tickSpacing;
    const preset = PRESETS.find((x) => x.id === mode);
    if (preset) return symRange(pool.tick, preset.pct, s);
    if (mode === "full") return fullRangeTicks(s);
    if (mode === "pct") {
      const pct = Number(pctStr) / 100;
      return pct > 0 ? symRange(pool.tick, pct, s) : null;
    }
    if (mode === "above" || mode === "below") {
      // one-sided: range starts at the current price and extends one way.
      // ABOVE deposits token0 only (sells into rises); BELOW token1 only.
      const pct = Number(pctStr) / 100;
      if (!(pct > 0)) return null;
      const d = tickDeltaForPct(pct);
      if (mode === "above") {
        const lower = alignTick(pool.tick, s, "ceil");
        let upper = alignTick(pool.tick + d, s, "ceil");
        if (upper <= lower) upper = lower + s;
        return { lower, upper };
      }
      const upper = alignTick(pool.tick, s, "floor");
      let lower = alignTick(pool.tick - d, s, "floor");
      if (lower >= upper) lower = upper - s;
      return { lower, upper };
    }
    const lo = parseInt(custom.lower, 10);
    const hi = parseInt(custom.upper, 10);
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo < hi)
      return {
        lower: alignTick(lo, s, "floor"),
        upper: alignTick(hi, s, "ceil"),
      };
    return null;
  }, [mode, pctStr, custom, pool.tick, pool.tickSpacing]);

  const advLabels: Record<AdvMode, { label: string; short: string; tip: string }> = {
    pct: {
      label: t("add.pctCustom"),
      short: t("add.pctCustomShort"),
      tip: t("add.pctCustomTip"),
    },
    above: {
      label: t("add.above"),
      short: t("add.aboveShort"),
      tip: t("add.aboveTip", { sym: t0.symbol }),
    },
    below: {
      label: t("add.below"),
      short: t("add.belowShort"),
      tip: t("add.belowTip", { sym: t1.symbol }),
    },
    ticks: {
      label: t("add.ticks"),
      short: t("add.ticksShort"),
      tip: t("add.ticksTip"),
    },
  };
  /**
   * Enter a custom mode carrying the band that is already on screen.
   *
   * TICKS used to arrive empty: the two fields were blank, so `ticks` was
   * null, so the chart — the thing the reader was looking at — vanished, and
   * with it the band they had spent the last minute placing. PRICE never did
   * this, because it seeded itself; the asymmetry was invisible while TICKS
   * was the fifth chip in a hidden row and is not now that it is a segment.
   */
  const enterMode = (m: AdvMode) => {
    if (m === "ticks") {
      const base = ticks ?? symRange(pool.tick, 0.1, pool.tickSpacing);
      setCustom({ lower: String(base.lower), upper: String(base.upper) });
    }
    setMode(m);
  };

  /** the word where there is room for it, the glyph where there is not */
  const advName = (m: AdvMode) => (
    <>
      <span className="hide-m">{advLabels[m].label}</span>
      <span className="show-m">{advLabels[m].short}</span>
    </>
  );
  /* The custom mode in effect, if any — what the summary chip names once the
     presets have gone dark.

     The row itself is a plain toggle with no pinning: nothing in it is the
     only copy of anything, because the band those controls produce is drawn on
     the chart either way. Which also means a drag, which lands in TICKS, does
     not unfold a row — the chip just starts saying TICKS, and the 44px stays
     with the chart the drag was aimed at. */
  const advMode = ADV_MODES.find((m) => m === mode);

  const below = ticks ? pool.tick < ticks.lower : false;
  const above = ticks ? pool.tick >= ticks.upper : false;

  /* The two amount boxes as one shape. Everything below is symmetric in which
     box is which, and naming the sides lets it say "the one being typed into"
     and "its partner" rather than re-deciding that at every step. */
  const sides = [
    { key: "amount0", cur: a0, set: setA0, dec: t0.decimals },
    { key: "amount1", cur: a1, set: setA1, dec: t1.decimals },
  ] as const;
  type AmountSide = (typeof sides)[number];

  /* Write an amount back only where it CHANGED. A band move that leaves a side
     alone must not renormalise the string in it — "0.100" reformatted to "0.1"
     under a reader's cursor reads as the app arguing with their typing. */
  const put = (side: AmountSide, next: bigint) => {
    if (safeParse(side.cur, side.dec) === next) return;
    side.set(next === 0n ? "0" : trim(formatUnits(next, side.dec)));
  };
  const applyPair = (p: Pair) => sides.forEach((side) => put(side, p[side.key]));

  /* Typing is how the position gets its SIZE: the box under the cursor keeps
     exactly the characters typed into it, and its partner follows the band. */
  const link = (v: string, is0: boolean) => {
    const which = is0 ? 0 : 1;
    const typed = sides[which];
    const partner = sides[which === 0 ? 1 : 0];
    typed.set(v);
    if (!ticks) return;
    let amt: bigint;
    try {
      amt = parseUnits(v === "" ? "0" : v, typed.dec);
    } catch {
      return; /* partial input — "0." on its way to "0.5" */
    }
    const p = pairFrom(pool.sqrtPriceX96, ticks.lower, ticks.upper, amt, which);
    put(partner, p[partner.key]);
    // Backstop. The input for a token the band cannot take is disabled, so
    // pairFrom moving the money across should be unreachable from here — but if
    // `disabled` and the band ever disagree, clear the box the deposit just
    // left rather than leave a number sitting on a side that mints nothing.
    if (amt > 0n && p[typed.key] === 0n) typed.set("0");
  };

  /* Dragging is how it gets its SHAPE, and shape alone: refitToBand holds the
     deposit's worth still and re-splits it, so a band move can neither strand
     the money on a token the band cannot take nor quietly resize the position
     (see lib/clDeposit for both failures). */
  useEffect(() => {
    if (!ticks) return;
    const held = {
      amount0: safeParse(a0, t0.decimals),
      amount1: safeParse(a1, t1.decimals),
    };
    if (held.amount0 === 0n && held.amount1 === 0n) return;
    applyPair(refitToBand(held, pool.sqrtPriceX96, ticks.lower, ticks.upper));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticks?.lower, ticks?.upper]);

  /** the biggest position the wallet can actually fund on this band */
  const takeMax = (limit0?: bigint, limit1?: bigint) => {
    if (!ticks) return;
    applyPair(
      largestFundable(
        pool.sqrtPriceX96,
        ticks.lower,
        ticks.upper,
        limit0,
        limit1,
      ),
    );
  };
  /* Sizing down to what is mintable measures against the coin the app will
     wrap for you, not just the wrapper already held. A balance that has not
     been read yet is passed on as undefined — read as zero it would bind, and
     one tap would empty the deposit. */
  const fitToBalances = () =>
    takeMax(
      bal0 === undefined ? undefined : cover0,
      bal1 === undefined ? undefined : cover1,
    );

  /* One line per amount row, in priority order: a band that will not take this
     token at all, then a balance the deposit has outgrown, then the wrap it
     will do on the way in. Hoisted out of the JSX so both rows are visibly the
     same rule — IncreasePanel states its pair the same way. */
  const noteFor = (
    inactive: string | false,
    over: boolean,
    short: bigint,
    sym: string,
  ): string | undefined => {
    if (inactive) return inactive;
    if (over) return t("add.overFit");
    if (short > 0n)
      return t("add.wrapNote", {
        amt: fmtAmount(short, CHAIN.nativeCurrency.decimals),
        native: CHAIN.nativeCurrency.symbol,
        wrappedShort: sym,
      });
    return undefined;
  };
  const note0 = noteFor(above && t("add.aboveNote"), over0, short0, t0.symbol);
  const note1 = noteFor(below && t("add.belowNote"), over1, short1, t1.symbol);

  /* What these amounts would actually mint. Zero is a deposit sitting on the
     token its band cannot take — the projection has nothing to say about it and
     the button below refuses it, rather than spending an approval on a mint
     that reverts at `require(liquidity > 0)`. */
  const liq = useMemo(() => {
    if (!ticks || (amt0 === 0n && amt1 === 0n)) return 0n;
    return pool.protocol === "univ4"
      ? v4IncreasePlan({
          sqrtP: pool.sqrtPriceX96,
          tickLower: ticks.lower,
          tickUpper: ticks.upper,
          amount0: amt0,
          amount1: amt1,
        })
      : pairLiquidity(pool.sqrtPriceX96, ticks.lower, ticks.upper, amt0, amt1);
  }, [ticks, amt0, amt1, pool]);

  const sim = useMemo(() => {
    if (!ticks || liq === 0n) return null;
    return simulateClAdd({
      pool,
      tickLower: ticks.lower,
      tickUpper: ticks.upper,
      liquidity: liq,
      amount0h: Number(a0) || 0,
      amount1h: Number(a1) || 0,
      dec0: t0.decimals,
      dec1: t1.decimals,
      stat,
      upUsd,
      wethUsd,
      volumeWindow,
    });
  }, [ticks, liq, a0, a1, pool, t0.decimals, t1.decimals, stat, upUsd, wethUsd, volumeWindow]);

  const mint = async () => {
    if (!user || !ticks) return;
    const stakeAfter = autostake.get(); // captured at click, like the zap flow
    const deferInvalidation = stakeAfter && poolStakeable(pool) && !!pool.gauge;
    setBusy(true);
    try {
      if (liq === 0n) return;
      // Every deposit path below pulls the pool's exact currencies. A wallet
      // holding the chain's coin instead of its wrapper would revert at the
      // pull (STF on v3, Permit2 on v4), so wrap just the shortfall first —
      // never the whole typed amount, the wrapper already held is spent too.
      if (wrapTotal > 0n) {
        const wrapped = short0 > 0n ? t0.symbol : t1.symbol;
        const ok = await step(
          t("add.stWrap", {
            amt: fmtAmount(wrapTotal, CHAIN.nativeCurrency.decimals),
            native: CHAIN.nativeCurrency.symbol,
            wrapped,
          }),
          () =>
            writeContract(wagmiConfig, {
              account: user,
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
      if (pool.protocol === "univ4") {
        await v4Deposit({
          target: {
            kind: "cl-mint",
            pool,
            tickLower: ticks.lower,
            tickUpper: ticks.upper,
          },
          user,
          amount0: amt0,
          amount1: amt1,
          symbol0: t0.symbol,
          symbol1: t1.symbol,
          label: t("add.stepMint", {
            kind: "v4",
            pair: `${t0.symbol}/${t1.symbol}`,
            lo: ticks.lower,
            hi: ticks.upper,
          }),
        });
        return;
      }
      // v3-family NPM addresses differ by venue; mint's struct follows whether
      // the active home CL keys pools by fee (Pancake) or spacing (Slipstream).
      const npm = clLiquidityNpm(pool);
      if (
        amt0 > 0n &&
        !(await ensureAllowance(pool.token0, user, npm, amt0, t0.symbol))
      )
        return;
      if (
        amt1 > 0n &&
        !(await ensureAllowance(pool.token1, user, npm, amt1, t1.symbol))
      )
        return;
      // fresh price + band-edge mins (see minAmountsForLiquidity) — avoids 'PS' reverts
      const sqrtP = await fetchSqrtPriceX96(pool.address);
      const sqrtA = getSqrtRatioAtTick(ticks.lower);
      const sqrtB = getSqrtRatioAtTick(ticks.upper);
      const fresh = getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, amt0, amt1);
      // The price can cross the band between the last render and this click,
      // which leaves the funded side the one the band no longer takes. Refuse
      // in the log rather than pay for a mint that reverts on arrival.
      if (fresh === 0n) {
        txlog.push("err", t("add.stNothingToMint"));
        return;
      }
      const mins = minAmountsForLiquidity(sqrtP, sqrtA, sqrtB, fresh, SLIP_BPS);
      const call = buildClMintCall(pool, {
        tickLower: ticks.lower,
        tickUpper: ticks.upper,
        amount0Desired: amt0,
        amount1Desired: amt1,
        amount0Min: mins.amount0Min,
        amount1Min: mins.amount1Min,
        recipient: user,
        deadline: deadline(),
      });
      const rcpt = await step(
        t("add.stepMint", {
          kind: pool.protocol === "univ3" ? "v3" : "CL",
          pair: `${t0.symbol}/${t1.symbol}`,
          lo: ticks.lower,
          hi: ticks.upper,
        }),
        () =>
          sendTransaction(wagmiConfig, {
            to: call.address,
            data: call.data,
            chainId: CHAIN_ID,
          }),
        { invalidate: deferInvalidation ? "none" : "liquidity" },
      );
      // continue into staking when the pool is stakeable and the pref is on —
      // the mint receipt carries the new tokenId, so it's exact, never a guess
      if (rcpt && deferInvalidation && pool.gauge) {
        let staked = false;
        try {
          const tokenId = mintedTokenId(rcpt, npm, user);
          if (tokenId !== null) staked = await stakeClNft(pool.gauge, npm, tokenId, user);
        } finally {
          if (!staked) invalidateTransactionState("liquidity");
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="expander add-cl">
      {recommendedPct != null && (
        <div
          className={`rec-applied mono-sm ${recommendationStatus === "observed" ? "amber" : "green"}`}
        >
          {t(
            recommendationStatus === "observed"
              ? "pools.recObservedApplied"
              : "pools.recApplied",
            {
              pct: recommendedPct,
              capital: fmtUsd(recommendedCapitalUsd ?? 0),
            },
          )}
        </div>
      )}
      {/* Two decisions, not one form: WHERE the band goes, and HOW MUCH goes
          into it. They are revised against each other — the fee APR on the
          right is the answer to the range on the left — and stacked they could
          not both be on screen, so choosing a range meant scrolling away from
          what it was worth. Under the split width they stack again, in this
          order. */}
      <div className="add-grid">
        <div className="add-col">
          {/* Six widths are ONE choice, so they are one object: a segment
              group draws a single border and hairline rules where six chips
              drew six outlines and five gaps. The pile ran 94px over two and a
              half rows on a 390px phone and four rows in the 400px trade
              column — most of what read as clutter was the frames, not the
              options in them. */}
          <div className="form-row range-row">
            <span className="lbl">{t("add.range")}</span>
            <div className="seg range-seg">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  className={mode === p.id ? "on" : ""}
                  onClick={() => setMode(p.id)}
                >
                  {p.label}
                  <span className="hide-m">%</span>
                </button>
              ))}
              <button
                className={mode === "full" ? "on" : ""}
                onClick={() => setMode("full")}
              >
                {t("add.full")}
              </button>
            </div>
            {/* One-sided, custom-% and raw ticks live behind this. It names the
                mode in effect rather than reading MORE while a custom band is
                loaded — the same summary-chip idea the slippage row uses, and
                once the presets have gone dark it is the only place the band's
                shape is stated at all. */}
            <button
              className={`chip ${advMode ? "on" : ""}`}
              onClick={() => setAdvOpen(!advOpen)}
              title={t("add.moreTip")}
              /* only where the face of the button is a glyph — naming it MORE
                 while it reads TICKS would announce a different control than
                 the one on screen */
              aria-label={advMode ? undefined : t("add.more")}
              aria-expanded={advOpen}
            >
              {advMode ? (
                <>
                  {advName(advMode)}
                  {/* the row it opens is directly underneath and either there
                      or not; the caret is a desktop nicety, and on a phone it
                      is 20px taken off the presets to say what is visible */}
                  <span className="hide-m"> {advOpen ? "▴" : "▾"}</span>
                </>
              ) : advOpen ? (
                "▴"
              ) : (
                "⋯"
              )}
            </button>
          </div>
          {advOpen && (
            <div className="form-row range-adv">
              <div className="seg">
                {ADV_MODES.map((m) => (
                  <button
                    key={m}
                    className={mode === m ? "on" : ""}
                    onClick={() => enterMode(m)}
                    title={advLabels[m].tip}
                    aria-label={advLabels[m].label}
                  >
                    {advName(m)}
                  </button>
                ))}
              </div>
              {ADV_WITH_INPUT.includes(mode) && (
                <>
                  <span className="dim">
                    {mode === "above" ? "+" : mode === "below" ? "−" : "±"}
                  </span>
                  <NumInput
                    value={pctStr}
                    onChange={setPctStr}
                    width={70}
                    placeholder="10"
                  />
                  <span className="dim">%</span>
                </>
              )}
              {mode === "ticks" && (
                <>
                  <NumInputSigned
                    value={custom.lower}
                    onChange={(v) => setCustom({ ...custom, lower: v })}
                    placeholder={t("add.tickLower")}
                  />
                  <NumInputSigned
                    value={custom.upper}
                    onChange={(v) => setCustom({ ...custom, upper: v })}
                    placeholder={t("add.tickUpper")}
                  />
                  <span className="dim mono-sm">
                    {t("add.spacing", { ts: pool.tickSpacing })}
                  </span>
                </>
              )}
            </div>
          )}
          {ticks && (
            /* A preset chip is a fast way to a round number; the chart is how you
               see whether that round number sits on the depth or beside it. Dragging
               lands in the same tick range the MORE panel edits by hand, so the two
               are one control reached two ways rather than two sources of truth. */
            <LiquidityRange
              pool={pool}
              tickLower={ticks.lower}
              tickUpper={ticks.upper}
              dec0={t0.decimals}
              dec1={t1.decimals}
              sym0={t0.symbol}
              sym1={t1.symbol}
              upUsd={upUsd}
              wethUsd={wethUsd}
              onChange={(lower, upper) => {
                setCustom({ lower: String(lower), upper: String(upper) });
                setMode("ticks");
              }}
            />
          )}
        </div>
        <div className="add-col">
          <FundSwitch
            fund={fund}
            onFund={setFund}
            zapDisabled={hookedV4}
            zapDisabledTip={hookedV4 ? t("add.mintHintV4Hooks") : undefined}
          />
          {fund === "zap" ? (
            ticks ? (
              <ZapPanel
                target={{
                  kind: "cl-mint",
                  pool,
                  tickLower: ticks.lower,
                  tickUpper: ticks.upper,
                }}
                t0={t0}
                t1={t1}
                stat={stat}
                upUsd={upUsd}
                wethUsd={wethUsd}
                volumeWindow={volumeWindow}
              />
            ) : (
              <div className="dim mono-sm">{t("add.setRangeFirst")}</div>
            )
          ) : (
            <>
              {/* MAX means the largest position the WALLET can fund, not the
                  whole of one balance — filling one side to the brim and
                  deriving the other lands over the second balance more often
                  than not, and nothing on screen then says how far to come
                  down. The same arithmetic is what the amber note offers when a
                  band change is what pushed a side over. */}
              <AmountRow
                sym={t0.symbol}
                value={a0}
                onChange={(v) => link(v, true)}
                bal={bal0}
                dec={t0.decimals}
                onMax={() => takeMax(bal0, bal1)}
                maxTip={t("add.maxTip")}
                disabled={above}
                note={note0}
                onNote={over0 && !above ? fitToBalances : undefined}
              />
              <AmountRow
                sym={t1.symbol}
                value={a1}
                onChange={(v) => link(v, false)}
                bal={bal1}
                dec={t1.decimals}
                onMax={() => takeMax(bal0, bal1)}
                maxTip={t("add.maxTip")}
                disabled={below}
                note={note1}
                onNote={over1 && !below ? fitToBalances : undefined}
              />
              <AddStats sim={sim} emitless={pool.protocol !== "home"} volumeWindow={volumeWindow} />
              <div className="form-row">
                <Btn
                  busy={busy}
                  onClick={mint}
                  disabled={!user || !ticks || liq === 0n || over0 || over1}
                  title={mintHint}
                >
                  {t("add.mint")}
                </Btn>
                {poolStakeable(pool) && <StakeAfterToggle disabled={busy} />}
                {hookedV4 && (
                  <span className="amber mono-sm">
                    {t("add.mintHintV4Hooks")}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------- shared bits ----------------

function NumInputSigned(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      className="input"
      style={{ width: 110 }}
      placeholder={props.placeholder}
      value={props.value}
      onChange={(e) => {
        const v = e.target.value;
        if (v === "" || /^-?\d*$/.test(v)) props.onChange(v);
      }}
    />
  );
}

function trim(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
function safeParse(s: string, dec: number): bigint {
  try {
    return parseUnits(s === "" ? "0" : s, dec);
  } catch {
    return 0n;
  }
}
