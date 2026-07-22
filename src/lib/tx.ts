import {
  BaseError,
  erc20Abi,
  parseAbi,
  parseEventLogs,
  UserRejectedRequestError,
  type Address,
  type Hex,
  type ReplacementReason,
  type TransactionReceipt,
} from 'viem'
import { readContract, waitForTransactionReceipt, writeContract } from 'wagmi/actions'
import { ADDR, CHAIN_ID, NATIVE } from '../config/addresses'
import { queryClient } from '../config/query'
import { wagmiConfig, type ConfiguredChainId } from '../config/wagmi'
import { t } from '../i18n'
import { fmtAmount } from './format'
import { setSwapIntent } from './swapIntent'
import { txlog } from './txlog'

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

export function invalidateAll() {
  void queryClient.invalidateQueries()
}

/** why a step returned null — lets multi-step flows tailor their advice
 *  (an on-chain revert is actionable; a wallet rejection is a user choice) */
export type StepFailWhy = 'rejected' | 'reverted' | 'error'

function stepFailWhy(e: unknown): StepFailWhy {
  if (e instanceof BaseError && e.walk((x) => x instanceof UserRejectedRequestError)) return 'rejected'
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
      invalidateAll()
      opts?.onFail?.(replacementReason === 'cancelled' ? 'rejected' : 'error')
      return null
    }
    if (rcpt.status !== 'success') {
      txlog.update(id, { kind: 'err', text: t('tx.reverted', { label }), hash: activeHash, href: href(activeHash) })
      invalidateAll()
      opts?.onFail?.('reverted')
      return null
    }
    txlog.update(id, {
      kind: 'ok',
      text: t('tx.ok', { label, n: rcpt.blockNumber.toString() }),
      hash: activeHash,
      href: href(activeHash),
    })
    invalidateAll()
    try {
      opts?.onSuccess?.(rcpt)
    } catch (e) {
      txlog.push('err', `${label} — ${shortErr(e)}`, activeHash)
    }
    return rcpt
  } catch (e) {
    txlog.update(id, {
      kind: 'err',
      text: `${label} — ${shortErr(e)}`,
      hash: activeHash,
      href: activeHash ? href(activeHash) : undefined,
    })
    invalidateAll()
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
    const total = receivedOf(rcpt, ADDR.UP, user)
    if (total === 0n) return
    txlog.push('info', t('tx.received', { amt: fmtAmount(total, 18) }), rcpt.transactionHash, {
      label: t('tx.swapToEth'),
      onClick: () => {
        setSwapIntent({ tokenIn: ADDR.UP, tokenOut: NATIVE, amount: total })
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
  const h = await step(t('tx.approve', { sym: symbol }), () =>
    writeContract(wagmiConfig, {
      account: owner,
      abi: erc20Abi,
      address: token,
      functionName: 'approve',
      args: [spender, amount],
      chainId: CHAIN_ID,
    }),
  )
  return h ? 'approved' : null
}

export function deadline(secondsFromNow = 1200): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + secondsFromNow)
}
