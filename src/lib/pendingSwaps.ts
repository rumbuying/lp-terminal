// Persistent registry of unresolved SWAP transactions. Each hash gets its own
// localStorage key so concurrent tabs cannot overwrite each other's entries.
import { isAddress, isHex, type Address, type Hex } from 'viem'
import { chainKey } from './chainStore'

export type PendingSwapStatus = 'pending' | 'confirmed' | 'failed' | 'stale'

export const PENDING_SWAP_STALE_MS = 10 * 60_000
export const PENDING_SWAP_STALE_POLL_MS = 60_000
export const PENDING_SWAP_LINGER_MS = 15_000

export type PendingSwap = {
  id: Hex
  account: Address
  tokenIn: Address
  tokenOut: Address
  amountIn: string
  inSym: string
  outSym: string
  amountInDisp: string
  createdAt: number
  status: PendingSwapStatus
  settledAt?: number
}

// per chain, and the chain sits BEFORE the hash so the prefix scan below still
// cannot see another chain's entries. A hash from the wrong chain never gets a
// receipt, so the row would sit "pending" forever and link into the wrong
// explorer (lib/chainStore.ts).
export const PENDING_SWAP_PREFIX = chainKey('up33.pendingSwaps.v2') + '.'
const statuses: readonly PendingSwapStatus[] = ['pending', 'confirmed', 'failed', 'stale']
const keyOf = (id: Hex) => PENDING_SWAP_PREFIX + id.toLowerCase()

export const isSettled = (status: PendingSwapStatus) => status === 'confirmed' || status === 'failed'
export const isUnresolved = (status: PendingSwapStatus) => !isSettled(status)

export function pendingSwapTickAction(
  entry: PendingSwap,
  now: number,
  lastStalePoll: number,
): 'poll' | 'mark-stale-and-poll' | 'dismiss' | null {
  if (entry.status === 'pending') {
    return now - entry.createdAt > PENDING_SWAP_STALE_MS ? 'mark-stale-and-poll' : 'poll'
  }
  if (entry.status === 'stale') {
    return now - lastStalePoll >= PENDING_SWAP_STALE_POLL_MS ? 'poll' : null
  }
  if (entry.settledAt && now - entry.settledAt > PENDING_SWAP_LINGER_MS) return 'dismiss'
  return null
}

export function isSameUnresolvedSwap(
  entry: PendingSwap,
  account: Address,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): boolean {
  return (
    isUnresolved(entry.status) &&
    entry.account.toLowerCase() === account.toLowerCase() &&
    entry.tokenIn.toLowerCase() === tokenIn.toLowerCase() &&
    entry.tokenOut.toLowerCase() === tokenOut.toLowerCase() &&
    entry.amountIn === amountIn.toString()
  )
}

function validEntry(value: unknown): value is PendingSwap {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.id === 'string' &&
    isHex(entry.id) &&
    entry.id.length === 66 &&
    typeof entry.account === 'string' &&
    isAddress(entry.account) &&
    typeof entry.tokenIn === 'string' &&
    isAddress(entry.tokenIn) &&
    typeof entry.tokenOut === 'string' &&
    isAddress(entry.tokenOut) &&
    typeof entry.amountIn === 'string' &&
    /^[1-9]\d*$/.test(entry.amountIn) &&
    typeof entry.inSym === 'string' &&
    typeof entry.outSym === 'string' &&
    typeof entry.amountInDisp === 'string' &&
    typeof entry.createdAt === 'number' &&
    Number.isFinite(entry.createdAt) &&
    entry.createdAt >= 0 &&
    typeof entry.status === 'string' &&
    statuses.includes(entry.status as PendingSwapStatus) &&
    (entry.settledAt === undefined ||
      (typeof entry.settledAt === 'number' && Number.isFinite(entry.settledAt) && entry.settledAt >= 0))
  )
}

function parse(raw: string | null): PendingSwap | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as unknown
    return validEntry(value) ? value : null
  } catch {
    return null
  }
}

function loadAll(): PendingSwap[] | null {
  try {
    const found: PendingSwap[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(PENDING_SWAP_PREFIX)) continue
      const entry = parse(localStorage.getItem(key))
      if (entry && key === keyOf(entry.id)) found.push(entry)
    }
    return found.sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return null
  }
}

let entries: PendingSwap[] | null = null
let storageUsable = true
const subs = new Set<() => void>()
let storageHooked = false

function all(): PendingSwap[] {
  if (entries !== null) return entries
  const stored = loadAll()
  if (stored === null) storageUsable = false
  entries = stored ?? []
  return entries
}

function fresh(): PendingSwap[] {
  if (!storageUsable) return entries ?? []
  const stored = loadAll()
  if (stored === null) {
    storageUsable = false
    return entries ?? []
  }
  entries = stored
  return stored
}

function write(entry: PendingSwap): boolean {
  if (!storageUsable) return false
  try {
    // `stale` is only a local UI/polling state. Persisting it would let a tab
    // with an old pending read overwrite another tab's just-written receipt.
    const stored = entry.status === 'stale' ? { ...entry, status: 'pending' as const, settledAt: undefined } : entry
    localStorage.setItem(keyOf(entry.id), JSON.stringify(stored))
    return true
  } catch {
    storageUsable = false
    return false
  }
}

function remove(id: Hex): boolean {
  if (!storageUsable) return false
  try {
    localStorage.removeItem(keyOf(id))
    return true
  } catch {
    storageUsable = false
    return false
  }
}

function notify() {
  for (const subscriber of subs) {
    try {
      subscriber()
    } catch {
      // A render observer must never break transaction tracking.
    }
  }
}

export const pendingSwaps = {
  add(entry: PendingSwap): boolean {
    if (!validEntry(entry)) return false
    const base = fresh()
    if (base.some((current) => current.id === entry.id)) return true
    entries = [entry, ...base].sort((a, b) => b.createdAt - a.createdAt)
    const persisted = write(entry)
    if (persisted) {
      const stored = loadAll()
      if (stored !== null) entries = stored
    }
    notify()
    return persisted
  },

  settle(id: Hex, status: PendingSwapStatus): boolean {
    const base = fresh()
    const current = base.find((entry) => entry.id === id)
    if (!current) return false
    if (isSettled(current.status) || (current.status === 'stale' && status === 'pending')) return true
    const next = {
      ...current,
      status,
      settledAt: isSettled(status) ? current.settledAt ?? Date.now() : current.settledAt,
    }
    entries = base.map((entry) => (entry.id === id ? next : entry))
    if (status === 'stale') {
      notify()
      return true
    }
    const persisted = write(next)
    notify()
    return persisted
  },

  replaceHash(oldId: Hex, newId: Hex, cancelled: boolean): boolean {
    const base = fresh()
    const current = base.find((entry) => entry.id === oldId)
    if (!current || oldId === newId) return !!current
    const next: PendingSwap = {
      ...current,
      id: newId,
      status: cancelled ? 'failed' : current.status,
      settledAt: cancelled ? Date.now() : current.settledAt,
    }
    entries = [next, ...base.filter((entry) => entry.id !== oldId && entry.id !== newId)]
    const persisted = write(next)
    const removed = persisted && remove(oldId)
    notify()
    return persisted && removed
  },

  dismiss(id: Hex): boolean {
    const base = fresh()
    const current = base.find((entry) => entry.id === id)
    if (!current || !isSettled(current.status)) return false
    entries = base.filter((entry) => entry.id !== id)
    const persisted = remove(id)
    notify()
    return persisted
  },

  get(): PendingSwap[] {
    return all()
  },

  subscribe(subscriber: () => void): () => void {
    if (!storageHooked && typeof window !== 'undefined') {
      storageHooked = true
      window.addEventListener('storage', (event) => {
        if (!event.key?.startsWith(PENDING_SWAP_PREFIX) || !storageUsable) return
        const stored = loadAll()
        if (stored === null) storageUsable = false
        else entries = stored
        notify()
      })
    }
    // Attach the storage listener before the read. React re-checks getSnapshot
    // after subscribe, closing the get→subscribe race.
    if (storageUsable) {
      const stored = loadAll()
      if (stored === null) storageUsable = false
      else entries = stored
    }
    subs.add(subscriber)
    return () => subs.delete(subscriber)
  },
}
