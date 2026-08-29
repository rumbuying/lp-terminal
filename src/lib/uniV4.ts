import {
  encodeAbiParameters,
  encodePacked,
  keccak256,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { CHAIN } from '../config/chains'
import { NATIVE } from '../config/addresses'
import { getSqrtRatioAtTick, liquidityForAmountsWithSlippage } from './clmath'
import type { ClPool } from '../types'

/**
 * Uniswap v4 on this chain, or null where none is deployed.
 *
 * v4 is the first venue here with no factory and no pool contract: one
 * singleton holds every pool, and a pool is named by the hash of its key
 * rather than by an address. Everything below exists to make that identity
 * computable off-chain, which is what lets discovery stay a probe — the same
 * shape as `factory.getPool`, with `StateView.getSlot0` answering instead.
 */
export const UNI_V4 = CHAIN.uniV4
export const HAS_UNI_V4 = UNI_V4 !== null

/** the (fee, tickSpacing) rungs discovery probes; empty where there is no v4 */
export const UNI_V4_RUNGS: readonly { fee: number; tickSpacing: number }[] = UNI_V4?.rungs ?? []

/** PoolKey fee sentinel used when a hook supplies a dynamic LP fee. */
export const V4_DYNAMIC_FEE_FLAG = 0x800000

/** Generic liquidity actions send empty hookData; hooked pools need caution. */
export function v4HasHooks(pool: Pick<ClPool, 'protocol' | 'hooks'>): boolean {
  return pool.protocol === 'univ4' && !!pool.hooks && pool.hooks.toLowerCase() !== zeroAddress
}

/**
 * A currency, in v4's terms.
 *
 * v4 pools the chain's coin DIRECTLY as `address(0)` rather than through its
 * wrapper, and a native-keyed pool is a DIFFERENT pool from its wrapped twin —
 * on BSC the native BNB/USDT 0.05% pool carries roughly twelve times the
 * liquidity of the WBNB one. So the usual `erc20Of` normalisation, which folds
 * the native sentinel onto WNATIVE, must NOT be applied here: it would quietly
 * address the shallow pool. Selling the native coin reaches native-keyed pools;
 * selling the wrapper reaches wrapped ones.
 */
export function v4Currency(token: Address): Address {
  return token.toLowerCase() === NATIVE.toLowerCase() ? (zeroAddress as Address) : token
}

export type V4PoolKey = {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}

/** currencies sorted as v4 requires — numerically, with native (0) sorting first */
export function v4SortCurrencies(a: Address, b: Address): readonly [Address, Address] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]
}

/**
 * Hookless only. A hook is part of the pool key and is a free 160-bit field, so
 * hooked pools cannot be enumerated by probing — reaching them would need an
 * external pool index. On BSC the canonical hookless rungs are where the
 * liquidity actually sits, so the probe finds the pools that matter.
 */
export function v4PoolKey(a: Address, b: Address, fee: number, tickSpacing: number): V4PoolKey {
  const [currency0, currency1] = v4SortCurrencies(a, b)
  return { currency0, currency1, fee, tickSpacing, hooks: zeroAddress as Address }
}

/** `keccak256(abi.encode(poolKey))` — v4's PoolId, computed without an RPC */
export function v4PoolId(key: V4PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'uint24' },
        { type: 'int24' },
        { type: 'address' },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  )
}

/** true when the swap runs currency0 -> currency1 through this pool */
export function v4ZeroForOne(key: V4PoolKey, currencyIn: Address): boolean {
  return key.currency0.toLowerCase() === currencyIn.toLowerCase()
}

/**
 * A position's range, unpacked from the single word the PositionManager returns
 * beside its pool key.
 *
 * PositionInfo packs, from the high bits down:
 *   200 bits truncated poolId | 24 tickUpper | 24 tickLower | 8 hasSubscriber
 *
 * The ticks are int24 in two's complement, so the sign has to be restored by
 * hand — a range like [-46899, -46896] reads as ~16.7 million without it, which
 * would place every position on the wrong side of the price.
 */
export type V4PositionRange = {
  tickLower: number
  tickUpper: number
  hasSubscriber: boolean
  /** the top 200 bits of the pool id, for cross-checking the derived one */
  poolIdPrefix: Hex
}

export function decodeV4PositionInfo(info: bigint): V4PositionRange {
  const int24 = (v: bigint) => Number(v >= 1n << 23n ? v - (1n << 24n) : v)
  return {
    hasSubscriber: (info & 0xffn) !== 0n,
    tickLower: int24((info >> 8n) & 0xffffffn),
    tickUpper: int24((info >> 32n) & 0xffffffn),
    poolIdPrefix: `0x${(info >> 56n).toString(16).padStart(50, '0')}` as Hex,
  }
}

/**
 * Does the pool key the PositionManager reported really hash to the pool the
 * position is recorded against?
 *
 * The stored id is TRUNCATED to 200 bits, so this compares prefixes — 25 bytes
 * is far past any accidental collision, and a mismatch means the key was
 * decoded wrong rather than that the position moved.
 */
export function v4PoolIdMatches(key: V4PoolKey, prefix: Hex): boolean {
  // 2 for '0x' + 50 nibbles = the same 25 bytes the position stores
  return v4PoolId(key).slice(0, 52).toLowerCase() === prefix.slice(0, 52).toLowerCase()
}

/**
 * The key the singleton files a position under: `keccak256(owner, tickLower,
 * tickUpper, salt)`, PACKED rather than abi-encoded.
 *
 * The owner is the PositionManager, not the wallet — every v4 position through
 * it is the PM's as far as the pool is concerned, and the token id rides in as
 * the salt. Getting that backwards reads a position that does not exist and
 * reports zero fees on everything.
 */
export function v4PositionKey(
  positionManager: Address,
  tickLower: number,
  tickUpper: number,
  tokenId: bigint,
): Hex {
  return keccak256(
    encodePacked(
      ['address', 'int24', 'int24', 'bytes32'],
      [positionManager, tickLower, tickUpper, `0x${tokenId.toString(16).padStart(64, '0')}` as Hex],
    ),
  )
}

/**
 * Uncollected fees for a position, which v4 makes you derive.
 *
 * A v3 NPM carries `tokensOwed` and can simulate `collect`; the v4
 * PositionManager offers neither, so this is the canonical identity instead:
 * fee growth per unit of liquidity across the range, minus the snapshot taken
 * when the position was last touched, times the liquidity.
 *
 * The subtraction WRAPS on purpose. Fee growth accumulators are unsigned and
 * allowed to overflow; the difference is still correct modulo 2^256, and doing
 * it in checked arithmetic would throw on a pool that has simply been busy.
 */
export function v4FeesOwed(
  liquidity: bigint,
  feeGrowthInside0X128: bigint,
  feeGrowthInside1X128: bigint,
  feeGrowthInside0LastX128: bigint,
  feeGrowthInside1LastX128: bigint,
): { fees0: bigint; fees1: bigint } {
  const TWO_256 = 1n << 256n
  const delta = (now: bigint, last: bigint) => (now - last + TWO_256) % TWO_256
  return {
    fees0: (liquidity * delta(feeGrowthInside0X128, feeGrowthInside0LastX128)) >> 128n,
    fees1: (liquidity * delta(feeGrowthInside1X128, feeGrowthInside1LastX128)) >> 128n,
  }
}

export const v4StateViewAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
  'function poolManager() view returns (address)',
  // v4 exposes no `tokensOwed` the way a v3 NPM does, so uncollected fees are
  // derived: the pool's fee growth across the range now, minus the snapshot
  // taken when the position was last touched.
  'function getPositionInfo(bytes32 poolId, bytes32 positionId) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)',
  'function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)',
  // the liquidity distribution, keyed by pool id rather than by pool address —
  // a v4 pool has no contract of its own to ask
  'function getTickLiquidity(bytes32 poolId, int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet)',
  'function getTickBitmap(bytes32 poolId, int16 wordPos) view returns (uint256)',
])

/**
 * The v4 PositionManager.
 *
 * `getPoolAndPositionInfo` hands back the whole pool key, which is what makes
 * discovery work at all — a v4 position names its own pool, so nothing has to
 * guess a (fee, tickSpacing) rung. That matters more than it sounds: live BSC
 * positions sit on rungs like 599900/11998 and 131100/2622, because v4 leaves
 * fee a free field rather than a ladder.
 *
 * There is one write entrypoint for every liquidity op. Where a v3 NPM offers
 * `increaseLiquidity` / `decreaseLiquidity` / `collect`, v4 offers
 * `modifyLiquidities`, which takes an encoded action list — see
 * `encodeV4Increase` below for what goes in it. `permit2` is the contract this
 * manager pulls ERC-20 through, exposed so a config can be checked against it
 * rather than trusted.
 */
export const v4PositionManagerAbi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)',
  'function poolManager() view returns (address)',
  'function permit2() view returns (address)',
  'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
])

// ---------------- liquidity actions ----------------

/** Actions.sol, as the action list encodes them: one byte each, concatenated,
 *  with one `params` entry apiece. */
const ACTION_INCREASE_LIQUIDITY = '00'
const ACTION_DECREASE_LIQUIDITY = '01'
const ACTION_MINT_POSITION = '02'
/**
 * Settles a debt or takes a credit, whichever way the delta points — and that
 * is why it is used here in place of the SETTLE_PAIR / TAKE_PAIR shorthand the
 * v4 docs lead with.
 *
 * Every v4 liquidity change credits the position's accrued fees into the SAME
 * delta as the principal. On an out-of-range position the inactive side owes
 * nothing and has fees, so its delta comes out positive — and SETTLE_PAIR, which
 * can only pay, reverts with `DeltaNotNegative` (0x3351b260). Measured on BSC
 * 2026-08-02 against five live out-of-range positions: SETTLE_PAIR reverted on
 * all five, CLOSE_CURRENCY simulated clean on all five.
 *
 * It also fixes where the money goes without a parameter: `_close` pays or
 * credits the caller, so the proceeds always reach the signer.
 */
const ACTION_CLOSE_CURRENCY = '12'
/**
 * Returns whatever part of `msg.value` the deposit did not need. The manager
 * settles the native coin out of its own balance, so without this the excess
 * simply stays there for whoever sweeps next.
 */
const ACTION_SWEEP = '14'

const v4ModifyParams = parseAbiParameters(
  'uint256 tokenId, uint256 liquidity, uint128 amount0, uint128 amount1, bytes hookData',
)
const v4MintParams = parseAbiParameters(
  '(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, int24 tickLower, int24 tickUpper, uint256 liquidity, uint128 amount0Max, uint128 amount1Max, address owner, bytes hookData',
)
const v4CurrencyParam = parseAbiParameters('address currency')
const v4SweepParams = parseAbiParameters('address currency, address recipient')

/**
 * How every v4 payload is wrapped, for the router and the PositionManager
 * alike: the action bytes, then one params blob per action.
 */
const v4Payload = parseAbiParameters('bytes actions, bytes[] params')

function encodeActionList(actions: string[], params: Hex[]): Hex {
  return encodeAbiParameters(v4Payload, [`0x${actions.join('')}` as Hex, params])
}

/** what `modifyLiquidities` is called with: the encoded action list, and the
 *  native coin that has to ride along with it */
export type V4LiquidityCall = { unlockData: Hex; value: bigint }

/**
 * v4 keys the chain's own coin as `address(0)`, and pools it directly rather
 * than through its wrapper — so a deposit into such a pool is paid in real BNB
 * via `msg.value`, not pulled as an ERC-20. Sorting puts the zero address
 * first, so it can only ever be currency0.
 */
export function v4NativeSide(key: V4PoolKey): 0 | 1 | null {
  if (key.currency0 === zeroAddress) return 0
  if (key.currency1 === zeroAddress) return 1 // unreachable for a sorted key
  return null
}

/**
 * The price move a deposit is sized to survive.
 *
 * Deliberately much tighter than the 1% the tab uses for withdrawal minimums,
 * because it covers a different thing: the drift between signing and mining,
 * seconds on this chain, rather than a tolerance for how far a payout may miss.
 *
 * It is also a real cost, which is why it is kept small. v4 fixes the liquidity
 * in the payload, where a v3 NPM re-derives it at execution and can quietly
 * deposit less — so a deposit that both always lands AND never spends more than
 * was typed has to be sized for the worst price in the band. What that gives up,
 * measured, as the share of the spot-sized deposit that survives:
 *
 *              ±0.5% range   ±2%    ±6%    ±22%
 *     10 bps       83%       95%    98%     99%
 *     25 bps       67%       89%    96%     99%
 *    100 bps       50%       66%    85%     95%
 *
 * The leftover stays in the wallet and can be added again at the new price, and
 * the panel shows exactly what will be taken before anything is signed. The
 * narrow-range column is the reason this is not simply the tab's 1% — and it
 * bites less than it reads, because a position already out of range collapses
 * the band to a point and gives up nothing at all.
 */
export const V4_DEPOSIT_BAND_BPS = 25

/**
 * Add liquidity to an existing position.
 *
 * `liquidity` is chosen off-chain — v4 does not derive it from the amounts the
 * way a v3 NPM does — and `amount0Max`/`amount1Max` are the ceiling on what may
 * be pulled for it. Pass the amounts the user actually typed as the maxes and
 * size the liquidity to fit them across the whole slippage band
 * (`liquidityForAmountsWithSlippage`); the maxes are then both the spend limit
 * and the slippage guard, and the deposit cannot cost more than was offered.
 *
 * The accrued fees are credited into the same settlement, so they go toward the
 * deposit and anything left over is paid back out — there is no way to increase
 * and leave fees uncollected, as v3 does.
 */
function encodeV4Deposit(args: {
  key: V4PoolKey
  action: string
  actionParams: Hex
  amount0Max: bigint
  amount1Max: bigint
  recipient: Address
}): V4LiquidityCall {
  const actions = [args.action, ACTION_CLOSE_CURRENCY, ACTION_CLOSE_CURRENCY]
  const params: Hex[] = [
    args.actionParams,
    encodeAbiParameters(v4CurrencyParam, [args.key.currency0]),
    encodeAbiParameters(v4CurrencyParam, [args.key.currency1]),
  ]
  const native = v4NativeSide(args.key)
  if (native === null) return { unlockData: encodeActionList(actions, params), value: 0n }
  actions.push(ACTION_SWEEP)
  params.push(encodeAbiParameters(v4SweepParams, [zeroAddress as Address, args.recipient]))
  return {
    unlockData: encodeActionList(actions, params),
    value: native === 0 ? args.amount0Max : args.amount1Max,
  }
}

export function encodeV4Increase(args: {
  key: V4PoolKey
  tokenId: bigint
  liquidity: bigint
  amount0Max: bigint
  amount1Max: bigint
  /** where unspent native goes; only read for a native-keyed pool */
  recipient: Address
}): V4LiquidityCall {
  return encodeV4Deposit({
    ...args,
    action: ACTION_INCREASE_LIQUIDITY,
    actionParams: encodeAbiParameters(v4ModifyParams, [
      args.tokenId,
      args.liquidity,
      args.amount0Max,
      args.amount1Max,
      '0x',
    ]),
  })
}

/** Mint a new PositionManager NFT into an already-initialised v4 pool. */
export function encodeV4Mint(args: {
  key: V4PoolKey
  tickLower: number
  tickUpper: number
  liquidity: bigint
  amount0Max: bigint
  amount1Max: bigint
  owner: Address
}): V4LiquidityCall {
  return encodeV4Deposit({
    key: args.key,
    action: ACTION_MINT_POSITION,
    actionParams: encodeAbiParameters(v4MintParams, [
      args.key,
      args.tickLower,
      args.tickUpper,
      args.liquidity,
      args.amount0Max,
      args.amount1Max,
      args.owner,
      '0x',
    ]),
    amount0Max: args.amount0Max,
    amount1Max: args.amount1Max,
    recipient: args.owner,
  })
}

/**
 * Remove liquidity from a position.
 *
 * One transaction where the v3 card needs two: the same action list that burns
 * the liquidity also pays out the principal AND the fees, so there is no
 * separate `collect` to follow it with.
 *
 * The mins bound the PRINCIPAL alone — v4 checks them against
 * `liquidityDelta - feesAccrued` — which is what makes
 * `minAmountsForLiquidity` the right source for them.
 */
export function encodeV4Decrease(args: {
  key: V4PoolKey
  tokenId: bigint
  liquidity: bigint
  amount0Min: bigint
  amount1Min: bigint
}): V4LiquidityCall {
  return {
    unlockData: encodeActionList(
      [ACTION_DECREASE_LIQUIDITY, ACTION_CLOSE_CURRENCY, ACTION_CLOSE_CURRENCY],
      [
        encodeAbiParameters(v4ModifyParams, [
          args.tokenId,
          args.liquidity,
          args.amount0Min,
          args.amount1Min,
          '0x',
        ]),
        encodeAbiParameters(v4CurrencyParam, [args.key.currency0]),
        encodeAbiParameters(v4CurrencyParam, [args.key.currency1]),
      ],
    ),
    value: 0n,
  }
}

/**
 * Collect fees and nothing else: a decrease of zero liquidity.
 *
 * v4 has no `collect`. Touching a position settles whatever it has accrued, so
 * removing none of it leaves the fees as the entire delta. The mins are zero
 * because they bound the principal, and the principal here is zero by
 * construction.
 */
export function encodeV4Collect(args: { key: V4PoolKey; tokenId: bigint }): V4LiquidityCall {
  return encodeV4Decrease({ ...args, liquidity: 0n, amount0Min: 0n, amount1Min: 0n })
}

// On-chain the quoter is nonpayable — it swaps inside `unlock` and reverts with
// the result — but it is declared view here so it can ride eth_call and
// multicall alongside every other quote. Same treatment as the v3 quoters.
export const v4QuoterAbi = parseAbi([
  'function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) view returns (uint256 amountOut, uint256 gasEstimate)',
])

export const universalRouterAbi = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
])

/** Permit2's allowance leg — the router pulls ERC-20 input through this, never
 *  through a plain allowance, so an approval to Permit2 alone is not enough. */
export const permit2Abi = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
])

/** UniversalRouter command: dispatch the payload to the v4 router */
const COMMAND_V4_SWAP = '0x10' as Hex
/** v4Router actions (Actions.sol) */
const ACTION_SWAP_EXACT_IN_SINGLE = '06'
const ACTION_SETTLE_ALL = '0c'
const ACTION_TAKE = '0e'
const ACTION_TAKE_PORTION = '10'
/** ActionConstants.OPEN_DELTA — "take whatever is owed", not a fixed amount */
const OPEN_DELTA = 0n

/**
 * The swap params the DEPLOYED router decodes — two shapes, one per era.
 *
 * v4-periphery added `minHopPriceX36` BETWEEN `amountOutMinimum` and
 * `hookData`, so the two encodings are not interchangeable: feeding the old
 * shape to a new router leaves it reading `hookData`'s offset as a price, and
 * the new shape to an old router appends a tail it never asked for. Neither
 * fails loudly. Which one a deployment wants is `perHopSlippage` in its chain
 * config, asserted against the router's own bytecode by chain-check.
 *
 * BSC predates the field; Robinhood Chain shipped after it.
 */
const PRE_PER_HOP_SWAP_PARAMS = parseAbiParameters(
  '((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)',
)
const PER_HOP_SWAP_PARAMS = parseAbiParameters(
  '((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)',
)

/**
 * Per-hop slippage OFF, on the routers that offer it.
 *
 * The router guards the field with `if (minHopPriceX36 != 0)`, so zero is how
 * a caller declines it — and declining is right here: the floor this app
 * enforces is `amountOutMinimum` on the swap's total output, which the router
 * still checks unconditionally. A second floor expressed as a per-hop PRICE
 * would reject fills that clear the only floor the user was shown.
 */
const NO_MIN_HOP_PRICE = 0n
const currencyAmount = parseAbiParameters('address currency, uint256 amount')
const currencyRecipientAmount = parseAbiParameters('address currency, address recipient, uint256 amount')

/**
 * The full v4 exact-in payload for `UniversalRouter.execute`.
 *
 * Four actions at most, and the order is load-bearing. SWAP leaves a positive
 * delta in the output currency and a negative one in the input; SETTLE_ALL pays
 * the input (from msg.value for the native coin, through Permit2 otherwise);
 * TAKE_PORTION skims the terminal fee off the delta; TAKE hands the remainder
 * to the recipient.
 *
 * The slippage floor lives on the swap's own `amountOutMinimum`, which is the
 * PRE-fee minimum — TAKE_PORTION removes a fixed fraction, so clearing the
 * gross floor guarantees the net one, and the router reverts with
 * V4TooLittleReceived before any fee is taken. A zero fee omits TAKE_PORTION
 * entirely rather than passing zero bips.
 */
export function encodeV4Swap(args: {
  key: V4PoolKey
  zeroForOne: boolean
  amountIn: bigint
  /** the PRE-fee floor: what the pool itself must produce */
  grossMinimumOut: bigint
  recipient: Address
  fee: { bps: number; receiver: Address }
}): { commands: Hex; inputs: readonly Hex[] } {
  const currencyIn = args.zeroForOne ? args.key.currency0 : args.key.currency1
  const currencyOut = args.zeroForOne ? args.key.currency1 : args.key.currency0

  const swap = UNI_V4?.perHopSlippage
    ? encodeAbiParameters(PER_HOP_SWAP_PARAMS, [
        {
          poolKey: args.key,
          zeroForOne: args.zeroForOne,
          amountIn: args.amountIn,
          amountOutMinimum: args.grossMinimumOut,
          minHopPriceX36: NO_MIN_HOP_PRICE,
          hookData: '0x',
        },
      ])
    : encodeAbiParameters(PRE_PER_HOP_SWAP_PARAMS, [
        {
          poolKey: args.key,
          zeroForOne: args.zeroForOne,
          amountIn: args.amountIn,
          amountOutMinimum: args.grossMinimumOut,
          hookData: '0x',
        },
      ])
  const settle = encodeAbiParameters(currencyAmount, [currencyIn, args.amountIn])
  const take = encodeAbiParameters(currencyRecipientAmount, [currencyOut, args.recipient, OPEN_DELTA])

  const actions: string[] = [ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE_ALL]
  const params: Hex[] = [swap, settle]
  if (args.fee.bps > 0) {
    actions.push(ACTION_TAKE_PORTION)
    params.push(
      encodeAbiParameters(currencyRecipientAmount, [
        currencyOut,
        args.fee.receiver,
        BigInt(args.fee.bps),
      ]),
    )
  }
  actions.push(ACTION_TAKE)
  params.push(take)

  return { commands: COMMAND_V4_SWAP, inputs: [encodeActionList(actions, params)] }
}

// ---------------- what a position card derives before it can write ----------------

/**
 * The pool key a card is about, rebuilt from what the card holds and verified
 * against the id it was read under.
 *
 * Cheap, and it turns "the payload addressed the wrong pool" from a class of
 * silent bug into a refusal.
 */
export function v4KeyOf(pool: ClPool): V4PoolKey | null {
  if (pool.protocol !== 'univ4' || !pool.poolId) return null
  const key: V4PoolKey = {
    currency0: pool.token0,
    currency1: pool.token1,
    fee: pool.feePpm,
    tickSpacing: pool.tickSpacing,
    hooks: pool.hooks ?? (zeroAddress as Address),
  }
  return v4PoolId(key).toLowerCase() === pool.poolId.toLowerCase() ? key : null
}

/**
 * The liquidity an increase would buy with these amounts — the same sizing the
 * write does, so the panel can show what will be taken before signing.
 *
 * `amount0`/`amount1` go in as the transaction's ceiling verbatim, which is
 * what makes them a hard spend limit rather than an estimate.
 */
export function v4IncreasePlan(args: {
  sqrtP: bigint
  tickLower: number
  tickUpper: number
  amount0: bigint
  amount1: bigint
}): bigint {
  return liquidityForAmountsWithSlippage(
    args.sqrtP,
    getSqrtRatioAtTick(args.tickLower),
    getSqrtRatioAtTick(args.tickUpper),
    args.amount0,
    args.amount1,
    V4_DEPOSIT_BAND_BPS,
  )
}

/**
 * The address a balance lookup should use for a v4 currency.
 *
 * v4 names the chain's coin `address(0)`; the balance hooks name it with the
 * usual 0xEeee… sentinel. Asking for `balanceOf` at the zero address would
 * report every native position as unfundable.
 */
export function v4BalanceAddress(currency: Address): Address {
  return currency === zeroAddress ? NATIVE : currency
}

/** true when this pool is paid in the chain's own coin on one side */
export function v4HasNative(pool: ClPool): boolean {
  const key = v4KeyOf(pool)
  return key !== null && v4NativeSide(key) !== null
}
