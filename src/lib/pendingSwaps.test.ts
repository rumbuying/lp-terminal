import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Hex } from 'viem'
import {
  isSettled,
  isSameUnresolvedSwap,
  isUnresolved,
  PENDING_SWAP_LINGER_MS,
  PENDING_SWAP_STALE_POLL_MS,
  PENDING_SWAP_STALE_MS,
  pendingSwapTickAction,
  pendingSwaps,
  type PendingSwap,
} from './pendingSwaps'

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex
const prefix = 'up33.pendingSwaps.v2.'
const base: PendingSwap = {
  id: hash(1),
  account: '0x3333333333333333333333333333333333333333',
  tokenIn: '0x1111111111111111111111111111111111111111',
  tokenOut: '0x2222222222222222222222222222222222222222',
  amountIn: '1000',
  inSym: 'ETH',
  outSym: 'UP',
  amountInDisp: '0.001',
  createdAt: 1_000,
  status: 'pending',
}

test('pending swaps remain protected through stale, replacement, reload and storage failure', () => {
  const backing = new Map<string, string>()
  let failWrites = false
  let confirmAfterRead: Hex | null = null
  const g = globalThis as { localStorage?: unknown }
  g.localStorage = {
    get length() {
      return backing.size
    },
    key: (i: number) => [...backing.keys()][i] ?? null,
    getItem: (k: string) => {
      const raw = backing.get(k) ?? null
      if (confirmAfterRead && k === prefix + confirmAfterRead) {
        backing.set(k, JSON.stringify({ ...base, id: confirmAfterRead, status: 'confirmed', settledAt: 2_000 }))
        confirmAfterRead = null
      }
      return raw
    },
    setItem: (k: string, v: string) => {
      if (failWrites) throw new Error('quota exceeded')
      backing.set(k, v)
    },
    removeItem: (k: string) => void backing.delete(k),
  }

  try {
    // Corrupt/unversioned storage is a trust boundary, never a render crash.
    backing.set(prefix + hash(99), JSON.stringify({ id: hash(99), status: 'pending', createdAt: 1 }))

    assert.equal(pendingSwaps.add(base), true)
    assert.deepEqual(pendingSwaps.get().map((e) => e.id), [hash(1)])

    pendingSwaps.settle(hash(1), 'stale')
    assert.equal(isUnresolved(pendingSwaps.get()[0].status), true)
    assert.equal(isSettled(pendingSwaps.get()[0].status), false)
    assert.equal(isSameUnresolvedSwap(pendingSwaps.get()[0], base.account, base.tokenIn, base.tokenOut, 1000n), true)
    assert.equal(
      isSameUnresolvedSwap(
        pendingSwaps.get()[0],
        '0x4444444444444444444444444444444444444444',
        base.tokenIn,
        base.tokenOut,
        1000n,
      ),
      false,
    )
    assert.equal(pendingSwaps.dismiss(hash(1)), false)

    // Tab A reads pending just before Tab B confirms it. A's stale verdict is
    // memory-only, so it cannot overwrite B's terminal receipt on disk.
    confirmAfterRead = hash(1)
    pendingSwaps.settle(hash(1), 'stale')
    assert.equal(JSON.parse(backing.get(prefix + hash(1))!).status, 'confirmed')
    pendingSwaps.add({ ...base, id: hash(8), createdAt: 8_000 }) // re-sync disk
    assert.equal(pendingSwaps.get().find((entry) => entry.id === hash(1))?.status, 'confirmed')
    assert.equal(pendingSwaps.dismiss(hash(1)), true)

    pendingSwaps.add({ ...base, id: hash(2), createdAt: 2_000 })
    assert.equal(pendingSwaps.replaceHash(hash(2), hash(9), false), true)
    assert.equal(pendingSwaps.get().find((entry) => entry.id === hash(9))?.status, 'pending')
    pendingSwaps.settle(hash(9), 'confirmed')
    pendingSwaps.settle(hash(9), 'stale')
    assert.equal(pendingSwaps.get().find((entry) => entry.id === hash(9))?.status, 'confirmed')

    // Another tab's independently keyed add survives our next mutation.
    const other = { ...base, id: hash(3), account: '0x4444444444444444444444444444444444444444' as const }
    backing.set(prefix + other.id, JSON.stringify(other))
    assert.equal(pendingSwaps.add({ ...base, id: hash(4), createdAt: 4_000 }), true)
    assert.deepEqual(new Set(pendingSwaps.get().map((e) => e.id)), new Set([hash(3), hash(4), hash(8), hash(9)]))

    assert.equal(pendingSwaps.dismiss(hash(9)), true)
    assert.equal(pendingSwaps.get().some((e) => e.id === hash(9)), false)

    pendingSwaps.add({ ...base, id: hash(6), createdAt: 6_000 })
    assert.equal(pendingSwaps.replaceHash(hash(6), hash(7), true), true)
    assert.equal(pendingSwaps.get().find((e) => e.id === hash(7))?.status, 'failed')

    // A quota failure is visible to the caller, while memory still protects
    // this session from re-submission.
    failWrites = true
    assert.equal(pendingSwaps.add({ ...base, id: hash(5), createdAt: 5_000 }), false)
    assert.equal(pendingSwaps.get().some((e) => e.id === hash(5)), true)
    pendingSwaps.settle(hash(5), 'stale')
    assert.equal(pendingSwaps.dismiss(hash(5)), false)

    const stale = { ...base, status: 'stale' as const }
    assert.equal(pendingSwapTickAction(stale, PENDING_SWAP_STALE_POLL_MS - 1, 0), null)
    assert.equal(pendingSwapTickAction(stale, PENDING_SWAP_STALE_POLL_MS, 0), 'poll')
    assert.equal(
      pendingSwapTickAction(base, base.createdAt + PENDING_SWAP_STALE_MS + 1, 0),
      'mark-stale-and-poll',
    )
    assert.equal(
      pendingSwapTickAction({ ...base, status: 'confirmed', settledAt: 2_000 }, 2_000 + PENDING_SWAP_LINGER_MS + 1, 0),
      'dismiss',
    )
    assert.ok(PENDING_SWAP_STALE_MS > PENDING_SWAP_LINGER_MS)
  } finally {
    delete g.localStorage
  }
})
