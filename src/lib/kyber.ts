import type { Address } from 'viem'
import { ENV } from '../config/env'

const HEADERS = { 'x-client-id': 'up33-terminal' }
const api = () => `${ENV.kyberBase}/${ENV.kyberChain}/api/v1`

/** Fee-free Kyber USD valuation. This module intentionally exposes no transaction builder. */
export async function kyberUsdValue(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  signal?: AbortSignal,
): Promise<number> {
  const url = new URL(`${api()}/routes`, location.origin)
  url.searchParams.set('tokenIn', tokenIn)
  url.searchParams.set('tokenOut', tokenOut)
  url.searchParams.set('amountIn', amountIn.toString())
  url.searchParams.set('gasInclude', 'false')

  const response = await fetch(url, { headers: HEADERS, signal })
  const payload = await response.json()
  const value = Number(payload?.data?.routeSummary?.amountOutUsd)
  if (!response.ok || payload?.code !== 0 || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Kyber valuation failed: ${payload?.message ?? response.status}`)
  }
  return value
}
