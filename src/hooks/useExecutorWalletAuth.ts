import { useCallback, useEffect, useRef, useState } from 'react'
import { useSignMessage } from 'wagmi'
import type { Address } from 'viem'
import { executorWalletChallenge, executorWalletVerify } from '../lib/executorClient'

type StoredSession = { token: string; address: Address; expiresAt: number }
export type ExecutorWalletAuthStatus = 'idle' | 'requesting' | 'signing' | 'verifying' | 'authenticated' | 'error'

const key = (address: string) => `lp-terminal:executor-wallet-session:v1:${address.toLowerCase()}`

function savedSession(address: Address): StoredSession | undefined {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(key(address)) ?? 'null') as StoredSession | null
    if (!parsed || parsed.address.toLowerCase() !== address.toLowerCase() || parsed.expiresAt <= Math.floor(Date.now() / 1000) + 30) {
      sessionStorage.removeItem(key(address))
      return undefined
    }
    return parsed
  } catch { return undefined }
}

export function useExecutorWalletAuth(address: Address | undefined, enabled = true, auto = true) {
  const { signMessageAsync } = useSignMessage()
  const [token, setToken] = useState('')
  const [status, setStatus] = useState<ExecutorWalletAuthStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const attemptedAddress = useRef('')
  const currentAddress = useRef(address?.toLowerCase())
  currentAddress.current = address?.toLowerCase()

  const authenticate = useCallback(async () => {
    if (!address || !enabled || inFlight.current) return
    const requestedAddress = address.toLowerCase()
    inFlight.current = true
    setError(null)
    try {
      setStatus('requesting')
      const challenge = await executorWalletChallenge(address)
      if (currentAddress.current !== requestedAddress) return
      setStatus('signing')
      const signature = await signMessageAsync({ message: challenge.message })
      if (currentAddress.current !== requestedAddress) return
      setStatus('verifying')
      const session = await executorWalletVerify(challenge.id, address, signature)
      if (currentAddress.current !== requestedAddress) return
      const stored: StoredSession = { token: session.token, address: session.address, expiresAt: session.expiresAt }
      sessionStorage.setItem(key(address), JSON.stringify(stored))
      setToken(session.token)
      setStatus('authenticated')
    } catch (cause) {
      if (currentAddress.current !== requestedAddress) return
      const message = cause instanceof Error ? cause.message : 'wallet authentication failed'
      setError(/rejected|denied|cancel/i.test(message) ? 'wallet signature was cancelled' : message)
      setStatus('error')
    } finally {
      inFlight.current = false
    }
  }, [address, enabled, signMessageAsync])

  const retry = useCallback(() => {
    attemptedAddress.current = ''
    void authenticate()
  }, [authenticate])

  const invalidate = useCallback(() => {
    if (address) {
      try { sessionStorage.removeItem(key(address)) } catch { /* unavailable storage */ }
    }
    setToken('')
    setStatus('idle')
    attemptedAddress.current = ''
  }, [address])

  useEffect(() => {
    setToken('')
    setError(null)
    if (!address || !enabled) {
      setStatus('idle')
      return
    }
    const saved = savedSession(address)
    if (saved) {
      setToken(saved.token)
      setStatus('authenticated')
      return
    }
    const normalized = address.toLowerCase()
    if (attemptedAddress.current === normalized) return
    attemptedAddress.current = normalized
    if (auto) void authenticate()
  }, [address, enabled, auto, authenticate])

  return { token, status, error, retry, invalidate }
}
