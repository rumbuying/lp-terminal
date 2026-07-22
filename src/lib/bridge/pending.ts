// Persistent registry of in-flight bridge transfers, polled CONSERVATIVELY.
// Product decision (2026-07-18): after the deposit confirms we do NOT sit in a
// tight status loop — the transfer becomes a PENDING entry on the bridge tab,
// the first status check waits until ~90% of the provider's ETA, and follow-ups
// run on a slow cadence (20s for fast engines, 60s for the ~10-min canonical
// bridge). Entries survive reloads via localStorage; after an hour still
// pending they go 'stale' (auto-polling stops, manual recheck stays).
import type { Hex } from 'viem'
import { fetchAcrossStatus } from './across'
import { fetchRelayStatus } from './relay'
import type { BridgeProviderId } from './types'

export type PendingTracker =
  | { provider: 'relay'; requestId: string }
  | { provider: 'across'; originChainId: number; depositTxHash: string }
  /** null childTxHash = receipt parse failed; untrackable, surfaces as stale */
  | { provider: 'portal'; childTxHash: Hex | null }

export type PendingStatus = 'pending' | 'filled' | 'refunded' | 'failed' | 'stale'

export type PendingTransfer = {
  /** deposit tx hash — unique per transfer */
  id: string
  provider: BridgeProviderId
  tracker: PendingTracker
  /** ms epoch of the deposit confirmation */
  createdAt: number
  etaSec: number
  originChainId: number
  destChainId: number
  /** same-token model: one symbol describes both legs */
  symbol: string
  /** origin-side amount, display units */
  amountIn: string
  /** expected destination amount, raw units as string */
  expectedOut: string
  decimals: number
  depositTxHash: string
  status: PendingStatus
  fillTxHash?: string
  checkedAt?: number
}

const KEY = 'up33.bridgePending.v1'
const MAX = 20

/** null = storage unavailable (blocked/absent) — distinct from an empty list,
 *  so an unreadable disk is never mistaken for "another tab dismissed all" */
function load(): PendingTransfer[] | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (t): t is PendingTransfer =>
        !!t &&
        typeof (t as PendingTransfer).id === 'string' &&
        typeof (t as PendingTransfer).createdAt === 'number' &&
        ['pending', 'filled', 'refunded', 'failed', 'stale'].includes((t as PendingTransfer).status) &&
        typeof (t as PendingTransfer).tracker === 'object',
    )
  } catch {
    return null
  }
}

function save(list: PendingTransfer[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* storage blocked/full — the in-memory list still works this session */
  }
}

let entries: PendingTransfer[] | null = null // lazy so module load never touches storage
const subs = new Set<() => void>()
let storageHooked = false

const isTerminal = (s: PendingStatus) => s === 'filled' || s === 'refunded' || s === 'failed'

function all(): PendingTransfer[] {
  entries ??= load() ?? []
  return entries
}

/** re-sync with storage before mutating: several tabs share this store, and
 *  whole-list last-writer-wins would drop the other tab's entries or status
 *  advances. Disk is the shared truth: disk-only entries are another tab's
 *  adds (keep), memory-only entries were dismissed there (drop), and an entry
 *  present in both keeps its most-advanced form. */
function fresh(): PendingTransfer[] {
  const disk = load()
  const mem = entries
  if (disk === null) return mem ?? [] // unreadable storage — memory carries on
  if (mem === null) return disk
  return disk.map((d) => {
    const m = mem.find((e) => e.id === d.id)
    if (!m) return d
    if (isTerminal(d.status) !== isTerminal(m.status)) return isTerminal(d.status) ? d : m
    return (m.checkedAt ?? 0) > (d.checkedAt ?? 0) ? m : d
  })
}

function emit() {
  save(all())
  subs.forEach((f) => f())
}

export const pendingBridges = {
  add(t: PendingTransfer) {
    const base = fresh()
    entries = base.some((e) => e.id === t.id) ? base : [t, ...base].slice(0, MAX)
    emit()
  },
  update(id: string, patch: Partial<PendingTransfer>) {
    entries = fresh().map((e) => {
      if (e.id !== id) return e
      const next = { ...e, ...patch }
      // a terminal state never regresses (e.g. a stale verdict computed from a
      // pre-fill snapshot, or a slow check racing another tab's fill)
      if (isTerminal(e.status) && patch.status && !isTerminal(patch.status)) next.status = e.status
      return next
    })
    emit()
  },
  dismiss(id: string) {
    entries = fresh().filter((e) => e.id !== id)
    emit()
  },
  get(): PendingTransfer[] {
    return all()
  },
  subscribe(f: () => void): () => void {
    // cross-tab sync: adopt another tab's write when it lands ('storage' only
    // fires in OTHER tabs — exactly the direction we need)
    if (!storageHooked && typeof window !== 'undefined') {
      storageHooked = true
      window.addEventListener('storage', (ev) => {
        if (ev.key !== KEY) return
        entries = load() ?? entries
        subs.forEach((s) => s())
      })
    }
    subs.add(f)
    return () => subs.delete(f)
  },
}

// ---- conservative scheduling (pure, unit-tested) ----

/** pending this long → 'stale': auto-polling stops, manual recheck remains */
export const PENDING_STALE_MS = 60 * 60_000

/** first check ≈90% of ETA (never under 8s), then 20s/60s cadence by speed class */
export function nextCheckAt(t: PendingTransfer): number {
  const eta = t.etaSec * 1000
  const first = t.createdAt + Math.max(Math.round(eta * 0.9), 8_000)
  if (!t.checkedAt) return first
  const cadence = eta >= 120_000 ? 60_000 : 20_000
  return Math.max(first, t.checkedAt + cadence)
}

export const isStale = (t: PendingTransfer, now: number) => now - t.createdAt > PENDING_STALE_MS

/** locale-neutral short ETA for terminal rows: 600 → "~10m", 7 → "~7s" */
export const fmtEtaShort = (sec: number): string =>
  sec >= 90 ? `~${Math.round(sec / 60)}m` : `~${Math.max(1, Math.round(sec))}s`

// ---- status checking (portal receipt probe injected: wagmi stays out of here) ----

export type PortalReceiptProbe = (childTxHash: Hex) => Promise<boolean>

/** one status check → patch to merge (always bumps checkedAt; transient API
 *  errors resolve to just that, so the cadence retries silently) */
export async function checkPendingTransfer(
  t: PendingTransfer,
  portalReceipt: PortalReceiptProbe,
): Promise<Partial<PendingTransfer>> {
  const base: Partial<PendingTransfer> = { checkedAt: Date.now() }
  try {
    if (t.tracker.provider === 'relay') {
      const s = await fetchRelayStatus(t.tracker.requestId)
      if (s.status === 'success') return { ...base, status: 'filled', fillTxHash: s.txHashes?.at(-1) }
      if (s.status === 'refund') return { ...base, status: 'refunded' }
      if (s.status === 'failure') return { ...base, status: 'failed' }
      return base
    }
    if (t.tracker.provider === 'across') {
      const s = await fetchAcrossStatus(t.tracker.originChainId, t.tracker.depositTxHash)
      if (s.status === 'filled') return { ...base, status: 'filled', fillTxHash: s.fillTx }
      if (s.status === 'refunded' || s.status === 'expired') return { ...base, status: 'refunded' }
      return base
    }
    // portal: the child tx hash was derived from the deposit receipt — arrival
    // is one receipt lookup on our own RPC
    if (t.tracker.childTxHash === null) return { ...base, status: 'stale' }
    const found = await portalReceipt(t.tracker.childTxHash)
    return found ? { ...base, status: 'filled', fillTxHash: t.tracker.childTxHash } : base
  } catch {
    return base
  }
}
