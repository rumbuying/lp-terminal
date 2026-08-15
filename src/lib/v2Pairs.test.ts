import assert from 'node:assert/strict'
import test from 'node:test'
import { getAddress, type Address } from 'viem'
import { ADDR, CONNECTORS } from '../config/addresses'
import { CHAIN } from '../config/chains'
import type { V2Pool, V2Position } from '../types'
import {
  HAS_V2_SWEEP,
  V2_SWEEP_VENUES,
  connectorCandidates,
  isVenuePair,
  sortTokens,
  sweepVenueOf,
  mergeV2ByPair,
  v2PairAddress,
} from './v2Pairs'

const sweepTest = HAS_V2_SWEEP ? test : test.skip

/**
 * Golden values read off BSC on 2026-08-02: each derived address matched
 * `factory.getPair` exactly. They are the whole basis for trusting derivation
 * over a lookup, so they are pinned rather than recomputed from the same code
 * that produces them.
 */
const BSC_GOLDEN: { dexId: string; a: Address; b: Address; pair: Address }[] = [
  {
    dexId: 'pancakeswap',
    a: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    b: '0x55d398326f99059fF775485246999027B3197955',
    pair: '0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE',
  },
  {
    dexId: 'pancakeswap',
    a: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
    b: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    pair: '0x0eD7e52944161450477ee417DE9Cd3a859b14fD0',
  },
  {
    dexId: 'uniswap',
    a: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    b: '0x55d398326f99059fF775485246999027B3197955',
    pair: '0x8a1Ed8e124fdFBD534bF48baF732E26db9Cc0Cf4',
  },
  {
    dexId: 'uniswap',
    a: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
    b: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    pair: '0xB9600e90414a9C8C128C78d4078784ecDfB03E49',
  },
]

sweepTest('derivation reproduces pairs the live factories actually deployed', () => {
  if (CHAIN.key !== 'bsc') return
  for (const g of BSC_GOLDEN) {
    const venue = sweepVenueOf(g.dexId)
    assert.ok(venue, `no sweep venue for dexId ${g.dexId}`)
    assert.equal(
      v2PairAddress(venue, g.a, g.b),
      getAddress(g.pair),
      `${g.dexId} ${g.a}/${g.b} derived the wrong pair`,
    )
  }
})

sweepTest('token order does not change the pair', () => {
  for (const venue of V2_SWEEP_VENUES) {
    const forward = v2PairAddress(venue, ADDR.WNATIVE, ADDR.STABLE)
    const reverse = v2PairAddress(venue, ADDR.STABLE, ADDR.WNATIVE)
    assert.equal(forward, reverse, 'a pair is the same pair whichever way it is named')
  }
  const [t0, t1] = sortTokens(ADDR.STABLE, ADDR.WNATIVE)
  assert.ok(t0.toLowerCase() < t1.toLowerCase(), 'sortTokens must order numerically')
})

sweepTest('the same tokens on different venues are different pairs', () => {
  if (V2_SWEEP_VENUES.length < 2) return
  const [a, b] = V2_SWEEP_VENUES
  assert.notEqual(
    v2PairAddress(a, ADDR.WNATIVE, ADDR.STABLE),
    v2PairAddress(b, ADDR.WNATIVE, ADDR.STABLE),
    'two factories must not derive the same address',
  )
})

sweepTest('verification rejects a pair that does not hold the tokens it claims', () => {
  if (CHAIN.key !== 'bsc') return
  const venue = sweepVenueOf('pancakeswap')!
  const real = BSC_GOLDEN[0]
  assert.ok(isVenuePair(venue, real.pair, real.a, real.b), 'the real pair must verify')

  // the same address, claiming a different pair of tokens
  const impostorTokens = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82' as Address
  assert.ok(
    !isVenuePair(venue, real.pair, real.a, impostorTokens),
    'a pair claiming tokens it does not hold must fail',
  )
  // a Pancake pair presented as a Uniswap one
  assert.ok(
    !isVenuePair(sweepVenueOf('uniswap')!, real.pair, real.a, real.b),
    'the other venue must not vouch for this pair',
  )
  // an arbitrary contract calling itself an LP token
  assert.ok(
    !isVenuePair(venue, '0x000000000000000000000000000000000000dEaD' as Address, real.a, real.b),
    'an unrelated address must never verify',
  )
  // and malformed input is a non-match, not a throw
  assert.equal(isVenuePair(venue, 'not-an-address' as Address, real.a, real.b), false)
})

sweepTest('each venue carries its own fee, taken from the venue config', () => {
  for (const venue of V2_SWEEP_VENUES) {
    assert.ok(venue.feeBps > 0, `${venue.dexId} has no fee`)
    if (venue.protocol === 'home') {
      assert.equal(venue.feeBps, (CHAIN.homeV2?.feePpm ?? 0) / 100, 'home fee must track homeV2.feePpm')
    } else {
      assert.equal(venue.feeBps, 30, 'uniswap v2 is 0.30% at every deployment')
    }
  }
  if (CHAIN.key === 'bsc') {
    const fees = V2_SWEEP_VENUES.map((v) => v.feeBps).sort()
    assert.deepEqual(fees, [25, 30], 'Pancake takes 25 bps where Uniswap takes 30')
  }
})

sweepTest('the connector floor needs no external source and covers every venue', () => {
  const cands = connectorCandidates()
  const expected = (CONNECTORS.length * (CONNECTORS.length - 1)) / 2 * V2_SWEEP_VENUES.length
  assert.equal(cands.length, expected)
  // every one of them verifies against the venue that produced it
  for (const c of cands) {
    assert.ok(isVenuePair(c.venue, c.address, c.token0, c.token1))
    assert.ok(c.token0.toLowerCase() < c.token1.toLowerCase(), 'candidates carry sorted tokens')
  }
  // and the addresses are distinct — a collision would silently merge positions
  assert.equal(new Set(cands.map((c) => c.address.toLowerCase())).size, cands.length)
})

// The inverse: a chain that has a holder-balance API must not sweep at all,
// because a sweep only ever sees its candidate list.
const noSweepTest = HAS_V2_SWEEP ? test.skip : test
noSweepTest('a chain with no sweep venues produces no candidates', () => {
  assert.equal(V2_SWEEP_VENUES.length, 0)
  assert.equal(connectorCandidates().length, 0)
  assert.equal(sweepVenueOf('pancakeswap'), undefined)
})

// ---- merging what two readers each found ----

const PAIR = '0x0eD7e52944161450477ee417DE9Cd3a859b14fD0' as Address
const OTHER = '0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE' as Address

function pool(address: Address, reserve0 = 1000n, reserve1 = 4000n, totalSupply = 2000n): V2Pool {
  return {
    kind: 'v2',
    protocol: 'home',
    address,
    token0: CONNECTORS[0],
    token1: CONNECTORS[1],
    stable: false,
    reserve0,
    reserve1,
    totalSupply,
    gaugeTotalSupply: 0n,
    feeBps: 25,
    gauge: null,
    gaugeAlive: false,
    weight: 0n,
    rewardRate: 0n,
    periodFinish: 0n,
  }
}

const empty = { earned: 0n, claimable0: 0n, claimable1: 0n }

/** what the wallet sweep reports: a balance, never a deposit */
function walletRow(address: Address, walletLp: bigint): V2Position {
  const p = pool(address)
  return {
    pool: p,
    walletLp,
    stakedLp: 0n,
    ...empty,
    amount0: (walletLp * p.reserve0) / p.totalSupply,
    amount1: (walletLp * p.reserve1) / p.totalSupply,
  }
}

/** what the farm reports: a deposit, never a balance */
function farmRow(address: Address, stakedLp: bigint, reward = 0n): V2Position {
  const p = pool(address)
  return {
    pool: p,
    walletLp: 0n,
    stakedLp,
    ...empty,
    amount0: (stakedLp * p.reserve0) / p.totalSupply,
    amount1: (stakedLp * p.reserve1) / p.totalSupply,
    farm: { address: OTHER, pid: 2, reward, symbol: 'CAKE', decimals: 18 },
  }
}

test('a pair found by only one reader passes through untouched', () => {
  const rows = [walletRow(PAIR, 100n), farmRow(OTHER, 300n, 7n)]
  const merged = mergeV2ByPair(rows)
  assert.equal(merged.length, 2)
  assert.deepEqual(merged[0], rows[0])
  assert.deepEqual(merged[1], rows[1])
})

test('wallet LP and farm LP in the same pair become one row', () => {
  const merged = mergeV2ByPair([walletRow(PAIR, 100n), farmRow(PAIR, 300n, 42n)])
  assert.equal(merged.length, 1, 'one card per pair, not two')
  const m = merged[0]
  assert.equal(m.walletLp, 100n)
  assert.equal(m.stakedLp, 300n)
  // the underlying covers BOTH, recomputed from total lp against the reserves
  assert.equal(m.amount0, (400n * 1000n) / 2000n)
  assert.equal(m.amount1, (400n * 4000n) / 2000n)
  assert.equal(m.farm?.reward, 42n, 'the farm reward survives the merge')
  assert.equal(m.farm?.pid, 2)
})

test('merging is order independent', () => {
  const a = mergeV2ByPair([walletRow(PAIR, 100n), farmRow(PAIR, 300n, 42n)])[0]
  const b = mergeV2ByPair([farmRow(PAIR, 300n, 42n), walletRow(PAIR, 100n)])[0]
  assert.equal(a.walletLp, b.walletLp)
  assert.equal(a.stakedLp, b.stakedLp)
  assert.equal(a.amount0, b.amount0)
  assert.equal(a.amount1, b.amount1)
  assert.equal(a.farm?.reward, b.farm?.reward)
})

test('the same pair under different address casing still merges', () => {
  const lower = walletRow(PAIR.toLowerCase() as Address, 100n)
  const merged = mergeV2ByPair([lower, farmRow(PAIR, 300n)])
  assert.equal(merged.length, 1, 'address case must not split one position into two cards')
  assert.equal(merged[0].walletLp + merged[0].stakedLp, 400n)
})

test('a pair whose supply went to zero prices at zero rather than dividing by it', () => {
  const p = pool(PAIR, 1000n, 4000n, 0n)
  const rows: V2Position[] = [
    { pool: p, walletLp: 100n, stakedLp: 0n, ...empty, amount0: 0n, amount1: 0n },
    { pool: p, walletLp: 0n, stakedLp: 300n, ...empty, amount0: 0n, amount1: 0n },
  ]
  const merged = mergeV2ByPair(rows)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].amount0, 0n)
  assert.equal(merged[0].amount1, 0n)
})
