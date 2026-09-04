import { readContract, writeContract } from 'wagmi/actions'
import { parseAbi, zeroAddress, type Address, type Hex } from 'viem'
import { CHAIN } from '../config/chains'
import { CHAIN_ID } from '../config/addresses'
import { wagmiConfig } from '../config/wagmi'
import { t } from '../i18n'
import { ENV } from '../config/env'
import {
  MIN_TICK,
  MAX_TICK,
  getSqrtRatioAtTick,
  getAmountsForLiquidity,
  liquidityForAmountsWithSlippage,
  priceToTick,
  sqrtPriceToPrice,
  alignTick,
  fullRangeTicks,
} from './clmath'
import {
  UNI_V4,
  encodeV4Mint,
  v4PoolId,
  v4PositionManagerAbi,
  v4StateViewAbi,
  type V4PoolKey,
} from './uniV4'
import { ensureV4CurrencyApproval } from './uniV4Write'
import { activeAccountMatches, deadline, step, type StepFailWhy } from './tx'
import { txlog } from './txlog'

/**
 * Creating a brand-new Uniswap v4 pool, end to end.
 *
 * Every other write in this terminal adds liquidity to a pool that already
 * exists; this one runs one step earlier. A v4 pool is not deployed — it is
 * INITIALISED into the singleton under a key the caller makes up — so the flow
 * is: approvals (Permit2's two legs), then `PositionManager.initializePool`
 * with the starting price, then the ordinary mint through
 * `modifyLiquidities`. Between the price check and the signature the pool may
 * already exist (someone else raced us to it), in which case initialize is
 * skipped and the mint re-sizes against the LIVE price instead of the one we
 * meant to set.
 *
 * Robinhood Chain only (FEATURES.v4Create gates the tab): the token is always
 * currency1 and the chain's own coin is always currency0 — the zero address
 * sorts first, so a native pair has exactly one orientation.
 *
 * Everything pure lives at the top so tests can pin the math without mocks.
 */

// ---------------- pure: identity ----------------

/**
 * The key for a new native/token pool. Native is always currency0 (zero
 * address sorts first), hooks are always off — the tab offers no hook field,
 * and a hooked first pool would make every later probe of the rung blind.
 */
export function newPoolKey(token: Address, fee: number, tickSpacing: number): V4PoolKey {
  return { currency0: zeroAddress as Address, currency1: token, fee, tickSpacing, hooks: zeroAddress as Address }
}

// ---------------- pure: price <-> sqrtPriceX96 ----------------

export type InitialPrice = { sqrtPriceX96: bigint; tick: number }

/**
 * The starting price a NEW pool is initialised at, from "how many token per
 * 1 ETH" in human units. The pool stores raw units — the decimal gap shifts
 * the ratio — and the pool's price convention is token1 per token0, which for
 * a native pair is token per ETH.
 *
 * The tick alongside is informational: v4's initialize takes any sqrtPrice,
 * aligned or not. Out-of-range ticks are the caller's validation problem (the
 * UI disables the field), because throwing here on a pasted price reads worse.
 */
export function initialSqrtPriceX96(tokenPerEth: number, decToken: number): InitialPrice {
  if (!Number.isFinite(tokenPerEth) || tokenPerEth <= 0) {
    throw new Error('price must be a positive number')
  }
  const raw = tokenPerEth * Math.pow(10, decToken - 18)
  const sqrt = Math.sqrt(raw) * 2 ** 96
  if (!Number.isFinite(sqrt) || sqrt >= 2 ** 160) {
    throw new Error('price out of representable range')
  }
  return {
    sqrtPriceX96: BigInt(Math.round(sqrt)),
    tick: priceToTick(tokenPerEth, 18, decToken),
  }
}

/** the display inverse — "token per 1 ETH" a stored pool price means */
export function tokenPerEthOf(sqrtPriceX96: bigint, decToken: number): number {
  return sqrtPriceToPrice(sqrtPriceX96, 18, decToken)
}

/** the price window v4's own TickMath can represent */
export function priceTickInRange(tick: number): boolean {
  return tick >= MIN_TICK && tick <= MAX_TICK
}

// ---------------- pure: range ----------------

export type RangeSpec =
  | { mode: 'full' }
  | { mode: 'band'; priceMin: number; priceMax: number }

/**
 * The position's ticks from the user's range setting, aligned to the pool's
 * spacing the way every CL position here is: lower floor, upper ceil, so the
 * typed prices are always INSIDE the position.
 */
export function rangeTicks(spec: RangeSpec, spacing: number, decToken: number): { lower: number; upper: number } {
  if (spec.mode === 'full') return fullRangeTicks(spacing)
  const lower = alignTick(priceToTick(spec.priceMin, 18, decToken), spacing, 'floor')
  const upper = alignTick(priceToTick(spec.priceMax, 18, decToken), spacing, 'ceil')
  if (lower >= upper) throw new Error('range: min must sit below max')
  return { lower, upper }
}

// ---------------- pure: picking a price source ----------------

/**
 * One venue's answer. `pricePerToken` is in the QUOTE's units — "quote per
 * token" — because that is what each venue natively reports; converting to
 * ETH happens at pick time, where the quote is known.
 */
export type PriceCandidate = { pricePerToken: number; liquidity: number; source: string }

/** deepest candidate wins; a pool with no liquidity read prices nothing */
export function pickPriceSource(cands: PriceCandidate[]): PriceCandidate | null {
  let best: PriceCandidate | null = null
  for (const c of cands) {
    if (!Number.isFinite(c.pricePerToken) || c.pricePerToken <= 0) continue
    if (!Number.isFinite(c.liquidity) || c.liquidity <= 0) continue
    if (!best || c.liquidity > best.liquidity) best = c
  }
  return best
}

// ---------------- reads ----------------

export type PoolInitState = { initialized: boolean; sqrtPriceX96: bigint; tick: number }

/**
 * Whether the pool already exists. An uninitialized v4 pool reads back zeros
 * rather than reverting — slot0 of an empty mapping entry is zero — but the
 * catch keeps a lens-level failure from turning into a double-initialize.
 */
export async function v4PoolState(poolId: Hex): Promise<PoolInitState> {
  if (!UNI_V4) return { initialized: false, sqrtPriceX96: 0n, tick: 0 }
  try {
    const s0 = await readContract(wagmiConfig, {
      abi: v4StateViewAbi,
      address: UNI_V4.STATE_VIEW,
      functionName: 'getSlot0',
      args: [poolId],
      chainId: CHAIN_ID,
    })
    return { initialized: s0[0] > 0n, sqrtPriceX96: s0[0], tick: Number(s0[1]) }
  } catch {
    return { initialized: false, sqrtPriceX96: 0n, tick: 0 }
  }
}

// ---------------- the on-chain price probe ----------------

export type EthPriceProbe = { ethPerToken: number; source: string }

type QuoteVenue = { address: Address; decimals: number; kind: 'native' | 'stable' }

/**
 * Where a starting price can come from, in priority order:
 *
 *   1. pools quoted in the wrapped coin — the pool's own units ARE the answer
 *   2. pools quoted in the stable — converted through the coin's stable price
 *   3. dexscreener — priceNative is a pair price in the chain's coin, the
 *      same trade-derived mark the rest of the terminal prices with
 *
 * Everything here is a READ — a token with no market at all simply returns
 * null, and the price field stays blank for the user to type into.
 */
export async function probeTokenEthPrice(token: Address, decToken: number): Promise<EthPriceProbe | null> {
  const wn = CHAIN.addr.WNATIVE
  const usdg = CHAIN.addr.STABLE
  const nativeQuote: QuoteVenue = { address: wn, decimals: 18, kind: 'native' }
  const stableQuote: QuoteVenue = { address: usdg, decimals: CHAIN.stable.decimals, kind: 'stable' }

  const nativeCands = await probeVenuesAgainstQuote(token, decToken, nativeQuote)
  const bestNative = pickPriceSource(nativeCands)
  if (bestNative) return { ethPerToken: bestNative.pricePerToken, source: bestNative.source }

  // stable-quoted pools can still seed the field, converted through the
  // coin's own stable price — read from the same venues, dexscreener last
  const stableCands = await probeVenuesAgainstQuote(token, decToken, stableQuote)
  const bestStable = pickPriceSource(stableCands)
  if (bestStable) {
    const coinPrice = await probeCoinStablePrice()
    if (coinPrice && coinPrice > 0) {
      return {
        ethPerToken: bestStable.pricePerToken / coinPrice,
        source: `${bestStable.source} ÷ ${CHAIN.stable.symbol}`,
      }
    }
  }

  return await probeDexscreener(token, wn)
}

/** every venue module this terminal has, asked for (token, quote) pools */
async function probeVenuesAgainstQuote(
  token: Address,
  decToken: number,
  q: QuoteVenue,
): Promise<PriceCandidate[]> {
  const cands: PriceCandidate[] = []

  // v4: probe the hookless rungs through the lens — the same discovery the
  // pools tab uses, pointed at one pair
  if (UNI_V4) {
    for (const { fee, tickSpacing } of UNI_V4.rungs) {
      const tokenFirst = token.toLowerCase() < q.address.toLowerCase()
      const key: V4PoolKey = {
        currency0: tokenFirst ? token : q.address,
        currency1: tokenFirst ? q.address : token,
        fee,
        tickSpacing,
        hooks: zeroAddress as Address,
      }
      const id = v4PoolId(key)
      try {
        const s0 = await readContract(wagmiConfig, {
          abi: v4StateViewAbi,
          address: UNI_V4.STATE_VIEW,
          functionName: 'getSlot0',
          args: [id],
          chainId: CHAIN_ID,
        })
        const liq = await readContract(wagmiConfig, {
          abi: v4StateViewAbi,
          address: UNI_V4.STATE_VIEW,
          functionName: 'getLiquidity',
          args: [id],
          chainId: CHAIN_ID,
        })
        if (s0[0] === 0n) continue
        // the stored price is currency1 per currency0, human units; orient it
        const p = sqrtPriceToPrice(s0[0], tokenFirst ? decToken : q.decimals, tokenFirst ? q.decimals : decToken)
        const price = tokenFirst ? 1 / p : p
        cands.push({
          pricePerToken: price,
          liquidity: Number(liq),
          source: `v4 ${fee / 10000}%/${tickSpacing}`,
        })
      } catch {
        /* rung not present — the next one answers */
      }
    }
  }

  // Uniswap v3: factory.getPool is the same probe by another name
  const uni = CHAIN.uni
  if (uni) {
    for (const fee of CHAIN.uniV3Fees) {
      try {
        const pool = await readContract(wagmiConfig, {
          abi: v3PoolAbi,
          address: uni.V3_FACTORY,
          functionName: 'getPool',
          args: [token, q.address, fee],
          chainId: CHAIN_ID,
        })
        if (pool === zeroAddress) continue
        const s0 = await readContract(wagmiConfig, {
          abi: v3Slot0Abi,
          address: pool,
          functionName: 'slot0',
          chainId: CHAIN_ID,
        })
        const liq = await readContract(wagmiConfig, {
          abi: v3LiquidityAbi,
          address: pool,
          functionName: 'liquidity',
          chainId: CHAIN_ID,
        })
        const tokenFirst = token.toLowerCase() < q.address.toLowerCase()
        const p = sqrtPriceToPrice(s0[0], tokenFirst ? decToken : q.decimals, tokenFirst ? q.decimals : decToken)
        cands.push({
          pricePerToken: tokenFirst ? 1 / p : p,
          liquidity: Number(liq),
          source: `v3 ${fee / 10000}%`,
        })
      } catch {
        /* fee tier absent */
      }
    }

    // v2: reserves quote directly — constant product needs no sqrt
    try {
      const pair = await readContract(wagmiConfig, {
        abi: v2FactoryAbi,
        address: uni.V2_FACTORY,
        functionName: 'getPair',
        args: [token, q.address],
        chainId: CHAIN_ID,
      })
      if (pair !== zeroAddress) {
        const reserves = await readContract(wagmiConfig, {
          abi: v2ReservesAbi,
          address: pair,
          functionName: 'getReserves',
          chainId: CHAIN_ID,
        })
        const token0 = await readContract(wagmiConfig, {
          abi: v2Token0Abi,
          address: pair,
          functionName: 'token0',
          chainId: CHAIN_ID,
        })
        const tokenIs0 = token0.toLowerCase() === token.toLowerCase()
        const raw = tokenIs0 ? Number(reserves[1]) / Number(reserves[0]) : Number(reserves[0]) / Number(reserves[1])
        cands.push({
          // raw reserve ratio is in 10^-decToken : 10^-decQuote units
          pricePerToken: raw * Math.pow(10, decToken - q.decimals),
          liquidity: Number(tokenIs0 ? reserves[1] : reserves[0]),
          source: 'v2',
        })
      }
    } catch {
      /* no pair */
    }
  }

  return cands
}

/** the coin's stable price, from the deepest (WETH, stable) venue */
async function probeCoinStablePrice(): Promise<number | null> {
  const wn = CHAIN.addr.WNATIVE
  const usdg = CHAIN.addr.STABLE
  // v2 first — two calls
  const uni = CHAIN.uni
  if (uni) {
    try {
      const pair = await readContract(wagmiConfig, {
        abi: v2FactoryAbi,
        address: uni.V2_FACTORY,
        functionName: 'getPair',
        args: [wn, usdg],
        chainId: CHAIN_ID,
      })
      if (pair !== zeroAddress) {
        const reserves = await readContract(wagmiConfig, {
          abi: v2ReservesAbi,
          address: pair,
          functionName: 'getReserves',
          chainId: CHAIN_ID,
        })
        const token0 = await readContract(wagmiConfig, {
          abi: v2Token0Abi,
          address: pair,
          functionName: 'token0',
          chainId: CHAIN_ID,
        })
        const wethIs0 = token0.toLowerCase() === wn.toLowerCase()
        const raw = wethIs0 ? Number(reserves[1]) / Number(reserves[0]) : Number(reserves[0]) / Number(reserves[1])
        // stable per WETH, both 18 decimals on this chain — but the stable's
        // own decimals still shift the ratio (USDG: 6)
        return raw * Math.pow(10, 18 - CHAIN.stable.decimals)
      }
    } catch {
      /* no pair */
    }
  }
  if (UNI_V4) {
    for (const { fee, tickSpacing } of UNI_V4.rungs) {
      const wethFirst = wn.toLowerCase() < usdg.toLowerCase()
      const key: V4PoolKey = {
        currency0: wethFirst ? wn : usdg,
        currency1: wethFirst ? usdg : wn,
        fee,
        tickSpacing,
        hooks: zeroAddress as Address,
      }
      try {
        const s0 = await readContract(wagmiConfig, {
          abi: v4StateViewAbi,
          address: UNI_V4.STATE_VIEW,
          functionName: 'getSlot0',
          args: [v4PoolId(key)],
          chainId: CHAIN_ID,
        })
        if (s0[0] === 0n) continue
        const p = sqrtPriceToPrice(s0[0], wethFirst ? CHAIN.stable.decimals : 18, wethFirst ? 18 : CHAIN.stable.decimals)
        if (Number.isFinite(p) && p > 0) return wethFirst ? p : 1 / p
      } catch {
        /* next rung */
      }
    }
  }
  return null
}

const v3PoolAbi = parseAbi(['function getPool(address, address, uint24) view returns (address)'])
const v3Slot0Abi = parseAbi(['function slot0() view returns (uint160 sqrtPriceX96, int24 tick)'])
const v3LiquidityAbi = parseAbi(['function liquidity() view returns (uint128)'])
const v2FactoryAbi = parseAbi(['function getPair(address, address) view returns (address)'])
const v2ReservesAbi = parseAbi(['function getReserves() view returns (uint112, uint112, uint32)'])
const v2Token0Abi = parseAbi(['function token0() view returns (address)'])

const DS_ROOT = ENV.proxied ? '/dexscreener' : 'https://api.dexscreener.com'

type DsPairRow = {
  chainId?: string
  priceNative?: string
  priceUsd?: string
  liquidity?: { usd?: number }
  baseToken?: { address?: string }
}

/** dexscreener catch-all: priceNative is the pair price in the chain's coin */
async function probeDexscreener(token: Address, wn: Address): Promise<EthPriceProbe | null> {
  try {
    const r = await fetch(`${DS_ROOT}/latest/dex/tokens/${token},${wn}`)
    if (!r.ok) return null
    const j = (await r.json()) as { pairs?: DsPairRow[] }
    const pairs = (j.pairs ?? []).filter((p) => p.chainId === CHAIN.slugs.dexscreener)
    let best: { liq: number; native: number } | null = null
    let wethUsd = NaN
    let tokenUsd = NaN
    for (const p of pairs) {
      const liq = Number(p.liquidity?.usd)
      if (!Number.isFinite(liq) || liq <= 0) continue
      const base = p.baseToken?.address?.toLowerCase()
      if (base === wn.toLowerCase()) {
        const pu = Number(p.priceUsd)
        if (Number.isFinite(pu) && pu > 0 && (!Number.isFinite(wethUsd) || liq > 0)) wethUsd = pu
        continue
      }
      const pu = Number(p.priceUsd)
      if (base === token.toLowerCase() && Number.isFinite(pu) && pu > 0 && (!Number.isFinite(tokenUsd) || liq > 0)) {
        tokenUsd = pu
      }
      const pn = Number(p.priceNative)
      if (base === token.toLowerCase() && Number.isFinite(pn) && pn > 0 && (!best || liq > best.liq)) {
        best = { liq, native: pn }
      }
    }
    if (best) return { ethPerToken: best.native, source: 'dexscreener' }
    if (Number.isFinite(tokenUsd) && tokenUsd > 0 && Number.isFinite(wethUsd) && wethUsd > 0) {
      return { ethPerToken: tokenUsd / wethUsd, source: 'dexscreener (USD)' }
    }
    return null
  } catch {
    return null
  }
}

// ---------------- writes ----------------

const v4PmInitAbi = parseAbi([
  'function initializePool((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint160 sqrtPriceX96, bytes hookData) payable returns (int24 tick)',
])

const MAX_UINT128 = (1n << 128n) - 1n

export type CreateStep = 'approve' | 'initialize' | 'mint'

/**
 * Create the pool and seed its first position, in at most three
 * transactions: Permit2's two approval legs, initialize, mint.
 *
 * `amount0Max`/`amount1Max` are the typed amounts AND the hard ceilings —
 * whatever the position does not need is swept back to the wallet by the same
 * action list. Liquidity is sized at signing time against the price the pool
 * will actually trade at: the freshly-set price when this flow initialized
 * it, the live one when it already existed, expanded by the user's slippage
 * band so a move in flight cannot pull more than was offered.
 */
export async function createV4Pool(args: {
  user: Address
  key: V4PoolKey
  preState: PoolInitState
  initPrice: InitialPrice
  tickLower: number
  tickUpper: number
  amount0Max: bigint
  amount1Max: bigint
  slipBps: number
  tokenSymbol: string
  onStep?: (s: CreateStep) => void
  onFail?: (why: StepFailWhy) => void
}): Promise<boolean> {
  const { user, key } = args
  if (!UNI_V4) {
    txlog.push('err', t('v4create.errNoV4'))
    return false
  }
  if (!activeAccountMatches(user)) {
    txlog.push('err', t('tx.accountChanged'))
    return false
  }

  // 1. the ERC-20 side rides Permit2; native needs nothing (msg.value)
  args.onStep?.('approve')
  if (!(await ensureV4CurrencyApproval(key.currency1, user, args.amount1Max, args.tokenSymbol))) return false
  if (!activeAccountMatches(user)) {
    txlog.push('err', t('tx.accountChanged'))
    return false
  }

  // 2. initialize — skipped when the pool beat us here. A lost race reverts
  //    with PoolAlreadyInitialized; that is the flow working, not failing, so
  //    the state is re-read and the mint proceeds at the price that won.
  let state = args.preState
  if (!state.initialized) {
    args.onStep?.('initialize')
    const rcpt = await step(
      t('v4create.stInit'),
      () =>
        writeContract(wagmiConfig, {
          account: user,
          abi: v4PmInitAbi,
          address: UNI_V4!.POSITION_MANAGER,
          functionName: 'initializePool',
          args: [key, args.initPrice.sqrtPriceX96, '0x'],
          chainId: CHAIN_ID,
        }),
      { onFail: args.onFail },
    )
    state = await v4PoolState(v4PoolId(key))
    if (!rcpt && !state.initialized) return false
  }

  // 3. size the position at the price that will greet the mint, then mint
  args.onStep?.('mint')
  const sqrtP = state.sqrtPriceX96 > 0n ? state.sqrtPriceX96 : args.initPrice.sqrtPriceX96
  const sqrtA = getSqrtRatioAtTick(args.tickLower)
  const sqrtB = getSqrtRatioAtTick(args.tickUpper)
  const liquidity = liquidityForAmountsWithSlippage(sqrtP, sqrtA, sqrtB, args.amount0Max, args.amount1Max, args.slipBps)
  if (liquidity === 0n) {
    txlog.push('err', t('v4create.errTooSmall'))
    return false
  }
  const call = encodeV4Mint({
    key,
    tickLower: args.tickLower,
    tickUpper: args.tickUpper,
    liquidity,
    amount0Max: args.amount0Max > MAX_UINT128 ? MAX_UINT128 : args.amount0Max,
    amount1Max: args.amount1Max > MAX_UINT128 ? MAX_UINT128 : args.amount1Max,
    owner: user,
  })
  const label = state.initialized && args.preState.initialized
    ? t('v4create.stMintExisting')
    : t('v4create.stMintNew')
  const rcpt = await step(
    label,
    () =>
      writeContract(wagmiConfig, {
        account: user,
        abi: v4PositionManagerAbi,
        address: UNI_V4!.POSITION_MANAGER,
        functionName: 'modifyLiquidities',
        args: [call.unlockData, deadline()],
        value: call.value,
        chainId: CHAIN_ID,
      }),
    { onFail: args.onFail, invalidate: 'liquidity' },
  )
  if (rcpt) {
    txlog.push('ok', t('v4create.done', { id: v4PoolId(key).slice(0, 10) }))
  }
  return !!rcpt
}

/**
 * What the position will consume AT the price the pool opens on — the preview
 * pair for the summary row. The signed transaction may take a little more of
 * one side (the slippage band) and always returns what it does not need.
 */
export function previewAtInitPrice(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  amount0Max: bigint,
  amount1Max: bigint,
  slipBps: number,
): { liquidity: bigint; amount0: bigint; amount1: bigint } {
  const sqrtA = getSqrtRatioAtTick(tickLower)
  const sqrtB = getSqrtRatioAtTick(tickUpper)
  const liquidity = liquidityForAmountsWithSlippage(sqrtPriceX96, sqrtA, sqrtB, amount0Max, amount1Max, slipBps)
  const { amount0, amount1 } = getAmountsForLiquidity(sqrtPriceX96, sqrtA, sqrtB, liquidity)
  return { liquidity, amount0, amount1 }
}
