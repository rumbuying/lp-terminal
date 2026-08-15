import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ClPool, ClPosition, V2Pool, V2Position } from '../types'
import type { PoolStat } from './poolstats'
import { compareClPositionDisplay, v2PosMetrics } from './posmetrics'

const position = (tokenId: bigint, protocol: ClPool['protocol'], staked: boolean) =>
  ({ tokenId, staked, pool: { protocol } }) as ClPosition

test('unstaking a CL position does not change display order', () => {
  const values = new Map([[1n, 100], [2n, 200]])
  const ids = (positions: ClPosition[]) =>
    [...positions]
      .sort((a, b) => compareClPositionDisplay(a, b, values.get(a.tokenId)!, values.get(b.tokenId)!))
      .map((position) => position.tokenId)

  assert.deepEqual(ids([position(1n, 'home', true), position(2n, 'home', false)]), [2n, 1n])
  assert.deepEqual(ids([position(1n, 'home', false), position(2n, 'home', false)]), [2n, 1n])
})

// ---- v2: where the LP sits changes who pays it ----

const v2Pool = (over: Partial<V2Pool> = {}): V2Pool => ({
  kind: 'v2',
  protocol: 'home',
  address: '0x0eD7e52944161450477ee417DE9Cd3a859b14fD0',
  token0: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
  token1: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  stable: false,
  reserve0: 1_000_000n * 10n ** 18n,
  reserve1: 1_000_000n * 10n ** 18n,
  totalSupply: 1_000_000n * 10n ** 18n,
  gaugeTotalSupply: 0n,
  feeBps: 25,
  gauge: null,
  gaugeAlive: false,
  weight: 0n,
  rewardRate: 0n,
  periodFinish: 0n,
  ...over,
})

const v2Pos = (pool: V2Pool, over: Partial<V2Position> = {}): V2Position => ({
  pool,
  walletLp: 0n,
  stakedLp: 0n,
  earned: 0n,
  claimable0: 0n,
  claimable1: 0n,
  amount0: 0n,
  amount1: 0n,
  ...over,
})

const stat: PoolStat = { vol24hUsd: 1_000_000, liqUsd: 10_000_000, source: 'dexscreener' }
const FARM = { address: '0xa5f8C5Dbd5F286960b9d90548680aE5ebFf07652' as const, pid: 2, reward: 5n, symbol: 'CAKE', decimals: 18 }

test('LP held by a farm still earns trading fees', () => {
  // custody moved the token; the claim on the pair's reserves did not move, so
  // reporting this as "emissions ended" would understate what it is doing
  const m = v2PosMetrics({
    pos: v2Pos(v2Pool(), { stakedLp: 100n * 10n ** 18n, farm: FARM }),
    dec0: 18,
    dec1: 18,
    stat,
  })
  assert.equal(m.staked, null, 'a farm has no gauge, so no emissions line')
  assert.equal(m.wallet?.kind, 'fees')
})

test('the fee share of farmed LP counts the staked LP, not just the wallet', () => {
  const pool = v2Pool()
  const both = v2PosMetrics({
    pos: v2Pos(pool, { walletLp: 100n * 10n ** 18n, stakedLp: 300n * 10n ** 18n, farm: FARM }),
    dec0: 18,
    dec1: 18,
    stat,
  })
  const walletOnly = v2PosMetrics({
    pos: v2Pos(pool, { walletLp: 100n * 10n ** 18n }),
    dec0: 18,
    dec1: 18,
    stat,
  })
  assert.equal(both.wallet?.kind, 'fees')
  assert.equal(walletOnly.wallet?.kind, 'fees')
  const bothShare = both.wallet.kind === 'fees' ? both.wallet.sharePct : 0
  const walletShare = walletOnly.wallet.kind === 'fees' ? walletOnly.wallet.sharePct : 0
  assert.ok(bothShare > walletShare, `${bothShare} should exceed ${walletShare}`)
  assert.ok(Math.abs(bothShare - walletShare * 4) < 1e-9, 'four times the LP, four times the share')
})

test('gauge-staked LP keeps taking the emissions branch', () => {
  const gauged = v2Pool({
    gauge: '0x1111111111111111111111111111111111111111',
    gaugeAlive: true,
    gaugeTotalSupply: 1000n * 10n ** 18n,
    rewardRate: 10n ** 18n,
    periodFinish: BigInt(Math.floor(Date.now() / 1000) + 86_400),
  })
  const m = v2PosMetrics({ pos: v2Pos(gauged, { stakedLp: 100n * 10n ** 18n }), dec0: 18, dec1: 18, stat })
  assert.equal(m.staked?.kind, 'emissions')
  assert.equal(m.wallet, null, 'nothing in the wallet earns fees')
})

test('gauge-staked LP with emissions over reports idle, not fees', () => {
  const dead = v2Pool({ gauge: '0x1111111111111111111111111111111111111111', gaugeAlive: false })
  const m = v2PosMetrics({ pos: v2Pos(dead, { stakedLp: 100n * 10n ** 18n }), dec0: 18, dec1: 18, stat })
  assert.equal(m.staked?.kind, 'emissions-idle')
  assert.equal(m.wallet, null)
})
