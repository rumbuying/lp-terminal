// GeckoTerminal enrichment — volume/liquidity/txn stats + token USD price
// seeds for the pricing waterfall. GT covers this chain's indexed
// deployments (network + per-dex top lists), sharing a 30-call cycle budget —
// the long tail keeps chain-derived TVL only.
// Free tier is 30 calls/min: calls are paced ≥ TUNE.gtPaceMs apart and the
// whole cycle (≤30 calls, shared fairly across lists) runs every TUNE.statsMs.
//
// NOTE: GT has no UP33 dex entry — UP33 pool stats stay on the frontend's
// existing dexscreener path.
import { CHAIN, GT, TUNE, log, sleep } from './config';
import { plausibleUsd } from './state';
import {
  poolRow,
  setTokenPrice,
  upsertStats,
  upsertV4MarketStats,
  v4PoolRow,
} from './store';

const GT_NET = CHAIN.slugs.gecko;
const LISTS = GT_NET
  ? [
      { path: `/networks/${GT_NET.network}/pools`, label: 'network' },
      ...(GT_NET.v2Dex
        ? [
            {
              path: `/networks/${GT_NET.network}/dexes/${GT_NET.v2Dex}/pools`,
              label: 'uni-v2',
            },
          ]
        : []),
      ...(GT_NET.v3Dex
        ? [
            {
              path: `/networks/${GT_NET.network}/dexes/${GT_NET.v3Dex}/pools`,
              label: 'uni-v3',
            },
          ]
        : []),
      ...(GT_NET.extraDexes ?? []).map((dex) => ({
        path: `/networks/${GT_NET.network}/dexes/${dex.id}/pools`,
        label: dex.label,
      })),
    ]
  : [];

type GtPool = {
  attributes?: {
    address?: string;
    reserve_in_usd?: string;
    volume_usd?: { h24?: string };
    transactions?: { h24?: { buys?: number; sells?: number } };
    base_token_price_usd?: string;
    quote_token_price_usd?: string;
  };
  relationships?: {
    base_token?: { data?: { id?: string } };
    quote_token?: { data?: { id?: string } };
  };
};

let lastCall = 0;
async function gtJson(url: string): Promise<{ data?: GtPool[] } | null> {
  const wait = lastCall + TUNE.gtPaceMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  try {
    const r = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'up33-lp-indexer/0.1',
      },
    });
    if (!r.ok) return null;
    return (await r.json()) as { data?: GtPool[] };
  } catch {
    return null;
  }
}

const num = (x: unknown): number | null => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};
// GT prefixes token ids with its network slug: `<network>_0x…`
const ID_PREFIX = GT_NET ? `${GT_NET.network}_` : null;
const tokenOfId = (id?: string): string | null =>
  ID_PREFIX && id?.startsWith(`${ID_PREFIX}0x`) ? id.slice(ID_PREFIX.length).toLowerCase() : null;

/**
 * A v4 pool has no pool contract, so GT identifies it by its bytes32 PoolId in
 * the same `address` field every other protocol puts a 20-byte address in.
 * Length is what tells them apart, and it is the only thing that can: both are
 * lowercase 0x hex, and neither carries a protocol tag.
 */
const POOL_ID = /^0x[0-9a-f]{64}$/;

type Ingested = { key: string; v4: boolean } | null;

/**
 * Record one GT row against whichever catalog claims it.
 *
 * The catalog is still the gate — an entry we cannot identify is ignored, as
 * before. What changed is that there are two catalogs: v4 rows used to fail
 * `poolRow` (they are not addresses, so nothing could ever match) and were
 * dropped after being paid for, which is why every v4 market showed "—" for
 * volume while GT was reporting eight figures a day on some of them.
 */
function ingest(p: GtPool): Ingested {
  const a = p.attributes;
  const key = a?.address?.toLowerCase();
  if (!a || !key) return null;
  const v4 = POOL_ID.test(key);
  if (v4 ? !v4PoolRow(key) : !poolRow(key)) return null;
  const reserve = num(a.reserve_in_usd);
  const h24 = a.transactions?.h24;
  const txns = h24 ? (h24.buys ?? 0) + (h24.sells ?? 0) : null;
  const vol = num(a.volume_usd?.h24);
  if (v4) upsertV4MarketStats(key, vol, txns, reserve, 'geckoterminal');
  else upsertStats(key, vol, txns, reserve, 'geckoterminal');
  // Token price seeds — these are the CREDIBLE roots the whole pricing graph
  // hangs off, and they're the one input the propagation rails can't second-
  // guess, so an implausible GT quote is dropped rather than seeded.
  const depth = (reserve ?? 0) / 2;
  if (depth > 0) {
    const base = tokenOfId(p.relationships?.base_token?.data?.id);
    const quote = tokenOfId(p.relationships?.quote_token?.data?.id);
    const bp = num(a.base_token_price_usd);
    const qp = num(a.quote_token_price_usd);
    if (base && plausibleUsd(bp)) setTokenPrice(base, bp, depth, 'gt');
    if (quote && plausibleUsd(qp)) setTokenPrice(quote, qp, depth, 'gt');
  }
  return { key, v4 };
}

/**
 * One enrichment cycle, with the free-tier budget shared across every list.
 *
 * Returns the matched pool ADDRESSES only. The caller spends them on
 * address-keyed RPC work (`computeTvlFor`), and a PoolId is not an address —
 * handing one back would send that work looking for a contract that does not
 * exist.
 */
export async function gtCycle(): Promise<string[]> {
  let seen = 0;
  const matchedAddresses = new Set<string>();
  const matchedPoolIds = new Set<string>();
  const pagesPerList = LISTS.length ? Math.max(1, Math.floor(30 / LISTS.length)) : 0;
  for (const list of LISTS) {
    for (let page = 1; page <= pagesPerList; page++) {
      const j = await gtJson(`${GT}${list.path}?page=${page}`);
      const items = j?.data;
      if (!items?.length) break;
      seen += items.length;
      for (const it of items) {
        const hit = ingest(it);
        if (!hit) continue;
        (hit.v4 ? matchedPoolIds : matchedAddresses).add(hit.key);
      }
      if (items.length < 20) break;
    }
  }
  const matched = matchedAddresses.size + matchedPoolIds.size;
  log(
    `[stats] gt cycle: ${matched}/${seen} list entries matched catalog ` +
      `(${matchedPoolIds.size} univ4)`,
  );
  return [...matchedAddresses];
}
