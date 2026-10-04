/** Provider-facing RPC request accounting, exposed at /api/rpc-metrics.
 *
 * Counts attempts, not successes: retries and failover re-reads each count as
 * one HTTP request, and a JSON-RPC batch counts once per method it carries.
 * The executor keeps the same counter shape (scopes read/broadcast); the
 * indexer never broadcasts, so a single flat scope is the honest shape here.
 * Method names only — URLs and params are never recorded (they are secrets
 * elsewhere in this service). */
const startedAt = Date.now()
const methods = new Map<string, number>()
let httpRequests = 0
let methodCalls = 0

/** viem http transport `onFetchRequest` hook. Must never throw or interfere. */
export function recordRpcRequest() {
  return (_request: Request, init: RequestInit) => {
    httpRequests += 1
    if (typeof init.body !== 'string') return
    try {
      const parsed = JSON.parse(init.body) as { method?: unknown } | { method?: unknown }[]
      const requests = Array.isArray(parsed) ? parsed : [parsed]
      for (const request of requests) {
        if (typeof request?.method !== 'string') continue
        methodCalls += 1
        methods.set(request.method, (methods.get(request.method) ?? 0) + 1)
      }
    } catch {
      // Request counting must never interfere with an RPC call.
    }
  }
}

export function rpcMetrics() {
  const now = Date.now()
  const seconds = Math.max(1, (now - startedAt) / 1000)
  return {
    startedAt: new Date(startedAt).toISOString(),
    observedSeconds: Math.floor(seconds),
    httpRequests,
    methodCalls,
    httpRequestsPerMinute: Number((httpRequests * 60 / seconds).toFixed(2)),
    methodCallsPerMinute: Number((methodCalls * 60 / seconds).toFixed(2)),
    methods: Object.fromEntries([...methods.entries()].sort((a, b) => b[1] - a[1])),
  }
}
