// Actor roles and the supply ledger (docs/EMERGING-POOL-LP-PRD.zh-CN.md §5.2,
// EMG-A03). Consumes the canonical Transfer stream the tokens scan produced
// (emerging_chain_events) and maintains, per tracked token:
//   - a time-point balance ledger replayed from the proven supply start,
//     reconciled against the contract's totalSupply (§5.2 对账);
//   - actor role evidence with per-claim provenance — a launchpad token's
//     self-reported creator is 'inferred', a large genesis recipient is
//     'inferred', and nothing here ever asserts insider status as fact.
//
// Reorg honesty (§4.3): when archived (canonical=0) events exist at or below
// a token's consumed watermark, the derived balances are stale — the state
// flips to 'reorg_stale' and the ledger fully replays from zero (young
// tokens are bounded, so a full replay is cheap and exact).
import { parseAbi, type Address } from 'viem';
import { CHAIN, EMERGING_TUNE, log, now } from './config';
import { mc } from './rpc';
import { db, isLaunchpadToken, kvGet, kvSet, tx } from './store';

const ERC20_TOTAL_SUPPLY = parseAbi(['function totalSupply() view returns (uint256)']);
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

export const ACTOR_ROLES = [
  'tx_initiator', 'factory_caller', 'launcher',
  'declared_beneficiary', 'genesis_recipient', 'funding_related',
] as const;
export type ActorRole = (typeof ACTOR_ROLES)[number];

const transfersAfterQ = db.prepare(`
  SELECT rowid AS rid, tx_hash AS txHash, log_index AS logIndex,
         block_number AS blockNumber, block_ts AS blockTs, payload
  FROM emerging_chain_events
  WHERE token = ? AND canonical = 1 AND kind = 'transfer' AND rowid > ?
  ORDER BY rowid
`);
const archivedAtOrBelowQ = db.prepare(`
  SELECT COUNT(*) AS n FROM emerging_chain_events
  WHERE token = ? AND canonical = 0 AND block_number <= ?
`);
const supplyStateQ = db.prepare(`SELECT * FROM emerging_supply_state WHERE token = ?`);
const balancesQ = db.prepare(`SELECT address, balance FROM emerging_supply_balances WHERE token = ?`);

const upsertBalanceQ = db.prepare(`
  INSERT INTO emerging_supply_balances(token, address, balance) VALUES (?, ?, ?)
  ON CONFLICT(token, address) DO UPDATE SET balance = excluded.balance
`);
const deleteBalanceQ = db.prepare(`DELETE FROM emerging_supply_balances WHERE token = ? AND address = ?`);
const upsertStateQ = db.prepare(`
  INSERT INTO emerging_supply_state(
    token, watermark_rowid, total_supply, minted, burned, balance_sum,
    birth_ts, supply_block, reconciled_at, reconcile_status, version
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT(token) DO UPDATE SET
    watermark_rowid = excluded.watermark_rowid,
    total_supply = excluded.total_supply,
    minted = excluded.minted,
    burned = excluded.burned,
    balance_sum = excluded.balance_sum,
    supply_block = excluded.supply_block,
    reconciled_at = excluded.reconciled_at,
    reconcile_status = excluded.reconcile_status
`);
const evidenceUpsertQ = db.prepare(`
  INSERT INTO emerging_actor_evidence(
    evidence_id, token, address, role, cluster_id, confidence, source,
    version, valid_from, valid_until, available_at
  ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?)
  ON CONFLICT(evidence_id) DO NOTHING
`);

export type SupplyStateRow = {
  token: string;
  watermark_rowid: number;
  total_supply: string;
  minted: string;
  burned: string;
  balance_sum: string;
  birth_ts: number | null;
  supply_block: number | null;
  reconciled_at: number | null;
  reconcile_status: string | null;
  version: number;
};

export const getSupplyState = (token: string): SupplyStateRow | null =>
  (supplyStateQ.get(token) as SupplyStateRow | undefined) ?? null;

export const supplyBalances = (token: string): Array<{ address: string; balance: bigint }> =>
  (balancesQ.all(token) as Array<{ address: string; balance: string }>).map((r) => ({
    address: r.address,
    balance: BigInt(r.balance),
  }));

// --- pure ledger math (unit-tested) ---

export type TransferDelta = { from: string; to: string; value: bigint };

/**
 * Apply one Transfer to a balance map following ERC-20 semantics: mint (from
 * zero) raises supply, burn (to zero) lowers it. A negative resulting
 * balance means the event stream is INCOMPLETE — clamp to zero and flag the
 * ledger corrupt rather than carry a nonsense number (§3.2's gap rule).
 */
export function applyDelta(
  balances: Map<string, bigint>,
  totals: { minted: bigint; burned: bigint },
  d: TransferDelta,
): { corrupt: boolean } {
  let corrupt = false;
  if (d.from === ZERO_ADDRESS) {
    totals.minted += d.value;
  } else {
    const b = balances.get(d.from) ?? 0n;
    if (b < d.value) corrupt = true;
    const next = b >= d.value ? b - d.value : 0n;
    if (next === 0n && b !== 0n) balances.delete(d.from);
    else balances.set(d.from, next);
  }
  if (d.to === ZERO_ADDRESS) {
    totals.burned += d.value;
  } else {
    balances.set(d.to, (balances.get(d.to) ?? 0n) + d.value);
  }
  return { corrupt };
}

export type GenesisClassification = {
  address: string;
  received: bigint;
  shareOfMinted: number;
};

/**
 * Genesis-window recipients (§5.2 genesis_recipient): cumulative received
 * during the window after the proven birth, at or above the share
 * threshold, excluding the zero address and the tracked pool contracts.
 * Classification is INFERRED by construction — a large recipient is a lead,
 * not a verdict.
 */
export function classifyGenesisRecipients(args: {
  transfers: TransferDelta[];
  birthTs: number;
  windowSeconds: number;
  minShareOfMinted: number;
  exclude: Set<string>;
}): GenesisClassification[] {
  let minted = 0n;
  const received = new Map<string, bigint>();
  for (const t of args.transfers) {
    if (t.from === ZERO_ADDRESS) minted += t.value;
    const to = t.to === ZERO_ADDRESS ? null : t.to;
    if (to !== null && !args.exclude.has(to)) received.set(to, (received.get(to) ?? 0n) + t.value);
  }
  if (minted === 0n) return [];
  const out: GenesisClassification[] = [];
  for (const [address, value] of received) {
    const share = Number(value) / Number(minted);
    if (share >= args.minShareOfMinted)
      out.push({ address, received: value, shareOfMinted: share });
  }
  return out.sort((a, b) => (a.received > b.received ? -1 : 1));
}

// --- sweep ---

const trackedTokensQ = () => db.prepare(`
  SELECT DISTINCT base_token AS token FROM emerging_discovery
  WHERE admitted_rank IS NOT NULL AND state != 'aged_out' AND base_token IS NOT NULL
`);

function recordEvidence(args: {
  token: string; address: string; role: ActorRole;
  confidence: 'proven' | 'inferred' | 'weak';
  source: string; version: number; validFrom: number;
}): void {
  evidenceUpsertQ.run(
    `${args.role}:${args.token}:${args.address}:${args.version}`,
    args.token, args.address, args.role,
    args.confidence, args.source, args.version,
    args.validFrom, args.validFrom,
  );
}

async function reconcileOnChain(token: string, computedSupply: bigint): Promise<'matched' | 'mismatch' | null> {
  try {
    const onChain = await mc([{ abi: ERC20_TOTAL_SUPPLY, address: token as Address, functionName: 'totalSupply' }]);
    const value = onChain[0];
    if (value === undefined || value === null) return null;
    return BigInt(value as unknown as bigint) === computedSupply ? 'matched' : 'mismatch';
  } catch {
    return null;
  }
}

/**
 * One actors sweep: per tracked token, consume newly scanned Transfers,
 * replay balances (full replay on reorg staleness), keep genesis-recipient
 * evidence current, and reconcile against the contract within budget.
 */
export async function runEmergingActorsSweep(): Promise<{
  tokens: number; consumed: number; reconciled: number; mismatches: number;
}> {
  const counters = { tokens: 0, consumed: 0, reconciled: 0, mismatches: 0 };
  const tokens = (trackedTokensQ().all() as Array<{ token: string }>).map((r) => r.token);
  const birthQ = db.prepare(
    'SELECT token_created_at AS t FROM emerging_discovery WHERE base_token = ? AND token_created_at IS NOT NULL LIMIT 1',
  );
  const reconcileBudget = EMERGING_TUNE.blockTsFetchesPerSweep; // shared engineering budget
  let reads = 0;

  for (const token of tokens) {
    counters.tokens++;
    // Birth comes from the DISCOVERY ledger's own age evidence (§3.1) — the
    // supply state never invents one.
    const birthRow = birthQ.get(token) as { t: number } | undefined;
    const birthTs = birthRow?.t ?? null;
    let state = getSupplyState(token);

    // Reorg staleness: any archived event at/below the consumed block means
    // the derived ledger is built on orphaned facts — replay from zero.
    if (state && state.reconcile_status !== 'reorg_stale' && state.supply_block !== null) {
      const archived = archivedAtOrBelowQ.get(token, state.supply_block) as { n: number };
      if (archived.n > 0)
        tx(() => {
          db.prepare('DELETE FROM emerging_supply_balances WHERE token = ?').run(token);
          db.prepare(`UPDATE emerging_supply_state SET reconcile_status = 'reorg_stale', watermark_rowid = 0,
                      total_supply = '0', minted = '0', burned = '0', balance_sum = '0' WHERE token = ?`).run(token);
        });
      state = getSupplyState(token);
    }

    const balances = new Map<string, bigint>();
    const totals = { minted: 0n, burned: 0n };
    let watermark = 0;
    let lastBlock = 0;
    if (state && state.reconcile_status !== 'reorg_stale') {
      watermark = state.watermark_rowid;
      lastBlock = state.supply_block ?? 0;
      totals.minted = BigInt(state.minted);
      totals.burned = BigInt(state.burned);
      for (const b of supplyBalances(token)) balances.set(b.address, b.balance);
    } else if (state) {
      // stale: watermark stays 0, maps stay empty → full replay below
    }

    let corrupt = false;
    const rows = transfersAfterQ.all(token, watermark) as Array<{
      rid: number; txHash: string; logIndex: number; blockNumber: number;
      blockTs: number | null; payload: string;
    }>;
    const windowEnd = birthTs !== null ? birthTs + 6 * 3600 : null;
    const exclude = new Set<string>([ZERO_ADDRESS, token]);
    for (const r of rows) {
      const p = JSON.parse(r.payload) as { from?: string; to?: string; value?: string };
      if (p.from === undefined || p.to === undefined || p.value === undefined) continue;
      const d: TransferDelta = { from: p.from.toLowerCase(), to: p.to.toLowerCase(), value: BigInt(p.value) };
      const res = applyDelta(balances, totals, d);
      if (res.corrupt) corrupt = true;
      watermark = Number(r.rid);
      lastBlock = Math.max(lastBlock, r.blockNumber);
    }
    counters.consumed += rows.length;

    // Genesis-recipient evidence, recomputed over the accumulated window.
    if (windowEnd !== null && totals.minted > 0n) {
      const all = transfersAfterQ.all(token, 0) as Array<{ payload: string; blockTs: number | null }>;
      const deltas: TransferDelta[] = [];
      for (const r of all) {
        const p = JSON.parse(r.payload) as { from?: string; to?: string; value?: string };
        if (p.from === undefined || p.to === undefined || p.value === undefined) continue;
        if (r.blockTs === null || r.blockTs > windowEnd) continue;
        deltas.push({ from: p.from.toLowerCase(), to: p.to.toLowerCase(), value: BigInt(p.value) });
      }
      for (const g of classifyGenesisRecipients({
        transfers: deltas, birthTs: birthTs!, windowSeconds: 6 * 3600,
        minShareOfMinted: 0.01, exclude,
      })) {
        recordEvidence({
          token, address: g.address, role: 'genesis_recipient',
          confidence: 'inferred', source: 'genesis-window',
          version: 1, validFrom: birthTs!,
        });
      }
    }

    // Launchpad tokens self-report their creator — an INFERRED role claim.
    if (isLaunchpadToken(token) && kvGet(`emerging_creator_evidenced:${token}`) === null) {
      try {
        // creator() rides the multicall path like every static read; a
        // revert (non-UERC20 shape) stays unevidenced and retries next sweep.
        const [creator] = await mc([{ abi: CREATOR_ABI, address: token as Address, functionName: 'creator' }]);
        if (creator !== undefined && creator !== null) {
          recordEvidence({
            token, address: String(creator).toLowerCase(), role: 'declared_beneficiary',
            confidence: 'inferred', source: 'uerc20-creator()',
            version: 1, validFrom: now(),
          });
          kvSet(`emerging_creator_evidenced:${token}`, '1');
        }
      } catch { /* retried next sweep */ }
    }

    // Reconcile at most one read per token per sweep, within budget.
    let reconcileStatus = state?.reconcile_status === 'reorg_stale' ? null : state?.reconcile_status ?? null;
    if (reads < reconcileBudget) {
      reads++;
      const result = await reconcileOnChain(token, totals.minted - totals.burned);
      if (result !== null) {
        reconcileStatus = result;
        counters.reconciled++;
        if (result === 'mismatch') counters.mismatches++;
      }
    }

    const balanceSum = [...balances.values()].reduce((a, b) => a + b, 0n);
    tx(() => {
      if (state && state.reconcile_status === 'reorg_stale')
        db.prepare('DELETE FROM emerging_supply_balances WHERE token = ?').run(token);
      for (const [address, balance] of balances) upsertBalanceQ.run(token, address, balance.toString());
      upsertStateQ.run(
        token, watermark, (totals.minted - totals.burned).toString(),
        totals.minted.toString(), totals.burned.toString(), balanceSum.toString(),
        birthTs, lastBlock, reconcileStatus !== null ? now() : null, reconcileStatus,
      );
    });
    if (corrupt || reconcileStatus === 'mismatch')
      log(`[emerging-actors] ${token}: corrupt=${corrupt} reconcile=${reconcileStatus}`);
  }
  return counters;
}

const CREATOR_ABI = parseAbi(['function creator() view returns (address)']);
