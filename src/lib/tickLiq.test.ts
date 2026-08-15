import assert from 'node:assert/strict'
import test from 'node:test'
import {
  binLiquidity,
  buildSegments,
  compressTick,
  decodeWord,
  decodeWords,
  tickWordRange,
  wordPosOf,
} from './tickLiq'

test('compressTick: floors toward negative infinity like the contract', () => {
  assert.equal(compressTick(0, 60), 0)
  assert.equal(compressTick(60, 60), 1)
  assert.equal(compressTick(59, 60), 0)
  assert.equal(compressTick(-60, 60), -1)
  // the case truncation gets wrong: -1/60 truncates to 0, floors to -1
  assert.equal(compressTick(-1, 60), -1)
  assert.equal(compressTick(-59, 60), -1)
  assert.equal(compressTick(-61, 60), -2)
})

test('wordPosOf: negative indices shift arithmetically', () => {
  assert.equal(wordPosOf(0), 0)
  assert.equal(wordPosOf(255), 0)
  assert.equal(wordPosOf(256), 1)
  assert.equal(wordPosOf(-1), -1)
  assert.equal(wordPosOf(-256), -1)
  assert.equal(wordPosOf(-257), -2)
})

test('decodeWord: bit position maps back to the tick that set it', () => {
  // bit 0 of word 0 is compressed tick 0; bit 3 is compressed tick 3
  assert.deepEqual(decodeWord(0, 0b1001n, 60), [0, 180])
  // word -1 holds compressed -256..-1, so its top bit is compressed -1
  assert.deepEqual(decodeWord(-1, 1n << 255n, 60), [-60])
  assert.deepEqual(decodeWord(0, 0n, 60), [])
})

test('decodeWord round-trips every tick through the bitmap layout', () => {
  const spacing = 200
  for (const tick of [-887200, -40000, -400, -200, 0, 200, 400, 40000, 887200]) {
    const c = compressTick(tick, spacing)
    const w = wordPosOf(c)
    const bit = c & 0xff
    assert.deepEqual(decodeWord(w, 1n << BigInt(bit), spacing), [tick], `tick ${tick}`)
  }
})

test('tickWordRange: covers both edges, and one word when they share it', () => {
  assert.deepEqual(tickWordRange(0, 60, 60), [0])
  // compressed 0..256 straddles words 0 and 1
  assert.deepEqual(tickWordRange(0, 256 * 60, 60), [0, 1])
  assert.deepEqual(tickWordRange(-60, 60, 60), [-1, 0])
  // argument order does not matter
  assert.deepEqual(tickWordRange(60, -60, 60), [-1, 0])
})

test('decodeWords: merges words into one ascending list', () => {
  assert.deepEqual(
    decodeWords([{ wordPos: 0, word: 0b10n }, { wordPos: -1, word: 1n << 255n }], 60),
    [-60, 60],
  )
})

test('buildSegments: a lone position stands over its own range only', () => {
  // one position of 1000 spanning [-120, 120), price inside it
  const nets = [
    { tick: -120, liquidityNet: 1000n },
    { tick: 120, liquidityNet: -1000n },
  ]
  const segs = buildSegments(nets, 0, 1000n, -240, 240)
  assert.deepEqual(segs, [
    { lower: -240, upper: -120, liquidity: 0n },
    { lower: -120, upper: 120, liquidity: 1000n },
    { lower: 120, upper: 240, liquidity: 0n },
  ])
})

test('buildSegments: stacked positions add where they overlap', () => {
  // A spans [-240,240) with 500, B spans [-120,120) with 300 → 800 in the middle
  const nets = [
    { tick: -240, liquidityNet: 500n },
    { tick: -120, liquidityNet: 300n },
    { tick: 120, liquidityNet: -300n },
    { tick: 240, liquidityNet: -500n },
  ]
  const segs = buildSegments(nets, 0, 800n, -360, 360)
  assert.deepEqual(
    segs.map((s) => [s.lower, s.upper, s.liquidity]),
    [
      [-360, -240, 0n],
      [-240, -120, 500n],
      [-120, 120, 800n],
      [120, 240, 500n],
      [240, 360, 0n],
    ],
  )
})

test('buildSegments: anchors correctly when the price sits off centre', () => {
  const nets = [
    { tick: -240, liquidityNet: 500n },
    { tick: -120, liquidityNet: 300n },
    { tick: 120, liquidityNet: -300n },
    { tick: 240, liquidityNet: -500n },
  ]
  // price in the outer shelf: the pool would report 500 active there
  const segs = buildSegments(nets, 200, 500n, -360, 360)
  assert.deepEqual(
    segs.map((s) => s.liquidity),
    [0n, 500n, 800n, 500n, 0n],
  )
})

test('buildSegments: window edges cut spans without changing liquidity', () => {
  const nets = [
    { tick: -600, liquidityNet: 700n },
    { tick: 600, liquidityNet: -700n },
  ]
  // both boundaries lie outside the window, so the whole window is one span
  const segs = buildSegments(nets, 0, 700n, -120, 120)
  assert.deepEqual(segs, [{ lower: -120, upper: 120, liquidity: 700n }])
})

test('buildSegments: a missed boundary clamps at zero instead of going negative', () => {
  // only the closing tick was read, so walking down would drive liquidity below 0
  const segs = buildSegments([{ tick: 120, liquidityNet: -1000n }], 0, 1000n, -240, 240)
  assert.deepEqual(
    segs.map((s) => s.liquidity),
    [1000n, 0n],
  )
})

test('buildSegments: empty pool and degenerate windows', () => {
  assert.deepEqual(buildSegments([], 0, 0n, -100, 100), [
    { lower: -100, upper: 100, liquidity: 0n },
  ])
  assert.deepEqual(buildSegments([], 0, 5n, 100, 100), [])
  assert.deepEqual(buildSegments([], 0, 5n, 100, -100), [])
})

test('binLiquidity: a flat span reports its own height in every column', () => {
  const segs = [{ lower: 0, upper: 100, liquidity: 42n }]
  assert.deepEqual(binLiquidity(segs, 0, 100, 4), [42n, 42n, 42n, 42n])
})

test('binLiquidity: a spike is diluted across the column that holds it', () => {
  // 1000 over a quarter of the column, nothing elsewhere → a quarter of 1000
  const segs = [
    { lower: 0, upper: 25, liquidity: 1000n },
    { lower: 25, upper: 100, liquidity: 0n },
  ]
  assert.deepEqual(binLiquidity(segs, 0, 100, 2), [500n, 0n])
  assert.deepEqual(binLiquidity(segs, 0, 100, 4), [1000n, 0n, 0n, 0n])
})

test('binLiquidity: columns tile the window with no ticks left over', () => {
  // 100 ticks over 3 columns divides unevenly; every tick still lands in one
  const segs = [{ lower: 0, upper: 100, liquidity: 9n }]
  const bins = binLiquidity(segs, 0, 100, 3)
  assert.equal(bins.length, 3)
  assert.deepEqual(bins, [9n, 9n, 9n])
})

test('binLiquidity: refuses degenerate windows rather than dividing by zero', () => {
  assert.deepEqual(binLiquidity([], 0, 0, 4), [])
  assert.deepEqual(binLiquidity([], 0, 100, 0), [])
})
