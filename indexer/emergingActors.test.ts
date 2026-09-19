import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

// env FIRST, then imports (connectorRank.test.ts's pattern).
const tmp = mkdtempSync(join(tmpdir(), 'lp-terminal-emerging-actors-'));
const previous = { chain: process.env.CHAIN, db: process.env.INDEXER_DB };
process.env.CHAIN = 'robinhood';
process.env.INDEXER_DB = join(tmp, 'catalog.db');

const store = await import('./store');
const emergingStore = await import('./emergingStore');
const { applyDelta, classifyGenesisRecipients } = await import('./emergingActors');

after(() => {
  store.db.close();
  if (previous.chain === undefined) delete process.env.CHAIN;
  else process.env.CHAIN = previous.chain;
  if (previous.db === undefined) delete process.env.INDEXER_DB;
  else process.env.INDEXER_DB = previous.db;
  rmSync(tmp, { recursive: true, force: true });
});

const ZERO = `0x${'0'.repeat(40)}`;
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

test('applyDelta: mint → transfer → burn keeps every balance and the totals honest', () => {
  const balances = new Map<string, bigint>();
  const totals = { minted: 0n, burned: 0n };
  const dev = addr(1);
  const buyer = addr(2);

  assert.equal(applyDelta(balances, totals, { from: ZERO, to: dev, value: 1_000n }).corrupt, false);
  assert.equal(balances.get(dev), 1_000n);
  assert.equal(totals.minted, 1_000n);

  applyDelta(balances, totals, { from: dev, to: buyer, value: 400n });
  assert.equal(balances.get(dev), 600n);
  assert.equal(balances.get(buyer), 400n);

  applyDelta(balances, totals, { from: buyer, to: ZERO, value: 400n });
  assert.equal(balances.has(buyer), false, 'zero balances leave the map');
  assert.equal(totals.burned, 400n);
  assert.equal(totals.minted - totals.burned, 600n);
  const sum = [...balances.values()].reduce((a, b) => a + b, 0n);
  assert.equal(sum, totals.minted - totals.burned, 'balance sum reconciles with supply');
});

test('applyDelta: spending more than the ledger shows flags corruption, clamps to zero', () => {
  const balances = new Map<string, bigint>([[addr(3), 5n]]);
  const totals = { minted: 0n, burned: 0n };
  const r = applyDelta(balances, totals, { from: addr(3), to: addr(4), value: 10n });
  assert.equal(r.corrupt, true, 'a negative ledger is an INCOMPLETE stream, not a market');
  assert.equal(balances.has(addr(3)), false, 'the clamped zero balance leaves the map');
  assert.equal(balances.get(addr(4)), 10n, 'the counterparty credit still lands');
});

test('applyDelta: mint straight to liquidity (from=to=zero sides) is handled independently', () => {
  const balances = new Map<string, bigint>();
  const totals = { minted: 0n, burned: 0n };
  applyDelta(balances, totals, { from: ZERO, to: addr(5), value: 50n });
  applyDelta(balances, totals, { from: addr(5), to: ZERO, value: 50n });
  assert.equal(totals.minted, 50n);
  assert.equal(totals.burned, 50n);
  assert.equal(balances.size, 0);
});

test('classifyGenesisRecipients: share threshold, exclusions, and zero-address burns ignored', () => {
  const birth = 1_000_000;
  const transfers = [
    { from: ZERO, to: addr(1), value: 700n },    // dev mints to itself: 70% recipient
    { from: addr(1), to: addr(2), value: 200n }, // distribution: 20%
    { from: addr(1), to: addr(3), value: 50n },  // small recipient: 5%
    { from: ZERO, to: addr(9), value: 300n },    // later mint: 30% — still a recipient
    { from: addr(9), to: ZERO, value: 300n },    // burn: never counts as received
  ];
  const out = classifyGenesisRecipients({
    transfers, birthTs: birth, windowSeconds: 6 * 3600,
    minShareOfMinted: 0.1, exclude: new Set([addr(8)]),
  });
  // Denominator = minted in window = 1000. Sorted by received: the self-mint
  // is the largest genesis recipient of all — that is what the data says.
  assert.deepEqual(out.map((o) => o.address), [addr(1), addr(9), addr(2)]);
  assert.ok(Math.abs(out[0].shareOfMinted - 0.7) < 1e-9);
});

test('classifyGenesisRecipients: an excluded contract address never becomes a recipient', () => {
  const transfers = [
    { from: ZERO, to: addr(1), value: 1000n },
    { from: addr(1), to: addr(8), value: 900n }, // the pool contract itself
  ];
  const out = classifyGenesisRecipients({
    transfers, birthTs: 1, windowSeconds: 60, minShareOfMinted: 0.1,
    exclude: new Set([addr(8)]),
  });
  // The pool received 900 but is excluded; the minter's own mint remains.
  assert.ok(out.every((o) => o.address !== addr(8)),
    'the excluded contract never appears, whatever it received');
});

// --- store-backed sweep behaviour (transfers via the real events table) ---

const token = addr(0xbeef);
function admitBaseToken() {
  const poolKey = `${4666}:univ3:${addr(0x77)}`;
  const birth = Math.floor(Date.now() / 1000) - 3_600;
  store.upsertEmergingDiscovery({
    poolKey, venue: 'univ3', canonicalId: addr(0x77),
    token0: token, token1: addr(2), baseToken: token, quoteIsUsdg: false,
    poolCreatedAt: birth, tokenCreatedAt: birth, launchAt: birth,
    firstSeenAt: 2_000, origin: 'test',
  });
  store.recordEmergingTransition({
    poolKey, fromState: 'discovered', toState: 'queued',
    reason: null, admittedRank: 1, occurredAt: 3_000,
  });
}

let seq = 0;
function transfer(args: { from: string; to: string; value: string; blockTs: number; block: number }) {
  const poolKey = `${4666}:univ3:${addr(0x77)}`;
  emergingStore.commitEmergingScanBatch({
    streamKey: 'tokens',
    events: [{
      txHash: `0x${(0x5000 + ++seq).toString(16)}`, logIndex: seq,
      blockNumber: args.block, blockHash: '0xh', txIndex: 0,
      blockTs: args.blockTs, contract: token, kind: 'transfer',
      poolKey: poolKey, token,
      payload: { from: args.from, to: args.to, value: args.value },
    }],
    cursorBlockNumber: args.block, cursorBlockHash: '0xh',
    cursorBlockTs: args.blockTs, at: 9_000,
  });
}

test('actors sweep: replays the ledger, records genesis evidence, reconciles honestly', async () => {
  const { runEmergingActorsSweep } = await import('./emergingActors');
  admitBaseToken();
  const ZERO = `0x${'0'.repeat(40)}`;
  const birth = Math.floor(Date.now() / 1000) - 3_600;
  transfer({ from: ZERO, to: addr(1), value: '1000', blockTs: birth + 10, block: 100 });
  transfer({ from: addr(1), to: addr(2), value: '300', blockTs: birth + 20, block: 101 });
  transfer({ from: addr(1), to: addr(3), value: '5', blockTs: birth + 30, block: 102 });

  // On an RPC-less test env the reconciliation read fails → stays null, the
  // ledger itself still lands (§4.2: a failed read is never a fabricated one).
  const counters = await runEmergingActorsSweep();
  assert.equal(counters.tokens, 1);
  assert.equal(counters.consumed, 3);

  const state = store.db
    .prepare('SELECT * FROM emerging_supply_state WHERE token = ?')
    .get(token) as { total_supply: string; minted: string; burned: string; watermark_rowid: number };
  assert.equal(state.total_supply, '1000', 'transfers move balances, not supply');
  assert.equal(state.minted, '1000');
  assert.equal(state.burned, '0');
  assert.equal(state.watermark_rowid > 0, true);

  const balances = store.db
    .prepare('SELECT address, balance FROM emerging_supply_balances WHERE token = ? ORDER BY address')
    .all(token) as Array<{ address: string; balance: string }>;
  assert.equal(balances.length, 3);
  const dev = balances.find((b) => b.address === addr(1))!;
  assert.equal(dev.balance, '695');

  // Genesis evidence: the self-minting dev (70%) and addr(2) (30%) clear the
  // 1% threshold; addr(3) at 0.5% stays out. All 'inferred' by construction.
  const evidence = store.db
    .prepare("SELECT address, confidence, source FROM emerging_actor_evidence WHERE token = ? AND role = 'genesis_recipient'")
    .all(token) as Array<{ address: string; confidence: string; source: string }>;
  assert.equal(evidence.length, 2);
  assert.deepEqual(evidence.map((e) => e.address).sort(), [addr(1), addr(2)]);
  assert.equal(evidence.every((e) => e.confidence === 'inferred'), true,
    'a large recipient is a lead, never a verdict (§5.2)');
});

test('actors sweep: a second pass consumes nothing new (watermark holds)', async () => {
  const { runEmergingActorsSweep } = await import('./emergingActors');
  const counters = await runEmergingActorsSweep();
  assert.equal(counters.consumed, 0);
  const state = store.db
    .prepare('SELECT total_supply FROM emerging_supply_state WHERE token = ?')
    .get(token) as { total_supply: string };
  assert.equal(state.total_supply, '1000');
});
