import assert from 'node:assert/strict'
import test from 'node:test'
import { awaitCatalogTask, fetchCatalog } from './catalogFetch'

test('catalog task stops waiting for an RPC API that cannot consume the signal', async () => {
  const controller = new AbortController()
  const task = awaitCatalogTask(new Promise<never>(() => {}), controller.signal)
  controller.abort(new DOMException('catalog deadline', 'TimeoutError'))

  await assert.rejects(
    task,
    (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
  )
})

test('catalog task preserves a transport failure before the deadline', async () => {
  const controller = new AbortController()
  const failure = new Error('rpc failed')
  await assert.rejects(awaitCatalogTask(Promise.reject(failure), controller.signal), failure)
})

test('catalog fetch aborts a transport that never returns', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        assert.ok(signal)
        const aborted = () => reject(signal.reason)
        if (signal.aborted) aborted()
        else signal.addEventListener('abort', aborted, { once: true })
      }),
  )

  await assert.rejects(
    fetchCatalog('https://terminal.example/catalog', {}, undefined, 20),
    (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
  )
})

test('catalog fetch consumes caller cancellation', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        assert.ok(signal)
        const aborted = () => reject(signal.reason)
        if (signal.aborted) aborted()
        else signal.addEventListener('abort', aborted, { once: true })
      }),
  )
  const controller = new AbortController()
  const request = fetchCatalog('https://terminal.example/catalog', {}, controller.signal)
  controller.abort(new DOMException('query cancelled', 'AbortError'))
  await assert.rejects(
    request,
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  )
})
