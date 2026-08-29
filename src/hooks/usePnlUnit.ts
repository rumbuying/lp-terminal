import { useCallback, useEffect, useState } from 'react'

export type PnlUnit = 'quote' | 'stable'

const STORAGE_KEY = 'lp-terminal:pnl-unit:v1'
const CHANGE_EVENT = 'lp-terminal:pnl-unit-change'

const readUnit = (): PnlUnit => {
  if (typeof window === 'undefined') return 'quote'
  try { return window.localStorage.getItem(STORAGE_KEY) === 'stable' ? 'stable' : 'quote' } catch { return 'quote' }
}

/** One preference shared by strategy, history and calendar views. */
export function usePnlUnit(): [PnlUnit, (unit: PnlUnit) => void] {
  const [unit, setUnitState] = useState<PnlUnit>(readUnit)
  useEffect(() => {
    const sync = () => setUnitState(readUnit())
    window.addEventListener('storage', sync)
    window.addEventListener(CHANGE_EVENT, sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener(CHANGE_EVENT, sync)
    }
  }, [])
  const setUnit = useCallback((next: PnlUnit) => {
    try { window.localStorage.setItem(STORAGE_KEY, next) } catch { /* keep the in-memory preference */ }
    setUnitState(next)
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }, [])
  return [unit, setUnit]
}
