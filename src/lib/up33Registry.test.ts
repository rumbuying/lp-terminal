import assert from 'node:assert/strict'
import test from 'node:test'
import { getAddress, type Address } from 'viem'
import { CHAIN_ID } from '../config/addresses'
import { CHAIN } from '../config/chains'
import type { ClPool, TokenInfo } from '../types'
import {
  fetchUp33Registry,
  mergeUp33Registry,
  type Up33RegistryData,
  type Up33RegistryPool,
} from './up33Registry'

const addr = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`
const checksum = (a: string): Address => getAddress(a)

const tokenA = addr(0xa1)
const tokenB = addr(0xb1)

const headPool = (n: number): ClPool => ({
  kind: 'cl',
  protocol: 'home',
  address: checksum(addr(n)),
  token0: checksum(tokenA),
  token1: checksum(tokenB),
  tickSpacing: 200,
  feePpm: 10_000,
  unstakedFeePpm: 150_000,
  sqrtPriceX96: 1n << 96n,
  tick: 0,
  liquidity: 5n,
  stakedLiquidity: 1n,
  gauge: null,
  gaugeAlive: false,
  weight: 12n,
  rewardRate: 3n,
  periodFinish: 99n,
})

const headTokens = (): Record<string, TokenInfo> => ({
  [tokenA]: { address: checksum(tokenA), symbol: 'USDG', decimals: 6 },
  [tokenB]: { address: checksum(tokenB), symbol: 'WETH', decimals: 18 },
})

/** A registry row the indexer's sweep has fully state-hydrated. */
const registryRow = (overrides: Partial<Up33RegistryPool> = {}): Up33RegistryPool => ({
  address: addr(0xc1),
  token0: tokenA,
  token1: addr(0xc2),
  feePpm: 10_000,
  unstakedFeePpm: 150_000,
  tickSpacing: 200,
  gauge: addr(0xc9),
  pairIndex: 1583,
  sqrtPriceX96: String(1n << 96n),
  tick: 0,
  liquidity: '517130667738',
  stakedLiquidity: '1000',
  rewardRate: '77',
  periodFinish: 1_800_000_000,
  gaugeAlive: true,
  stateUpdated: 1_700_000_000,
  stateReady: true,
  ...overrides,
})

const registryData = (
  pools: Up33RegistryPool[],
  tokens: Up33RegistryData['tokens'] = {
    [tokenA]: { address: tokenA, symbol: 'USDG', decimals: 6 },
    [addr(0xc2)]: { address: addr(0xc2), symbol: 'NET', decimals: 9 },
  },
): Up33RegistryData => ({
  chainId: CHAIN_ID,
  ready: true,
  chain: { key: CHAIN.key, id: CHAIN_ID },
  pools,
  tokens,
})

test('registry top-up appends tail rows as home CL pools with sweep state', () => {
  const scanned = { pools: [headPool(1)], tokens: headTokens() }
  const merged = mergeUp33Registry(scanned, registryData([registryRow()]))
  assert.equal(merged.added, 1)
  assert.equal(merged.pools.length, 2)
  const tail = merged.pools[1]
  assert.equal(tail.protocol, 'home')
  assert.equal(tail.kind, 'cl')
  assert.equal(tail.address, checksum(addr(0xc1)))
  assert.equal(tail.tickSpacing, 200)
  assert.equal(tail.feePpm, 10_000)
  assert.equal(tail.unstakedFeePpm, 150_000)
  assert.equal(tail.sqrtPriceX96, 1n << 96n)
  assert.equal(tail.liquidity, 517130667738n)
  assert.equal(tail.stakedLiquidity, 1000n)
  assert.equal(tail.rewardRate, 77n)
  assert.equal(tail.periodFinish, 1_800_000_000n)
  assert.equal(tail.gauge, checksum(addr(0xc9)))
  assert.equal(tail.gaugeAlive, true)
  // Voter weights are a browser-scan read; a registry row has none.
  assert.equal(tail.weight, 0n)
  // the row's unnamed side arrives as searchable metadata
  assert.deepEqual(merged.tokens[addr(0xc2)], {
    address: checksum(addr(0xc2)),
    symbol: 'NET',
    decimals: 9,
  })
})

test('head-scan rows win: a registry row for an already-scanned pool is dropped', () => {
  const head = headPool(1)
  const scanned = { pools: [head], tokens: headTokens() }
  const row = registryRow({ address: addr(1), pairIndex: 0 })
  const merged = mergeUp33Registry(scanned, registryData([row]))
  assert.equal(merged.added, 0)
  assert.equal(merged.pools.length, 1)
  assert.equal(merged.pools[0], head, 'the scan object must survive untouched')
})

test('rows without sweep state, without price, or without token metadata are held back', () => {
  const scanned = { pools: [], tokens: headTokens() }
  const merged = mergeUp33Registry(
    scanned,
    registryData([
      registryRow({ address: addr(0xd1), stateReady: false, sqrtPriceX96: null, tick: null, liquidity: null }),
      registryRow({ address: addr(0xd2), sqrtPriceX96: '0' }),
      registryRow({ address: addr(0xd3), token1: addr(0xd9) /* no metadata for it */ }),
      registryRow({ address: addr(0xd4) }),
    ]),
  )
  assert.equal(merged.added, 1)
  assert.equal(merged.pools[0].address, checksum(addr(0xd4)))
})

test('scan metadata wins over registry metadata; a null registry changes nothing', () => {
  const scanned = { pools: [headPool(1)], tokens: headTokens() }
  const untouched = mergeUp33Registry(scanned, null)
  assert.equal(untouched.added, 0)
  assert.equal(untouched.pools.length, 1)
  assert.equal(untouched.tokens[tokenA].symbol, 'USDG')

  const registry = registryData([registryRow()], {
    [tokenA]: { address: tokenA, symbol: 'FAKE', decimals: 18 },
    [addr(0xc2)]: { address: addr(0xc2), symbol: 'NET', decimals: 9 },
  })
  const merged = mergeUp33Registry(scanned, registry)
  assert.equal(merged.tokens[tokenA].symbol, 'USDG', 'chain-read metadata must not be replaced')
})

test('a malformed registry row is one skipped row, not a failed merge', () => {
  const scanned = { pools: [], tokens: headTokens() }
  const merged = mergeUp33Registry(
    scanned,
    registryData([
      registryRow({ address: 'not-an-address' }),
      registryRow({ address: addr(0xd5) }),
    ]),
  )
  assert.equal(merged.added, 1)
})

test('registry fetch answers null for an old indexer, a wrong chain, and non-JSON', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://terminal.example' },
  })
  let served: () => Response = () => new Response('{"pools":[]}', { status: 404 })
  globalThis.fetch = (async () => served()) as typeof fetch
  try {
    served = () => new Response('not found', { status: 404 })
    assert.equal(await fetchUp33Registry(undefined, 1_000), null, '404 (pre-deploy indexer) must top up nothing')

    served = () =>
      new Response(
        JSON.stringify({ ...registryData([]), chain: { key: 'other', id: 999 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    assert.equal(await fetchUp33Registry(undefined, 1_000), null, 'a wrong-chain body must be refused')

    served = () => new Response('<html>', { status: 200 })
    assert.equal(await fetchUp33Registry(undefined, 1_000), null)

    served = () =>
      new Response(JSON.stringify(registryData([], {})), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    const ok = await fetchUp33Registry(undefined, 1_000)
    assert.ok(ok)
    assert.equal(ok.chain.key, CHAIN.key)
    assert.deepEqual(ok.pools, [])
  } finally {
    globalThis.fetch = originalFetch
    if (originalLocation)
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: originalLocation,
      })
    else Reflect.deleteProperty(globalThis, 'location')
  }
})
