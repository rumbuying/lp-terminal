import { readContract, writeContract } from 'wagmi/actions'
import { zeroAddress, type Address, type Hex, type TransactionReceipt } from 'viem'
import { CHAIN_ID } from '../config/addresses'
import { wagmiConfig } from '../config/wagmi'
import { t } from '../i18n'
import { getSqrtRatioAtTick, minAmountsForLiquidity } from './clmath'
import {
  accountChangedMessage,
  activeAccountMatches,
  deadline,
  ensureAllowance,
  ensurePermit2Allowance,
  step,
  type StepFailWhy,
} from './tx'
import { txlog } from './txlog'
import {
  UNI_V4,
  encodeV4Collect,
  encodeV4Decrease,
  encodeV4Increase,
  encodeV4Mint,
  v4IncreasePlan,
  v4KeyOf,
  v4PositionManagerAbi,
  v4StateViewAbi,
  type V4LiquidityCall,
  type V4PoolKey,
} from './uniV4'
import type { ClPool, ClPosition } from '../types'

/**
 * Writing Uniswap v4 liquidity.
 *
 * Every other CL card here writes through named entrypoints on a manager that
 * owns the pool — `increaseLiquidity`, `decreaseLiquidity`, `collect`. v4 has
 * one write entrypoint, `modifyLiquidities`, and hands it an encoded list of
 * actions (see encodeV4Increase and friends). Three consequences shape this
 * file:
 *
 *  - The POOL KEY is the address. A v4 pool has no contract, so the payload
 *    names its pool by key; one wrong field still encodes, still executes, and
 *    modifies a different pool. Every op re-derives the key and checks it
 *    against the id the position was read under before it will sign anything.
 *  - ERC-20 moves through PERMIT2, in two legs — the token approved to Permit2,
 *    then Permit2 approved for the manager. One leg alone reverts at settlement.
 *  - The chain's own coin is a currency in its own right, keyed as address(0)
 *    and paid as `msg.value`. On BSC that is the common case, not the exotic
 *    one: the native BNB pools carry the deeper liquidity.
 */
const V4 = UNI_V4

type Ready = { key: V4PoolKey; pm: Address; poolId: Hex }

function readyPool(pool: ClPool, tokenId?: bigint): Ready | null {
  const key = V4 && v4KeyOf(pool)
  if (!V4 || !key || !pool.poolId) {
    txlog.push(
      'err',
      tokenId === undefined
        ? t('zap.errV4PoolKey')
        : t('pos.v4KeyMismatch', { id: tokenId.toString() }),
    )
    return null
  }
  return { key, pm: V4.POSITION_MANAGER, poolId: pool.poolId }
}


/**
 * The pool's price right now, read from the singleton's lens.
 *
 * The cached positions feed is fine for display and too stale to size a deposit
 * against — the same reason the v3 paths re-read slot0 before writing. A v4
 * pool has no contract to ask, so the read goes through StateView by pool id.
 */
async function freshSqrtPriceX96(poolId: Hex): Promise<bigint> {
  const slot0 = await readContract(wagmiConfig, {
    abi: v4StateViewAbi,
    address: V4!.STATE_VIEW,
    functionName: 'getSlot0',
    args: [poolId],
    chainId: CHAIN_ID,
  })
  return slot0[0]
}

function send(
  pm: Address,
  call: V4LiquidityCall,
  label: string,
  account: Address,
  onFail?: (why: StepFailWhy) => void,
): Promise<TransactionReceipt | null> {
  if (!activeAccountMatches(account)) {
    txlog.push('err', `${label} — ${accountChangedMessage()}`)
    onFail?.('error')
    return Promise.resolve(null)
  }
  return step(
    label,
    () =>
      writeContract(wagmiConfig, {
        account,
        abi: v4PositionManagerAbi,
        address: pm,
        functionName: 'modifyLiquidities',
        args: [call.unlockData, deadline()],
        value: call.value,
        chainId: CHAIN_ID,
      }),
    { onFail },
  )
}

/** fees only — a decrease of zero liquidity, which is how v4 spells `collect` */
export async function v4Collect(pos: ClPosition, user: Address): Promise<boolean> {
  const r = readyPool(pos.pool, pos.tokenId)
  if (!r) return false
  const call = encodeV4Collect({ key: r.key, tokenId: pos.tokenId })
  return !!(await send(r.pm, call, t('pos.stCollect', { id: pos.tokenId.toString() }), user))
}

/**
 * Remove `pct`% of the position's liquidity, principal and fees together.
 *
 * One transaction. The v3 card decreases and then collects, because there the
 * withdrawn principal is only credited to the NFT; v4 settles the whole delta
 * in the same action list.
 */
export async function v4Decrease(pos: ClPosition, pct: number, slipBps: number, user: Address): Promise<boolean> {
  const r = readyPool(pos.pool, pos.tokenId)
  if (!r) return false
  if (!activeAccountMatches(user)) {
    txlog.push('err', accountChangedMessage())
    return false
  }
  const liquidity = (pos.liquidity * BigInt(Math.round(pct * 100))) / 10_000n
  if (liquidity === 0n) {
    txlog.push('err', t('pos.stNothingRemove'))
    return false
  }
  const sqrtP = await freshSqrtPriceX96(r.poolId)
  const { amount0Min, amount1Min } = minAmountsForLiquidity(
    sqrtP,
    getSqrtRatioAtTick(pos.tickLower),
    getSqrtRatioAtTick(pos.tickUpper),
    liquidity,
    slipBps,
  )
  const call = encodeV4Decrease({ key: r.key, tokenId: pos.tokenId, liquidity, amount0Min, amount1Min })
  return !!(await send(r.pm, call, t('pos.stDecrease', { id: pos.tokenId.toString(), pct }), user))
}

/**
 * Approve a currency for the PositionManager to pull.
 *
 * Native needs nothing — it rides as `msg.value`. An ERC-20 needs BOTH Permit2
 * legs, and `amount` is the exact ceiling the deposit may spend, so neither
 * approval outlives or outsizes the transaction that asked for it.
 */
export async function ensureV4CurrencyApproval(
  currency: Address,
  user: Address,
  amount: bigint,
  symbol: string,
): Promise<boolean> {
  if (amount === 0n || currency === zeroAddress) return true
  if (!V4) return false
  if (!activeAccountMatches(user)) {
    txlog.push('err', accountChangedMessage())
    return false
  }
  const permit2 = V4.PERMIT2
  if (!(await ensureAllowance(currency, user, permit2, amount, symbol))) return false
  if (!activeAccountMatches(user)) {
    txlog.push('err', accountChangedMessage())
    return false
  }
  return !!(await ensurePermit2Allowance(
    permit2,
    currency,
    user,
    V4.POSITION_MANAGER,
    amount,
    symbol,
  ))
}

/**
 * Mint or increase v4 liquidity, spending at most the amounts given.
 *
 * The price is re-read and liquidity re-sized immediately before signing, so
 * approvals cannot leave a stale size behind. Both amounts remain hard spend
 * ceilings; native currency rides as msg.value and ERC-20s move through Permit2.
 */
export type V4DepositTarget =
  | { kind: 'cl-mint'; pool: ClPool; tickLower: number; tickUpper: number }
  | { kind: 'cl-increase'; pool: ClPool; tickLower: number; tickUpper: number; tokenId: bigint }

export async function v4Deposit(args: {
  target: V4DepositTarget
  user: Address
  amount0: bigint
  amount1: bigint
  symbol0: string
  symbol1: string
  label: string
  onFail?: (why: StepFailWhy) => void
}): Promise<TransactionReceipt | null> {
  const { target } = args
  const r = readyPool(target.pool, target.kind === 'cl-increase' ? target.tokenId : undefined)
  if (!r || (args.amount0 === 0n && args.amount1 === 0n)) return null
  if (!activeAccountMatches(args.user)) {
    txlog.push('err', accountChangedMessage())
    return null
  }

  if (!(await ensureV4CurrencyApproval(r.key.currency0, args.user, args.amount0, args.symbol0))) return null
  if (!(await ensureV4CurrencyApproval(r.key.currency1, args.user, args.amount1, args.symbol1))) return null
  if (!activeAccountMatches(args.user)) {
    txlog.push('err', accountChangedMessage())
    return null
  }

  const sqrtP = await freshSqrtPriceX96(r.poolId)
  const liquidity = v4IncreasePlan({
    sqrtP,
    tickLower: target.tickLower,
    tickUpper: target.tickUpper,
    amount0: args.amount0,
    amount1: args.amount1,
  })
  if (liquidity === 0n) {
    txlog.push('err', t('pos.v4IncTooSmall'))
    return null
  }
  const common = {
    key: r.key,
    liquidity,
    amount0Max: args.amount0,
    amount1Max: args.amount1,
  }
  const call =
    target.kind === 'cl-increase'
      ? encodeV4Increase({
          ...common,
          tokenId: target.tokenId,
          recipient: args.user,
        })
      : encodeV4Mint({
          ...common,
          tickLower: target.tickLower,
          tickUpper: target.tickUpper,
          owner: args.user,
        })
  return send(r.pm, call, args.label, args.user, args.onFail)
}

export async function v4Increase(args: {
  pos: ClPosition
  user: Address
  amount0: bigint
  amount1: bigint
  symbol0: string
  symbol1: string
}): Promise<boolean> {
  const { pos } = args
  return !!(await v4Deposit({
    target: {
      kind: 'cl-increase',
      pool: pos.pool,
      tickLower: pos.tickLower,
      tickUpper: pos.tickUpper,
      tokenId: pos.tokenId,
    },
    user: args.user,
    amount0: args.amount0,
    amount1: args.amount1,
    symbol0: args.symbol0,
    symbol1: args.symbol1,
    label: t('zap.stIncrease', { id: pos.tokenId.toString() }),
  }))
}
