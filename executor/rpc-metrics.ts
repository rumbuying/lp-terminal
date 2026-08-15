type RpcScope = 'read' | 'broadcast'
type ScopeMetrics = { httpRequests: number; methodCalls: number; methods: Map<string, number> }

const startedAt = Date.now()
const scopes: Record<RpcScope, ScopeMetrics> = {
  read: { httpRequests: 0, methodCalls: 0, methods: new Map() },
  broadcast: { httpRequests: 0, methodCalls: 0, methods: new Map() },
}

/** Counts provider-facing attempts, including retries and JSON-RPC batches. */
export function recordRpcRequest(scope: RpcScope) {
  return (_request: Request, init: RequestInit) => {
    const metrics = scopes[scope]
    metrics.httpRequests += 1
    if (typeof init.body !== 'string') return
    try {
      const parsed = JSON.parse(init.body) as { method?: unknown } | { method?: unknown }[]
      const requests = Array.isArray(parsed) ? parsed : [parsed]
      for (const request of requests) {
        if (typeof request?.method !== 'string') continue
        metrics.methodCalls += 1
        metrics.methods.set(request.method, (metrics.methods.get(request.method) ?? 0) + 1)
      }
    } catch {
      // Request counting must never interfere with an RPC call.
    }
  }
}

export function rpcMetrics() {
  const now = Date.now()
  const seconds = Math.max(1, (now - startedAt) / 1000)
  const format = (value: ScopeMetrics) => ({
    httpRequests: value.httpRequests,
    methodCalls: value.methodCalls,
    httpRequestsPerMinute: Number((value.httpRequests * 60 / seconds).toFixed(2)),
    methodCallsPerMinute: Number((value.methodCalls * 60 / seconds).toFixed(2)),
    methods: Object.fromEntries([...value.methods.entries()].sort((a, b) => b[1] - a[1])),
  })
  return {
    startedAt: new Date(startedAt).toISOString(),
    observedSeconds: Math.floor(seconds),
    read: format(scopes.read),
    broadcast: format(scopes.broadcast),
  }
}
