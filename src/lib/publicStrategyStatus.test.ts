import assert from 'node:assert/strict'
import test from 'node:test'
import type { PublicStatusResult, PublicStrategyStatus } from './publicStrategyStatus'
import { aggregatePublicPnlCurve, positionRangeState, publicStatusTotals, statusAddressFromPath, statusPath } from './publicStrategyStatus'

const address = '0x0000000000000000000000000000000000000001' as const

function status(overrides: Partial<PublicStrategyStatus> = {}): PublicStrategyStatus {
  return {
    chain: { id: 4663, key: 'robinhood', name: 'Robinhood Chain', stable: { address, symbol: 'USDG', decimals: 6 } },
    address,
    generatedAt: 1_000,
    intervalSeconds: 300,
    strategies: [{
      id: 's1', name: 'Strategy 1', protocol: 'univ3', state: 'monitoring', updatedAt: 900,
      pool: address, activeTokenId: '7', range: { mode: 'symmetric', lowerPct: 5, upperPct: 5 },
      performance: { calculatedAt: 1_000, baselineAt: 100, summary: {
        reopens: 1, currentValueQuoteRaw: '120000000', baselineValueQuoteRaw: '100000000', pnlQuoteRaw: '20000000', pnlPct: 20,
        currentValueStableRaw: '120000000', baselineValueStableRaw: '100000000', pnlStableRaw: '20000000', pnlStablePct: 20,
      } },
    }],
    points: [
      { strategyId: 's1', bucketAt: 300, observedAt: 310, quote: { address, symbol: 'USDG', decimals: 6 }, pnlQuoteRaw: '5000000', pnlStableRaw: '5000000' },
      { strategyId: 's1', bucketAt: 600, observedAt: 610, quote: { address, symbol: 'USDG', decimals: 6 }, pnlQuoteRaw: '10000000', pnlStableRaw: '10000000' },
    ],
    ...overrides,
  }
}

test('status paths validate and canonicalize wallet addresses', () => {
  assert.equal(statusAddressFromPath('/status/0x0000000000000000000000000000000000000001'), address)
  assert.equal(statusAddressFromPath('/status/not-an-address'), null)
  assert.equal(statusAddressFromPath('/status'), null)
  assert.equal(statusPath(address), `/status/${address}`)
})

test('cross-chain totals normalize each stable token by its own decimals', () => {
  const robin = status()
  const bsc = status({
    chain: { id: 56, key: 'bsc', name: 'BNB Smart Chain', stable: { address, symbol: 'USDT', decimals: 18 } },
    strategies: [{ ...status().strategies[0], id: 's2', performance: { summary: {
      reopens: 0, currentValueQuoteRaw: '80000000000000000000', baselineValueQuoteRaw: '100000000000000000000', pnlQuoteRaw: '-20000000000000000000', pnlPct: -20,
      currentValueStableRaw: '80000000000000000000', baselineValueStableRaw: '100000000000000000000', pnlStableRaw: '-20000000000000000000', pnlStablePct: -20,
    } } }],
    points: [],
  })
  assert.deepEqual(publicStatusTotals([{ chainKey: 'robinhood', chainName: 'Robinhood Chain', data: robin }, { chainKey: 'bsc', chainName: 'BNB Smart Chain', data: bsc }]), {
    strategies: 2, currentValue: 200, pnl: 0, pnlPct: 0, valuedStrategies: 2,
  })
})

test('aggregate curve carries sparse strategy values forward instead of inserting zero', () => {
  const first: PublicStatusResult = { chainKey: 'robinhood', chainName: 'Robinhood Chain', data: status() }
  const secondStatus = status({
    chain: { id: 56, key: 'bsc', name: 'BNB Smart Chain', stable: { address, symbol: 'USDT', decimals: 18 } },
    generatedAt: 1_000,
    strategies: [{ ...status().strategies[0], id: 's2', performance: { calculatedAt: 1_000, baselineAt: 500, summary: {
      reopens: 0, currentValueQuoteRaw: null, baselineValueQuoteRaw: null, pnlQuoteRaw: null, pnlPct: null,
      currentValueStableRaw: null, baselineValueStableRaw: null, pnlStableRaw: '3000000000000000000', pnlStablePct: 3,
    } } }],
    points: [{ strategyId: 's2', bucketAt: 900, observedAt: 905, quote: { address, symbol: 'USDT', decimals: 18 }, pnlQuoteRaw: null, pnlStableRaw: '2000000000000000000' }],
  })
  const points = aggregatePublicPnlCurve([first, { chainKey: 'bsc', chainName: 'BNB Smart Chain', data: secondStatus }])
  assert.deepEqual(points, [
    { at: 100, value: 0 }, { at: 300, value: 5 }, { at: 500, value: 5 }, { at: 600, value: 10 },
    { at: 900, value: 12 }, { at: 1_000, value: 23 },
  ])
})

test('position range state is strict at the upper tick', () => {
  assert.equal(positionRangeState({ tokenId: '1', tick: 0, tickLower: -10, tickUpper: 10 }), 'in')
  assert.equal(positionRangeState({ tokenId: '1', tick: 10, tickLower: -10, tickUpper: 10 }), 'out')
  assert.equal(positionRangeState(undefined), 'unknown')
})
