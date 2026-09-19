// The eight observation gates (docs/EMERGING-POOL-LP-PRD.zh-CN.md §5.3,
// EMG-B01). Every gate is a THREE-state claim — pass / fail / unknown — bound
// to evidence times and to a researchProfileHash where the amount matters
// (G07/G08). The contract that makes the whole pipeline safe:
//   - missing, stale or uncovered evidence is UNKNOWN, and unknown blocks;
//   - only a VERIFIED violation is fail;
//   - every gate read carries availableAt (§3.2) and, where freshness decays,
//     expiresAt — an expired pass is not a pass.
//
// Two gates are honest unknowns by design in this phase: G04 (protected
// depth) and G07 (exit-depth impact) need the locker audit and the
// exit-depth simulator — evidence feeds that do not exist yet. Returning
// unknown (with the reason) is the PRD's own fail-closed answer; faking a
// pass from proxies is exactly what §5.3 forbids.
import { CHAIN, now } from './config';
import { db, kvGet } from './store';
import {
  EMERGING_POLICY, EMERGING_THRESHOLDS as T,
  isApprovedQuote, policyTemplate, researchProfile,
} from './emergingPolicy';

export type GateStatus = 'pass' | 'fail' | 'unknown'

export type GateResult = {
  status: GateStatus
  reason: string
  availableAt: number | null
  expiresAt: number | null
}

const gate = (status: GateStatus, reason: string, availableAt: number | null = null, expiresAt: number | null = null): GateResult =>
  ({ status, reason, availableAt, expiresAt })

export type GateBundle = Record<string, GateResult> & { researchProfileHash?: string; policyVersion?: number }

// --- shared reads ---

const ledgerQ = db.prepare(`
  SELECT pool_key AS poolKey, venue, canonical_id AS canonicalId, token0, token1,
         base_token AS baseToken, quote_is_usdg AS quoteIsUsdg,
         pool_created_at AS poolCreatedAt, token_created_at AS tokenCreatedAt
  FROM emerging_discovery WHERE pool_key = ?`)
const v4HooksQ = db.prepare(`SELECT hooks FROM v4_pools WHERE pool_id = ?`)
const supplyQ = db.prepare(`SELECT total_supply, balance_sum, reconcile_status FROM emerging_supply_state WHERE token = ?`)
const topBalancesQ = db.prepare(`SELECT address, balance FROM emerging_supply_balances WHERE token = ? ORDER BY CAST(balance AS REAL) DESC LIMIT 20`)
const rolesQ = db.prepare(`SELECT COUNT(*) AS n FROM emerging_actor_evidence WHERE token = ?`)
const cursorFreshQ = db.prepare(`
  SELECT MAX(complete_through_ts) AS t FROM emerging_scan_cursors
  WHERE chain_id = ? AND status = 'active' AND complete_through_ts IS NOT NULL`)

// --- individual gates (pure over their inputs) ---

export function g01Identity(args: {
  venue: string; baseToken: string | null; quoteIsUsdg: number
  tokenCreatedAt: number | null; poolCreatedAt: number | null
  t: number
}): GateResult {
  if (!EMERGING_POLICY.venues.includes(args.venue as never))
    return gate('fail', 'venue_not_in_policy')
  if (!isApprovedQuote(CHAIN.addr.STABLE))
    return gate('fail', 'quote_registry_broken')
  if (args.baseToken === null)
    return gate('unknown', 'base_token_unproven', args.t)
  if (!isApprovedQuote(CHAIN.addr.STABLE) || !args.quoteIsUsdg)
    return gate('unknown', 'quote_pair_unproven', args.t)
  const birth = args.tokenCreatedAt ?? args.poolCreatedAt
  if (birth === null) return gate('unknown', 'token_age_unknown', args.t)
  if (args.t - birth >= T.emergingMaxAgeDays * 86_400)
    return gate('fail', 'token_not_young', birth, birth + T.emergingMaxAgeDays * 86_400)
  return gate('pass', 'identity_ok', Math.max(birth, args.t - T.sourceStaleSeconds), birth + T.emergingMaxAgeDays * 86_400)
}

export function g02TokenCapability(baseToken: string | null): GateResult {
  if (baseToken === null) return gate('unknown', 'base_token_unproven')
  const tpl = policyTemplate(baseToken)
  if (tpl === null)
    return gate('unknown', 'template_unreviewed', null, null)
  return gate('pass', `template_reviewed:${tpl.review.reviewer}`, tpl.review.reviewedAt, null)
}

export function g03PoolHookFee(args: { venue: string; canonicalId: string; completeThroughTs: number | null; t: number }): GateResult {
  if (!EMERGING_POLICY.venues.includes(args.venue as never)) return gate('fail', 'venue_not_in_policy')
  if (args.venue === 'univ4') {
    const row = v4HooksQ.get(args.canonicalId) as { hooks: string } | undefined
    if (!row) return gate('unknown', 'pool_not_in_v4_directory')
    if (row.hooks !== '0x' + '0'.repeat(40)) return gate('fail', 'v4_hooked_pool')
  }
  // up33-cl: dynamic-fee/unstaked-levy history needs its dedicated adapter
  // (§2 首期) — honest unknown until then, never a silent pass.
  if (args.venue === 'up33-cl') return gate('unknown', 'up33_fee_adapter_pending')
  const stale = args.completeThroughTs === null ||
    args.t - args.completeThroughTs > T.sourceStaleSeconds * 10
  if (stale) return gate('unknown', 'fee_history_stale', args.completeThroughTs, (args.completeThroughTs ?? 0) + T.sourceStaleSeconds * 10)
  return gate('pass', 'static_fee_v3', args.completeThroughTs, (args.completeThroughTs ?? 0) + T.sourceStaleSeconds * 10)
}

export const g04ProtectedDepth = (): GateResult =>
  gate('unknown', 'protected_depth_evidence_not_built')

export function g05Concentration(args: { baseToken: string; t: number }): GateResult {
  const sup = supplyQ.get(args.baseToken) as
    | { total_supply: string; balance_sum: string; reconcile_status: string | null }
    | undefined
  if (!sup || sup.reconcile_status === 'reorg_stale')
    return gate('unknown', 'holder_ledger_not_ready', args.t)
  const totalSupply = BigInt(sup.total_supply)
  if (totalSupply === 0n) return gate('unknown', 'supply_zero', args.t)
  if (BigInt(sup.balance_sum) !== totalSupply && sup.reconcile_status !== 'matched')
    return gate('unknown', 'holder_ledger_incomplete', args.t)
  const rows = topBalancesQ.all(args.baseToken) as Array<{ address: string; balance: string }>
  // System-held addresses (the pool contracts themselves) are excluded from
  // the ranking; §5.2's related-actor clustering refines this later.
  const system = new Set([args.baseToken, `0x${'0'.repeat(40)}`])
  const nonSystem = rows.filter((r) => !system.has(r.address)).slice(0, 10)
  const top10 = nonSystem.reduce((a, r) => a + BigInt(r.balance), 0n)
  const share = Number(top10) / Number(totalSupply)
  if (share >= T.maxTop10Pct) return gate('fail', `top10_share>=${T.maxTop10Pct}`, args.t)
  return gate('pass', `top10_share=${share.toFixed(4)}`, args.t, args.t + T.permissionStaleSeconds)
}

export function g06InventoryReleased(baseToken: string | null): GateResult {
  if (baseToken === null) return gate('unknown', 'base_token_unproven')
  const roles = rolesQ.get(baseToken) as { n: number }
  if (!roles || roles.n === 0) return gate('unknown', 'issuer_roles_unmapped')
  const raw = kvGet(`emerging_reduction:${baseToken}`)
  if (!raw) return gate('unknown', 'reduction_not_observed')
  const st = JSON.parse(raw) as { confirmedAt: number | null; invalidatedAt: number | null }
  if (st.invalidatedAt !== null || st.confirmedAt === null)
    return gate('unknown', 'reduction_not_confirmed', st.invalidatedAt)
  return gate('pass', 'tracked_inventory_reduced', st.confirmedAt, null)
}

export function g07ExitDepth(): GateResult {
  return gate('unknown', 'exit_depth_simulator_not_built')
}

export function g08SellEvidence(args: { poolKey: string; canonicalId: string; entrySizeUsdg: number; completeThroughTs: number | null; t: number }): GateResult {
  if (args.completeThroughTs === null || args.t - args.completeThroughTs > T.sourceStaleSeconds * 10)
    return gate('unknown', 'streams_stale', args.completeThroughTs)
  const rows = db
    .prepare(`SELECT payload FROM emerging_chain_events
              WHERE pool_key = ? AND canonical = 1 AND kind = 'swap'
              ORDER BY block_number DESC LIMIT 500`)
    .all(args.poolKey) as Array<{ payload: string }>
  const sellers = new Map<string, bigint>()
  let sells = 0
  const usdg = CHAIN.addr.STABLE.toLowerCase()
  for (const r of rows) {
    const p = JSON.parse(r.payload) as { amount0?: string; amount1?: string; sender?: string }
    if (p.amount0 === undefined || p.amount1 === undefined) continue
    // A sell of the BASE (token0) prints amount0 > 0 with the quote side out;
    // its quote volume is the USDG leg when the pair is USDG-quoted.
    if (BigInt(p.amount0) <= 0n) continue
    sells++
    const sender = (p.sender ?? '').toLowerCase()
    if (!sender || sender === args.canonicalId) continue
    const vol = usdg !== '' ? absStr(p.amount1) : 0n
    if (vol > 0n) sellers.set(sender, (sellers.get(sender) ?? 0n) + vol)
  }
  const bigSell = [...sellers.values()].some((v) => v >= BigInt(Math.round(args.entrySizeUsdg * 1e6)))
  if (sells >= T.minSellTrades && sellers.size >= T.minSellActors && bigSell)
    return gate('pass', `sells=${sells},actors=${sellers.size}`, args.t, args.t + T.sourceStaleSeconds * 10)
  if (sells < T.minSellTrades || sellers.size < T.minSellActors)
    return gate('unknown', `sell_evidence_insufficient(${sells}/${sellers.size})`, args.t)
  return gate('unknown', 'no_sell_covers_paper_size', args.t)
}

const absStr = (s: string) => (s.startsWith('-') ? BigInt(s.slice(1)) : BigInt(s))

// --- aggregate ---

/**
 * Evaluate all eight gates for one pool under one research profile. The
 * bundle carries the profile hash and the policy version it ran under —
 * a pass is meaningless without both (§5.3, §6.1).
 */
export function evaluateGates(poolKey: string, profileHash: string): { gates: GateBundle; allPass: boolean } {
  const profile = researchProfile(profileHash)
  if (profile === null) throw new Error(`unknown research profile ${profileHash}`)
  const row = ledgerQ.get(poolKey) as
    | { venue: string; canonicalId: string; baseToken: string | null; quoteIsUsdg: number; tokenCreatedAt: number | null; poolCreatedAt: number | null }
    | undefined
  if (!row) throw new Error(`unknown pool ${poolKey}`)
  const t = now()
  const completeThrough = (cursorFreshQ.get(CHAIN.id) as { t: number | null } | null)?.t ?? null

  const gates: GateBundle = {}
  gates.G01 = g01Identity({ venue: row.venue, baseToken: row.baseToken, quoteIsUsdg: row.quoteIsUsdg, tokenCreatedAt: row.tokenCreatedAt, poolCreatedAt: row.poolCreatedAt, t })
  gates.G02 = g02TokenCapability(row.baseToken)
  gates.G03 = g03PoolHookFee({ venue: row.venue, canonicalId: row.canonicalId, completeThroughTs: completeThrough, t })
  gates.G04 = g04ProtectedDepth()
  gates.G05 = row.baseToken !== null
    ? g05Concentration({ baseToken: row.baseToken, t })
    : gate('unknown', 'base_token_unproven')
  gates.G06 = g06InventoryReleased(row.baseToken)
  gates.G07 = g07ExitDepth()
  gates.G08 = g08SellEvidence({ poolKey, canonicalId: row.canonicalId, entrySizeUsdg: profile.entrySizeUsdg, completeThroughTs: completeThrough, t })
  gates.researchProfileHash = profileHash
  gates.policyVersion = String(EMERGING_POLICY.policyVersion) as never

  const allPass = ['G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07', 'G08']
    .every((k) => gates[k].status === 'pass')
  return { gates, allPass }
}
