import assert from 'node:assert/strict'
import test from 'node:test'
import { strategyName, strategyRangeName } from '../../shared/strategy/name'
import { ADDR } from '../config/addresses'

const stonk = '0xe934e36A439C94017B64a3FecE66AF12099aBF50' as const

test('strategy names identify the pair and remain independent of NFT ids', () => {
  const symbols = new Map([[ADDR.WNATIVE.toLowerCase(), 'WETH'], [stonk.toLowerCase(), 'STONKBROKER']])
  const name = strategyName({
    protocol: 'univ3',
    quoteToken: ADDR.WNATIVE,
    riskToken: stonk,
    range: { mode: 'symmetric', lowerPct: 3, upperPct: 3 },
  }, (address) => symbols.get(address.toLowerCase()))
  assert.equal(name, 'WETH/STONKBROKER · UNIV3 · ±3%')
  assert.equal(name.includes('#'), false)
})

test('strategy range names preserve asymmetric and fixed-tick intent', () => {
  assert.equal(strategyRangeName({ mode: 'asymmetric', lowerPct: 2.5, upperPct: 8 }), '−2.5%/+8%')
  assert.equal(strategyRangeName({ mode: 'fixed_ticks', lowerPct: 1, upperPct: 1, tickLower: -120, tickUpper: 240 }), 'ticks -120…240')
})
