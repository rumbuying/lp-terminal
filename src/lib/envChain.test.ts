import assert from 'node:assert/strict'
import test from 'node:test'

test('Kyber routing follows the runtime chain selected in the URL', async () => {
  const g = globalThis as Record<string, unknown>
  g.window = { location: { search: '?chain=robinhood' } }
  Object.defineProperty(g, 'localStorage', {
    configurable: true,
    value: { getItem: () => null },
  })

  const runtimeCase = 'robinhood'
  const { ENV } = (await import(
    `../config/env?runtime-chain=${runtimeCase}`
  )) as typeof import('../config/env')
  const { CHAIN } = await import('../config/chains')
  assert.equal(CHAIN.key, 'robinhood')
  assert.equal(ENV.kyberChain, CHAIN.slugs.kyber)
})
