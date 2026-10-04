import assert from 'node:assert/strict'
import test from 'node:test'
import { recordRpcRequest, rpcMetrics } from './rpc-metrics'

const record = recordRpcRequest()
const req = {} as Request
const body = (payload: unknown): RequestInit => ({ body: JSON.stringify(payload) })

test('rpc-metrics counts one HTTP request per attempt, one method call per batch entry', () => {
  const before = rpcMetrics()
  record(req, body({ method: 'eth_call', params: [] }))
  record(req, body([{ method: 'eth_getLogs', params: [] }, { method: 'eth_getLogs', params: [] }]))
  const after = rpcMetrics()
  assert.equal(after.httpRequests - before.httpRequests, 2)
  assert.equal(after.methodCalls - before.methodCalls, 3)
  assert.ok((after.methods['eth_getLogs'] ?? 0) >= 2)
})

test('rpc-metrics skips unreadable bodies without interfering', () => {
  const before = rpcMetrics()
  record(req, {})
  record(req, { body: 'not json' })
  const after = rpcMetrics()
  assert.equal(after.httpRequests - before.httpRequests, 2)
  assert.equal(after.methodCalls - before.methodCalls, 0)
})

test('rpc-metrics reports uptime and rates', () => {
  const m = rpcMetrics()
  assert.equal(typeof m.startedAt, 'string')
  assert.ok(m.observedSeconds >= 0)
  assert.ok(m.httpRequestsPerMinute >= 0)
  assert.ok(m.methodCallsPerMinute >= 0)
})
