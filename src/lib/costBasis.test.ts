import assert from 'node:assert/strict'
import test from 'node:test'
import { firstExistingBlock } from '../../shared/strategy/cost-basis'

test('finds the exact original mint block without scanning a wide log range', async () => {
  const visited: bigint[] = []
  const found = await firstExistingBlock(31_806_447n, async (block) => {
    visited.push(block)
    return block >= 31_752_258n
  })
  assert.equal(found, 31_752_258n)
  assert.ok(visited.length < 30)
})

test('rejects a snapshot block at which the position did not exist', async () => {
  await assert.rejects(() => firstExistingBlock(100n, async () => false), /did not exist/)
})
