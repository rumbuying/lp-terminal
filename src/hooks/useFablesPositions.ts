import { useQuery } from '@tanstack/react-query'
import { getAddress, zeroAddress, type Address } from 'viem'
import { erc20Abi } from '../abi'
import { ACTIVE_IS_BUILD, CHAIN } from '../config/chains'
import { indexerApiPath } from '../config/chains/routes'
import { ENV } from '../config/env'
import { fablesHook } from '../config/fables'
import { fablesRangeId, readFablesPools, readFablesPosition, type FablesPosition } from '../lib/fables'
import { publicRpcClient } from '../lib/publicRpcClient'
import type { FablesManualRef } from './useFablesManualRefs'

type Candidate = { hook: string; rangeId: string; seenBlock: number }
export type { FablesManualRef } from './useFablesManualRefs'
export type FablesToken = { address: Address; symbol: string; decimals: number | null }

export async function fetchFablesPositions(owner: Address, manualRefs: readonly FablesManualRef[] = []): Promise<{
  positions: FablesPosition[]
  tokens: Record<string, FablesToken>
  indexError: string | null
}> {
  if (CHAIN.id !== 4663) throw new Error('Fables requires Robinhood Chain')
  const pools = await readFablesPools(publicRpcClient)
  const path = indexerApiPath('fables/positions', CHAIN.key, ENV.chainGateway, ACTIVE_IS_BUILD)
  let candidates: Candidate[] = []
  let indexError: string | null = null
  try {
    if (!path) throw new Error('Fables position index is unavailable on this host')
    const url = new URL(path, location.origin)
    url.searchParams.set('owner', owner)
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`Fables position index HTTP ${response.status}`)
    const body = await response.json() as {
      chainId?: unknown; ready?: unknown; error?: unknown; candidates?: unknown
    }
    if (body.chainId !== 4663 || !Array.isArray(body.candidates))
      throw new Error('Fables position index returned an invalid chain or shape')
    if (body.ready !== true)
      throw new Error(`Fables position index is not ready${body.error ? `: ${String(body.error)}` : ''}`)
    if (body.candidates.length > 500) throw new Error('Fables position index has too many candidates for this wallet')
    candidates = body.candidates as Candidate[]
  } catch (error) {
    indexError = String(error)
    if (manualRefs.length === 0) throw error
  }
  for (const row of candidates) {
    if (!row || typeof row.hook !== 'string' || !fablesHook(row.hook)
      || typeof row.rangeId !== 'string' || !/^\d+$/.test(row.rangeId))
      throw new Error('Fables position index returned an invalid candidate')
  }
  for (const ref of manualRefs) {
    const pool = pools.find(row => row.id.toLowerCase() === ref.poolId.toLowerCase())
    if (!pool?.active || !pool.reviewed || !Number.isInteger(ref.tickLower)
      || !Number.isInteger(ref.tickUpper) || ref.tickLower >= ref.tickUpper)
      throw new Error('Fables manual position identity is invalid')
    candidates.push({ hook: pool.key.hooks, rangeId: fablesRangeId(pool.id, ref.tickLower, ref.tickUpper).toString(), seenBlock: 0 })
  }
  candidates = [...new Map(candidates.map(row => [`${row.hook.toLowerCase()}:${row.rangeId}`, row])).values()]
  const positions: FablesPosition[] = []
  // Bounded parallel reads; range IDs are hints, and every retained result is
  // independently checked against hook balances, registry and Lens.
  for (let i = 0; i < candidates.length; i += 8) {
    const rows = await Promise.all(candidates.slice(i, i + 8).map(async row => {
      try {
        return await readFablesPosition(publicRpcClient, {
          owner, hook: getAddress(row.hook), rangeId: BigInt(row.rangeId), pools,
        })
      } catch (error) {
        if (error instanceof Error && error.message === 'E_FABLES_POSITION_EMPTY') return null
        throw error
      }
    }))
    positions.push(...rows.filter((row): row is FablesPosition => row !== null))
  }
  const currencies = [...new Set(positions.flatMap(position =>
    [position.pool.key.currency0.toLowerCase(), position.pool.key.currency1.toLowerCase()]))]
  const tokens: Record<string, FablesToken> = {}
  await Promise.all(currencies.map(async currency => {
    const address = getAddress(currency)
    if (address === zeroAddress) {
      tokens[currency] = { address, symbol: 'ETH', decimals: 18 }
      return
    }
    const [symbol, decimals] = await Promise.allSettled([
      publicRpcClient.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
      publicRpcClient.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
    ])
    tokens[currency] = {
      address,
      symbol: symbol.status === 'fulfilled' && typeof symbol.value === 'string'
        ? symbol.value.slice(0, 32) : `${address.slice(0, 6)}…`,
      decimals: decimals.status === 'fulfilled' && Number.isSafeInteger(Number(decimals.value))
        ? Number(decimals.value) : null,
    }
  }))
  return { positions, tokens, indexError }
}

export function useFablesPositions(owner: Address | undefined, manualRefs: readonly FablesManualRef[] = []) {
  return useQuery({
    queryKey: ['fables-positions', CHAIN.id, owner?.toLowerCase(), manualRefs],
    queryFn: () => fetchFablesPositions(owner!, manualRefs),
    enabled: CHAIN.id === 4663 && !!owner,
    refetchInterval: 30_000,
    staleTime: 20_000,
  })
}
