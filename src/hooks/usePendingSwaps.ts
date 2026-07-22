// Drives settlement of persisted pending swaps while the SWAP tab is mounted:
// pending hashes poll every 3s; old unresolved hashes stay protected as `stale`
// and continue at a lower cadence. Confirmed/failed rows linger briefly. This
// keeps reloads and slow/replaced transactions from enabling a duplicate swap.
import { useEffect, useSyncExternalStore } from 'react'
import { getPublicClient } from 'wagmi/actions'
import { CHAIN_ID } from '../config/addresses'
import { wagmiConfig } from '../config/wagmi'
import {
  pendingSwapTickAction,
  pendingSwaps,
  type PendingSwap,
} from '../lib/pendingSwaps'
import { invalidateAll } from '../lib/tx'

const inflight = new Set<string>()
const lastStalePoll = new Map<string, number>()

async function settleOne(entry: PendingSwap) {
  if (inflight.has(entry.id)) return
  inflight.add(entry.id)
  try {
    const client = getPublicClient(wagmiConfig, { chainId: CHAIN_ID })
    // not-yet-mined throws — treated as "keep polling"
    const rcpt = client ? await client.getTransactionReceipt({ hash: entry.id }).catch(() => null) : null
    if (!rcpt) return
    pendingSwaps.settle(entry.id, rcpt.status === 'success' ? 'confirmed' : 'failed')
    lastStalePoll.delete(entry.id)
    invalidateAll() // a fill changes balances
  } finally {
    inflight.delete(entry.id)
  }
}

export function usePendingSwaps(): PendingSwap[] {
  const list = useSyncExternalStore(pendingSwaps.subscribe, pendingSwaps.get)
  useEffect(() => {
    const tick = () => {
      const now = Date.now()
      for (const entry of pendingSwaps.get()) {
        const action = pendingSwapTickAction(entry, now, lastStalePoll.get(entry.id) ?? 0)
        if (action === 'mark-stale-and-poll') pendingSwaps.settle(entry.id, 'stale')
        if (action === 'poll' || action === 'mark-stale-and-poll') {
          if (entry.status === 'stale' || action === 'mark-stale-and-poll') lastStalePoll.set(entry.id, now)
          void settleOne(entry)
        } else if (action === 'dismiss') {
          lastStalePoll.delete(entry.id)
          pendingSwaps.dismiss(entry.id)
        }
      }
    }
    tick()
    const id = setInterval(tick, 3_000)
    return () => clearInterval(id)
  }, [])
  return list
}
