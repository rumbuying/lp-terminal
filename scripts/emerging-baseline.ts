// EMG-A00 baseline probe (docs/EMERGING-POOL-LP-PRD.zh-CN.md §11): a
// READ-ONLY capability inventory for the emerging-pool pipeline, run against
// the same RPC configuration the production indexer uses.
//
//   CHAIN=robinhood npx tsx scripts/emerging-baseline.ts
//
// It measures what the PRD's design budget depends on instead of assuming it:
// block time and finality lag (the discovery-latency floor), getLogs range and
// result caps (tail + backfill windows), archive-state depth (initial tick /
// fee checkpoints for replay), and per-venue young-pool supply over a trailing
// window (Initialize/PoolCreated/TokenCreated logs, hook share, USDG-pair
// fixtures for EMG-C00). Every probe that cannot be answered lands in
// `gaps` — explicit, per A00's contract — and no failure here blocks basic
// collection work (§11: "不足显式记载，不阻塞基础采集").
//
// Budget: paced at ≤~4.5 requests/s, under the PRD §4.5 engineering initial
// of 5 rps. Results land under indexer/data/ (gitignored) so a re-run never
// overwrites the record a report cited.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseAbi, toEventSelector, type Address } from 'viem';
import { CHAIN, INDEXER_FINALITY_BLOCKS, V4, log, sleep } from '../indexer/config';
import { mc, pc, safeError, verifyRpcChain } from '../indexer/rpc';

const V4_INITIALIZE_EVENT = parseAbi([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
]);
const POOL_CREATED_EVENT = parseAbi([
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
]);
const CL_FACTORY_ABI = parseAbi(['function allPoolsLength() view returns (uint256)']);
const ZERO_HOOK = '0x0000000000000000000000000000000000000000' as const;
/** TokenCreated(address,(string,string,string,bytes)) — same selector v4Rpc.ts tails. */
const TOKEN_CREATED_TOPIC0 = toEventSelector('TokenCreated(address,(string,string,string,bytes))');
const TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;

const OUT_DIR = resolve('indexer/data/emerging');
const TRAILING_DAYS = 7;
/** A result page at or above this is treated as provider-truncated (§3.2). */
const RESULT_CAP_SUSPECTED = 9_900;
/** getLogs range probes, descending; the first answered is the measured cap. */
const RANGE_PROBE_BLOCKS = [500_000, 100_000, 20_000, 5_000, 1_000];
const PACER_MS = 230;

type InitArgs = {
  id: string; currency0: string; currency1: string;
  fee: number; tickSpacing: number; hooks: string;
};

const gaps: Array<{ probe: string; error: string }> = [];
let requests = 0;
let lastAt = 0;

/** Serialize probes through one pacer so total load stays inside budget. */
async function paced<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  const wait = PACER_MS - (Date.now() - lastAt);
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
  requests++;
  try {
    return await fn();
  } catch (error) {
    gaps.push({ probe: label, error: safeError(error) });
    return null;
  }
}

async function measureLatency(label: string, runs: number, fn: () => Promise<unknown>) {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = Date.now();
    const r = await paced(`${label}#${i}`, fn);
    if (r === null) return null;
    samples.push(Date.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return { runs, p50Ms: samples[Math.floor(samples.length / 2)], maxMs: samples[samples.length - 1] };
}

/** Descending window probe: the first range the provider answers in one call. */
async function probeMaxLogRange(
  label: string,
  params: { address: Address; topics?: `0x${string}`[] },
  head: number,
): Promise<{ maxWindowBlocks: number; latencyMs: number } | null> {
  for (const window of RANGE_PROBE_BLOCKS) {
    const t0 = Date.now();
    const logs = await paced(`${label}@${window}b`, () =>
      pc.getLogs({ ...params, fromBlock: BigInt(head - window), toBlock: BigInt(head) }),
    );
    if (logs !== null) return { maxWindowBlocks: window, latencyMs: Date.now() - t0 };
    log(`  [${label}] ${window}-block window rejected, shrinking`);
  }
  return null;
}

type RawLog = Record<string, unknown>;

/**
 * Walk [fromBlock, toBlock] in pages the provider answers. Shrinks on
 * rejection and on a suspected result-page cap — a capped page is an
 * incomplete scan, flagged via `truncated`, never read as a complete count.
 */
async function scanWindow(args: {
  label: string;
  address: Address;
  event?: unknown;
  topics?: `0x${string}`[];
  fromBlock: number;
  toBlock: number;
}): Promise<{ logs: RawLog[]; truncated: boolean; pages: number } | null> {
  const all: RawLog[] = [];
  let truncated = false;
  let pages = 0;
  let lo = args.fromBlock;
  let window = Math.max(1, args.toBlock - args.fromBlock + 1);
  while (lo <= args.toBlock) {
    const hi = Math.min(lo + window - 1, args.toBlock);
    const logs = await paced(args.label, () =>
      pc.getLogs({
        address: args.address,
        ...(args.event !== undefined ? { event: args.event as never } : {}),
        ...(args.topics !== undefined ? { topics: args.topics } : {}),
        fromBlock: BigInt(lo),
        toBlock: BigInt(hi),
      }),
    );
    if (logs === null) {
      if (window <= 1) {
        gaps.push({ probe: `${args.label}@${lo}`, error: 'single-block getLogs rejected' });
        lo = hi + 1;
        continue;
      }
      window = Math.floor(window / 4);
      continue;
    }
    pages++;
    all.push(...(logs as RawLog[]));
    if (logs.length >= RESULT_CAP_SUSPECTED) {
      truncated = true;
      window = Math.max(1, Math.floor(window / 2));
    }
    lo = hi + 1;
  }
  return { logs: all, truncated, pages };
}

async function main(): Promise<void> {
  const gapsAtStart = () => gaps.length;
  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    chain: { key: CHAIN.key, id: CHAIN.id },
    finalityBlocks: INDEXER_FINALITY_BLOCKS,
    readOnly: true,
  };
  await verifyRpcChain();

  // --- chain basics: block time and the finality lag every polling tail waits for ---
  const head = Number(await pc.getBlockNumber());
  const blockAt = async (n: number) =>
    Number((await pc.getBlock({ blockNumber: BigInt(n) })).timestamp);
  const headTs = await blockAt(head);
  const blockTimeSec = (headTs - (await blockAt(head - 1_000))) / 1_000;
  const finalityLagSec = headTs - (await blockAt(head - INDEXER_FINALITY_BLOCKS));
  const blockNumberLatency = await measureLatency('getBlockNumber', 5, () => pc.getBlockNumber());
  report.chainBasics = {
    headBlock: head,
    headTimestamp: headTs,
    blockTimeSec,
    finalityBlocks: INDEXER_FINALITY_BLOCKS,
    finalityLagSec,
    blockNumberLatency,
    discoveryLatencyFloorSec: finalityLagSec,
  };
  log(`head=${head} blockTime=${blockTimeSec.toFixed(2)}s finalityLag=${finalityLagSec.toFixed(1)}s`);

  // --- multicall: the production path for static/permission reads ---
  const clFactory = CHAIN.addr.CL_FACTORY as Address;
  const mcT0 = Date.now();
  const mcResults = await paced('multicall3', () =>
    mc(Array.from({ length: 2 }, () => ({
      abi: CL_FACTORY_ABI,
      address: clFactory,
      functionName: 'allPoolsLength',
    }))),
  );
  report.multicall3 = mcResults
    ? { ok: mcResults.every((r) => r !== undefined && r !== null), latencyMs: Date.now() - mcT0, calls: 2 }
    : { ok: false, latencyMs: Date.now() - mcT0, calls: 2 };

  // --- archive state: initial tick/fee checkpoints for EMG-A05/C00 replay ---
  const archiveBlock = Math.max(1, Math.min(
    V4?.rpcDirectory?.poolGenesisBlock ? V4.rpcDirectory.poolGenesisBlock + 10 : 9_080,
    head - 1_000_000,
  ));
  const archive = await paced('archive-getStorageAt', () =>
    pc.getStorageAt({ address: CHAIN.addr.STABLE, slot: '0x0', blockNumber: BigInt(archiveBlock) }),
  );
  report.archiveState = {
    probedBlock: archiveBlock,
    depthBlocksBehindHead: head - archiveBlock,
    ok: archive !== null,
    note: archive !== null
      ? 'node serves deep state — on-chain initial checkpoints are replayable'
      : 'GAP: no deep state; initial checkpoints must come from events or a fork fixture',
  };

  // --- log range cap on the lowest-traffic contract (the launchpad factory) ---
  const launchpadFactory = CHAIN.launchpad?.tokenFactory;
  const v4Ready = V4 !== undefined && launchpadFactory !== undefined;
  if (!v4Ready) {
    gaps.push({ probe: 'v4-scope', error: 'chain has no launchpad/uniV4 config; v4 probes skipped' });
    report.logs = { rangeCap: null };
  } else {
    report.logs = {
      rangeCap: await probeMaxLogRange('tokenFactory-logs', { address: launchpadFactory }, head),
    };
  }

  // --- venue coverage over the trailing window ---
  const windowBlocks = Math.floor((TRAILING_DAYS * 86_400) / blockTimeSec);
  const fromBlock = head - windowBlocks;
  log(`coverage window: ${TRAILING_DAYS}d = ${windowBlocks} blocks (from ${fromBlock})`);
  const coverage: Record<string, unknown> = { trailingDays: TRAILING_DAYS, fromBlock, headBlock: head };
  report.venueCoverage = coverage;
  const usdg = CHAIN.addr.STABLE.toLowerCase();

  if (V4 && launchpadFactory) {
    const init = await scanWindow({
      label: 'v4-initialize',
      address: V4.POOL_MANAGER,
      event: V4_INITIALIZE_EVENT[0],
      fromBlock,
      toBlock: head,
    });
    if (init) {
      const pools = init.logs.map((l) => l.args as InitArgs);
      const feeDist: Record<string, number> = {};
      for (const p of pools) {
        const k = `${p.fee}/${p.tickSpacing}`;
        feeDist[k] = (feeDist[k] ?? 0) + 1;
      }
      const usdgHookless = pools.filter(
        (p) =>
          p.hooks?.toLowerCase() === ZERO_HOOK &&
          (p.currency0?.toLowerCase() === usdg || p.currency1?.toLowerCase() === usdg),
      );
      coverage.v4PoolsInitialized = {
        count: pools.length,
        truncated: init.truncated,
        hooklessShare: pools.length
          ? pools.filter((p) => p.hooks?.toLowerCase() === ZERO_HOOK).length / pools.length
          : null,
        distinctHooks: new Set(pools.map((p) => p.hooks?.toLowerCase())).size,
        feeDist,
        // C00 verified_replay fixture candidates: the most recent hookless
        // USDG pools — static fee, stock PairManager semantics, days of history.
        usdgHooklessFixtures: usdgHookless.slice(-5).map((p) => ({
          poolId: p.id, fee: p.fee, tickSpacing: p.tickSpacing,
          currency0: p.currency0, currency1: p.currency1,
        })),
      };
    }

    const launches = await scanWindow({
      label: 'launchpad-tokenCreated',
      address: launchpadFactory,
      topics: [TOKEN_CREATED_TOPIC0],
      fromBlock,
      toBlock: head,
    });
    coverage.launchpadTokensCreated = launches
      ? {
          count: launches.logs.length,
          truncated: launches.truncated,
          perDay: Math.round(launches.logs.length / TRAILING_DAYS),
        }
      : null;

    const pmTransfers = await scanWindow({
      label: 'v4-pm-transfers',
      address: V4.POSITION_MANAGER,
      topics: [TRANSFER_TOPIC0],
      fromBlock,
      toBlock: head,
    });
    coverage.v4PositionManagerTransfers = pmTransfers
      ? { count: pmTransfers.logs.length, truncated: pmTransfers.truncated }
      : null;
  }

  const clCreated = await scanWindow({
    label: 'up33-cl-poolCreated',
    address: clFactory,
    event: POOL_CREATED_EVENT[0],
    fromBlock,
    toBlock: head,
  });
  coverage.up33ClPoolsCreated = clCreated
    ? { count: clCreated.logs.length, truncated: clCreated.truncated }
    : null;

  const uniV3Factory = (CHAIN as { uni?: { V3_FACTORY?: Address } }).uni?.V3_FACTORY;
  if (uniV3Factory) {
    const v3Created = await scanWindow({
      label: 'univ3-poolCreated',
      address: uniV3Factory,
      event: POOL_CREATED_EVENT[0],
      fromBlock,
      toBlock: head,
    });
    coverage.univ3PoolsCreated = v3Created
      ? { count: v3Created.logs.length, truncated: v3Created.truncated }
      : null;
  }

  const allPoolsT0 = Date.now();
  const clLen = await paced('up33-allPoolsLength', () =>
    pc.readContract({ address: clFactory, abi: CL_FACTORY_ABI, functionName: 'allPoolsLength' }),
  );
  coverage.up33ClRegistry = clLen !== null
    ? { allPoolsLength: Number(clLen), readLatencyMs: Date.now() - allPoolsT0 }
    : null;

  report.gaps = gaps;
  report.requestCount = requests;
  report.summary =
    `blockTime=${blockTimeSec.toFixed(2)}s archive=${archive !== null ? 'yes' : 'NO'} ` +
    Object.entries(coverage)
      .filter(([, v]) => v && typeof (v as { count?: number }).count === 'number')
      .map(([k, v]) => `${k}=${(v as { count: number }).count}`)
      .join(' ');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = resolve(OUT_DIR, `baseline-${CHAIN.key}-${stamp}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  log(`requests=${requests} gaps=${gaps.length} → ${outPath}`);
  for (const g of gaps) log(`  GAP ${g.probe}: ${g.error}`);
  void gapsAtStart;
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('baseline probe failed:', safeError(error));
    process.exit(1);
  },
);
