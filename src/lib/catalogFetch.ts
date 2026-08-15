export const CATALOG_FETCH_TIMEOUT_MS = 10_000

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('catalog request aborted', 'AbortError')

/** Bound async work whose API cannot consume an AbortSignal (for example viem
 * multicalls). The underlying transport may finish later, but the catalog query
 * stops waiting immediately and the attached handlers absorb that late result. */
export function awaitCatalogTask<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task
  if (signal.aborted) return Promise.reject(abortReason(signal))

  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortReason(signal))
    signal.addEventListener('abort', abort, { once: true })
    task.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

/** Consume TanStack's cancellation signal while also bounding a live request. */
export function fetchCatalog(
  input: RequestInfo | URL,
  init: RequestInit = {},
  signal?: AbortSignal,
  timeoutMs = CATALOG_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs)
  return fetch(input, {
    ...init,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
}
