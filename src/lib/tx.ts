import {
  BaseError,
  erc20Abi,
  ExecutionRevertedError,
  parseAbi,
  parseEventLogs,
  UserRejectedRequestError,
  type Address,
  type Hex,
  type ReplacementReason,
  type TransactionReceipt,
} from 'viem'
import { getAccount, readContract, waitForTransactionReceipt, writeContract } from 'wagmi/actions'
import { CHAIN_ID, NATIVE, requireGov } from '../config/addresses'
import { queryClient } from '../config/query'
import { wagmiConfig, type ConfiguredChainId } from '../config/wagmi'
import { t } from '../i18n'
import { fmtAmount } from './format'
import { setSwapIntent } from './swapIntent'
import { txlog } from './txlog'
import { permit2Abi } from './uniV4'
import { invalidateFarmUsers } from './v2Farm'

// Slipstream periphery's abbreviated revert reasons, translated for humans
// (hints resolve lazily so they follow the active language at error time)
const REVERT_HINTS: [RegExp, () => string][] = [
  [/Return amount is not enough/i, () => t('tx.hintSwapMinOut')],
  [/reason:\s*PS\b/, () => t('tx.hintPS')],
  [/INSUFFICIENT_[AB]_AMOUNT/, () => t('tx.hintV2Ratio')],
  [/reason:\s*STF\b/, () => t('tx.hintSTF')],
  [/reason:\s*NP\b/, () => t('tx.hintNP')],
  [/Transaction too old/i, () => t('tx.hintDeadline')],
]

export function shortErr(e: unknown): string {
  const anyE = e as any
  const m: string = anyE?.shortMessage ?? anyE?.message ?? String(e)
  const first = m.split('\n')[0]
  const base = first.length > 110 ? first.slice(0, 110) + '…' : first
  for (const [re, hint] of REVERT_HINTS) if (re.test(first)) return `${base} → ${hint()}`
  return base
}

// slot0's leading (sqrtPriceX96, tick) is shared by Slipstream (6-word) and
// Uniswap v3 (7-word, extra feeProtocol) pools; decoding only the prefix keeps
// this one helper valid for both — viem ignores the trailing words.
const slot0PrefixAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick)',
])

/** live pool price for slippage math — never trust the cached pools query for mins */
export async function fetchSqrtPriceX96(pool: Address): Promise<bigint> {
  const s0 = await readContract(wagmiConfig, {
    abi: slot0PrefixAbi,
    address: pool,
    functionName: 'slot0',
    chainId: CHAIN_ID,
  })
  return s0[0]
}

export type TransactionInvalidation = 'none' | 'balances' | 'swap' | 'liquidity'

const BALANCE_QUERY_ROOTS = new Set(['balances', 'bridgeBal'])
const SWAP_QUERY_ROOTS = new Set([
  ...BALANCE_QUERY_ROOTS,
  'directQuote',
  'solverQuote',
  'zapPlan',
  'liveSlot0',
])
const LIQUIDITY_QUERY_ROOTS = new Set([
  ...SWAP_QUERY_ROOTS,
  'positions',
  'tickLiq',
])

/** Public catalogs are deliberately absent: one receipt cannot change them. */
export function shouldInvalidateForTransaction(
  queryKey: readonly unknown[],
  scope: Exclude<TransactionInvalidation, 'none'>,
): boolean {
  const root = queryKey[0]
  if (typeof root !== 'string') return false
  const roots =
    scope === 'balances'
      ? BALANCE_QUERY_ROOTS
      : scope === 'swap'
        ? SWAP_QUERY_ROOTS
        : LIQUIDITY_QUERY_ROOTS
  return roots.has(root)
}

export function invalidateTransactionState(scope: TransactionInvalidation = 'liquidity') {
  if (scope === 'none') return
  // A liquidity move may have staked v2 LP into a farm pid the reconcile cache
  // has never proved — drop the per-wallet farm discovery so the next positions
  // read reconciles instead of waiting out the 30-minute window.
  if (scope === 'liquidity') invalidateFarmUsers()
  void queryClient.invalidateQueries({
    predicate: (query) => shouldInvalidateForTransaction(query.queryKey, scope),
  })
}

/** Resolve lazily so a language switch made after module load is respected. */
export function accountChangedMessage(): string {
  return t('tx.accountChanged')
}

/**
 * Multi-transaction flows freeze their submitting account when the user starts.
 * Wallets can emit an account change while an approval or RPC read is pending;
 * every later write must stop instead of silently using the newly-selected
 * account for an old plan.
 */
export function activeAccountMatches(expected: Address): boolean {
  const active = getAccount(wagmiConfig).address
  return !!active && active.toLowerCase() === expected.toLowerCase()
}

/** why a step returned null — lets multi-step flows tailor their advice
 *  (an on-chain revert is actionable; a wallet rejection is a user choice) */
export type StepFailWhy = 'rejected' | 'reverted' | 'error'

function stepFailWhy(e: unknown): StepFailWhy {
  if (e instanceof BaseError) {
    if (e.walk((x) => x instanceof UserRejectedRequestError)) return 'rejected'
    // An estimate that reverts is the chain running this exact calldata and
    // refusing it — the same verdict a reverted receipt carries, reached before
    // the fee is paid instead of after. Callers key their retry advice on
    // 'reverted' (raise the tolerance, re-quote), and a swap stopped by the
    // solver's pre-flight needs that advice as much as one that landed.
    if (e.walk((x) => x instanceof ExecutionRevertedError)) return 'reverted'
  }
  return /reject|denied|declin/i.test(String((e as Error)?.message ?? '')) ? 'rejected' : 'error'
}

/**
 * Run one transaction step: wallet prompt -> pending -> receipt.
 * Returns the confirmed receipt on success, null on rejection/revert (callers
 * should stop a multi-step flow on null; opts.onFail hears which kind of null).
 * opts.onSuccess sees the same receipt. opts.chainId/explorer let bridge steps
 * run on a remote origin chain — every other flow defaults to Robinhood.
 */
export async function step(
  label: string,
  send: () => Promise<Hex>,
  opts?: {
    /** fires the instant the tx is broadcast (hash in hand), before it confirms
     *  — lets a caller persist a prominent "pending" entry that survives reload */
    onSubmitted?: (hash: Hex) => void
    onReplaced?: (oldHash: Hex, newHash: Hex, reason: ReplacementReason) => void
    onSuccess?: (rcpt: TransactionReceipt) => void
    onFail?: (why: StepFailWhy) => void
    chainId?: ConfiguredChainId
    explorer?: string
    /** Query domain changed by a successful receipt. Failures never invalidate. */
    invalidate?: TransactionInvalidation
  },
): Promise<TransactionReceipt | null> {
  const id = txlog.push('pending', t('tx.confirm', { label }))
  const chainId = opts?.chainId ?? CHAIN_ID
  const href = (hash: Hex) => (opts?.explorer ? `${opts.explorer}/tx/${hash}` : undefined)
  let activeHash: Hex | undefined
  try {
    const hash = await send()
    activeHash = hash
    txlog.update(id, { text: t('tx.pending', { label }), hash, href: href(hash) })
    try {
      opts?.onSubmitted?.(hash)
    } catch (e) {
      txlog.push('err', `${label} — ${shortErr(e)}`, hash)
    }
    let replacementReason: ReplacementReason | null = null
    const rcpt = await waitForTransactionReceipt(wagmiConfig, {
      hash,
      chainId,
      // Robinhood blocks in ~100ms; viem's 4s default would leave a confirmed
      // swap looking pending for seconds (the "is it stuck?" reload trigger).
      // Remote bridge chains keep the default cadence.
      pollingInterval: chainId === CHAIN_ID ? 800 : undefined,
      onReplaced: ({ reason, replacedTransaction, transaction }) => {
        const oldHash = replacedTransaction.hash
        activeHash = transaction.hash
        replacementReason = reason
        txlog.update(id, { hash: activeHash, href: href(activeHash) })
        try {
          opts?.onReplaced?.(oldHash, activeHash, reason)
        } catch (e) {
          txlog.push('err', `${label} — ${shortErr(e)}`, activeHash)
        }
      },
    })
    activeHash = rcpt.transactionHash
    if (replacementReason && replacementReason !== 'repriced') {
      txlog.update(id, {
        kind: 'err',
        text: `${label} — ${replacementReason}`,
        hash: activeHash,
        href: href(activeHash),
      })
      opts?.onFail?.(replacementReason === 'cancelled' ? 'rejected' : 'error')
      return null
    }
    if (rcpt.status !== 'success') {
      txlog.update(id, { kind: 'err', text: t('tx.reverted', { label }), hash: activeHash, href: href(activeHash) })
      opts?.onFail?.('reverted')
      return null
    }
    txlog.update(id, {
      kind: 'ok',
      text: t('tx.ok', { label, n: rcpt.blockNumber.toString() }),
      hash: activeHash,
      href: href(activeHash),
    })
    invalidateTransactionState(opts?.invalidate ?? 'liquidity')
    try {
      opts?.onSuccess?.(rcpt)
    } catch (e) {
      txlog.push('err', `${label} — ${shortErr(e)}`, activeHash)
    }
    return rcpt
  } catch (e) {
    // A hash means the transaction reached the network and the WAIT is what
    // broke — a dropped RPC socket, a timeout, a tab asleep too long. That says
    // nothing about the transaction, which is out there and may well confirm.
    // Calling it failed contradicts the pending banner tracking the same hash
    // beside it, and talks people into sending the trade a second time. Report
    // what is known: sent, and no longer watched from here.
    const broadcast = activeHash !== undefined
    txlog.update(id, {
      kind: broadcast ? 'info' : 'err',
      text: broadcast
        ? t('tx.unwatched', { label, why: shortErr(e) })
        : `${label} — ${shortErr(e)}`,
      hash: activeHash,
      href: activeHash ? href(activeHash) : undefined,
    })
    // The flow above still stops: this step has no receipt to hand it, and a
    // later step built on an unconfirmed one would be guessing.
    opts?.onFail?.(stepFailWhy(e))
    return null
  }
}

/** total of `token` delivered to `to` in a receipt's Transfer logs — the
 *  ground truth for "how much did I actually receive" after a swap/claim */
export function receivedOf(rcpt: TransactionReceipt, token: Address, to: Address): bigint {
  const transfers = parseEventLogs({ abi: erc20Abi, logs: rcpt.logs, eventName: 'Transfer' })
  let total = 0n
  for (const t of transfers) {
    if (t.address.toLowerCase() === token.toLowerCase() && t.args.to?.toLowerCase() === to.toLowerCase()) {
      total += t.args.value ?? 0n
    }
  }
  return total
}

/**
 * Post-claim follow-up: read how much UP actually landed in the wallet from the
 * receipt's Transfer logs and offer a one-click "swap it to ETH" that jumps to
 * the SWAP tab prefilled with the exact claimed amount.
 */
export function offerSwapClaimedUp(user: Address) {
  return (rcpt: TransactionReceipt) => {
    const gov = requireGov()
    const total = receivedOf(rcpt, gov.UP, user)
    if (total === 0n) return
    txlog.push('info', t('tx.received', { amt: fmtAmount(total, 18) }), rcpt.transactionHash, {
      label: t('tx.swapToEth'),
      onClick: () => {
        setSwapIntent({ tokenIn: gov.UP, tokenOut: NATIVE, amount: total })
        location.hash = 'swap'
      },
    })
  }
}

export type AllowanceResult = 'sufficient' | 'approved'

/** Approve `spender` for exactly `amount` if current allowance is lower. */
export async function ensureAllowance(
  token: Address,
  owner: Address,
  spender: Address,
  amount: bigint,
  symbol: string,
): Promise<AllowanceResult | null> {
  const current = await readContract(wagmiConfig, {
    abi: erc20Abi,
    address: token,
    functionName: 'allowance',
    args: [owner, spender],
    chainId: CHAIN_ID,
  })
  if (current >= amount) return 'sufficient'
  const h = await step(
    t('tx.approve', { sym: symbol }),
    () =>
      writeContract(wagmiConfig, {
        account: owner,
        abi: erc20Abi,
        address: token,
        functionName: 'approve',
        args: [spender, amount],
        chainId: CHAIN_ID,
      }),
    { invalidate: 'none' },
  )
  return h ? 'approved' : null
}

/**
 * Permit2's own allowance leg.
 *
 * A token approved to Permit2 is not yet spendable by anything — Permit2 keeps
 * a second, per-operator allowance that also carries an expiry. Uniswap's
 * UniversalRouter pulls exclusively through it, so a v4 swap needs both legs and
 * approving the token alone would revert at settlement.
 *
 * The allowance is written for exactly `amount`, and expires with the same
 * horizon a swap deadline uses, so a stale approval cannot outlive the trade
 * that asked for it.
 */
export async function ensurePermit2Allowance(
  permit2: Address,
  token: Address,
  owner: Address,
  operator: Address,
  amount: bigint,
  symbol: string,
): Promise<AllowanceResult | null> {
  const [current, expiration] = await readContract(wagmiConfig, {
    abi: permit2Abi,
    address: permit2,
    functionName: 'allowance',
    args: [owner, token, operator],
    chainId: CHAIN_ID,
  })
  const now = BigInt(Math.floor(Date.now() / 1000))
  // an unexpired allowance for enough is the only one worth reusing
  if (current >= amount && BigInt(expiration) > now) return 'sufficient'
  if (amount > (1n << 160n) - 1n) throw new Error('Permit2 allowance exceeds uint160')
  const expiry = Number(deadline(PERMIT2_ALLOWANCE_SECONDS))
  const h = await step(
    t('tx.approve', { sym: symbol }),
    () =>
      writeContract(wagmiConfig, {
        account: owner,
        abi: permit2Abi,
        address: permit2,
        functionName: 'approve',
        args: [token, operator, amount, expiry],
        chainId: CHAIN_ID,
      }),
    { invalidate: 'none' },
  )
  return h ? 'approved' : null
}

/** how long a Permit2 allowance stays valid — long enough to cover the approval
 *  landing and the swap that follows, short enough not to linger */
const PERMIT2_ALLOWANCE_SECONDS = 3600

export function deadline(secondsFromNow = 1200): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + secondsFromNow)
}
