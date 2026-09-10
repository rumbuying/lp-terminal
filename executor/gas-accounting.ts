import { zeroAddress, type Address, type TransactionReceipt } from 'viem'
import type { LedgerEntry, StrategyConfig } from '../shared/strategy/types'
import { quoteWithNativeFallback } from './kyber'
import { EXECUTOR } from './config'
import { completeGasValuation, gasValuation, recordGasReceipt, type GasValuationMark } from './store'

const low = (value: string) => value.toLowerCase()
const WRAPPED_NATIVE = EXECUTOR.network.wrappedNative
const SETTLEMENT = EXECUTOR.network.settlementToken

function baseMark(config: StrategyConfig, jobId: string, receipt: TransactionReceipt): Omit<GasValuationMark, 'quoteValueRaw' | 'settlementValueRaw' | 'quoteSource' | 'settlementSource' | 'error'> {
  return {
    txHash: receipt.transactionHash,
    strategyId: config.id,
    jobId,
    blockNumber: receipt.blockNumber.toString(),
    observedAt: Math.floor(Date.now() / 1000),
    gasWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
    quoteToken: config.quoteToken,
    settlementToken: SETTLEMENT,
    valuationVersion: 1,
  }
}

/** Persist the exact receipt fact synchronously before any fallible price read. */
export function recordConfirmedGasReceipt(config: StrategyConfig, jobId: string, receipt: TransactionReceipt): ReturnType<typeof gasValuation> {
  try {
    const base = baseMark(config, jobId, receipt)
    recordGasReceipt(base)
    return gasValuation(base.txHash)
  } catch {
    // The financial transaction is already confirmed. Accounting storage must
    // never turn that success into a retryable transaction failure.
    return undefined
  }
}

async function valueAtConfirmation(token: Address, gasWei: bigint): Promise<{
  value: string
  source: NonNullable<GasValuationMark['quoteSource']>
}> {
  if (low(token) === low(WRAPPED_NATIVE) || low(token) === low(zeroAddress))
    return { value: gasWei.toString(), source: 'exact_native' }
  const quote = await quoteWithNativeFallback(WRAPPED_NATIVE, token, gasWei)
  return { value: quote.routeSummary.amountOut, source: 'confirmation_quote' }
}

/**
 * Pin quote and settlement values as close to receipt confirmation as
 * possible. Missing marks remain missing forever; reporting is responsible
 * for failing closed rather than substituting a later market price.
 */
export async function captureConfirmedGasValuation(config: StrategyConfig, jobId: string, receipt: TransactionReceipt): Promise<void> {
  const base = recordConfirmedGasReceipt(config, jobId, receipt)
  if (!base) return
  if (base.strategyId !== config.id || base.jobId !== jobId
    || base.blockNumber !== receipt.blockNumber.toString()
    || base.gasWei !== (receipt.gasUsed * receipt.effectiveGasPrice).toString()
    || low(base.quoteToken) !== low(config.quoteToken)
    || low(base.settlementToken) !== low(SETTLEMENT)) return
  const gasWei = BigInt(base.gasWei)
  const errors: string[] = []
  let quote: Awaited<ReturnType<typeof valueAtConfirmation>> | undefined
  let settlement: Awaited<ReturnType<typeof valueAtConfirmation>> | undefined
  try {
    quote = await valueAtConfirmation(config.quoteToken, gasWei)
  } catch (error) {
    errors.push(`quote: ${error instanceof Error ? error.message.slice(0, 120) : 'unavailable'}`)
  }
  if (low(config.quoteToken) === low(SETTLEMENT) && quote) settlement = quote
  else {
    try {
      settlement = await valueAtConfirmation(SETTLEMENT, gasWei)
    } catch (error) {
      errors.push(`settlement: ${error instanceof Error ? error.message.slice(0, 120) : 'unavailable'}`)
    }
  }
  try {
    completeGasValuation({
      ...base,
      quoteValueRaw: quote?.value,
      settlementValueRaw: settlement?.value,
      quoteSource: quote?.source,
      settlementSource: settlement?.source,
      error: errors.length ? errors.join('; ').slice(0, 300) : undefined,
    })
  } catch {
    // Receipt confirmation remains authoritative even if this auxiliary write
    // fails. The missing mark will make P/L unavailable instead of inaccurate.
  }
}

/** Build immutable ledger rows from receipt facts plus their pinned mark. */
export function gasLedgerEntries(config: StrategyConfig, jobId: string, receipts: TransactionReceipt[]): LedgerEntry[] {
  const now = Math.floor(Date.now() / 1000)
  return receipts.map((receipt, index) => {
    const gasWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString()
    const mark = gasValuation(receipt.transactionHash)
    const valid = mark
      && mark.strategyId === config.id
      && mark.jobId === jobId
      && mark.blockNumber === receipt.blockNumber.toString()
      && mark.gasWei === gasWei
      && low(mark.quoteToken) === low(config.quoteToken)
      && low(mark.settlementToken) === low(SETTLEMENT)
    return {
      id: `${receipt.transactionHash}-gas-${index}`,
      strategyId: config.id,
      jobId,
      ts: now,
      blockNumber: receipt.blockNumber.toString(),
      txHash: receipt.transactionHash,
      kind: 'gas',
      amount: gasWei,
      quoteValue: valid ? mark.quoteValueRaw : undefined,
      meta: valid ? {
        unit: 'wei',
        gasValuationVersion: 1,
        observedAt: mark.observedAt,
        quoteToken: mark.quoteToken,
        quoteSource: mark.quoteSource,
        settlementToken: mark.settlementToken,
        settlementValueRaw: mark.settlementValueRaw,
        settlementSource: mark.settlementSource,
        valuationError: mark.error,
      } : { unit: 'wei', gasValuationMissing: true },
    }
  })
}
