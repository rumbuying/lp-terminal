// Bridge execution: send the provider-built origin-chain txs through the
// shared step() runner, then hand the transfer to the persistent pending
// registry (pending.ts). Fills are verified there on a conservative cadence —
// this function returns as soon as the deposit lands, and the wallet is
// switched back to Robinhood right away.
import type { Address, TransactionReceipt } from 'viem'
import { getChainId, sendTransaction, switchChain } from 'wagmi/actions'
import { CHAIN_ID } from '../../config/addresses'
import { explorerOf, type ResolvedIntent } from '../../config/bridge'
import { asConfiguredChain, wagmiConfig } from '../../config/wagmi'
import { t } from '../../i18n'
import { invalidateAll, shortErr, step } from '../tx'
import { txlog } from '../txlog'
import { fmtEtaShort, pendingBridges, type PendingTracker } from './pending'
import { parseEthDepositReceipt } from './portal'
import type { BridgeQuote } from './types'

/** 'sent' = deposit confirmed and the transfer is tracked as pending */
export type BridgeOutcome = 'sent' | null

/** live position inside an executing bridge, for inline UI progress */
export type BridgeStage = 'approve' | 'deposit'

async function ensureWalletChain(chainId: number): Promise<boolean> {
  const target = asConfiguredChain(chainId)
  if (getChainId(wagmiConfig) === target) return true
  try {
    await switchChain(wagmiConfig, { chainId: target })
    return true
  } catch (e) {
    txlog.push('err', t('bridge.switchFailed', { err: shortErr(e) }))
    return false
  }
}

function buildTracker(quote: BridgeQuote, depositRcpt: TransactionReceipt): PendingTracker {
  if (quote.tracker.provider === 'relay') return quote.tracker
  if (quote.tracker.provider === 'across')
    return { provider: 'across', originChainId: quote.tracker.originChainId, depositTxHash: depositRcpt.transactionHash }
  return { provider: 'portal', childTxHash: parseEthDepositReceipt(depositRcpt) }
}

export async function executeBridge(
  quote: BridgeQuote,
  sender: Address,
  ctx: { leg: ResolvedIntent; amountInStr: string; depositLabel: string },
  onStage?: (stage: BridgeStage) => void,
): Promise<BridgeOutcome> {
  if (quote.expiresAt !== null && Date.now() / 1000 > quote.expiresAt - 30) {
    txlog.push('err', t('bridge.quoteExpired'))
    return null
  }
  let depositRcpt: TransactionReceipt | null = null
  const originChain = quote.steps[0]?.chainId ?? CHAIN_ID
  if (!(await ensureWalletChain(originChain))) return null

  for (const s of quote.steps) {
    onStage?.(s.kind)
    const rcpt = await step(
      s.kind === 'approve' ? t('tx.approve', { sym: ctx.leg.inputSymbol }) : ctx.depositLabel,
      () =>
        sendTransaction(wagmiConfig, {
          account: sender,
          to: s.to,
          data: s.data,
          value: s.value,
          chainId: asConfiguredChain(s.chainId),
        }),
      { chainId: asConfiguredChain(s.chainId), explorer: explorerOf(s.chainId) },
    )
    if (!rcpt) return null
    if (s.kind === 'deposit') depositRcpt = rcpt
  }
  if (!depositRcpt) return null

  pendingBridges.add({
    id: depositRcpt.transactionHash,
    provider: quote.provider,
    tracker: buildTracker(quote, depositRcpt),
    createdAt: Date.now(),
    etaSec: quote.etaSec,
    originChainId: ctx.leg.originChainId,
    destChainId: ctx.leg.destChainId,
    symbol: ctx.leg.outputSymbol,
    amountIn: ctx.amountInStr,
    expectedOut: quote.outputAmount.toString(),
    decimals: ctx.leg.outputDecimals,
    depositTxHash: depositRcpt.transactionHash,
    status: 'pending',
  })
  txlog.push('info', t('bridge.pendingTracked', { eta: fmtEtaShort(quote.etaSec) }))

  // bring the wallet home after an off-Robinhood origin (best effort)
  if (originChain !== CHAIN_ID) {
    try {
      await switchChain(wagmiConfig, { chainId: CHAIN_ID })
    } catch {
      /* user declined — the header banner will offer the switch */
    }
  }
  invalidateAll()
  return 'sent'
}
