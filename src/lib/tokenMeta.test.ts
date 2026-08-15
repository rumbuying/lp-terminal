import assert from 'node:assert/strict'
import test from 'node:test'
import type { Address, PublicClient } from 'viem'
import { readTokenInfo } from './tokenMeta'

const TOKEN = '0x1234567890abcdef1234567890abcdef12345678' as Address

function clientWith(
  read: (functionName: 'decimals' | 'symbol') => Promise<number | string>,
): Pick<PublicClient, 'readContract'> {
  return {
    readContract: (({ functionName }: { functionName: 'decimals' | 'symbol' }) =>
      read(functionName)) as PublicClient['readContract'],
  }
}

test('reads the metadata needed to select an arbitrary ERC-20 address', async () => {
  const token = await readTokenInfo(
    clientWith(async (functionName) => (functionName === 'decimals' ? 6 : 'USDC')),
    TOKEN,
  )

  assert.deepEqual(token, { address: TOKEN, symbol: 'USDC', decimals: 6 })
})

test('an ERC-20 without optional symbol metadata remains selectable by address', async () => {
  const token = await readTokenInfo(
    clientWith(async (functionName) => {
      if (functionName === 'symbol') throw new Error('symbol unavailable')
      return 18
    }),
    TOKEN,
  )

  assert.deepEqual(token, {
    address: TOKEN,
    symbol: '0x1234…5678',
    decimals: 18,
  })
})

test('missing decimals rejects selection because amounts cannot be encoded', async () => {
  await assert.rejects(
    readTokenInfo(
      clientWith(async (functionName) => {
        if (functionName === 'decimals') throw new Error('decimals unavailable')
        return 'TOKEN'
      }),
      TOKEN,
    ),
    /decimals unavailable/,
  )
})
