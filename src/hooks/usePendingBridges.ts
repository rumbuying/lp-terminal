// Drives the conservative pending-transfer polling while the bridge tab is
// mounted: a 5s scheduler runs due checks (cadence decided in pending.ts),
// announces terminal states to the activity log, and refreshes balances on
// fill. Leaving the tab pauses polling; entries persist and resume later.
import { useEffect, useSyncExternalStore } from 'react'
import type { Hex } from 'viem'
import { CHAIN_ID } from '../config/addresses'
import { explorerOf } from '../config/bridge'
import { t } from '../i18n'
import {
  checkPendingTransfer,
  isStale,
  nextCheckAt,
  pendingBridges,
  type PendingTransfer,
} from '../lib/bridge/pending'
import { invalidateTransactionState } from '../lib/tx'
import { txlog } from '../lib/txlog'
import { homeClient } from '../lib/homeClient'

const portalReceiptProbe = async (childTxHash: Hex): Promise<boolean> => {
  const client = homeClient()
  const rcpt = await client.getTransactionReceipt({ hash: childTxHash }).catch(() => null)
  return rcpt !== null
}

const inflight = new Set<string>()

function announce(t0: PendingTransfer, status: PendingTransfer['status'], fillTxHash?: string) {
  if (status === 'filled') {
    const id = txlog.push('ok', t('bridge.filled'), fillTxHash)
    if (fillTxHash) txlog.update(id, { href: `${explorerOf(t0.destChainId)}/tx/${fillTxHash}` })
    invalidateTransactionState('balances')
  } else if (status === 'refunded') txlog.push('err', t('bridge.refunded'))
  else if (status === 'failed') txlog.push('err', t('bridge.fillFailed'))
}

async function runCheck(entry: PendingTransfer) {
  if (inflight.has(entry.id)) return
  inflight.add(entry.id)
  try {
    const patch = await checkPendingTransfer(entry, portalReceiptProbe)
    pendingBridges.update(entry.id, patch)
    if (patch.status && patch.status !== entry.status) announce(entry, patch.status, patch.fillTxHash)
  } finally {
    inflight.delete(entry.id)
  }
}

/** manual "check now" — bypasses the conservative schedule for one entry */
export function recheckPending(entry: PendingTransfer) {
  void runCheck(entry)
}

export function usePendingBridges(): PendingTransfer[] {
  const list = useSyncExternalStore(pendingBridges.subscribe, pendingBridges.get)
  useEffect(() => {
    const tick = () => {
      const now = Date.now()
      for (const entry of pendingBridges.get()) {
        if (entry.status !== 'pending') continue
        if (isStale(entry, now)) {
          pendingBridges.update(entry.id, { status: 'stale' })
          continue
        }
        if (now >= nextCheckAt(entry)) void runCheck(entry)
      }
    }
    tick()
    const id = setInterval(tick, 5_000)
    return () => clearInterval(id)
  }, [])
  return list
}
