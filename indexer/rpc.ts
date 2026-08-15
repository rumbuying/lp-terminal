import { createPublicClient, defineChain, fallback, http, type PublicClient } from 'viem'
import { CHAIN, log, PUBLIC_RPC, TUNE, rpcUrls, sleep } from './config'

// duplicated from src/config/chain.ts — that module imports src/config/env.ts
// (import.meta.env, vite-only) so it can't be loaded under node
const indexerChain = defineChain({
  id: CHAIN.id,
  name: CHAIN.name,
  nativeCurrency: CHAIN.nativeCurrency,
  rpcUrls: { default: { http: [PUBLIC_RPC] } },
  blockExplorers: { default: { name: CHAIN.explorer.name, url: CHAIN.explorer.url } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
})

const urls = rpcUrls()
export const usingPrivateRpc = urls.some((url) => url !== PUBLIC_RPC)
// timeout is deliberately tight: a healthy 400-call aggregate answers in 2-4s
// (measured 2026-07-16); a stalled attempt should fail fast and retry, not
// pin the whole boot for 30s. Bad chunks degrade to sub-chunks in mc().
export const pc: PublicClient = createPublicClient({
  chain: indexerChain,
  transport: fallback(
    urls.map((url) => http(url, { timeout: 10_000 })),
    { retryCount: 2, retryDelay: 400 },
  ),
})

/**
 * Allocate independent requests round-robin across the direct transports.
 * Selection happens synchronously before the request starts, so a concurrent
 * batch fans out instead of viem's aggregate fallback always leading with the
 * same endpoint. A direct failure is retried through the aggregate client,
 * which preserves failover/retry behaviour across the whole configured set.
 */
export function createRpcRequestRotator<TClient>(
  directClients: readonly TClient[],
  aggregateClient: TClient,
) {
  if (!directClients.length) throw new Error('no direct RPC clients configured')
  let nextIndex = 0
  return async function withRpcClient<T>(
    request: (client: TClient) => Promise<T>,
  ): Promise<T> {
    const direct = directClients[nextIndex % directClients.length]
    nextIndex = (nextIndex + 1) % directClients.length
    try {
      return await request(direct)
    } catch {
      return request(aggregateClient)
    }
  }
}

const directClients: PublicClient[] = urls.map((url) =>
  createPublicClient({
    chain: indexerChain,
    transport: http(url, { timeout: 10_000 }),
  }),
)

/** Direct round-robin request with aggregate fallback; configured URLs stay private. */
export const withRotatingRpcClient = createRpcRequestRotator(directClients, pc)

/** Fatal configuration error: continuing would write one chain into another's DB. */
export class RpcChainMismatchError extends Error {
  constructor(actualChainId: number) {
    super(
      `RPC chain mismatch: configured ${CHAIN.key}:${CHAIN.id}, endpoint returned chain id ${actualChainId}`,
    )
    this.name = 'RpcChainMismatchError'
  }
}

export function assertConfiguredChainId(actualChainId: number): void {
  if (actualChainId !== CHAIN.id) throw new RpcChainMismatchError(actualChainId)
}

export function assertConfiguredRpcChainIds(actualChainIds: readonly number[]): void {
  if (!actualChainIds.length) throw new Error('no RPC endpoints configured')
  for (const chainId of actualChainIds) assertConfiguredChainId(chainId)
}

/**
 * Probe EVERY fallback endpoint before discovery. Verifying only the aggregate
 * client proves whichever endpoint happened to answer first; a wrong-chain
 * fallback could later take over during rate limiting and poison the bound DB.
 */
export async function verifyRpcChain(): Promise<number> {
  const actualChainIds = await Promise.all(
    urls.map((url) =>
      createPublicClient({ transport: http(url, { timeout: 10_000 }) }).getChainId(),
    ),
  )
  assertConfiguredRpcChainIds(actualChainIds)
  return actualChainIds[0]
}

/** Redact every configured endpoint before any error text reaches a log. */
export const redactRpcUrls = (text: string, configuredUrls: readonly string[] = urls): string => {
  // Longest-first prevents a host-only endpoint from exposing the secret suffix
  // of another endpoint on the same host. The final generic pass also covers a
  // transport that normalizes an endpoint before including it in an error.
  const exact = [...configuredUrls]
    .sort((a, b) => b.length - a.length)
    .reduce((redacted, url) => redacted.replaceAll(url, '<rpc>'), text)
  return exact.replace(/https?:\/\/[^\s"'`)}\]]+/gi, '<rpc>')
}

/** error text safe to log — RPC urls (and embedded credentials) are redacted */
export const safeError = (e: unknown) =>
  redactRpcUrls(
    String(e instanceof Error ? `${e.name}: ${e.message.split('\n')[0]}` : e),
  ).slice(0, 120)

// loose call shape — abi fragments come from parseAbi, results are narrowed by ok<T>()
export type Call = { abi: unknown; address: `0x${string}`; functionName: string; args?: unknown[] }
export type McRes = { status: 'success' | 'failure'; result?: unknown }

const agg = async (chunk: Call[]): Promise<McRes[]> =>
  (await pc.multicall({ contracts: chunk as never, batchSize: 250_000 })) as McRes[]

/**
 * Chunked multicall: fixed TUNE.batch calls per aggregate3 (batchSize is set
 * high so viem never sub-chunks by calldata bytes), allowFailure semantics,
 * gentle pacing between chunks. A failing chunk is retried once, then split
 * into 100-call sub-chunks so one bad call can only take 100 results down
 * with it — mc() never throws, it returns per-call failures instead.
 */
export async function mc(calls: Call[]): Promise<McRes[]> {
  const out: McRes[] = []
  for (let i = 0; i < calls.length; i += TUNE.batch) {
    const chunk = calls.slice(i, i + TUNE.batch)
    const t0 = Date.now()
    try {
      out.push(...(await agg(chunk)))
    } catch (e) {
      log('[rpc] chunk failed, retrying:', safeError(e))
      await sleep(600)
      try {
        out.push(...(await agg(chunk)))
      } catch {
        for (let j = 0; j < chunk.length; j += 100) {
          const part = chunk.slice(j, j + 100)
          try {
            out.push(...(await agg(part)))
          } catch (e2) {
            log(`[rpc] dropped ${part.length}-call sub-chunk:`, safeError(e2))
            out.push(...part.map(() => ({ status: 'failure' as const })))
          }
        }
      }
    }
    const ms = Date.now() - t0
    if (ms > 8_000) log(`[rpc] slow chunk: ${ms}ms (${chunk.length} calls)`)
    if (i + TUNE.batch < calls.length) await sleep(TUNE.batchGapMs)
  }
  return out
}

export const ok = <T,>(r?: McRes): T | undefined =>
  r && r.status === 'success' ? (r.result as T) : undefined
