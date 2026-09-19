// Emerging event streams (docs/EMERGING-POOL-LP-PRD.zh-CN.md §4.2, EMG-A02):
// cursor-based, address-filtered log collection for the tracked young set.
//
// Three durable streams cover the whole tracked set — bounded by admission
// (≤200 pools), so filters stay small and attribution stays exact:
//   cl-pools : Swap/Mint/Burn on the tracked UP33-CL + Uniswap-v3 pool
//              addresses (shapes are production-proven — logtail tails them);
//   v4-pools : ALL events on the PoolManager whose first indexed topic is a
//              tracked PoolId. This chain's PoolManager emits non-standard
//              event shapes (its Initialize carries address-indexed
//              currencies, not a PoolKey topic), so v4 facts are stored RAW
//              and decoded by a versioned derivation once shapes are proven —
//              §4.3's "raw ordered facts + decode version", never a guess.
//   tokens   : ERC-20 Transfer on the tracked base tokens (A03's supply
//              ledger consumes these).
//
// Cursor discipline is the v4Rpc.ts one, per stream: advance only across a
// completed window prefix, carry the block hash the advance was proven
// against, and treat a hash mismatch as a reorg — walk back to a provable
// common ancestor using block hashes previously stored with events, archive
// orphans, and if no reference exists within the walk bound, fail the stream
// closed as reorg_repair (人工修复) rather than guess (§4.2).
import { decodeEventLog, parseAbi, toEventSelector, type Address } from 'viem';
import { CHAIN, EMERGING_TUNE, INDEXER_FINALITY_BLOCKS, V4, log, now } from './config';
import { pc } from './rpc';
import { db, kvSet } from './store';
import {
  commitEmergingScanBatch,
  emergingEventCounts,
  getEmergingCursor,
  rewindEmergingStream,
  setEmergingStreamStatus,
} from './emergingStore';
import type { EmergingPoolKey } from '../shared/emerging/types';

const V3_EVENT_ABIS = parseAbi([
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
  'event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
]);
const TRANSFER_ABI = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

const CL_TOPIC0S = [
  toEventSelector('Swap(address,address,int256,int256,uint160,uint128,int24)'),
  toEventSelector('Mint(address,address,int24,int24,uint128,uint256,uint256)'),
  toEventSelector('Burn(address,int24,int24,uint128,uint256,uint256)'),
] as `0x${string}`[];
const TRANSFER_TOPIC0 = toEventSelector('Transfer(address,address,uint256)');

// --- pure scheduling/reorg math (tested in emergingScan.test.ts) ---

/** Adaptive window: halve on rejection, grow on success, never past the cap. */
export function nextWindow(window: number, succeeded: boolean, cap: number): number {
  return succeeded
    ? Math.min(cap, Math.max(1, window * 2))
    : Math.max(1, Math.floor(window / 2));
}

/**
 * Common-ancestor search after a cursor hash mismatch: walk back through the
 * CURRENT chain's block hashes until one matches a hash previously stored
 * with an event at that height. Blocks without stored events cannot vouch —
 * the walk skips them, and a walk that proves nothing fails closed (null).
 */
export function findCommonAncestor(
  currentHashByBlock: Array<{ block: number; hash: string }>,
  storedHashByBlock: Map<number, string>,
): number | null {
  for (const { block, hash } of currentHashByBlock) {
    const stored = storedHashByBlock.get(block);
    if (stored !== undefined && stored.toLowerCase() === hash.toLowerCase()) return block;
  }
  return null;
}

export type StreamSpec = {
  key: string;
  kind: 'cl-pools' | 'v4-pools' | 'tokens';
  address: Address | Address[];
  /** viem filter topics; a null position matches anything (v4: any topic0
   *  whose topic1 is a tracked PoolId). */
  topics: Array<`0x${string}` | `0x${string}`[] | null> | undefined;
};

export type TrackedSet = {
  clAddresses: Address[];
  clPoolKeyByAddress: Map<string, EmergingPoolKey>;
  v4PoolIds: `0x${string}`[];
  v4PoolKeyById: Map<string, EmergingPoolKey>;
  tokens: Address[];
};

const trackedSetQ = () => db.prepare(`
  SELECT pool_key, venue, canonical_id, base_token
  FROM emerging_discovery
  WHERE admitted_rank IS NOT NULL AND state != 'aged_out'
`);

/** Rebuild the tracked-set filters from the durable ledger each sweep. */
export function buildTrackedSet(): TrackedSet {
  const rows = trackedSetQ().all() as Array<{
    pool_key: string; venue: string; canonical_id: string; base_token: string | null;
  }>;
  const set: TrackedSet = {
    clAddresses: [], clPoolKeyByAddress: new Map(), v4PoolIds: [], v4PoolKeyById: new Map(), tokens: [],
  };
  for (const r of rows) {
    if (r.venue === 'univ4') {
      set.v4PoolIds.push(r.canonical_id as `0x${string}`);
      set.v4PoolKeyById.set(r.canonical_id.toLowerCase(), r.pool_key as EmergingPoolKey);
    } else {
      set.clAddresses.push(r.canonical_id as Address);
      set.clPoolKeyByAddress.set(r.canonical_id.toLowerCase(), r.pool_key as EmergingPoolKey);
    }
    if (r.base_token !== null && !set.tokens.includes(r.base_token as Address))
      set.tokens.push(r.base_token as Address);
  }
  return set;
}

export function buildStreams(set: TrackedSet): StreamSpec[] {
  const streams: StreamSpec[] = [];
  if (set.clAddresses.length)
    streams.push({ key: 'cl-pools', kind: 'cl-pools', address: set.clAddresses, topics: [CL_TOPIC0S] });
  if (set.v4PoolIds.length && V4)
    streams.push({ key: 'v4-pools', kind: 'v4-pools', address: V4.POOL_MANAGER, topics: [null, set.v4PoolIds] });
  if (set.tokens.length)
    streams.push({ key: 'tokens', kind: 'tokens', address: set.tokens, topics: [[TRANSFER_TOPIC0]] });
  return streams;
}

// --- sweep engine ---

type BlockInfo = { hash: string; ts: number };
const blockCache = new Map<number, BlockInfo>();
let blockTimeSec = 2;

async function blockInfo(n: number): Promise<BlockInfo | null> {
  const cached = blockCache.get(n);
  if (cached) return cached;
  try {
    const b = await pc.getBlock({ blockNumber: BigInt(n) });
    const info = { hash: b.hash.toLowerCase(), ts: Number(b.timestamp) };
    blockCache.set(n, info);
    return info;
  } catch {
    return null;
  }
}

/** Decode one log into an event insert; null = not attributable to the set. */
function decodeLog(
  stream: StreamSpec,
  set: TrackedSet,
  raw: { address: string; topics: string[]; data: string; blockNumber: number; blockHash: string; txHash: string; txIndex: number; logIndex: number },
): { kind: 'swap' | 'mint' | 'burn' | 'transfer' | 'v4raw'; poolKey: string | null; token: string | null; payload: Record<string, unknown> } | null {
  const blockNumber = Number(raw.blockNumber);
  if (stream.kind === 'v4-pools') {
    // topics[1] is the PoolId on every pool-scoped v4 event; attribution
    // needs no decode. The payload stays RAW (topics + data) until this
    // deployment's event shapes are proven and a decode version is pinned.
    const poolKey = raw.topics[1] ? set.v4PoolKeyById.get(raw.topics[1].toLowerCase()) : undefined;
    if (!poolKey) return null;
    return {
      kind: 'v4raw', poolKey, token: null,
      payload: { topics: raw.topics, data: raw.data },
    };
  }
  const poolKey = set.clPoolKeyByAddress.get(raw.address.toLowerCase()) ?? null;
  const token = stream.kind === 'tokens' ? raw.address.toLowerCase() : null;
  if (!poolKey && !token) return null;
  try {
    const decoded = decodeEventLog({
      abi: stream.kind === 'tokens' ? TRANSFER_ABI : V3_EVENT_ABIS,
      data: raw.data as `0x${string}`,
      topics: raw.topics as [`0x${string}`, ...`0x${string}`[]],
    });
    const p: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(decoded.args))
      p[k] = typeof v === 'bigint' ? v.toString() : v;
    const kind = decoded.eventName === 'Swap' ? 'swap'
      : decoded.eventName === 'Mint' ? 'mint'
      : decoded.eventName === 'Burn' ? 'burn'
      : 'transfer';
    return { kind, poolKey, token, payload: p };
  } catch {
    // A decode failure is one lost row, not a stream fault — but it is
    // COUNTED, so §10.2 observability can see the decode-version drifting.
    decodeFailures++;
    return null;
  }
}

let decodeFailures = 0;

/**
 * Seed a stream's cursor at the young-window floor (§4.2: never a gap). The
 * seed's getBlock is budgeted like every other request.
 */
async function seedStream(spec: StreamSpec, finalityHead: number, budget: { left: number }): Promise<boolean> {
  if (budget.left <= 0) return false;
  const seedBlocks = Math.ceil(((EMERGING_TUNE.trackMaxAgeDays + 1) * 86_400) / blockTimeSec);
  const seedAt = Math.max(1, finalityHead - seedBlocks);
  budget.left--;
  const info = await blockInfo(seedAt - 1);
  if (!info) return false;
  commitEmergingScanBatch({
    streamKey: spec.key, events: [],
    cursorBlockNumber: seedAt - 1, cursorBlockHash: info.hash, cursorBlockTs: info.ts, at: now(),
  });
  // The seed ts is the stream's PROVABLE coverage floor: minutes before it
  // were never scanned, so aggregation must never write them (§3.2).
  kvSet(`emerging_stream_seed:${spec.key}`, String(info.ts));
  return true;
}

/**
 * Advance one stream within the request budget. Returns requests spent.
 * Fail-closed paths (single-block rejection, unprovable reorg) mark the
 * stream's status and stop — they never skip (§4.2).
 */
async function scanStream(spec: StreamSpec, set: TrackedSet, finalityHead: number, budget: { left: number }): Promise<number> {
  let spent = 0;
  const req = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    if (budget.left <= 0) return null;
    budget.left--;
    spent++;
    try {
      return await fn();
    } catch {
      return null;
    }
  };

  let cursor = getEmergingCursor(spec.key);
  if (!cursor) {
    if (!(await seedStream(spec, finalityHead, budget))) return spent;
    cursor = getEmergingCursor(spec.key);
    if (!cursor) return spent;
  }

  // Reorg check: the cursor block's CURRENT hash must match what it was
  // proven against. Mismatch → walk back to a provable ancestor.
  const current = await req(() => blockInfo(cursor!.blockNumber));
  if (current === null) return spent; // budget or RPC exhausted; try next sweep
  if (current.hash.toLowerCase() !== cursor.blockHash.toLowerCase()) {
    const walk: Array<{ block: number; hash: string }> = [];
    for (let d = 1; d <= 64 && walk.length < 32; d++) {
      const b = cursor.blockNumber - d;
      if (b < 1) break;
      const info = await req(() => blockInfo(b));
      if (info === null) break;
      walk.push({ block: b, hash: info.hash });
      if (budget.left <= 0) break;
    }
    const stored = new Map<number, string>();
    for (const { block } of walk) {
      const row = db
        .prepare('SELECT block_hash AS h FROM emerging_chain_events WHERE chain_id = ? AND block_number = ? LIMIT 1')
        .get(CHAIN.id, block) as { h: string } | undefined;
      if (row) stored.set(block, row.h);
    }
    const ancestor = findCommonAncestor(walk, stored);
    if (ancestor === null) {
      setEmergingStreamStatus(spec.key, 'reorg_repair', now());
      log(`[${spec.key}] reorg beyond provable ancestor at ${cursor.blockNumber}; stream paused for manual repair`);
      return spent;
    }
    const ancestorInfo = await req(() => blockInfo(ancestor));
    if (!ancestorInfo) return spent;
    const archived = rewindEmergingStream({
      streamKey: spec.key,
      ancestorBlockNumber: ancestor,
      ancestorBlockHash: ancestorInfo.hash,
      at: now(),
    });
    log(`[${spec.key}] reorg: rewound to ${ancestor}, archived ${archived} orphan events`);
    cursor = getEmergingCursor(spec.key);
    if (!cursor) return spent;
  }

  // Page walk: cursor+1 → finalityHead, adaptive window, commit per page.
  let lo = cursor.blockNumber + 1;
  let window = EMERGING_TUNE.scanStartWindowBlocks;
  while (lo <= finalityHead) {
    if (budget.left <= 0) break;
    const hi = Math.min(lo + window - 1, finalityHead);
    const logs = await req(() => pc.getLogs({
      address: spec.address,
      ...(spec.topics ? { topics: spec.topics as never } : {}),
      fromBlock: BigInt(lo),
      toBlock: BigInt(hi),
    }) as Promise<Array<{ address: string; topics: string[]; data: string; blockNumber: bigint; blockHash: string; blockTimestamp?: bigint; transactionHash: string; transactionIndex: number; logIndex: number }>>);
    if (logs === null) {
      if (window <= 1) {
        setEmergingStreamStatus(spec.key, 'data_gap', now());
        log(`[${spec.key}] single-block getLogs rejected at ${lo}; stream paused`);
        return spent;
      }
      window = nextWindow(window, false, EMERGING_TUNE.scanMaxWindowBlocks);
      continue;
    }
    window = nextWindow(window, true, EMERGING_TUNE.scanMaxWindowBlocks);

    const events = logs
      .map((raw) => {
        const decoded = decodeLog(spec, set, {
          address: raw.address, topics: raw.topics, data: raw.data,
          blockNumber: Number(raw.blockNumber), blockHash: raw.blockHash,
          txHash: raw.transactionHash, txIndex: raw.transactionIndex, logIndex: raw.logIndex,
        });
        if (!decoded) return null;
        return {
          txHash: raw.transactionHash, logIndex: raw.logIndex,
          blockNumber: Number(raw.blockNumber), blockHash: raw.blockHash,
          txIndex: raw.transactionIndex, blockTs: null,
          contract: raw.address, kind: decoded.kind,
          poolKey: decoded.poolKey, token: decoded.token, payload: decoded.payload,
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    // Cursor proof for the page end: free from a log at that block, else one
    // getBlock (which also dates it for complete_through_ts — §4.4).
    const logAtHi = logs.find((l) => Number(l.blockNumber) === hi);
    let endHash = logAtHi?.blockHash.toLowerCase();
    let endTs: number | null = null;
    if (!endHash || !logAtHi?.blockTimestamp) {
      const info = await req(() => blockInfo(hi));
      if (info === null) break; // out of budget; the page re-reads next sweep
      endHash = endHash ?? info.hash;
      endTs = info.ts;
    } else {
      endTs = Number(logAtHi.blockTimestamp);
    }
    commitEmergingScanBatch({
      streamKey: spec.key, events,
      cursorBlockNumber: hi, cursorBlockHash: endHash!, cursorBlockTs: endTs, at: now(),
    });
    lo = hi + 1;
  }
  return spent;
}

/**
 * One scan sweep: rebuild the tracked set, walk the streams round-robin under
 * the shared request budget. Returns counters for the log line (§10.2).
 */
export async function runEmergingScanSweep(): Promise<{
  streams: number; requests: number; decodeFailures: number; eventsDelta: number;
}> {
  blockTimeSec = await measureBlockTime();
  const finalityHead = Number(await pc.getBlockNumber()) - INDEXER_FINALITY_BLOCKS;
  const set = buildTrackedSet();
  const streams = buildStreams(set);
  const budget = { left: EMERGING_TUNE.scanRequestsPerSweep };
  decodeFailures = 0;
  const canonicalBefore = emergingEventCounts().canonical;
  let spent = 0;
  for (const spec of streams.slice(0, EMERGING_TUNE.scanMaxStreamsPerSweep))
    spent += await scanStream(spec, set, finalityHead, budget);
  const counts = emergingEventCounts();
  return {
    streams: Math.min(streams.length, EMERGING_TUNE.scanMaxStreamsPerSweep),
    requests: spent,
    decodeFailures,
    eventsDelta: counts.canonical - canonicalBefore,
  };
}

async function measureBlockTime(): Promise<number> {
  try {
    const head = Number(await pc.getBlockNumber());
    const [t1, t0] = [Number((await pc.getBlock({ blockNumber: BigInt(head) })).timestamp), Number((await pc.getBlock({ blockNumber: BigInt(head - 1_000) })).timestamp)];
    return Math.max(0.01, (t1 - t0) / 1_000);
  } catch {
    return blockTimeSec;
  }
}
