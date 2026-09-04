import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { zeroAddress, type Address } from 'viem'
import { MAX_TICK, MIN_TICK } from './clmath'
import { v4PoolId } from './uniV4'

/**
 * The create-pool math, pinned before any of it touches a wallet: the price a
 * pool opens on has to survive the round trip through sqrtPriceX96 for every
 * decimal layout this chain mints, and the range ticks have to land on the
 * pool's own spacing grid.
 *
 * The module is loaded after Node's mocks because its write half imports
 * wagmi eagerly (the same shape as zapV4.test.ts).
 */
mock.module('wagmi/actions', {
  namedExports: {
    getAccount: () => ({ address: undefined }),
    readContract: async () => {
      throw new Error('unexpected readContract')
    },
    writeContract: async () => {
      throw new Error('unexpected writeContract')
    },
    waitForTransactionReceipt: async () => {
      throw new Error('unexpected waitForTransactionReceipt')
    },
  },
})
mock.module('../config/wagmi', { namedExports: { wagmiConfig: {} } })
mock.module('../config/query', {
  namedExports: {
    queryClient: { invalidateQueries: async () => {} },
  },
})
mock.module('../i18n', { namedExports: { t: (key: string) => key } })

const { initialSqrtPriceX96, tokenPerEthOf, priceTickInRange, newPoolKey, rangeTicks, pickPriceSource, previewAtInitPrice } =
  await import('./v4PoolCreate')

const TOKEN = '0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B' as Address

test('newPoolKey: a native pair has exactly one orientation, hooks off', () => {
  for (const fee of [20000, 2500, 100]) {
    const key = newPoolKey(TOKEN, fee, 200)
    assert.equal(key.currency0, zeroAddress, 'zero address sorts first — native is always currency0')
    assert.equal(key.currency1, TOKEN)
    assert.equal(key.hooks, zeroAddress)
    assert.equal(key.fee, fee)
  }
  // and the key is the pool: the id is the hash of exactly these fields
  assert.equal(typeof v4PoolId(newPoolKey(TOKEN, 20000, 200)), 'string')
})

test('initialSqrtPriceX96 <-> tokenPerEthOf round-trips across decimal layouts', () => {
  const cases: [number, number][] = [
    [1, 18], // 1 token per ETH, 18 decimals
    [500_000, 18], // a fresh meme at 1 AMC = 2e-6 ETH
    [0.5, 6], // a 6-decimal token above parity
    [12.3456, 2],
    [1e-9, 18],
    [1e9, 8],
  ]
  for (const [price, dec] of cases) {
    const { sqrtPriceX96 } = initialSqrtPriceX96(price, dec)
    const back = tokenPerEthOf(sqrtPriceX96, dec)
    assert.ok(
      Math.abs(back / price - 1) < 1e-9,
      `${price} token/ETH at ${dec} decimals: ${back} read back`,
    )
  }
})

test('initialSqrtPriceX96 rejects nonsense prices instead of encoding them', () => {
  for (const bad of [0, -1, NaN, Infinity]) {
    assert.throws(() => initialSqrtPriceX96(bad, 18))
  }
  // 1e30 token per ETH at 18 decimals squares past uint160 — refuse, do not
  // wrap into a price nobody meant
  assert.throws(() => initialSqrtPriceX96(1e40, 18))
})

test('the tick a starting price implies sits inside TickMath, and moves with the price', () => {
  const sane = initialSqrtPriceX96(500_000, 18)
  assert.ok(priceTickInRange(sane.tick))
  // anything whose sqrtPrice fits uint160 carries a tick well inside TickMath —
  // the real guard is initialSqrtPriceX96 throwing on overflow (pinned above)
  const bigger = initialSqrtPriceX96(1e20, 18)
  assert.ok(bigger.tick > sane.tick)
  assert.ok(priceTickInRange(bigger.tick))
  assert.ok(priceTickInRange(MIN_TICK) && priceTickInRange(MAX_TICK))
  assert.ok(!priceTickInRange(MAX_TICK + 1) && !priceTickInRange(MIN_TICK - 1))
})

test('rangeTicks: full range spans the grid, bands stay inside their typed prices', () => {
  const full = rangeTicks({ mode: 'full' }, 200, 18)
  assert.ok(full.lower < full.upper)
  assert.equal(Math.abs(full.lower % 200), 0)
  assert.equal(Math.abs(full.upper % 200), 0)

  const price = 500_000
  const band = rangeTicks({ mode: 'band', priceMin: price * 0.5, priceMax: price * 2 }, 200, 18)
  const initTick = initialSqrtPriceX96(price, 18).tick
  assert.ok(band.lower <= initTick && initTick <= band.upper, 'a ±50% band brackets the opening price')
  // floor/ceil on the typed bounds means the position never sits inside them
  const lowerPrice = Math.pow(1.0001, band.lower) * Math.pow(10, 18 - 18)
  const upperPrice = Math.pow(1.0001, band.upper) * Math.pow(10, 18 - 18)
  assert.ok(lowerPrice <= price * 0.5 && upperPrice >= price * 2)
  assert.throws(() => rangeTicks({ mode: 'band', priceMin: 2, priceMax: 1 }, 200, 18))
})

test('pickPriceSource: deepest liquid pool wins, dust and garbage price nothing', () => {
  assert.equal(pickPriceSource([]), null)
  assert.equal(
    pickPriceSource([
      { pricePerToken: NaN, liquidity: 1e9, source: 'x' },
      { pricePerToken: 0, liquidity: 1e9, source: 'x' },
      { pricePerToken: 5, liquidity: 0, source: 'x' },
    ]),
    null,
  )
  const best = pickPriceSource([
    { pricePerToken: 1.0, liquidity: 10, source: 'shallow' },
    { pricePerToken: 1.5, liquidity: 1e12, source: 'deep' },
  ])
  assert.equal(best?.source, 'deep')
  assert.equal(best?.pricePerToken, 1.5)
})

test('previewAtInitPrice: the opening-price preview spends at most what was typed', () => {
  const price = 500_000 // 1 ETH = 500k token
  const { sqrtPriceX96 } = initialSqrtPriceX96(price, 18)
  const { lower, upper } = rangeTicks({ mode: 'band', priceMin: price * 0.5, priceMax: price * 2 }, 200, 18)
  // 1 ETH + the 500k token it trades for, sized with a 1% band
  const amount0 = 10n ** 18n
  const amount1 = 500_000n * 10n ** 18n
  const prev = previewAtInitPrice(sqrtPriceX96, lower, upper, amount0, amount1, 100)
  assert.ok(prev.liquidity > 0n)
  assert.ok(prev.amount0 <= amount0 && prev.amount1 <= amount1, 'preview never promises more than the ceilings')
  // at the opening price the two sides hold each other's value — the pool
  // ratio IS the price, so both sides bind to within the sizing band
  const valueRatio = (Number(prev.amount1) / Number(prev.amount0)) / price
  assert.ok(Math.abs(valueRatio - 1) < 0.02, `sides should be price-consistent, ratio ${valueRatio}`)
})
