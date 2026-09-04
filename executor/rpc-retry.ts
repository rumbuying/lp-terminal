type ErrorRecord = {
  message?: unknown
  shortMessage?: unknown
  details?: unknown
  status?: unknown
  statusCode?: unknown
  code?: unknown
  cause?: unknown
}

function errorChain(error: unknown): ErrorRecord[] {
  const records: ErrorRecord[] = []
  let current = error
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth += 1) {
    const record = current as ErrorRecord
    records.push(record)
    current = record.cause
  }
  return records
}

/** Provider rejected the whole request with its generic malformed-params body.
 * With JSON-RPC batching this fires for the entire coalesced call when any one
 * member is rejected, so valid reads inside the batch die with it — a provider
 * artifact, not a deterministic bug in our params. A standalone call that
 * still returns this is rare; retrying it a bounded number of times is cheap
 * and harmless because every retried call here is idempotent. */
export function isBatchRejection(error: unknown): boolean {
  const records = errorChain(error)
  const statuses = records.flatMap((record) => [record.status, record.statusCode]).map(Number)
  const text = records.flatMap((record) => [record.message, record.shortMessage, record.details]).filter((value): value is string => typeof value === 'string').join('\n')
  if (/^missing or invalid parameters\.?/im.test(text)) return true
  return statuses.some((status) => status === 400) && /missing or invalid parameters/i.test(text)
}

/** Only errors that can represent temporary provider/network unavailability. */
export function isTransientRpcFailure(error: unknown): boolean {
  if (isBatchRejection(error)) return true
  const records = errorChain(error)
  const statuses = records.flatMap((record) => [record.status, record.statusCode]).map(Number)
  if (statuses.some((status) => status === 403 || status === 408 || status === 425 || status === 429 || status >= 500)) return true

  const codes = records.map((record) => String(record.code ?? '').toUpperCase())
  if (codes.some((code) => ['ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(code))) return true

  const text = records.flatMap((record) => [record.message, record.shortMessage, record.details]).filter((value): value is string => typeof value === 'string').join('\n')
  if (/invalid parameters?|execution reverted|insufficient funds|nonce too low|underpriced|fee cap|intrinsic gas/i.test(text)) return false
  return /timeout|timed out|fetch failed|network|socket|connection|HTTP request failed|status:\s*(403|408|425|429|5\d\d)|RPC Request failed/i.test(text)
}

export const retryDelay = (baseMs: number, attempt: number) => Math.min(baseMs * (2 ** attempt), 10_000)
