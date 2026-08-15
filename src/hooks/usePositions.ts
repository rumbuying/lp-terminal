import { useQuery } from "@tanstack/react-query";
import { getAddress, zeroAddress, type Address, type PublicClient } from "viem";
import {
  clFactoryAbi,
  clFarmAbi,
  clGaugeAbi,
  clPmAbi,
  clPoolAbi,
  erc20Abi,
  uniV2PairAbi,
  uniV3FactoryAbi,
  uniV3PmAbi,
  uniV3PoolAbi,
  v2GaugeAbi,
  v2PoolAbi,
} from "../abi";
import { ADDR, CHAIN_ID, CONNECTORS, EXPLORER, UNI } from "../config/addresses";
import { CHAIN } from "../config/chains";
import { ENV } from "../config/env";
import { FEATURES } from "../config/features";
import { HOME_CL_FEE_KEYED } from "../lib/homeCl";
import { mc, ok } from "../lib/multicall";
import {
  fetchV2FarmPositions,
  V2FarmKnownPositionReadError,
} from "../lib/v2Farm";
import {
  fetchV4Positions,
  mergeTokenInfoWithVerifiedV4,
} from "../lib/uniV4Positions";
import {
  connectorCandidates,
  isVenuePair,
  mergeV2ByPair,
  v2PairAddress,
  V2_SWEEP_VENUES,
  sortTokens,
  sweepVenueOf,
  type V2Candidate,
} from "../lib/v2Pairs";
import {
  MAX_UINT128,
  getAmountsForLiquidity,
  getSqrtRatioAtTick,
} from "../lib/clmath";
import { previewV2ClaimFees } from "../lib/v2Fees";
import { v2SupportsClaimFees } from "../lib/liquidityCalls";
import { enumerateOwnedNftIds } from "../lib/nftEnumeration";
import { publicRpcClient } from "../lib/publicRpcClient";
import {
  POSITION_DISCOVERY_QUERY_POLICY,
  positionQueryKey,
} from "../lib/positionLifecycle";
import type {
  ClPool,
  ClPosition,
  PoolsData,
  PositionsData,
  PositionSourceId,
  TokenInfo,
  V2Pool,
  V2Position,
} from "../types";
import { usePools } from "./usePools";

type RawPos = readonly [
  bigint, // nonce
  Address, // operator
  Address, // token0
  Address, // token1
  number, // tickSpacing
  number, // tickLower
  number, // tickUpper
  bigint, // liquidity
  bigint,
  bigint,
  bigint, // tokensOwed0
  bigint, // tokensOwed1
];

// same tuple shape as RawPos, but index 4 is the uint24 fee tier (univ3 NPMs
// are fee-keyed where Slipstream is tickSpacing-keyed)
type RawUniPos = RawPos;

/**
 * Uniswap v2 wallet positions. V2 LP is a plain ERC-20 — there is no NFT
 * enumeration like the NPMs, and the official factory holds 15k+ pairs
 * (mostly dust), so pair-side sweeps are out. Discover from the WALLET
 * instead: Blockscout lists the address's ERC-20 holdings in one call, and
 * every UNI-V2 entry is verified on-chain (factory() must be the official
 * deployment — a spoofed "Uniswap V2" token fails this) with balance,
 * reserves and supply read fresh. Blockscout being down hides univ2
 * positions for that refresh only — same degrade contract as the univ3
 * fetch below.
 */
async function fetchUniV2Positions(
  pc: PublicClient,
  user: Address,
): Promise<{ v2: V2Position[]; tokens: Record<string, TokenInfo> }> {
  type Held = {
    token?: { symbol?: string | null; address?: string; address_hash?: string };
    value?: string;
  };
  // Blockscout paginates (default 50/page): a wallet holding more than a page
  // of ERC-20s keeps its UNI-V2 LP past page 1 invisible unless the cursor is
  // followed. Capped so a pathological wallet cannot turn one refresh into an
  // unbounded crawl — ten pages is 500 holdings, far past any real LP wallet.
  const MAX_PAGES = 10;
  const held: Held[] = [];
  let query = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(
      `${EXPLORER}/api/v2/addresses/${user}/tokens?type=ERC-20${query}`,
      {
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) throw new Error(`blockscout ${res.status}`);
    const body = (await res.json()) as {
      items?: Held[];
      next_page_params?: Record<string, string | number> | null;
    };
    held.push(...(body.items ?? []));
    const next = body.next_page_params;
    if (!next || (body.items ?? []).length === 0) break;
    query =
      "&" + // the base URL already carries ?type=ERC-20 — a second ? would be swallowed into that value
      new URLSearchParams(
        Object.entries(next).map(([k, v]) => [k, String(v)]),
      ).toString();
  }
  const pairs = [
    ...new Set(
      held
        .filter(
          (it) => it.token?.symbol === "UNI-V2" && BigInt(it.value ?? "0") > 0n,
        )
        .map((it) =>
          (it.token?.address_hash ?? it.token?.address)?.toLowerCase(),
        )
        .filter((a): a is string => !!a),
    ),
  ] as Address[];
  if (pairs.length === 0) return { v2: [], tokens: {} };

  const det = await mc(
    pc,
    pairs.flatMap((p) => [
      { abi: uniV2PairAbi, address: p, functionName: "factory" },
      { abi: uniV2PairAbi, address: p, functionName: "token0" },
      { abi: uniV2PairAbi, address: p, functionName: "token1" },
      { abi: uniV2PairAbi, address: p, functionName: "getReserves" },
      { abi: uniV2PairAbi, address: p, functionName: "totalSupply" },
      {
        abi: uniV2PairAbi,
        address: p,
        functionName: "balanceOf",
        args: [user],
      },
    ]),
  );

  const v2: V2Position[] = [];
  pairs.forEach((p, j) => {
    const base = j * 6;
    const factory = ok<Address>(det[base]);
    const token0 = ok<Address>(det[base + 1]);
    const token1 = ok<Address>(det[base + 2]);
    const reserves = ok<readonly [bigint, bigint, number]>(det[base + 3]);
    const totalSupply = ok<bigint>(det[base + 4]) ?? 0n;
    const walletLp = ok<bigint>(det[base + 5]) ?? 0n;
    if (factory?.toLowerCase() !== UNI.V2_FACTORY.toLowerCase()) return;
    if (
      !token0 ||
      !token1 ||
      !reserves ||
      walletLp === 0n ||
      totalSupply === 0n
    )
      return;
    const pool: V2Pool = {
      kind: "v2",
      protocol: "univ2",
      address: p,
      token0,
      token1,
      stable: false,
      reserve0: reserves[0],
      reserve1: reserves[1],
      totalSupply,
      gaugeTotalSupply: 0n,
      feeBps: 30, // uniswap v2 flat 0.30%, rolled into reserves
      gauge: null,
      gaugeAlive: false,
      weight: 0n,
      rewardRate: 0n,
      periodFinish: 0n,
    };
    v2.push({
      pool,
      walletLp,
      stakedLp: 0n,
      earned: 0n,
      claimable0: 0n,
      claimable1: 0n,
      amount0: (walletLp * reserves[0]) / totalSupply,
      amount1: (walletLp * reserves[1]) / totalSupply,
    });
  });

  // erc20 metadata for pair tokens outside the UP33 registry, so any pair
  // renders with real symbols/decimals
  const tokens: Record<string, TokenInfo> = {};
  const uniq = [...new Set(v2.flatMap((r) => [r.pool.token0, r.pool.token1]))];
  const meta = await mc(
    pc,
    uniq.flatMap((a) => [
      { abi: erc20Abi, address: a, functionName: "symbol" },
      { abi: erc20Abi, address: a, functionName: "decimals" },
    ]),
  );
  uniq.forEach((a, j) => {
    tokens[a.toLowerCase()] = {
      address: a,
      symbol: ok<string>(meta[j * 2]) ?? a.slice(0, 6) + "…",
      decimals: ok<number>(meta[j * 2 + 1]) ?? 18,
    };
  });
  return { v2, tokens };
}

const DS = ENV.proxied ? "/dexscreener" : "https://api.dexscreener.com";
/** liquid pairs taken from DexScreener per refresh, on top of the derived floor */
const SWEEP_CAP = 60;
/** counterparty tokens crossed with the connectors — each is a free derivation,
 *  and a pair that was never deployed simply has no code to answer */
const COUNTERPARTY_CAP = 40;
const SWEEP_CANDIDATE_TTL_MS = 5 * 60_000;

type SweepCandidateCache = {
  at: number;
  promise: Promise<V2Candidate[]>;
};
const sweepCandidateCache = new Map<number, SweepCandidateCache>();

/** Explicit diagnostics/tests can force the next wallet read to rebuild it. */
export function resetV2SweepCandidateCache(): void {
  sweepCandidateCache.clear();
}

/**
 * Candidate v2 pairs to ask about, on a chain where nothing can be asked.
 *
 * Two sources, and neither is trusted on its word. The CONNECTOR FLOOR is
 * derived offline from the chain config, so the most ordinary LP on the chain
 * stays visible with every data API unreachable. DexScreener then adds the
 * pairs that actually carry liquidity — but only as a SUGGESTION: each one is
 * re-derived by CREATE2 from the tokens it claims to hold, and an address that
 * is not the one the factory would have deployed to never joins the set.
 *
 * Note there is no label filter. DexScreener's version labels are inconsistent
 * per chain and requiring one has already cost this codebase a venue; CREATE2
 * is the stronger gate anyway, since a v3 pool or an impostor cannot occupy an
 * address only the v2 factory can deploy to.
 */
async function loadSweepCandidates(): Promise<V2Candidate[]> {
  const byAddress = new Map<string, V2Candidate>();
  for (const c of connectorCandidates())
    byAddress.set(c.address.toLowerCase(), c);

  type DsTok = { address?: string };
  type DsPair = {
    chainId?: string;
    dexId?: string;
    pairAddress?: string;
    baseToken?: DsTok;
    quoteToken?: DsTok;
    liquidity?: { usd?: number };
  };
  const responses = await Promise.allSettled(
    CONNECTORS.map(async (token) => {
      const r = await fetch(
        `${DS}/token-pairs/v1/${CHAIN.slugs.dexscreener}/${token}`,
        {
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!r.ok) throw new Error(`dexscreener ${r.status}`);
      return (await r.json()) as unknown;
    }),
  );

  const ranked: { candidate: V2Candidate; liq: number }[] = [];
  // Counterparties worth deriving against, from the same responses. The pairs
  // DexScreener returns per token are capped and dominated by v3, so a venue's
  // largest v2 pair can be missing from them entirely — CAKE/WBNB was. Its
  // TOKENS are still in there, and a pair address costs nothing to derive, so
  // the counterparty set is what the pair list cannot be: complete over the
  // tokens we saw.
  const counterparties = new Map<string, number>();
  for (const res of responses) {
    if (res.status !== "fulfilled") continue;
    const arr: DsPair[] = Array.isArray(res.value)
      ? (res.value as DsPair[])
      : ((res.value as { pairs?: DsPair[] })?.pairs ?? []);
    for (const p of arr) {
      if (p?.chainId !== CHAIN.slugs.dexscreener) continue;
      const rawLiq = Number(p.liquidity?.usd);
      const liq = Number.isFinite(rawLiq) ? rawLiq : 0;
      for (const t of [p.baseToken?.address, p.quoteToken?.address]) {
        if (!t) continue;
        const key = t.toLowerCase();
        if (liq > (counterparties.get(key) ?? 0)) counterparties.set(key, liq);
      }
      const venue = sweepVenueOf(p.dexId);
      const pair = p.pairAddress;
      const a = p.baseToken?.address;
      const b = p.quoteToken?.address;
      if (!venue || !pair || !a || !b) continue;
      // the gate: only an address the factory itself could have produced
      if (!isVenuePair(venue, pair as Address, a as Address, b as Address))
        continue;
      const [token0, token1] = sortTokens(a as Address, b as Address);
      ranked.push({
        candidate: { venue, address: getAddress(pair), token0, token1 },
        liq,
      });
    }
  }
  ranked.sort((x, y) => y.liq - x.liq);
  for (const { candidate } of ranked.slice(0, SWEEP_CAP)) {
    byAddress.set(candidate.address.toLowerCase(), candidate);
  }

  // Derive connector×counterparty on every venue. A pair that was never
  // deployed has no code, so its balanceOf simply fails and the candidate
  // drops out — nothing has to know in advance which of these exist.
  const tops = [...counterparties.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, COUNTERPARTY_CAP)
    .map(([a]) => a as Address);
  for (const venue of V2_SWEEP_VENUES) {
    for (const connector of CONNECTORS) {
      for (const other of tops) {
        if (other === connector.toLowerCase()) continue;
        const [token0, token1] = sortTokens(connector, other);
        const address = v2PairAddress(venue, token0, token1);
        const key = address.toLowerCase();
        if (!byAddress.has(key))
          byAddress.set(key, { venue, address, token0, token1 });
      }
    }
  }
  return [...byAddress.values()];
}

/**
 * Candidate identities are user-independent, so account switches share them.
 * Wallet balance, reserves and supply are never cached: a transaction-triggered
 * positions refresh still sees changed LP immediately. Newly created pairs join
 * on the next five-minute discovery window.
 */
function sweepCandidates(): Promise<V2Candidate[]> {
  const now = Date.now();
  const hit = sweepCandidateCache.get(CHAIN_ID);
  if (hit && now - hit.at < SWEEP_CANDIDATE_TTL_MS) return hit.promise;

  let promise: Promise<V2Candidate[]>;
  promise = loadSweepCandidates().catch((error: unknown) => {
    if (sweepCandidateCache.get(CHAIN_ID)?.promise === promise)
      sweepCandidateCache.delete(CHAIN_ID);
    throw error;
  });
  sweepCandidateCache.set(CHAIN_ID, { at: now, promise });
  return promise;
}

/**
 * v2 LP found by sweeping derived pairs, for a chain with no holder-balance
 * endpoint to enumerate instead.
 *
 * The candidate's tokens need no on-chain confirmation: the address itself
 * proves them, since only these two tokens hash to it under this factory. So
 * the reads are the state that actually moves — balance, reserves, supply.
 */
async function fetchV2SweepPositions(
  pc: PublicClient,
  user: Address,
): Promise<{ v2: V2Position[]; tokens: Record<string, TokenInfo> }> {
  const candidates = await sweepCandidates();
  if (candidates.length === 0) return { v2: [], tokens: {} };

  const balances = await mc(
    pc,
    candidates.map((c) => ({
      abi: uniV2PairAbi,
      address: c.address,
      functionName: "balanceOf",
      args: [user],
    })),
  );
  const held = candidates
    .map((candidate, i) => ({
      candidate,
      walletLp: ok<bigint>(balances[i]) ?? 0n,
    }))
    .filter(({ walletLp }) => walletLp > 0n);
  if (held.length === 0) return { v2: [], tokens: {} };

  const det = await mc(
    pc,
    held.flatMap(({ candidate }) => [
      {
        abi: uniV2PairAbi,
        address: candidate.address,
        functionName: "getReserves",
      },
      {
        abi: uniV2PairAbi,
        address: candidate.address,
        functionName: "totalSupply",
      },
    ]),
  );

  const v2: V2Position[] = [];
  held.forEach(({ candidate, walletLp }, j) => {
    const reserves = ok<readonly [bigint, bigint, number]>(det[j * 2]);
    const totalSupply = ok<bigint>(det[j * 2 + 1]) ?? 0n;
    if (!reserves || totalSupply === 0n) return;
    const pool: V2Pool = {
      kind: "v2",
      protocol: candidate.venue.protocol,
      address: candidate.address,
      token0: candidate.token0,
      token1: candidate.token1,
      stable: false,
      reserve0: reserves[0],
      reserve1: reserves[1],
      totalSupply,
      gaugeTotalSupply: 0n,
      feeBps: candidate.venue.feeBps,
      gauge: null,
      gaugeAlive: false,
      weight: 0n,
      rewardRate: 0n,
      periodFinish: 0n,
    };
    v2.push({
      pool,
      walletLp,
      stakedLp: 0n,
      earned: 0n,
      claimable0: 0n,
      claimable1: 0n,
      amount0: (walletLp * reserves[0]) / totalSupply,
      amount1: (walletLp * reserves[1]) / totalSupply,
    });
  });

  const tokens: Record<string, TokenInfo> = {};
  const uniq = [...new Set(v2.flatMap((r) => [r.pool.token0, r.pool.token1]))];
  const meta = await mc(
    pc,
    uniq.flatMap((a) => [
      { abi: erc20Abi, address: a, functionName: "symbol" },
      { abi: erc20Abi, address: a, functionName: "decimals" },
    ]),
  );
  uniq.forEach((a, j) => {
    tokens[a.toLowerCase()] = {
      address: a,
      symbol: ok<string>(meta[j * 2]) ?? a.slice(0, 6) + "…",
      decimals: ok<number>(meta[j * 2 + 1]) ?? 18,
    };
  });
  return { v2, tokens };
}

/**
 * A v3-shaped CLMM venue: fee-keyed pools, Uniswap-v3 NPM and factory ABIs.
 *
 * `farm` is set for the pass that reads positions the user has STAKED. Staking
 * transfers the NFT, so those positions are enumerated against the farm — the
 * NPM would report the farm as their owner and never mention the user.
 */
type V3Venue = {
  npm: Address;
  factory: Address;
  protocol: "univ3" | "home";
  farm?: { address: Address; reward: { symbol: string; decimals: number } };
};

/**
 * Positions on a FEE-KEYED CLMM. Pools are discovered per position via
 * factory.getPool and read fresh (slot0/liquidity/tickSpacing); tokens outside
 * the home registry get erc20 metadata fetched so any pair renders correctly.
 *
 * Runs once per (venue, custodian) the chain has: Uniswap's NPM always, plus
 * the home DEX where that is fee-keyed too (PancakeSwap on BSC), plus its farm
 * where it has one. A tick-spacing-keyed home CL cannot use this path — its
 * positions() returns a spacing where this reads a fee — and is handled by the
 * Slipstream passes in fetchPositions.
 *
 * WHERE THE IDS COME FROM is the only thing the farm changes. A staked NFT's
 * position state still lives on the NPM — staking moves custody, not state —
 * so `positions()` is read from the NPM either way.
 */
async function fetchV3VenuePositions(
  pc: PublicClient,
  user: Address,
  pools: PoolsData,
  venue: V3Venue,
): Promise<{ cl: ClPosition[]; tokens: Record<string, TokenInfo> }> {
  const none = { cl: [], tokens: {} };
  // the farm holds the NFTs it has been staked, so it is the only contract that
  // still answers "which of these belong to this user"
  const custodian = venue.farm?.address ?? venue.npm;
  const cntRes = await mc(pc, [
    {
      abi: uniV3PmAbi,
      address: custodian,
      functionName: "balanceOf",
      args: [user],
    },
  ]);
  const count = ok<bigint>(cntRes[0]) ?? 0n;
  if (count === 0n) return none;

  // Keep each RPC/multicall and its temporary descriptors bounded, but walk
  // the full owner index. A failed index rejects this refresh rather than
  // making a wallet/farm with >100 NFTs look complete when it is not.
  const ids = await enumerateOwnedNftIds(count, async (indices) => {
    const rows = await mc(
      pc,
      indices.map((index) => ({
        abi: uniV3PmAbi,
        address: custodian,
        functionName: "tokenOfOwnerByIndex",
        args: [user, index],
      })),
    );
    return rows.map((row) => ok<bigint>(row));
  });
  if (ids.length === 0) return none;

  const posRes = await mc(pc, [
    ...ids.map((id) => ({
      abi: uniV3PmAbi,
      address: venue.npm,
      functionName: "positions",
      args: [id],
    })),
    ...(venue.farm
      ? ids.map((id) => ({
          abi: clFarmAbi,
          address: venue.farm!.address,
          functionName: "pendingCake",
          args: [id],
        }))
      : []),
  ]);
  const raws = ids
    .map((id, j) => ({
      id,
      raw: ok<RawUniPos>(posRes[j]),
      reward: venue.farm ? (ok<bigint>(posRes[ids.length + j]) ?? 0n) : 0n,
    }))
    .filter((x): x is { id: bigint; raw: RawUniPos; reward: bigint } => !!x.raw)
    // drop empty NFTs (closed positions linger), but never one still owed a
    // reward — a fully withdrawn farm position can hold unclaimed CAKE
    .filter(
      ({ raw, reward }) =>
        raw[7] > 0n || raw[10] > 0n || raw[11] > 0n || reward > 0n,
    );
  if (raws.length === 0) return none;

  // resolve each distinct (token0, token1, fee) to its pool address
  const poolKeys = new Map<
    string,
    { token0: Address; token1: Address; fee: number }
  >();
  for (const { raw } of raws) {
    poolKeys.set(`${raw[2].toLowerCase()}|${raw[3].toLowerCase()}|${raw[4]}`, {
      token0: raw[2],
      token1: raw[3],
      fee: raw[4],
    });
  }
  const keys = [...poolKeys.entries()];
  const addrRes = await mc(
    pc,
    keys.map(([, k]) => ({
      abi: uniV3FactoryAbi,
      address: venue.factory,
      functionName: "getPool",
      args: [k.token0, k.token1, k.fee],
    })),
  );

  // pool state + erc20 metadata for tokens the UP33 registry doesn't know
  const unknownTokens = new Set<string>();
  for (const [, k] of keys) {
    for (const t of [k.token0, k.token1]) {
      if (!pools.tokens[t.toLowerCase()]) unknownTokens.add(t.toLowerCase());
    }
  }
  const tokenList = [...unknownTokens] as Address[];
  const poolAddrs = keys.map(([,], i) => ok<Address>(addrRes[i]));
  const stateCalls: unknown[] = poolAddrs.flatMap((a) =>
    a
      ? [
          { abi: uniV3PoolAbi, address: a, functionName: "slot0" },
          { abi: uniV3PoolAbi, address: a, functionName: "liquidity" },
          { abi: uniV3PoolAbi, address: a, functionName: "tickSpacing" },
        ]
      : [],
  );
  const metaCalls: unknown[] = tokenList.flatMap((t) => [
    { abi: erc20Abi, address: t, functionName: "symbol" },
    { abi: erc20Abi, address: t, functionName: "decimals" },
  ]);
  const r = await mc(pc, [...stateCalls, ...metaCalls]);

  const poolByKey = new Map<string, ClPool>();
  let ri = 0;
  keys.forEach(([key, k], i) => {
    const address = poolAddrs[i];
    if (!address) return;
    const s0 = ok<
      readonly [bigint, number, number, number, number, number, boolean]
    >(r[ri]);
    const liquidity = ok<bigint>(r[ri + 1]) ?? 0n;
    const tickSpacing = ok<number>(r[ri + 2]) ?? 0;
    ri += 3;
    if (!s0) return;
    poolByKey.set(key, {
      kind: "cl",
      protocol: venue.protocol,
      address,
      token0: k.token0,
      token1: k.token1,
      tickSpacing,
      feePpm: k.fee, // univ3 fee unit (hundredths of a bip) == ppm
      unstakedFeePpm: 0,
      sqrtPriceX96: s0[0],
      tick: s0[1],
      liquidity,
      stakedLiquidity: 0n,
      gauge: null,
      gaugeAlive: false,
      weight: 0n,
      rewardRate: 0n,
      periodFinish: 0n,
    });
  });
  const tokens: Record<string, TokenInfo> = {};
  tokenList.forEach((t, i) => {
    const base = stateCalls.length + i * 2;
    tokens[t.toLowerCase()] = {
      address: t,
      symbol: ok<string>(r[base]) ?? t.slice(0, 6) + "…",
      decimals: ok<number>(r[base + 1]) ?? 18,
    };
  });

  const cl: ClPosition[] = [];
  for (const { id, raw, reward } of raws) {
    const pool = poolByKey.get(
      `${raw[2].toLowerCase()}|${raw[3].toLowerCase()}|${raw[4]}`,
    );
    if (!pool) continue;
    const { amount0, amount1 } = getAmountsForLiquidity(
      pool.sqrtPriceX96,
      getSqrtRatioAtTick(raw[5]),
      getSqrtRatioAtTick(raw[6]),
      raw[7],
    );
    cl.push({
      tokenId: id,
      pool,
      tickLower: raw[5],
      tickUpper: raw[6],
      liquidity: raw[7],
      staked: !!venue.farm,
      amount0,
      amount1,
      fees0: raw[10],
      fees1: raw[11],
      // `earned` is the emissions protocol's UP and stays zero here; a farm
      // reward is a different token and travels in its own field
      earned: 0n,
      ...(venue.farm
        ? {
            farm: {
              reward,
              symbol: venue.farm.reward.symbol,
              decimals: venue.farm.reward.decimals,
            },
          }
        : {}),
    });
  }
  return { cl, tokens };
}

async function fetchPositions(
  pc: PublicClient,
  user: Address,
  pools: PoolsData,
): Promise<PositionsData> {
  // Every venue reader degrades to empty on failure so one down API cannot
  // blank the page — but each failure is RECORDED. "Fewer positions than
  // expected" with a warning chip is honest; "fewer positions" presented as
  // the whole truth is a lie by omission.
  const failed = new Set<PositionSourceId>();
  type ClRead = { cl: ClPosition[]; tokens: Record<string, TokenInfo> };
  type V2Read = { v2: V2Position[]; tokens: Record<string, TokenInfo> };
  const orEmpty =
    <T extends ClRead | V2Read>(source: PositionSourceId, empty: T) =>
    (p: Promise<T>): Promise<T> =>
      p.catch(() => {
        failed.add(source);
        return empty;
      });

  // v3-shaped venues discover concurrently with the Slipstream passes below
  const uniP = orEmpty<ClRead>("univ3", { cl: [], tokens: {} })(
    fetchV3VenuePositions(pc, user, pools, {
      npm: UNI.V3_NPM,
      factory: UNI.V3_FACTORY,
      protocol: "univ3",
    }),
  );
  // A fee-keyed home DEX (PancakeSwap) reads through the same path, against
  // its own NPM and factory. Where the home CL is tick-spacing-keyed this stays
  // empty and the Slipstream passes below own those positions instead.
  const homeP = HOME_CL_FEE_KEYED
    ? orEmpty<ClRead>("homeCl", { cl: [], tokens: {} })(
        fetchV3VenuePositions(pc, user, pools, {
          npm: ADDR.CL_PM,
          factory: ADDR.CL_FACTORY,
          protocol: "home",
        }),
      )
    : Promise.resolve({
        cl: [] as ClPosition[],
        tokens: {} as Record<string, TokenInfo>,
      });
  // The same venue again, asked of its FARM. Staking transfers the NFT, so a
  // farmed position answers to neither pass above — the NPM names the farm as
  // its owner, and the farm is where the depositor is still recorded. Without
  // this pass every staked position on the chain reads as nonexistent.
  const homeFarmP =
    HOME_CL_FEE_KEYED && CHAIN.homeClFarm
      ? orEmpty<ClRead>("homeClFarm", { cl: [], tokens: {} })(
          fetchV3VenuePositions(pc, user, pools, {
            npm: ADDR.CL_PM,
            factory: ADDR.CL_FACTORY,
            protocol: "home",
            farm: CHAIN.homeClFarm,
          }),
        )
      : Promise.resolve({
          cl: [] as ClPosition[],
          tokens: {} as Record<string, TokenInfo>,
        });
  // Uniswap v2 LPs are found by enumerating the holder's ERC-20 balances,
  // which only Blockscout's REST API exposes — an Etherscan-family explorer
  // has no equivalent, so those chains show v3 positions only.
  // Ask the wallet what it holds where that is possible; sweep derived pairs
  // where it is not. Never both — the explorer answer is a superset.
  const uniV2P = FEATURES.v2PositionsFromExplorer
    ? orEmpty<V2Read>("univ2", { v2: [], tokens: {} })(fetchUniV2Positions(pc, user))
    : FEATURES.v2PositionsFromSweep
      ? orEmpty<V2Read>("v2Sweep", { v2: [], tokens: {} })(
          fetchV2SweepPositions(pc, user),
        )
      : Promise.resolve({
          v2: [] as V2Position[],
          tokens: {} as Record<string, TokenInfo>,
        });
  // Staked v2 LP, which neither reader above can see: staking transfers the LP
  // token, so the wallet's balance is genuinely zero and only the farm still
  // knows whose deposit it is. Runs alongside them, never instead.
  const v2FarmP: Promise<
    | { v2: V2Position[]; tokens: Record<string, TokenInfo> }
    | { fatal: V2FarmKnownPositionReadError }
  > =
    FEATURES.v2StakedFromFarm && CHAIN.homeV2Farm
      ? fetchV2FarmPositions(pc, user, CHAIN.homeV2Farm).catch((error) => {
          if (error instanceof V2FarmKnownPositionReadError)
            return { fatal: error };
          failed.add("v2Farm");
          return { v2: [], tokens: {} };
        })
      : Promise.resolve({
          v2: [] as V2Position[],
          tokens: {} as Record<string, TokenInfo>,
        });
  // Uniswap v4, the one venue whose positions no contract can enumerate. The
  // index names candidate token ids; the PositionManager decides whose they
  // are. Unreachable index means no v4 positions for this refresh, same degrade
  // contract as every other reader here.
  const v4P = FEATURES.v4Positions
    ? orEmpty<ClRead>("univ4", { cl: [], tokens: {} })(fetchV4Positions(pc, user))
    : Promise.resolve({
        cl: [] as ClPosition[],
        tokens: {} as Record<string, TokenInfo>,
      });
  const clPools = pools.pools.filter((p): p is ClPool => p.kind === "cl");
  const v2Pools = pools.pools.filter((p): p is V2Pool => p.kind === "v2");
  const clGauges = clPools.filter((p) => p.gauge);

  // pass 1: counts + per-pool balances
  const pass1: unknown[] = [
    {
      abi: clPmAbi,
      address: ADDR.CL_PM,
      functionName: "balanceOf",
      args: [user],
    },
    ...clGauges.map((p) => ({
      abi: clGaugeAbi,
      address: p.gauge!,
      functionName: "stakedValues",
      args: [user],
    })),
    ...v2Pools.flatMap((p) => [
      {
        abi: v2PoolAbi,
        address: p.address,
        functionName: "balanceOf",
        args: [user],
      },
      {
        abi: v2PoolAbi,
        address: p.address,
        functionName: "claimable0",
        args: [user],
      },
      {
        abi: v2PoolAbi,
        address: p.address,
        functionName: "claimable1",
        args: [user],
      },
      ...(p.gauge
        ? [
            {
              abi: v2GaugeAbi,
              address: p.gauge,
              functionName: "balanceOf",
              args: [user],
            },
            {
              abi: v2GaugeAbi,
              address: p.gauge,
              functionName: "earned",
              args: [user],
            },
          ]
        : []),
    ]),
  ];
  const r1 = await mc(pc, pass1);
  let idx = 0;
  const walletCount = ok<bigint>(r1[idx++]) ?? 0n;
  const stakedIdsByGauge: { pool: ClPool; ids: bigint[] }[] = [];
  for (const p of clGauges) {
    const ids = ok<readonly bigint[]>(r1[idx++]) ?? [];
    if (ids.length) stakedIdsByGauge.push({ pool: p, ids: [...ids] });
  }
  const v2Raw: {
    pool: V2Pool;
    walletLp: bigint;
    claimable0: bigint;
    claimable1: bigint;
    stakedLp: bigint;
    earned: bigint;
  }[] = [];
  for (const p of v2Pools) {
    const walletLp = ok<bigint>(r1[idx++]) ?? 0n;
    const claimable0 = ok<bigint>(r1[idx++]) ?? 0n;
    const claimable1 = ok<bigint>(r1[idx++]) ?? 0n;
    let stakedLp = 0n;
    let earned = 0n;
    if (p.gauge) {
      stakedLp = ok<bigint>(r1[idx++]) ?? 0n;
      earned = ok<bigint>(r1[idx++]) ?? 0n;
    }
    if (
      walletLp > 0n ||
      stakedLp > 0n ||
      claimable0 > 0n ||
      claimable1 > 0n ||
      earned > 0n
    ) {
      v2Raw.push({
        pool: p,
        walletLp,
        claimable0,
        claimable1,
        stakedLp,
        earned,
      });
    }
  }

  // pass 2: wallet tokenIds
  const walletIds = await enumerateOwnedNftIds(walletCount, async (indices) => {
    const rows = await mc(
      pc,
      indices.map((index) => ({
        abi: clPmAbi,
        address: ADDR.CL_PM,
        functionName: "tokenOfOwnerByIndex",
        args: [user, index],
      })),
    );
    return rows.map((row) => ok<bigint>(row));
  });

  // pass 3: position structs (+ earned for staked)
  const stakedFlat = stakedIdsByGauge.flatMap(({ pool, ids }) =>
    ids.map((id) => ({ pool, id })),
  );
  const pass3: unknown[] = [
    ...walletIds.map((id) => ({
      abi: clPmAbi,
      address: ADDR.CL_PM,
      functionName: "positions",
      args: [id],
    })),
    ...stakedFlat.flatMap(({ pool, id }) => [
      {
        abi: clPmAbi,
        address: ADDR.CL_PM,
        functionName: "positions",
        args: [id],
      },
      {
        abi: clGaugeAbi,
        address: pool.gauge!,
        functionName: "earned",
        args: [user, id],
      },
    ]),
  ];
  const r3 = await mc(pc, pass3);

  const poolByKey = new Map<string, ClPool>();
  for (const p of clPools) {
    poolByKey.set(
      `${p.token0.toLowerCase()}|${p.token1.toLowerCase()}|${p.tickSpacing}`,
      p,
    );
  }
  const findPool = (raw: RawPos): ClPool | undefined =>
    poolByKey.get(`${raw[2].toLowerCase()}|${raw[3].toLowerCase()}|${raw[4]}`);

  const missedTokens: Record<string, TokenInfo> = {};

  // A position minted into a pool the CATALOG has not reached (enumeration is
  // capped — pool 601 exists whether the catalog got there or not) used to be
  // dropped on the floor at `buildPos`, invisibly, until the pools query's own
  // refresh happened to cover it. Resolve a miss fresh, the way the univ3
  // venue path always does: the factory names the pool, the pool names its own
  // state. gaugeAlive stays false — a conservative "shown, stake action held"
  // rather than a guess at the voter's liveness.
  const missedKeys = new Map<
    string,
    { token0: Address; token1: Address; tickSpacing: number }
  >();
  const noteMiss = (raw: RawPos | undefined) => {
    if (!raw) return;
    const key = `${raw[2].toLowerCase()}|${raw[3].toLowerCase()}|${raw[4]}`;
    if (!poolByKey.has(key))
      missedKeys.set(key, {
        token0: raw[2],
        token1: raw[3],
        tickSpacing: raw[4],
      });
  };
  walletIds.forEach((_, j) => noteMiss(ok<RawPos>(r3[j])));
  stakedFlat.forEach((_, j) =>
    noteMiss(ok<RawPos>(r3[walletIds.length + j * 2])),
  );
  if (missedKeys.size > 0) {
    const mKeys = [...missedKeys.entries()];
    const addrRes = await mc(
      pc,
      mKeys.map(([, k]) => ({
        abi: clFactoryAbi,
        address: ADDR.CL_FACTORY,
        functionName: "getPool",
        args: [k.token0, k.token1, k.tickSpacing],
      })),
    );
    const mAddrs = mKeys.map((_, i) => ok<Address>(addrRes[i]));
    const stateRes = await mc(
      pc,
      mAddrs.flatMap((a) =>
        a && a !== zeroAddress
          ? [
              { abi: clPoolAbi, address: a, functionName: "slot0" },
              { abi: clPoolAbi, address: a, functionName: "liquidity" },
              { abi: clPoolAbi, address: a, functionName: "stakedLiquidity" },
              { abi: clPoolAbi, address: a, functionName: "fee" },
              { abi: clPoolAbi, address: a, functionName: "unstakedFee" },
              { abi: clPoolAbi, address: a, functionName: "gauge" },
            ]
          : [],
      ),
    );
    let mi = 0;
    mKeys.forEach(([key, k], i) => {
      const address = mAddrs[i];
      if (!address || address === zeroAddress) return;
      const s0 = ok<
        readonly [bigint, number, number, number, number, boolean]
      >(stateRes[mi]);
      const liquidity = ok<bigint>(stateRes[mi + 1]) ?? 0n;
      const stakedLiquidity = ok<bigint>(stateRes[mi + 2]) ?? 0n;
      const fee = ok<number>(stateRes[mi + 3]) ?? 0;
      const unstakedFee = ok<number>(stateRes[mi + 4]) ?? 0;
      const gauge = ok<Address>(stateRes[mi + 5]) ?? null;
      mi += 6;
      if (!s0) return;
      poolByKey.set(key, {
        kind: "cl",
        protocol: "home",
        address,
        token0: k.token0,
        token1: k.token1,
        tickSpacing: k.tickSpacing,
        feePpm: fee,
        unstakedFeePpm: unstakedFee,
        sqrtPriceX96: s0[0],
        tick: s0[1],
        liquidity,
        stakedLiquidity,
        gauge: gauge && gauge !== zeroAddress ? gauge : null,
        gaugeAlive: false,
        weight: 0n,
        rewardRate: 0n,
        periodFinish: 0n,
      });
    });

    // A pool the catalog never reached can hold tokens the registry never
    // loaded — a wrong decimals here misprices every amount on the card.
    const unknown = [
      ...new Set(
        [...missedKeys.values()].flatMap((k) => [k.token0, k.token1]),
      ),
    ].filter((a) => !pools.tokens[a.toLowerCase()]);
    const metaRes = await mc(
      pc,
      unknown.flatMap((a) => [
        { abi: erc20Abi, address: a, functionName: "symbol" },
        { abi: erc20Abi, address: a, functionName: "decimals" },
      ]),
    );
    unknown.forEach((a, i) => {
      missedTokens[a.toLowerCase()] = {
        address: a,
        symbol: ok<string>(metaRes[i * 2]) ?? a.slice(0, 6) + "…",
        decimals: ok<number>(metaRes[i * 2 + 1]) ?? 18,
      };
    });
  }

  const cl: ClPosition[] = [];

  const buildPos = (
    id: bigint,
    raw: RawPos,
    staked: boolean,
    earned: bigint,
  ): ClPosition | null => {
    const pool = findPool(raw);
    if (!pool) return null;
    const liquidity = raw[7];
    const { amount0, amount1 } = getAmountsForLiquidity(
      pool.sqrtPriceX96,
      getSqrtRatioAtTick(raw[5]),
      getSqrtRatioAtTick(raw[6]),
      liquidity,
    );
    return {
      tokenId: id,
      pool,
      tickLower: raw[5],
      tickUpper: raw[6],
      liquidity,
      staked,
      amount0,
      amount1,
      fees0: raw[10],
      fees1: raw[11],
      earned,
    };
  };

  walletIds.forEach((id, j) => {
    const raw = ok<RawPos>(r3[j]);
    if (!raw) return;
    const pos = buildPos(id, raw, false, 0n);
    if (pos && (pos.liquidity > 0n || pos.fees0 > 0n || pos.fees1 > 0n))
      cl.push(pos);
  });
  stakedFlat.forEach(({ id }, j) => {
    const base = walletIds.length + j * 2;
    const raw = ok<RawPos>(r3[base]);
    const earned = ok<bigint>(r3[base + 1]) ?? 0n;
    if (!raw) return;
    const pos = buildPos(id, raw, true, earned);
    if (pos) cl.push(pos);
  });

  // univ3 wallet positions join here so the fee simulation below covers them
  const uni = await uniP;
  cl.push(...uni.cl);
  const home = await homeP;
  cl.push(...home.cl);
  const homeFarm = await homeFarmP;
  cl.push(...homeFarm.cl);
  // joins BEFORE the fee pass below, which must skip it: v4 fees are already
  // derived from fee growth, and the collect simulation it would otherwise run
  // is a v3 NPM entrypoint the v4 PositionManager does not have
  const v4 = await v4P;
  cl.push(...v4.cl);

  // pass 4: exact uncollected fees for wallet positions via collect() simulation
  // (collect is signature-identical on both NPMs — only the address differs).
  // v4 is excluded: its PositionManager has no `collect`, so the simulation
  // would revert against whichever NPM this picked and silently discard fees
  // that were already derived correctly from fee growth.
  await Promise.all(
    cl
      .filter((p) => !p.staked && p.pool.protocol !== "univ4")
      .map(async (p) => {
        try {
          const sim = await pc.simulateContract({
            abi: clPmAbi,
            address: p.pool.protocol === "univ3" ? UNI.V3_NPM : ADDR.CL_PM,
            functionName: "collect",
            args: [
              {
                tokenId: p.tokenId,
                recipient: user,
                amount0Max: MAX_UINT128,
                amount1Max: MAX_UINT128,
              },
            ],
            account: user,
          });
          const [f0, f1] = sim.result as readonly [bigint, bigint];
          p.fees0 = f0;
          p.fees1 = f1;
        } catch {
          /* keep tokensOwed fallback */
        }
      }),
  );

  // Solidly claimable getters only expose fees materialized by a prior pool
  // interaction. Simulating claimFees as the owner includes the latest index.
  await Promise.all(
    v2Raw
      .filter((r) => v2SupportsClaimFees(r.pool) && r.walletLp > 0n)
      .map(async (r) => {
        const [fee0, fee1] = await previewV2ClaimFees(
          pc,
          r.pool.address,
          user,
          [r.claimable0, r.claimable1],
        );
        r.claimable0 = fee0;
        r.claimable1 = fee1;
      }),
  );

  const v2: V2Position[] = v2Raw.map((r) => {
    const lp = r.walletLp + r.stakedLp;
    const ts = r.pool.totalSupply;
    return {
      pool: r.pool,
      walletLp: r.walletLp,
      stakedLp: r.stakedLp,
      earned: r.earned,
      claimable0: r.claimable0,
      claimable1: r.claimable1,
      amount0: ts > 0n ? (lp * r.pool.reserve0) / ts : 0n,
      amount1: ts > 0n ? (lp * r.pool.reserve1) / ts : 0n,
    };
  });

  const uniV2 = await uniV2P;
  const v2Farm = await v2FarmP;
  // A failed first-time farm probe can degrade independently, but once a pid
  // has proved non-zero, absence caused by RPC failure must reject the refresh
  // so TanStack keeps the prior complete positions snapshot.
  if ("fatal" in v2Farm) throw v2Farm.fatal;
  v2.push(...uniV2.v2, ...v2Farm.v2);

  return {
    cl,
    v2: mergeV2ByPair(v2),
    // homeFarm's tokens belong here too — a farmed position can be the only
    // holder of a pair whose tokens the registry never loaded
    // Every other reader may still supply display metadata with a permissive
    // fallback. V4 positions are actionable only after strict decimals proof,
    // so that proof must have final precedence for every shared currency.
    tokens: mergeTokenInfoWithVerifiedV4(
      [
        missedTokens,
        uni.tokens,
        home.tokens,
        homeFarm.tokens,
        uniV2.tokens,
        v2Farm.tokens,
      ],
      v4.tokens,
    ),
    failedSources: [...failed],
  };
}

export type UsePositionsOptions = {
  /**
   * Position discovery is one of the app's widest wallet reads. Surfaces that
   * only browse pools must opt in when the user asks for wallet-specific data.
   */
  enabled?: boolean;
};

export function usePositions(
  user?: Address,
  options: UsePositionsOptions = {},
) {
  const pools = usePools();
  const requested = options.enabled ?? true;
  return useQuery({
    queryKey: positionQueryKey(CHAIN_ID, user),
    enabled: requested && !!user && !!pools.data,
    ...POSITION_DISCOVERY_QUERY_POLICY,
    // The scan rides the chain's official public RPC (lib/publicRpcClient.ts):
    // the widest wallet read in the app should spend the visitor's own IP
    // allowance, not the terminal's RPC quota.
    queryFn: () => fetchPositions(publicRpcClient, user!, pools.data!),
  });
}
