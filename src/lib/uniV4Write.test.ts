import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeAbiParameters, parseAbiParameters, zeroAddress, type Address, type Hex } from 'viem'
import {
  encodeV4Collect,
  encodeV4Decrease,
  encodeV4Increase,
  encodeV4Mint,
  V4_DEPOSIT_BAND_BPS,
  v4HasHooks,
  v4NativeSide,
  type V4PoolKey,
} from './uniV4'
import {
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getSqrtRatioAtTick,
  liquidityForAmountsWithSlippage,
} from './clmath'

/**
 * The encoders below were simulated against the DEPLOYED BSC PositionManager
 * (0x7A4a…f95b) on 2026-08-02, by eth_call from real owners of live positions
 * #985658 (ERC-20 pool) and #985406 / #985397 (native-keyed). Collect,
 * decrease, increase, and a new native BNB/USDT mint all executed cleanly.
 * These tests pin the action-list structures that produced those results.
 */
const payload = parseAbiParameters('bytes actions, bytes[] params')
const modifyParams = parseAbiParameters(
  'uint256 tokenId, uint256 liquidity, uint128 amount0, uint128 amount1, bytes hookData',
)
const mintParams = parseAbiParameters(
  '(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, int24 tickLower, int24 tickUpper, uint256 liquidity, uint128 amount0Max, uint128 amount1Max, address owner, bytes hookData',
)
const currencyParam = parseAbiParameters('address currency')
const sweepParams = parseAbiParameters('address currency, address recipient')

const USDT = '0x55d398326f99059fF775485246999027B3197955' as Address
const OTHER = '0x8554D38b95E4F7Ca11D391008627Df30B2b07777' as Address
const DEAD = '0x000000000000000000000000000000000000dEaD' as Address
const ERC20_POOL: V4PoolKey = {
  currency0: USDT,
  currency1: OTHER,
  fee: 27400,
  tickSpacing: 548,
  hooks: zeroAddress as Address,
}
/** v4 keys the chain's coin as address(0), which sorts first — so it is currency0 */
const NATIVE_POOL: V4PoolKey = { ...ERC20_POOL, currency0: zeroAddress as Address }

function unpack(unlockData: Hex) {
  const [actions, params] = decodeAbiParameters(payload, unlockData)
  return { actions, params: params as readonly Hex[] }
}

test('an increase closes both currencies rather than settling them', () => {
  const { unlockData } = encodeV4Increase({
    key: ERC20_POOL,
    tokenId: 42n,
    liquidity: 1000n,
    amount0Max: 7n,
    amount1Max: 9n,
    recipient: DEAD,
  })
  const { actions, params } = unpack(unlockData)
  // INCREASE_LIQUIDITY, CLOSE_CURRENCY, CLOSE_CURRENCY.
  //
  // SETTLE_PAIR (0x0d) is the shorthand the v4 docs lead with and it is WRONG
  // here: a liquidity change credits accrued fees into the same delta, so an
  // out-of-range position's inactive side comes out positive and SETTLE_PAIR,
  // which can only pay, reverts with DeltaNotNegative (0x3351b260). Measured on
  // five live BSC positions — all five reverted, all five passed with 0x12.
  assert.equal(actions, '0x001212')
  assert.equal(params.length, 3)
  assert.deepEqual(decodeAbiParameters(currencyParam, params[1]), [ERC20_POOL.currency0])
  assert.deepEqual(decodeAbiParameters(currencyParam, params[2]), [ERC20_POOL.currency1])
})

test('the increase carries the token id, the sized liquidity and the spend ceiling', () => {
  const { unlockData } = encodeV4Increase({
    key: ERC20_POOL,
    tokenId: 42n,
    liquidity: 1000n,
    amount0Max: 7n,
    amount1Max: 9n,
    recipient: DEAD,
  })
  const [tokenId, liquidity, amount0, amount1, hookData] = decodeAbiParameters(
    modifyParams,
    unpack(unlockData).params[0],
  )
  assert.equal(tokenId, 42n)
  assert.equal(liquidity, 1000n)
  assert.equal(amount0, 7n)
  assert.equal(amount1, 9n)
  assert.equal(hookData, '0x')
})

test('mint encodes the pool key, range, liquidity, ceilings and owner', () => {
  const { unlockData, value } = encodeV4Mint({
    key: ERC20_POOL,
    tickLower: -548,
    tickUpper: 548,
    liquidity: 1000n,
    amount0Max: 7n,
    amount1Max: 9n,
    owner: DEAD,
  })
  const { actions, params } = unpack(unlockData)
  assert.equal(actions, '0x021212')
  assert.equal(value, 0n)
  const [key, lower, upper, liquidity, amount0, amount1, owner, hookData] =
    decodeAbiParameters(mintParams, params[0])
  assert.deepEqual(key, ERC20_POOL)
  assert.equal(lower, -548)
  assert.equal(upper, 548)
  assert.equal(liquidity, 1000n)
  assert.equal(amount0, 7n)
  assert.equal(amount1, 9n)
  assert.equal(owner, DEAD)
  assert.equal(hookData, '0x')
})

test('native mint pays msg.value and sweeps unspent coin to its owner', () => {
  const { unlockData, value } = encodeV4Mint({
    key: NATIVE_POOL,
    tickLower: -548,
    tickUpper: 548,
    liquidity: 1000n,
    amount0Max: 7n,
    amount1Max: 9n,
    owner: DEAD,
  })
  const { actions, params } = unpack(unlockData)
  assert.equal(actions, '0x02121214')
  assert.equal(value, 7n)
  assert.deepEqual(decodeAbiParameters(sweepParams, params[3]), [zeroAddress, DEAD])
})

test('a native-keyed pool pays msg.value and sweeps the remainder back', () => {
  const { unlockData, value } = encodeV4Increase({
    key: NATIVE_POOL,
    tokenId: 42n,
    liquidity: 1000n,
    amount0Max: 7n,
    amount1Max: 9n,
    recipient: DEAD,
  })
  // the coin is not pulled, it rides along — and the manager settles out of its
  // own balance, so anything left over needs sweeping or it stays there
  assert.equal(value, 7n)
  const { actions, params } = unpack(unlockData)
  assert.equal(actions, '0x00121214')
  assert.deepEqual(decodeAbiParameters(sweepParams, params[3]), [zeroAddress, DEAD])
})

test('an ERC-20 pool sends no value and has nothing to sweep', () => {
  const { unlockData, value } = encodeV4Increase({
    key: ERC20_POOL,
    tokenId: 42n,
    liquidity: 1000n,
    amount0Max: 7n,
    amount1Max: 9n,
    recipient: DEAD,
  })
  assert.equal(value, 0n)
  assert.equal(unpack(unlockData).actions, '0x001212')
})

test('v4NativeSide names the coin side, and only for a pool that has one', () => {
  assert.equal(v4NativeSide(ERC20_POOL), null)
  assert.equal(v4NativeSide(NATIVE_POOL), 0)
})

test('generic zap identifies hooked v4 pools before any swap can run', () => {
  const base = { ...NATIVE_POOL, protocol: 'univ4' as const, hooks: zeroAddress }
  assert.equal(v4HasHooks(base), false)
  assert.equal(v4HasHooks({ ...base, hooks: DEAD }), true)
  assert.equal(v4HasHooks({ ...base, protocol: 'univ3' }), false)
})

test('a decrease bounds the principal and pays out fees in the same list', () => {
  const { unlockData, value } = encodeV4Decrease({
    key: ERC20_POOL,
    tokenId: 42n,
    liquidity: 500n,
    amount0Min: 11n,
    amount1Min: 13n,
  })
  // DECREASE_LIQUIDITY then close both — one transaction, where the v3 card
  // needs a decrease followed by a collect
  assert.equal(unpack(unlockData).actions, '0x011212')
  assert.equal(value, 0n, 'removing liquidity never sends value')
  const [tokenId, liquidity, min0, min1] = decodeAbiParameters(modifyParams, unpack(unlockData).params[0])
  assert.equal(tokenId, 42n)
  assert.equal(liquidity, 500n)
  assert.equal(min0, 11n)
  assert.equal(min1, 13n)
})

test('collect is a decrease of nothing', () => {
  const collect = encodeV4Collect({ key: ERC20_POOL, tokenId: 42n })
  const same = encodeV4Decrease({
    key: ERC20_POOL,
    tokenId: 42n,
    liquidity: 0n,
    amount0Min: 0n,
    amount1Min: 0n,
  })
  assert.deepEqual(collect, same)
  // the mins bound the PRINCIPAL, and there is none — a nonzero min here would
  // reject every collect
  const [, liquidity, min0, min1] = decodeAbiParameters(modifyParams, unpack(collect.unlockData).params[0])
  assert.equal(liquidity, 0n)
  assert.equal(min0, 0n)
  assert.equal(min1, 0n)
})

// ---------------- sizing ----------------

const Q96 = 1n << 96n
const SLIP = V4_DEPOSIT_BAND_BPS

test('a deposit never costs more than the amounts it was sized from', () => {
  const [lower, upper] = [-600, 600]
  const sqrtA = getSqrtRatioAtTick(lower)
  const sqrtB = getSqrtRatioAtTick(upper)
  const sqrtP = getSqrtRatioAtTick(0)
  const amount0 = 1000n * 10n ** 18n
  const amount1 = 1000n * 10n ** 18n
  const L = liquidityForAmountsWithSlippage(sqrtP, sqrtA, sqrtB, amount0, amount1, SLIP)
  assert.ok(L > 0n, 'an in-range deposit must be fundable')

  // walk the whole band the transaction may land in: this is the property the
  // maxes rely on, since they are set to the typed amounts verbatim
  for (let bps = -SLIP; bps <= SLIP; bps += 1) {
    const moved = (sqrtP * BigInt(Math.round(Math.sqrt(1 + bps / 10_000) * 1e9))) / 1_000_000_000n
    const cost = getAmountsForLiquidity(moved, sqrtA, sqrtB, L)
    assert.ok(cost.amount0 <= amount0, `token0 overspends at ${bps}bps: ${cost.amount0} > ${amount0}`)
    assert.ok(cost.amount1 <= amount1, `token1 overspends at ${bps}bps: ${cost.amount1} > ${amount1}`)
  }
})

test('the band costs liquidity, which is why the shipped one is narrow', () => {
  const sqrtA = getSqrtRatioAtTick(-600) // a ~6% wide range
  const sqrtB = getSqrtRatioAtTick(600)
  const sqrtP = getSqrtRatioAtTick(0)
  const a = 1000n * 10n ** 18n
  const pct = (x: bigint, of: bigint) => Number((x * 1000n) / of) / 10
  const atSpot = getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, a, a)
  const shipped = liquidityForAmountsWithSlippage(sqrtP, sqrtA, sqrtB, a, a, V4_DEPOSIT_BAND_BPS)
  const wide = liquidityForAmountsWithSlippage(sqrtP, sqrtA, sqrtB, a, a, 100)
  assert.ok(shipped < atSpot, 'covering a price move costs some liquidity')
  assert.ok(wide < shipped, 'covering a wider move costs more of it')
  // this is why the deposit band is its own constant rather than the tab's 1%
  // withdrawal tolerance: on this range 1% gives up ~15% of the deposit where
  // 25bps gives up ~4%, and the gap widens as the range narrows
  assert.ok(pct(shipped, atSpot) > 95, `shipped band too costly: kept ${pct(shipped, atSpot)}%`)
  assert.ok(pct(wide, atSpot) < 90, `a 1% band should visibly cost more: kept ${pct(wide, atSpot)}%`)
})

test('a narrower range gives up more of the deposit to the same band', () => {
  const a = 1000n * 10n ** 18n
  const kept = (halfWidthTicks: number) => {
    const sqrtA = getSqrtRatioAtTick(-halfWidthTicks)
    const sqrtB = getSqrtRatioAtTick(halfWidthTicks)
    const sqrtP = getSqrtRatioAtTick(0)
    const spot = getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, a, a)
    const band = liquidityForAmountsWithSlippage(sqrtP, sqrtA, sqrtB, a, a, V4_DEPOSIT_BAND_BPS)
    return Number((band * 1000n) / spot) / 10
  }
  // the cost is set by how much of the RANGE the band covers, so it climbs as
  // the range tightens — the table in V4_DEPOSIT_BAND_BPS is this curve
  assert.ok(kept(2000) > kept(600) && kept(600) > kept(200) && kept(200) > kept(50))
  assert.ok(kept(2000) > 98, `a wide range should barely notice: ${kept(2000)}%`)
  assert.ok(kept(50) > 50, `even a ±0.5% range keeps most of it: ${kept(50)}%`)
})

test('a one-sided top-up stays fundable when the band straddles the range edge', () => {
  // price a hair BELOW the range: the deposit is token0-only, and the panel
  // offers no token1 field at all
  const [lower, upper] = [100, 700]
  const sqrtA = getSqrtRatioAtTick(lower)
  const sqrtB = getSqrtRatioAtTick(upper)
  const sqrtP = getSqrtRatioAtTick(99)
  const amount0 = 1000n * 10n ** 18n

  // a band that ignored which side of the range the price is on would reach
  // above the lower tick, where token1 IS required — and with none offered it
  // sizes the whole deposit at zero, i.e. "nothing can be deposited" on exactly
  // the range-order top-up this is for
  const naiveHigh = (sqrtP * BigInt(Math.round(Math.sqrt(1 + SLIP / 10_000) * 1e9))) / 1_000_000_000n
  assert.ok(naiveHigh > sqrtA, 'this fixture must actually straddle the lower tick')
  assert.equal(getLiquidityForAmounts(naiveHigh, sqrtA, sqrtB, amount0, 0n), 0n)

  const L = liquidityForAmountsWithSlippage(sqrtP, sqrtA, sqrtB, amount0, 0n, SLIP)
  assert.ok(L > 0n, 'an out-of-range top-up must still be fundable')
  const cost = getAmountsForLiquidity(sqrtP, sqrtA, sqrtB, L)
  assert.equal(cost.amount1, 0n, 'below the range the deposit is token0 alone')
  assert.ok(cost.amount0 <= amount0)
  // it spends essentially all of what was offered, since price cannot make an
  // out-of-range deposit dearer while it stays out
  assert.ok(cost.amount0 * 10_000n > amount0 * 9_999n, `left too much on the table: ${cost.amount0}`)
})

test('a one-sided top-up above the range is token1 alone', () => {
  const sqrtA = getSqrtRatioAtTick(-700)
  const sqrtB = getSqrtRatioAtTick(-100)
  const sqrtP = getSqrtRatioAtTick(-99)
  const amount1 = 1000n * 10n ** 18n
  const L = liquidityForAmountsWithSlippage(sqrtP, sqrtA, sqrtB, 0n, amount1, SLIP)
  assert.ok(L > 0n)
  const cost = getAmountsForLiquidity(sqrtP, sqrtA, sqrtB, L)
  assert.equal(cost.amount0, 0n)
  assert.ok(cost.amount1 <= amount1)
  assert.ok(cost.amount1 * 10_000n > amount1 * 9_999n)
})

test('funding only the inactive side of an in-range position buys nothing', () => {
  // both tokens are required in range, so an empty side is a hard zero rather
  // than a deposit that quietly reaches for a token nobody offered
  const sqrtA = getSqrtRatioAtTick(-600)
  const sqrtB = getSqrtRatioAtTick(600)
  const sqrtP = getSqrtRatioAtTick(0)
  assert.equal(liquidityForAmountsWithSlippage(sqrtP, sqrtA, sqrtB, 1000n * 10n ** 18n, 0n, SLIP), 0n)
  assert.equal(liquidityForAmountsWithSlippage(sqrtP, sqrtA, sqrtB, 0n, 0n, SLIP), 0n)
  assert.equal(sqrtP, Q96, 'tick 0 is the Q96 anchor these fixtures assume')
})
