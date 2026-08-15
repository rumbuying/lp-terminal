import { createHash } from 'node:crypto'
import { uniV2FactoryAbi } from '../src/abi'
import {
  ADDR,
  CHAIN,
  INDEXER_FINALITY_BLOCKS,
  log,
  rpcUrls,
  sleep,
} from './config'
import { pc } from './rpc'
import {
  insertPool,
  kvGet,
  kvSet,
  pancakeV2CatalogGeneration,
  tx,
  v2PairIndexStats,
  v2PoolIdentity,
} from './store'
import {
  ensurePancakeV2AdvancedSnapshot,
  PancakeV2PageTokenRejectedError,
  PANCAKE_V2_SNAPSHOT_KEYS,
  PANCAKE_V2_SNAPSHOT_SOURCE,
  type PancakeV2AdvancedRequest,
  type PancakeV2AdvancedSnapshotResult,
} from './pancakeV2AdvancedCore'

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const REQUEST_ATTEMPTS = 4
const ANKR_HOST = 'rpc.ankr.com'
const ANKR_TOKEN = /^[A-Za-z0-9_-]{16,256}$/
const ENDPOINT_FINGERPRINT = /^[0-9a-f]{64}$/
const PUBLISHED_BLOCK_HASH = /^0x[0-9a-f]{64}$/i
const POSITIVE_DECIMAL = /^[1-9]\d*$/

export class AnkrAdvancedApiError extends Error {
  constructor(
    message: string,
    readonly rejectsGeneration = false,
  ) {
    super(message)
    this.name = 'AnkrAdvancedApiError'
  }
}

type PublishedCacheTarget = {
  identity: string
  block: number
  poolCount: number
}

function publishedCacheTarget(
  get: (key: string) => string | undefined,
  getCatalogGeneration: () => string,
): PublishedCacheTarget | null {
  const key = PANCAKE_V2_SNAPSHOT_KEYS
  const complete = get(key.complete)
  const source = get(key.source)
  const rawBlock = get(key.block) ?? ''
  const blockHash = get(key.blockHash) ?? ''
  const rawPoolCount = get(key.poolCount) ?? ''
  const publishedCatalogGeneration = get(key.catalogGeneration) ?? ''
  const catalogGeneration = getCatalogGeneration()
  if (
    complete !== '1' ||
    source !== PANCAKE_V2_SNAPSHOT_SOURCE ||
    !POSITIVE_DECIMAL.test(rawBlock) ||
    !PUBLISHED_BLOCK_HASH.test(blockHash) ||
    !POSITIVE_DECIMAL.test(rawPoolCount) ||
    !/^(0|[1-9]\d*)$/.test(publishedCatalogGeneration) ||
    publishedCatalogGeneration !== catalogGeneration
  ) return null
  const block = Number(rawBlock)
  const poolCount = Number(rawPoolCount)
  if (!Number.isSafeInteger(block) || !Number.isSafeInteger(poolCount)) return null
  return {
    identity: `${source}:${rawBlock}:${blockHash}:${rawPoolCount}:${publishedCatalogGeneration}`,
    block,
    poolCount,
  }
}

/**
 * Cache only a generation that core successfully validated in this process.
 * Restart, incomplete provenance, or any identity change forces full RPC and DB
 * validation again; ordinary tail ticks avoid a 2.66m-row aggregate scan.
 */
export function createPancakeV2PublishedSnapshotCache(
  get: (key: string) => string | undefined,
  getCatalogGeneration: () => string,
  ensure: (freshLimit: number) => Promise<PancakeV2AdvancedSnapshotResult>,
): (freshLimit: number) => Promise<PancakeV2AdvancedSnapshotResult> {
  let verifiedIdentity: string | null = null
  return async (freshLimit) => {
    const before = publishedCacheTarget(get, getCatalogGeneration)
    if (before && before.identity === verifiedIdentity) {
      return {
        added: 0,
        fresh: [],
        snapshotBlock: before.block,
        snapshotPoolCount: before.poolCount,
        bootstrapped: false,
      }
    }
    verifiedIdentity = null
    const result = await ensure(freshLimit)
    verifiedIdentity =
      publishedCacheTarget(get, getCatalogGeneration)?.identity ?? null
    return result
  }
}

/**
 * Convert authenticated Ankr BSC Node API endpoints to the equivalent indexed
 * multichain endpoint without ever logging or persisting the resulting URL.
 */
export function deriveAnkrAdvancedEndpoints(configuredUrls: readonly string[]): string[] {
  const endpoints: string[] = []
  for (const configured of configuredUrls) {
    try {
      const url = new URL(configured)
      const parts = url.pathname.split('/').filter(Boolean)
      if (
        url.protocol !== 'https:' ||
        url.hostname.toLowerCase() !== ANKR_HOST ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        parts.length !== 2 ||
        parts[0] !== 'bsc' ||
        !ANKR_TOKEN.test(parts[1])
      ) {
        continue
      }
      url.pathname = `/multichain/${parts[1]}`
      const endpoint = url.toString()
      if (!endpoints.includes(endpoint)) endpoints.push(endpoint)
    } catch {
      // Non-URL candidates are rejected without reflecting their contents.
    }
  }
  return endpoints
}

const safeApiMessage = (value: unknown, secrets: readonly string[] = []): string =>
  [...secrets]
    .sort((left, right) => right.length - left.length)
    .reduce(
      (message, secret) => (secret ? message.replaceAll(secret, '<redacted>') : message),
      String(value ?? ''),
    )
    .replace(/https?:\/\/[^\s"'`)}\]]+/gi, '<rpc>')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<redacted>')
    .slice(0, 100)

async function cappedText(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES)
    throw new AnkrAdvancedApiError('Ankr Advanced API response is too large', true)
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new AnkrAdvancedApiError('Ankr Advanced API response is too large', true)
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

function retryableHttp(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function rpcRejectsGeneration(code: number, rawMessage: unknown): boolean {
  if ([-32_700, -32_600, -32_601, -32_602].includes(code)) return true
  const message = String(rawMessage ?? '').toLowerCase()
  return (
    /(page[ _-]?token|cursor)/.test(message) &&
    /(invalid|expired|unknown|reject|malformed)/.test(message)
  )
}

/**
 * Validate the endpoint-independent page envelope before a generation fetcher
 * persists an endpoint slot. PairCreated contents remain the core's concern.
 */
function assertPageEnvelope(
  parsed: unknown,
  pageSize: number,
): asserts parsed is { result: { logs: unknown[]; nextPageToken?: string | null } } {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new AnkrAdvancedApiError('Ankr Advanced API returned invalid JSON-RPC', true)
  const result = (parsed as { result?: unknown }).result
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new AnkrAdvancedApiError('Ankr Advanced API returned an invalid page result', true)
  const logs = (result as { logs?: unknown }).logs
  if (!Array.isArray(logs))
    throw new AnkrAdvancedApiError('Ankr Advanced API page result is missing logs', true)
  if (!logs.length)
    throw new AnkrAdvancedApiError('Ankr Advanced API returned an empty log page', true)
  if (logs.length > pageSize)
    throw new AnkrAdvancedApiError('Ankr Advanced API returned an oversized log page', true)
  const nextPageToken = (result as { nextPageToken?: unknown }).nextPageToken
  if (
    nextPageToken !== undefined &&
    nextPageToken !== null &&
    typeof nextPageToken !== 'string'
  )
    throw new AnkrAdvancedApiError('Ankr Advanced API returned an invalid page token', true)
}

/** One endpoint per generation: opaque page tokens are never rotated across keys. */
export function createAnkrAdvancedPageFetcher(
  endpoint: string,
  requestFetch: typeof fetch = globalThis.fetch,
): (request: PancakeV2AdvancedRequest) => Promise<unknown> {
  return async (params) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'ankr_getLogs',
      params,
    })
    let lastFailure = 'request failed'
    let lastRejectsGeneration = false
    for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt++) {
      try {
        const response = await requestFetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'up33-lp-indexer/0.1',
          },
          body,
          signal: AbortSignal.timeout(90_000),
        })
        const text = await cappedText(response)
        if (!response.ok) {
          lastFailure = `HTTP ${response.status}`
          lastRejectsGeneration = false
          if (!retryableHttp(response.status))
            throw new AnkrAdvancedApiError(
              `Ankr Advanced API rejected the request (${lastFailure})`,
              true,
            )
        } else {
          let parsed: unknown
          try {
            parsed = JSON.parse(text)
          } catch {
            throw new AnkrAdvancedApiError(
              'Ankr Advanced API returned invalid JSON',
              true,
            )
          }
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const error = (parsed as { error?: unknown }).error
            if (error !== undefined && error !== null) {
              if (typeof error !== 'object' || Array.isArray(error))
                throw new AnkrAdvancedApiError(
                  'Ankr Advanced API returned a malformed JSON-RPC error',
                  true,
                )
              const code = Number((error as { code?: unknown }).code)
              const rawMessage = (error as { message?: unknown }).message
              const endpointToken = new URL(endpoint).pathname.split('/').filter(Boolean).at(-1) ?? ''
              const message = safeApiMessage(
                rawMessage,
                [endpoint, endpointToken],
              )
              lastFailure = `RPC ${Number.isSafeInteger(code) ? code : 'error'}${message ? `: ${message}` : ''}`
              lastRejectsGeneration = rpcRejectsGeneration(code, rawMessage)
            } else {
              assertPageEnvelope(parsed, params.pageSize)
              return parsed
            }
          } else {
            throw new AnkrAdvancedApiError(
              'Ankr Advanced API returned invalid JSON-RPC',
              true,
            )
          }
        }
      } catch (error) {
        if (error instanceof AnkrAdvancedApiError && error.rejectsGeneration)
          throw error
        // Fetch/timeout errors are deliberately collapsed: endpoint/key values
        // must never escape through a transport's error message.
        if (error instanceof AnkrAdvancedApiError) lastFailure = error.message
        else lastFailure = 'transport unavailable'
        lastRejectsGeneration = false
      }
      if (attempt + 1 < REQUEST_ATTEMPTS) await sleep(1_000 * (attempt + 1))
    }
    throw new AnkrAdvancedApiError(
      `Ankr Advanced API ${safeApiMessage(lastFailure)}`,
      lastRejectsGeneration,
    )
  }
}

/**
 * Select a working key only before page one, then pin every opaque page token
 * to that exact endpoint. If a token chain ultimately fails, the core resets
 * to page one; only that token-free replay may select another candidate.
 */
export function createAnkrAdvancedGenerationFetcher(
  endpoints: readonly string[],
  requestFetch: typeof fetch = globalThis.fetch,
  endpointSlot: {
    get: () => string | undefined
    set: (value: string) => void
    getFingerprint: () => string | undefined
    setFingerprint: (value: string) => void
  } | null = null,
): (request: PancakeV2AdvancedRequest) => Promise<unknown> {
  if (!endpoints.length)
    throw new AnkrAdvancedApiError(
      'no authenticated Ankr BSC endpoint is configured for the historical snapshot',
    )
  let selected: ((request: PancakeV2AdvancedRequest) => Promise<unknown>) | null = null
  let selectedIndex: number | null = null
  let selectedFailed = false
  let failedGenerationIndex: number | null = null
  return async (request) => {
    if (request.pageToken) {
      if (!selected) {
        const stored = Number(endpointSlot?.get())
        const storedFingerprint = endpointSlot?.getFingerprint() ?? ''
        const currentFingerprint =
          Number.isSafeInteger(stored) && stored >= 0 && stored < endpoints.length
            ? createHash('sha256').update(endpoints[stored]).digest('hex')
            : ''
        if (
          !Number.isSafeInteger(stored) ||
          stored < 0 ||
          stored >= endpoints.length ||
          !ENDPOINT_FINGERPRINT.test(storedFingerprint) ||
          storedFingerprint !== currentFingerprint
        )
          throw new PancakeV2PageTokenRejectedError(
            'Ankr Advanced API page token has no bound endpoint slot',
          )
        selected = createAnkrAdvancedPageFetcher(endpoints[stored], requestFetch)
        selectedIndex = stored
      }
      try {
        return await selected(request)
      } catch (error) {
        if (error instanceof AnkrAdvancedApiError && error.rejectsGeneration) {
          selectedFailed = true
          failedGenerationIndex = selectedIndex
          throw new PancakeV2PageTokenRejectedError(
            'Ankr Advanced API rejected the bound page-token generation',
          )
        }
        throw error
      }
    }
    if (selected && !selectedFailed) return selected(request)

    selected = null
    selectedIndex = null
    selectedFailed = false
    let lastError: unknown
    const ordinary = endpoints.map((_, index) => index)
    // Prefer every other key for a page-one replay. The failed key remains a
    // bounded last resort for a genuinely expired token or single-key setup.
    const candidateIndices = failedGenerationIndex === null
      ? ordinary
      : [
          ...ordinary.filter((index) => index !== failedGenerationIndex),
          failedGenerationIndex,
        ]
    for (const index of candidateIndices) {
      const endpoint = endpoints[index]
      const candidate = createAnkrAdvancedPageFetcher(endpoint, requestFetch)
      try {
        const result = await candidate(request)
        selected = candidate
        selectedIndex = index
        failedGenerationIndex = null
        endpointSlot?.set(String(index))
        endpointSlot?.setFingerprint(
          createHash('sha256').update(endpoint).digest('hex'),
        )
        return result
      } catch (error) {
        lastError = error
      }
    }
    throw (
      lastError ??
      new AnkrAdvancedApiError('Ankr Advanced API historical snapshot is unavailable')
    )
  }
}

/** Uncached production adapter used for first validation/import in this process. */
async function ensureBscPancakeV2AdvancedSnapshotUncached(
  freshLimit: number,
): Promise<PancakeV2AdvancedSnapshotResult> {
  // Resolve lazily: an already-published snapshot only needs canonical RPC
  // revalidation and can keep tailing even if its historical downloader key is
  // later removed. A partial/new generation remains fail-closed without Ankr.
  let fetchPage: ((request: PancakeV2AdvancedRequest) => Promise<unknown>) | undefined
  const requestPage = (request: PancakeV2AdvancedRequest) => {
    if (!fetchPage) {
      fetchPage = createAnkrAdvancedGenerationFetcher(
        deriveAnkrAdvancedEndpoints(rpcUrls()),
        globalThis.fetch,
        {
          get: () => kvGet(PANCAKE_V2_SNAPSHOT_KEYS.importEndpointSlot),
          set: (value) => kvSet(PANCAKE_V2_SNAPSHOT_KEYS.importEndpointSlot, value),
          getFingerprint: () =>
            kvGet(PANCAKE_V2_SNAPSHOT_KEYS.importEndpointFingerprint),
          setFingerprint: (value) =>
            kvSet(PANCAKE_V2_SNAPSHOT_KEYS.importEndpointFingerprint, value),
        },
      )
    }
    return fetchPage(request)
  }

  return ensurePancakeV2AdvancedSnapshot({
    factory: ADDR.V2_FACTORY,
    finalityBlocks: INDEXER_FINALITY_BLOCKS,
    freshLimit,
    chain: {
      getHead: async () => Number(await pc.getBlockNumber()),
      getBlockHash: async (block) => {
        const value = await pc.getBlock({ blockNumber: BigInt(block) })
        if (!value.hash) throw new Error('canonical RPC returned a block without hash')
        return value.hash
      },
      getFactoryCount: async (block) =>
        Number(
          await pc.readContract({
            abi: uniV2FactoryAbi,
            address: ADDR.V2_FACTORY,
            functionName: 'allPairsLength',
            blockNumber: BigInt(block),
          }),
        ),
    },
    storage: {
      get: kvGet,
      set: kvSet,
      transaction: tx,
      insertPool,
      poolIdentity: v2PoolIdentity,
      pairIndexStats: () => v2PairIndexStats('pancakev2'),
      catalogGeneration: pancakeV2CatalogGeneration,
    },
    fetchPage: requestPage,
    progress: (processed, total) =>
      log(`[catalog] pancakev2 Ankr snapshot ${processed}/${total}`),
  })
}

const ensureCachedBscPancakeV2AdvancedSnapshot =
  createPancakeV2PublishedSnapshotCache(
    kvGet,
    pancakeV2CatalogGeneration,
    ensureBscPancakeV2AdvancedSnapshotUncached,
  )

/** Production adapter used only for BSC's initial Pancake V2 full directory. */
export async function ensureBscPancakeV2AdvancedSnapshot(
  freshLimit = 1_000,
): Promise<PancakeV2AdvancedSnapshotResult> {
  if (CHAIN.id !== 56)
    throw new Error('Pancake V2 Advanced API snapshot is BSC-only')
  return ensureCachedBscPancakeV2AdvancedSnapshot(freshLimit)
}
