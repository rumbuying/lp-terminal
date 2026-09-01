import assert from 'node:assert/strict'
import test from 'node:test'
import { scanAdaptiveLogWindows } from './adaptiveLogs'

test('adaptive log scan shrinks rejected ranges without gaps and checkpoints each window', async () => {
  const fetched: Array<[number, number]> = []
  const committed: Array<[number, number]> = []
  const shrunk: number[] = []

  await scanAdaptiveLogWindows({
    fromBlock: 10,
    toBlock: 16,
    maxWindowBlocks: 8,
    fetchWindow: async (from, to) => {
      fetched.push([from, to])
      if (to - from + 1 > 2) throw new Error('limit exceeded')
      return [`${from}:${to}`]
    },
    commitWindow: ({ fromBlock, toBlock, rows }) => {
      assert.deepEqual(rows, [`${fromBlock}:${toBlock}`])
      committed.push([fromBlock, toBlock])
    },
    onShrink: (n) => shrunk.push(n),
    singleBlockError: 'one block rejected',
  })

  assert.deepEqual(shrunk, [4, 2])
  assert.deepEqual(committed, [[10, 11], [12, 13], [14, 15], [16, 16]])
  assert.deepEqual(fetched.slice(0, 3), [[10, 16], [10, 13], [10, 11]])
})

test('adaptive log scan reports a provider that rejects one block', async () => {
  await assert.rejects(
    scanAdaptiveLogWindows({
      fromBlock: 5,
      toBlock: 5,
      maxWindowBlocks: 1,
      fetchWindow: async () => {
        throw new Error('limit exceeded')
      },
      commitWindow: () => assert.fail('a rejected window must not commit'),
      singleBlockError: 'configure a logs-capable RPC',
    }),
    /configure a logs-capable RPC/,
  )
})

test('dense-window rejections phrased as invalid parameters halve like a range error', async () => {
  const fetched: Array<[number, number]> = []
  const committed: Array<[number, number]> = []
  await scanAdaptiveLogWindows({
    fromBlock: 10,
    toBlock: 15,
    maxWindowBlocks: 8,
    fetchWindow: async (from, to) => {
      fetched.push([from, to])
      if (to - from + 1 > 2) throw new Error('Missing or invalid parameters.')
      return ['ok']
    },
    commitWindow: ({ fromBlock, toBlock }) => {
      committed.push([fromBlock, toBlock])
    },
    singleBlockError: 'one block rejected',
  })
  assert.deepEqual(committed, [[10, 11], [12, 13], [14, 15]])
  assert.deepEqual(fetched.slice(0, 3), [[10, 15], [10, 13], [10, 11]])
})

test('a one-block rejection phrased as invalid parameters still fails closed', async () => {
  await assert.rejects(
    scanAdaptiveLogWindows({
      fromBlock: 5,
      toBlock: 5,
      maxWindowBlocks: 1,
      fetchWindow: async () => {
        throw new Error('Invalid parameters were provided to the RPC method.')
      },
      commitWindow: () => assert.fail('a rejected window must not commit'),
      singleBlockError: 'configure a logs-capable RPC',
    }),
    /configure a logs-capable RPC/,
  )
})

test('concurrent log scan fetches in parallel but commits a contiguous ordered prefix', async () => {
  let active = 0
  let maxActive = 0
  const committed: Array<[number, number]> = []

  await scanAdaptiveLogWindows({
    fromBlock: 1,
    toBlock: 12,
    maxWindowBlocks: 2,
    concurrency: 3,
    fetchWindow: async (from, to) => {
      active++
      maxActive = Math.max(maxActive, active)
      // Complete later windows first to prove commit order is independent of
      // network completion order.
      await new Promise((resolve) => setTimeout(resolve, 15 - from))
      active--
      return `${from}:${to}`
    },
    commitWindow: ({ fromBlock, toBlock, rows }) => {
      assert.equal(rows, `${fromBlock}:${toBlock}`)
      committed.push([fromBlock, toBlock])
    },
    singleBlockError: 'one block rejected',
  })

  assert.equal(maxActive, 3)
  assert.deepEqual(committed, [
    [1, 2],
    [3, 4],
    [5, 6],
    [7, 8],
    [9, 10],
    [11, 12],
  ])
})
