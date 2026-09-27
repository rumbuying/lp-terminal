import { useEffect, useState } from 'react'
import type { Address, Hex } from 'viem'

export type FablesManualRef = { poolId: Hex; tickLower: number; tickUpper: number }
const changed = 'fables-manual-refs-changed'
const keyFor = (owner: Address) => `fables-imports:4663:${owner.toLowerCase()}`

function read(key: string): FablesManualRef[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter((row): row is FablesManualRef => {
      const ref = row as FablesManualRef
      return !!ref && typeof ref.poolId === 'string' && /^0x[0-9a-fA-F]{64}$/.test(ref.poolId)
        && Number.isInteger(ref.tickLower) && Number.isInteger(ref.tickUpper)
    })
  } catch { return [] }
}

/** The position and strategy tabs share the same wallet-scoped manual imports. */
export function useFablesManualRefs(owner: Address) {
  const key = keyFor(owner)
  const [state, setState] = useState(() => ({ key, refs: read(key) }))
  useEffect(() => {
    const sync = () => setState({ key, refs: read(key) })
    const onStorage = (event: StorageEvent) => { if (event.key === key) sync() }
    sync()
    window.addEventListener(changed, sync)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(changed, sync)
      window.removeEventListener('storage', onStorage)
    }
  }, [key])
  const manualRefs = state.key === key ? state.refs : read(key)
  const saveManualRefs = (refs: FablesManualRef[]) => {
    localStorage.setItem(key, JSON.stringify(refs))
    setState({ key, refs })
    window.dispatchEvent(new Event(changed))
  }
  return { manualRefs, saveManualRefs }
}
