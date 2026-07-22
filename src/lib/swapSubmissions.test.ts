import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Address } from 'viem'
import { swapSubmissionKey, swapSubmissions } from './swapSubmissions'

test('swap submissions stay locked outside a mounted component', async () => {
  const account = '0x1111111111111111111111111111111111111111' as Address
  const tokenIn = '0x2222222222222222222222222222222222222222' as Address
  const tokenOut = '0x3333333333333333333333333333333333333333' as Address
  const key = swapSubmissionKey(account, tokenIn, tokenOut, 1000n)
  let release!: () => void
  const wallet = new Promise<void>((resolve) => {
    release = resolve
  })
  let duplicateRan = false

  const first = swapSubmissions.run(key, () => wallet)
  assert.equal(swapSubmissions.has(key), true)
  assert.equal(
    await swapSubmissions.run(key, async () => {
      duplicateRan = true
    }),
    false,
  )
  assert.equal(duplicateRan, false)

  release()
  assert.equal(await first, true)
  assert.equal(swapSubmissions.has(key), false)
  assert.equal(await swapSubmissions.run(key, async () => {}), true)
})
