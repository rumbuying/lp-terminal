import { erc20Abi, zeroAddress, type Address } from 'viem'
import type { StrategyConfig, StrategyExecutionPlan, StrategyPositionSnapshot } from '../shared/strategy/types'
import { ADDR, NATIVE } from '../src/config/addresses'
import { strategyChain } from '../src/config/networks'
import { getAmountsForLiquidity, getSqrtRatioAtTick } from '../src/lib/clmath'
import { publicClient, readCollectableFees, readPerformanceSnapshot } from './chain'
import { quoteRewardToQuote } from './reward'
import { convertPoolAmount, quotePerRiskAtTick, quoteTurnover } from './risk'
import { reconstructOriginalMintCostBasis, type OriginalMintCostBasis } from './cost-basis'
import { db, getJobContext, setJobContext, setStrategyBaselineUsdgIfAbsent, strategyAllocationComponents, strategyAllocations, strategyBaseline, type StrategyBaseline } from './store'
import { distributionAdjustedPnl, executionShortfall } from '../shared/strategy/accounting'
import { historicalQuoteValueInUsdg, quoteValueInUsdg } from './stable-valuation'
import { EXECUTOR } from './config'
import { INCOME_RETENTION_BPS, INCOME_RETENTION_CUSTODY } from '../shared/strategy/income-retention'

type CycleRow = {
  id: string
  job_id: string
  old_token_id: string | null
  new_token_id: string | null
  started_at: number
  completed_at: number | null
  trigger_side: string | null
  status: string
  tx_hashes_json: string
  plan_json: string
}

type LedgerRow = {
  cycle_id: string | null
  block_number: string | null
  kind: string
  token: string | null
  amount: string | null
  quote_value: string | null
  tx_hash: string | null
  meta_json: string
}

type CyclePrice = {
  snapshot: StrategyPositionSnapshot
  sqrtPriceX96: bigint
  tick: number
  observedAt: number
  blockNumber: string
  source: 'pre_decrease_snapshot' | 'trigger_snapshot' | 'rebalance_snapshot'
}

type SwapContext = {
  sqrtPriceX96?: string
  tick?: number
  swaps?: { tokenIn: Address; tokenOut: Address; amountIn: string }[]
}

type FeeTaxContext = {
  retainedUsdg?: string
}

const low = (value: string) => value.toLowerCase()
const SETTLEMENT = EXECUTOR.network.settlementToken
const WRAPPED_NATIVE = EXECUTOR.network.wrappedNative
const sum = (values: bigint[]) => values.reduce((total, value) => total + value, 0n)
const PERFORMANCE_CACHE_MS = 30_000
const performanceCache = new Map<string, { expiresAt: number; value?: Awaited<ReturnType<typeof strategyPerformance>>; pending?: Promise<Awaited<ReturnType<typeof strategyPerformance>>> }>()
const mintBasisRetryAfter = new Map<string, number>()
const MINT_BASIS_RETRY_MS = 15 * 60_000

function rowsForStrategy(strategyId: string) {
  const cycles = db.prepare(`SELECT c.id,substr(c.id,7) AS job_id,c.old_token_id,c.new_token_id,c.started_at,c.completed_at,c.trigger_side,c.status,c.tx_hashes_json,j.plan_json
    FROM cycles c JOIN jobs j ON j.id=substr(c.id,7) WHERE c.strategy_id=? AND c.status='completed' ORDER BY c.completed_at,c.id`).all(strategyId) as unknown as CycleRow[]
  const ledger = db.prepare(`SELECT cycle_id,block_number,kind,token,amount,quote_value,tx_hash,meta_json FROM ledger_entries WHERE strategy_id=? ORDER BY ts,id`).all(strategyId) as unknown as LedgerRow[]
  return { cycles, ledger }
}

function cycleRebalancePrice(row: CycleRow): CyclePrice {
  const plan = JSON.parse(row.plan_json) as StrategyExecutionPlan
  const context = getJobContext<SwapContext>(row.job_id, 'swap_plan')
  return {
    snapshot: plan.snapshot,
    sqrtPriceX96: BigInt(context?.sqrtPriceX96 ?? plan.snapshot.sqrtPriceX96),
    tick: context?.tick ?? plan.snapshot.tick,
    observedAt: row.completed_at ?? plan.snapshot.observedAt,
    blockNumber: plan.snapshot.blockNumber,
    source: 'rebalance_snapshot',
  }
}

/** The cost basis belongs to the withdrawal, never to a later recovery swap. */
function cycleExitPrice(row: CycleRow): CyclePrice {
  const plan = JSON.parse(row.plan_json) as StrategyExecutionPlan
  const context = getJobContext<{ observedAt?: number; blockNumber?: string; tick?: number; sqrtPriceX96?: string }>(row.job_id, 'exit_valuation')
  return {
    snapshot: plan.snapshot,
    sqrtPriceX96: BigInt(context?.sqrtPriceX96 ?? plan.snapshot.sqrtPriceX96),
    tick: context?.tick ?? plan.snapshot.tick,
    observedAt: context?.observedAt ?? plan.snapshot.observedAt,
    blockNumber: context?.blockNumber ?? plan.snapshot.blockNumber,
    source: context?.sqrtPriceX96 ? 'pre_decrease_snapshot' : 'trigger_snapshot',
  }
}

function quotedAmount(row: LedgerRow, config: StrategyConfig, price: CyclePrice): bigint {
  if (!row.token || !row.amount) return 0n
  return quoteTurnover(BigInt(row.amount), row.token as Address, config, price.snapshot, price.sqrtPriceX96)
}

function quotedRows(rows: LedgerRow[], kind: string, config: StrategyConfig, price: CyclePrice): bigint {
  return sum(rows.filter((row) => row.kind === kind).map((row) => quotedAmount(row, config, price)))
}

function isRewardOutput(row: LedgerRow): boolean {
  if (row.kind !== 'swap_out') return false
  try {
    const meta = JSON.parse(row.meta_json)
    return meta.source === 'staking_reward' && meta.rewardFinal !== false
  } catch { return false }
}

function isIncomeTaxInput(row: LedgerRow): boolean {
  if (row.kind !== 'swap_in') return false
  try { return JSON.parse(row.meta_json).purpose === 'fee_tax' } catch { return false }
}

function cycleIncomeTaxQuote(cycle: CycleRow, rows: LedgerRow[], config: StrategyConfig, price: CyclePrice): bigint {
  const swappedTax = sum(rows.filter(isIncomeTaxInput).map((row) => quotedAmount(row, config, price)))
  const retainedRows = rows.filter((row) => row.kind === 'income_tax')
  if (retainedRows.length) return swappedTax + sum(retainedRows.map((row) => quotedAmount(row, config, price)))

  // Backfill completed cycles written before direct USDG retention received
  // its own ledger kind. The durable job context is part of the same atomic
  // execution record and prevents old tax from being hidden in the LP residual.
  const retainedRaw = getJobContext<FeeTaxContext>(cycle.job_id, 'fee_tax')?.retainedUsdg
  if (!retainedRaw || !/^\d+$/.test(retainedRaw) || BigInt(retainedRaw) === 0n) return swappedTax
  try {
    return swappedTax + quoteTurnover(BigInt(retainedRaw), SETTLEMENT, config, price.snapshot, price.sqrtPriceX96)
  } catch {
    return swappedTax
  }
}

type GasValuation = {
  opening: bigint
  cycles: Map<string, bigint>
  total: bigint
  quoteComplete: boolean
  openingUsdg: bigint
  cyclesUsdg: Map<string, bigint>
  totalUsdg: bigint
  usdgComplete: boolean
  cycleComplete: Map<string, boolean>
  cycleUsdgComplete: Map<string, boolean>
}

function pinnedGasValue(row: LedgerRow, token: Address, config: StrategyConfig): bigint | undefined {
  if (!row.amount || !/^\d+$/.test(row.amount)) return undefined
  if (low(token) === low(WRAPPED_NATIVE) || low(token) === low(zeroAddress)) return BigInt(row.amount)
  try {
    const meta = JSON.parse(row.meta_json) as Record<string, unknown>
    if (meta.gasValuationVersion !== 1) return undefined
    if (low(token) === low(config.quoteToken)
      && typeof meta.quoteToken === 'string'
      && low(meta.quoteToken) === low(token)
      && row.quote_value && /^\d+$/.test(row.quote_value)) return BigInt(row.quote_value)
    if (typeof meta.settlementToken === 'string'
      && low(meta.settlementToken) === low(token)
      && typeof meta.settlementValueRaw === 'string'
      && /^\d+$/.test(meta.settlementValueRaw)) return BigInt(meta.settlementValueRaw)
  } catch {
    return undefined
  }
  return undefined
}

export function valueGas(cycles: CycleRow[], ledger: LedgerRow[], config: StrategyConfig, openingGasWei: bigint): GasValuation {
  const opening = openingGasWei === 0n
    ? 0n
    : low(config.quoteToken) === low(WRAPPED_NATIVE) || low(config.quoteToken) === low(zeroAddress) ? openingGasWei : 0n
  const openingUsdg = openingGasWei > 0n && (low(SETTLEMENT) === low(WRAPPED_NATIVE) || low(SETTLEMENT) === low(zeroAddress))
    ? openingGasWei
    : openingGasWei > 0n && low(config.quoteToken) === low(SETTLEMENT) ? opening : 0n
  let quoteComplete = openingGasWei === 0n || low(config.quoteToken) === low(WRAPPED_NATIVE) || low(config.quoteToken) === low(zeroAddress)
  let usdgComplete = openingGasWei === 0n || low(SETTLEMENT) === low(WRAPPED_NATIVE) || low(SETTLEMENT) === low(zeroAddress)
    || (low(config.quoteToken) === low(SETTLEMENT) && quoteComplete)
  const cycleComplete = new Map<string, boolean>()
  const cycleUsdgComplete = new Map<string, boolean>()
  const cycleValues = new Map<string, bigint>()
  const cycleUsdgValues = new Map<string, bigint>()
  for (const cycle of cycles) {
    const rows = ledger.filter((row) => row.cycle_id === cycle.id && row.kind === 'gas')
    let cycleQuote = 0n
    let cycleUsdg = 0n
    let complete = true
    let stableComplete = true
    for (const row of rows) {
      const quote = pinnedGasValue(row, config.quoteToken, config)
      const stable = low(config.quoteToken) === low(SETTLEMENT) ? quote : pinnedGasValue(row, SETTLEMENT, config)
      if (quote === undefined) complete = false
      else cycleQuote += quote
      if (stable === undefined) stableComplete = false
      else cycleUsdg += stable
    }
    cycleComplete.set(cycle.id, complete)
    cycleUsdgComplete.set(cycle.id, stableComplete)
    cycleValues.set(cycle.id, cycleQuote)
    cycleUsdgValues.set(cycle.id, cycleUsdg)
    quoteComplete &&= complete
    usdgComplete &&= stableComplete
  }
  return {
    opening,
    cycles: cycleValues,
    total: opening + sum([...cycleValues.values()]),
    quoteComplete,
    openingUsdg,
    cyclesUsdg: cycleUsdgValues,
    totalUsdg: openingUsdg + sum([...cycleUsdgValues.values()]),
    usdgComplete,
    cycleComplete,
    cycleUsdgComplete,
  }
}

function riskDirection(side: string | null, config: StrategyConfig, snapshot: StrategyPositionSnapshot): 'up' | 'down' | null {
  if (side !== 'lower' && side !== 'upper') return null
  const riskIsToken0 = low(config.riskToken) === low(snapshot.token0)
  const rawTickUp = side === 'upper'
  return rawTickUp === riskIsToken0 ? 'up' : 'down'
}

/** Best-known spot/quote-to-fill shortfall, valued in the strategy quote token. */
function cycleExecutionCost(rows: LedgerRow[], config: StrategyConfig, price: CyclePrice): { quote: bigint; maxImpactBps: number | null } {
  const ins = rows.filter((row) => row.kind === 'swap_in' && row.token && row.amount)
  let quote = 0n
  let maxImpactBps = 0
  let found = false
  for (const input of ins) {
    const output = rows.find((row) => row.kind === 'swap_out' && row.tx_hash && row.tx_hash === input.tx_hash && row.token && row.amount)
    if (!output) continue
    const amountIn = BigInt(input.amount!)
    const amountOut = BigInt(output.amount!)
    let inputMeta: Record<string, unknown> = {}
    let outputMeta: Record<string, unknown> = {}
    try { inputMeta = JSON.parse(input.meta_json) } catch { /* empty metadata */ }
    try { outputMeta = JSON.parse(output.meta_json) } catch { /* empty metadata */ }
    // Fee tax deliberately leaves the strategy pool: one pool-side fee token
    // is converted to USDG and retained in the wallet. It remains part of the
    // audited ledger, but it is not a pool-token swap and therefore has no
    // meaningful pool spot execution-cost comparison. Trying to value USDG
    // with the strategy pool's sqrt price would raise E_POOL_IDENTITY and make
    // the otherwise healthy live position unavailable.
    if (inputMeta.purpose === 'fee_tax' || outputMeta.purpose === 'fee_tax') continue
    if (inputMeta.source === 'staking_reward') {
      if (outputMeta.rewardFinal === false) continue
      const quotedOut = typeof outputMeta.quotedOut === 'string' ? BigInt(outputMeta.quotedOut) : amountOut
      const execution = executionShortfall({ spotOut: quotedOut, quotedOut, actualOut: amountOut })
      if (execution.amountOut > 0n) {
        found = true
        quote += execution.amountOut
        if ((execution.impactBps ?? 0) > maxImpactBps) maxImpactBps = execution.impactBps ?? 0
      }
      continue
    }
    const spotOut = convertPoolAmount(amountIn, input.token as Address, output.token as Address, price.snapshot, price.sqrtPriceX96)
    const quotedOut = typeof outputMeta.quotedOut === 'string' && /^\d+$/.test(outputMeta.quotedOut)
      ? BigInt(outputMeta.quotedOut)
      : undefined
    const execution = executionShortfall({ spotOut, quotedOut, actualOut: amountOut })
    if (execution.amountOut === 0n) continue
    found = true
    quote += quoteTurnover(execution.amountOut, output.token as Address, config, price.snapshot, price.sqrtPriceX96)
    if ((execution.impactBps ?? 0) > maxImpactBps) maxImpactBps = execution.impactBps ?? 0
  }
  return { quote, maxImpactBps: found ? maxImpactBps : null }
}

const symbolCache = new Map<string, Promise<string>>()

async function tokenSymbol(token: Address): Promise<string> {
  if (low(token) === low(zeroAddress) || low(token) === low(NATIVE))
    return strategyChain(EXECUTOR.chainId).nativeCurrency.symbol
  if (low(token) === low(WRAPPED_NATIVE)) return EXECUTOR.chainId === 56 ? 'WBNB' : 'WETH'
  const key = low(token)
  const existing = symbolCache.get(key)
  if (existing) return existing
  const pending = publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' })
    .then((symbol) => String(symbol))
    .catch(() => {
      symbolCache.delete(key)
      return `${token.slice(0, 6)}…${token.slice(-4)}`
    })
  symbolCache.set(key, pending)
  return pending
}

function pnlPct(pnl: bigint, baseline: bigint): number | null {
  if (baseline <= 0n) return null
  return Number((pnl * 1_000_000n) / baseline) / 10_000
}

async function originalMintBasis(first: CycleRow, config: StrategyConfig, price: CyclePrice): Promise<OriginalMintCostBasis | undefined> {
  const stored = getJobContext<OriginalMintCostBasis>(first.job_id, 'performance_original_mint_basis')
  if (stored?.basisVersion === 2 && stored.kind === 'original_mint' && stored.tokenId === first.old_token_id) return stored
  if (!first.old_token_id || (mintBasisRetryAfter.get(first.job_id) ?? 0) > Date.now()) return undefined
  try {
    const reconstructed = await reconstructOriginalMintCostBasis(config, price.snapshot, first.old_token_id, price.blockNumber)
    setJobContext(first.job_id, 'performance_original_mint_basis', reconstructed)
    mintBasisRetryAfter.delete(first.job_id)
    return reconstructed
  } catch {
    // Historical RPC/indexer access can be temporarily unavailable. Retry
    // later, but never manufacture a basis from a subsequent principal exit.
    mintBasisRetryAfter.set(first.job_id, Date.now() + MINT_BASIS_RETRY_MS)
    return undefined
  }
}

/**
 * Build a mark-to-market strategy dashboard from durable receipts/ledger rows
 * and a fresh on-chain position snapshot. A strategy without a recorded start
 * or reconstructed original mint basis has no reportable P/L.
 */
export async function strategyPerformance(config: StrategyConfig, state: string) {
  const { cycles, ledger } = rowsForStrategy(config.id)
  const prices = new Map(cycles.map((cycle) => [cycle.id, cycleRebalancePrice(cycle)]))
  const first = cycles[0]
  const firstPrice = first ? cycleExitPrice(first) : undefined
  const mintBasis = first && firstPrice ? await originalMintBasis(first, config, firstPrice) : undefined
  const startBaseline = strategyBaseline(config.id)
  let baselineValue = startBaseline
    ? BigInt(startBaseline.valueQuoteRaw)
    : mintBasis
    ? BigInt(mintBasis.valueQuoteRaw)
    : 0n
  if (!startBaseline && mintBasis && firstPrice) {
    const precheck = getJobContext<{ prior?: Record<string, string> }>(first.job_id, 'precheck')
    for (const [token, raw] of Object.entries(precheck?.prior ?? {}))
      baselineValue += quoteTurnover(BigInt(raw), token as Address, config, firstPrice.snapshot, firstPrice.sqrtPriceX96)
  }

  const profitWithdrawals = ledger.filter((row) => row.kind === 'profit_withdrawal' && row.amount).flatMap((row) => {
    try {
      const meta = JSON.parse(row.meta_json) as Record<string, unknown>
      const target = meta.target
      if (target !== 'USDG' && target !== 'WETH' && target !== 'ETH') return []
      const txHashes = Array.isArray(meta.txHashes) ? meta.txHashes.filter((value): value is string => typeof value === 'string') : []
      return [{
        id: String(meta.id ?? row.tx_hash ?? `${target}-${row.amount}`),
        target,
        amountRaw: row.amount!,
        decimals: Number(meta.decimals ?? (target === 'USDG' ? 6 : 18)),
        quoteValueRaw: row.quote_value ?? '0',
        usdgValueRaw: typeof meta.usdgValueRaw === 'string' ? meta.usdgValueRaw : '0',
        gasWei: typeof meta.gasWei === 'string' ? meta.gasWei : '0',
        gasQuoteRaw: typeof meta.gasQuoteRaw === 'string' ? meta.gasQuoteRaw : '0',
        gasUsdgRaw: typeof meta.gasUsdgRaw === 'string' ? meta.gasUsdgRaw : '0',
        withdrawnAt: Number(meta.withdrawnAt ?? 0),
        txHashes,
      }]
    } catch { return [] }
  })
  // Distribution marks are frozen when funds leave strategy custody so later
  // token-price movement cannot rewrite already-realized performance.
  const withdrawnProfitQuote = sum(profitWithdrawals.map((row) => BigInt(row.quoteValueRaw)))
  const withdrawnProfitUsdg = sum(profitWithdrawals.map((row) => BigInt(row.usdgValueRaw)))
  const withdrawalGasQuote = sum(profitWithdrawals.map((row) => BigInt(row.gasQuoteRaw)))
  const withdrawalGasUsdg = sum(profitWithdrawals.map((row) => BigInt(row.gasUsdgRaw)))

  const feeByToken = new Map<string, { address: Address; gross: bigint; protocol: bigint; decimals: number }>()
  const referenceSnapshot = firstPrice?.snapshot
  for (const row of ledger.filter((entry) => entry.kind === 'fee_gross' || entry.kind === 'protocol_fee' || isRewardOutput(entry))) {
    if (!row.token || !row.amount || !referenceSnapshot) continue
    const address = row.token as Address
    const key = low(address)
    const decimals = low(address) === low(referenceSnapshot.token0) ? referenceSnapshot.token0Decimals : referenceSnapshot.token1Decimals
    const item = feeByToken.get(key) ?? { address, gross: 0n, protocol: 0n, decimals }
    if (row.kind === 'fee_gross' || isRewardOutput(row)) item.gross += BigInt(row.amount)
    else item.protocol += BigInt(row.amount)
    feeByToken.set(key, item)
  }

  let grossFeesQuote = 0n
  let protocolFeesQuote = 0n
  let incomeTaxQuote = 0n
  const openingGasWei = !startBaseline && mintBasis ? BigInt(mintBasis.openingGasWeiRaw) : 0n
  const gasValuation = valueGas(cycles, ledger, config, openingGasWei)
  const openingGasCostQuote = gasValuation.opening
  let gasCostQuote = openingGasCostQuote + withdrawalGasQuote
  let executionCostQuote = 0n
  const cycleDetails = cycles.map((cycle) => {
    const cycleRows = ledger.filter((row) => row.cycle_id === cycle.id)
    const price = prices.get(cycle.id)!
    const exitPrice = cycleExitPrice(cycle)
    const gross = quotedRows(cycleRows, 'fee_gross', config, price) + sum(cycleRows.filter(isRewardOutput).map((row) => quotedAmount(row, config, price)))
    const protocol = quotedRows(cycleRows, 'protocol_fee', config, price)
    const incomeTax = cycleIncomeTaxQuote(cycle, cycleRows, config, price)
    const gas = gasValuation.cycles.get(cycle.id) ?? 0n
    const gasUsdg = gasValuation.cyclesUsdg.get(cycle.id) ?? 0n
    grossFeesQuote += gross
    protocolFeesQuote += protocol
    incomeTaxQuote += incomeTax
    gasCostQuote += gas
    const execution = cycleExecutionCost(cycleRows, config, price)
    executionCostQuote += execution.quote
    let txHashes: string[] = []
    try { txHashes = JSON.parse(cycle.tx_hashes_json) as string[] } catch { txHashes = [] }
    return {
      id: cycle.id,
      oldTokenId: cycle.old_token_id,
      newTokenId: cycle.new_token_id,
      startedAt: cycle.started_at,
      completedAt: cycle.completed_at,
      triggerSide: cycle.trigger_side,
      grossFeesQuoteRaw: gross.toString(),
      protocolFeesQuoteRaw: protocol.toString(),
      incomeTaxQuoteRaw: incomeTax.toString(),
      incomeRetentionQuoteRaw: incomeTax.toString(),
      netFeesQuoteRaw: (gross - protocol - incomeTax).toString(),
      capitalQuoteRaw: quotedRows(cycleRows, 'principal_exit', config, exitPrice).toString(),
      gasCostQuoteRaw: gas.toString(),
      gasValuationComplete: gasValuation.cycleComplete.get(cycle.id) ?? true,
      gasCostUsdgRaw: gasUsdg.toString(),
      gasStableValuationComplete: gasValuation.cycleUsdgComplete.get(cycle.id) ?? true,
      executionCostQuoteRaw: execution.quote.toString(),
      maxExecutionImpactBps: execution.maxImpactBps,
      rangeScale: (JSON.parse(cycle.plan_json) as StrategyExecutionPlan).rangeScale ?? 1,
      riskDirection: riskDirection(cycle.trigger_side, config, price.snapshot),
      txHashes,
    }
  }).reverse()

  let currentValue = 0n
  let profitReserveQuote = 0n
  let currentUncollectedFees = 0n
  // Live pool-token fee claims (token0/token1 amounts) so the terminal can value
  // uncollected LP fees token-by-token instead of only through the quote mark.
  let uncollectedFeeClaims: { address: Address; decimals: number; raw: bigint }[] | undefined
  let currentUnclaimedReward = 0n
  let currentUnclaimedRewardQuote = 0n
  let rewardReadAvailable = true
  let rewardValuationError: string | undefined
  let currentPosition: { tokenId: string | null; tick: number | null; tickLower: number | null; tickUpper: number | null } = {
    tokenId: config.activeTokenId,
    tick: null,
    tickLower: null,
    tickUpper: null,
  }
  let quoteDecimals = referenceSnapshot
    ? (low(config.quoteToken) === low(referenceSnapshot.token0) ? referenceSnapshot.token0Decimals : referenceSnapshot.token1Decimals)
    : 18
  let liveError: string | undefined
  let priceSnapshot = referenceSnapshot
  try {
    const allocations = strategyAllocations(config.id)
    const allocationComponents = strategyAllocationComponents(config.id)
    if (config.activeTokenId) {
      const snapshot = await readPerformanceSnapshot(config)
      priceSnapshot = snapshot
      const fees = config.staking?.enabled
        ? { amount0: BigInt(snapshot.tokensOwed0), amount1: BigInt(snapshot.tokensOwed1) }
        : await readCollectableFees(config)
      const pool = { sqrtPriceX96: BigInt(snapshot.sqrtPriceX96), tick: snapshot.tick }
      const principal = getAmountsForLiquidity(
        pool.sqrtPriceX96,
        getSqrtRatioAtTick(snapshot.tickLower),
        getSqrtRatioAtTick(snapshot.tickUpper),
        BigInt(snapshot.liquidity),
      )
      quoteDecimals = low(config.quoteToken) === low(snapshot.token0) ? snapshot.token0Decimals : snapshot.token1Decimals
      const total0 = principal.amount0 + fees.amount0 + (allocations[low(snapshot.token0)] ?? 0n)
      const total1 = principal.amount1 + fees.amount1 + (allocations[low(snapshot.token1)] ?? 0n)
      currentValue = quoteTurnover(total0, snapshot.token0, config, snapshot, pool.sqrtPriceX96) + quoteTurnover(total1, snapshot.token1, config, snapshot, pool.sqrtPriceX96)
      profitReserveQuote = quoteTurnover(allocationComponents[low(snapshot.token0)]?.heldProfit ?? 0n, snapshot.token0, config, snapshot, pool.sqrtPriceX96)
        + quoteTurnover(allocationComponents[low(snapshot.token1)]?.heldProfit ?? 0n, snapshot.token1, config, snapshot, pool.sqrtPriceX96)
      currentUncollectedFees = quoteTurnover(fees.amount0, snapshot.token0, config, snapshot, pool.sqrtPriceX96) + quoteTurnover(fees.amount1, snapshot.token1, config, snapshot, pool.sqrtPriceX96)
      uncollectedFeeClaims = [
        { address: snapshot.token0, decimals: snapshot.token0Decimals, raw: fees.amount0 },
        { address: snapshot.token1, decimals: snapshot.token1Decimals, raw: fees.amount1 },
      ]
      rewardReadAvailable = !snapshot.rewardReadError
      if (snapshot.rewardReadError) rewardValuationError = snapshot.rewardReadError
      currentUnclaimedReward = config.staking?.enabled && rewardReadAvailable ? BigInt(snapshot.rewardOwed ?? '0') : 0n
      if (rewardReadAvailable && currentUnclaimedReward > 0n) {
        try {
          const rewardQuote = await quoteRewardToQuote(currentUnclaimedReward, config.quoteToken)
          currentUnclaimedRewardQuote = rewardQuote.amountOut
          currentValue += currentUnclaimedRewardQuote
        } catch (error) {
          rewardValuationError = error instanceof Error ? error.message.slice(0, 160) : 'reward valuation unavailable'
        }
      }
      currentPosition = { tokenId: snapshot.tokenId, tick: pool.tick, tickLower: snapshot.tickLower, tickUpper: snapshot.tickUpper }
    } else if (referenceSnapshot) {
      currentValue = sum(Object.entries(allocations).map(([token, raw]) => quoteTurnover(raw, token as Address, config, referenceSnapshot, firstPrice!.sqrtPriceX96)))
      profitReserveQuote = sum(Object.entries(allocationComponents).map(([token, component]) => quoteTurnover(component.heldProfit, token as Address, config, referenceSnapshot, firstPrice!.sqrtPriceX96)))
    }
  } catch (error) {
    liveError = error instanceof Error ? error.message.slice(0, 160) : 'live valuation unavailable'
  }

  const feeTokens = await Promise.all([...feeByToken.values()].map(async (item) => ({
    address: item.address,
    symbol: await tokenSymbol(item.address),
    decimals: item.decimals,
    grossRaw: item.gross.toString(),
    protocolRaw: item.protocol.toString(),
    netRaw: (item.gross - item.protocol).toString(),
  })))
  const quoteSymbol = await tokenSymbol(config.quoteToken)
  const riskSymbol = await tokenSymbol(config.riskToken)
  // Live claimable LP fees per pool token. Only available when the live
  // position snapshot was read cleanly; planned/archived rows carry null.
  const uncollectedFees = uncollectedFeeClaims && !liveError
    ? {
        token0: { address: uncollectedFeeClaims[0].address, symbol: await tokenSymbol(uncollectedFeeClaims[0].address), decimals: uncollectedFeeClaims[0].decimals, raw: uncollectedFeeClaims[0].raw.toString() },
        token1: { address: uncollectedFeeClaims[1].address, symbol: await tokenSymbol(uncollectedFeeClaims[1].address), decimals: uncollectedFeeClaims[1].decimals, raw: uncollectedFeeClaims[1].raw.toString() },
      }
    : null
  const baselineTick = startBaseline?.tick ?? mintBasis?.tick
  const startQuotePerRisk = baselineTick !== undefined && priceSnapshot
    ? quotePerRiskAtTick(baselineTick, config, priceSnapshot)
    : null
  const currentQuotePerRisk = currentPosition.tick !== null && priceSnapshot
    ? quotePerRiskAtTick(currentPosition.tick, config, priceSnapshot)
    : null
  const hasBaseline = Boolean(startBaseline || mintBasis)
  const valuationIncomplete = Boolean(liveError || rewardValuationError || !gasValuation.quoteComplete)
  const pnl = hasBaseline && !valuationIncomplete ? distributionAdjustedPnl({ currentValue, withdrawnValue: withdrawnProfitQuote, baselineValue, gasCost: gasCostQuote }) : undefined
  let baselineValueUsdg: bigint | undefined
  let currentValueUsdg: bigint | undefined
  let gasCostUsdg: bigint | undefined
  let stableValuationError: string | undefined
  let stableBaselineSource: 'recorded_at_start' | 'historical_weth_usdg' | undefined
  if (hasBaseline && !valuationIncomplete) {
    try {
      if (startBaseline?.valueUsdgRaw !== undefined) {
        baselineValueUsdg = BigInt(startBaseline.valueUsdgRaw)
        stableBaselineSource = 'recorded_at_start'
      } else {
        const baselineBlockNumber = startBaseline?.blockNumber ?? mintBasis?.blockNumber ?? firstPrice?.blockNumber
        if (!baselineBlockNumber) throw new Error('stable baseline block unavailable')
        baselineValueUsdg = await historicalQuoteValueInUsdg(baselineValue, config.quoteToken, BigInt(baselineBlockNumber))
        stableBaselineSource = 'historical_weth_usdg'
        if (startBaseline) setStrategyBaselineUsdgIfAbsent(config.id, baselineValueUsdg.toString())
      }
      if (!gasValuation.usdgComplete) throw new Error('pinned gas settlement valuation unavailable')
      const liveUsdg = await quoteValueInUsdg(currentValue, config.quoteToken)
      currentValueUsdg = liveUsdg
      gasCostUsdg = gasValuation.totalUsdg + withdrawalGasUsdg
    } catch (error) {
      stableValuationError = error instanceof Error ? error.message.slice(0, 160) : 'stable valuation unavailable'
    }
  }
  const pnlUsdg = baselineValueUsdg !== undefined && currentValueUsdg !== undefined && gasCostUsdg !== undefined
    ? distributionAdjustedPnl({ currentValue: currentValueUsdg, withdrawnValue: withdrawnProfitUsdg, baselineValue: baselineValueUsdg, gasCost: gasCostUsdg })
    : undefined
  const netFeesQuote = grossFeesQuote - protocolFeesQuote - incomeTaxQuote
  // Reconciliation: P/L = net income after tax - gas - execution cost + market/LP residual.
  // The residual includes token-price movement, concentrated-liquidity inventory
  // changes and any valuation drift between collection and the current mark.
  const marketAndLpQuote = pnl === undefined ? undefined : pnl - netFeesQuote + gasCostQuote + executionCostQuote
  const estimatedFeeAccounting = ledger.some((row) => {
    if (row.kind !== 'fee_gross' && row.kind !== 'protocol_fee') return false
    try { return JSON.parse(row.meta_json).estimated === true } catch { return false }
  })
  const warnings = [
    ...(startBaseline ? [startBaseline.source === 'baseline_backfill' ? 'pnl_baseline_backfilled' : 'pnl_baseline_strategy_start']
      : mintBasis ? ['pnl_baseline_original_mint']
      : first ? ['pnl_baseline_mint_unavailable']
      : ['pnl_baseline_not_available']),
    ...(!gasValuation.quoteComplete ? ['gas_historical_price_unavailable'] : []),
    ...(!gasValuation.usdgComplete ? ['gas_stable_price_unavailable'] : []),
    ...(estimatedFeeAccounting ? ['protocol_fee_reconstructed'] : []),
    ...(liveError ? ['live_valuation_unavailable'] : []),
    ...(rewardValuationError ? ['reward_valuation_unavailable'] : []),
    ...(stableValuationError ? ['stable_valuation_unavailable'] : []),
    ...(['planned', 'executing', 'recovery', 'recovery_quarantined'].includes(state) ? ['execution_in_progress'] : []),
  ]

  return {
    strategyId: config.id,
    calculatedAt: Math.floor(Date.now() / 1000),
    state,
    quote: { address: config.quoteToken, symbol: quoteSymbol, decimals: quoteDecimals },
    stable: { address: SETTLEMENT, symbol: EXECUTOR.network.settlementSymbol, decimals: EXECUTOR.network.settlementDecimals, baselineSource: stableBaselineSource },
    risk: { address: config.riskToken, symbol: riskSymbol },
    price: { startQuotePerRisk, currentQuotePerRisk },
    uncollectedFees,
    summary: {
      reopens: cycles.filter((cycle) => cycle.new_token_id !== null).length,
      grossFeesQuoteRaw: grossFeesQuote.toString(),
      protocolFeesQuoteRaw: protocolFeesQuote.toString(),
      incomeTaxQuoteRaw: incomeTaxQuote.toString(),
      incomeRetentionQuoteRaw: incomeTaxQuote.toString(),
      incomeRetentionBps: INCOME_RETENTION_BPS,
      incomeRetentionCustody: INCOME_RETENTION_CUSTODY,
      platformRevenueQuoteRaw: '0',
      netFeesQuoteRaw: netFeesQuote.toString(),
      gasCostQuoteRaw: gasCostQuote.toString(),
      openingGasCostQuoteRaw: openingGasCostQuote.toString(),
      gasValuationComplete: gasValuation.quoteComplete,
      executionCostQuoteRaw: executionCostQuote.toString(),
      marketAndLpQuoteRaw: marketAndLpQuote?.toString() ?? null,
      currentValueQuoteRaw: liveError ? null : currentValue.toString(),
      profitReserveQuoteRaw: liveError ? null : profitReserveQuote.toString(),
      withdrawnProfitQuoteRaw: withdrawnProfitQuote.toString(),
      withdrawnProfitUsdgRaw: withdrawnProfitUsdg.toString(),
      currentUncollectedFeesQuoteRaw: liveError ? null : currentUncollectedFees.toString(),
      currentUnclaimedRewardsQuoteRaw: rewardValuationError ? null : currentUnclaimedRewardQuote.toString(),
      currentUnclaimedTotalQuoteRaw: liveError || rewardValuationError ? null : (currentUncollectedFees + currentUnclaimedRewardQuote).toString(),
      baselineValueQuoteRaw: hasBaseline ? baselineValue.toString() : null,
      pnlQuoteRaw: pnl?.toString() ?? null,
      pnlPct: pnl === undefined ? null : pnlPct(pnl, baselineValue),
      currentValueUsdgRaw: currentValueUsdg?.toString() ?? null,
      baselineValueUsdgRaw: baselineValueUsdg?.toString() ?? null,
      gasCostUsdgRaw: gasCostUsdg?.toString() ?? null,
      pnlUsdgRaw: pnlUsdg?.toString() ?? null,
      pnlUsdgPct: pnlUsdg === undefined || baselineValueUsdg === undefined ? null : pnlPct(pnlUsdg, baselineValueUsdg),
    },
    baseline: startBaseline ? {
      kind: 'strategy_start',
      at: startBaseline.observedAt,
      tokenId: startBaseline.tokenId,
      priceSource: 'strategy_start_snapshot',
      blockNumber: startBaseline.blockNumber,
      tick: startBaseline.tick,
    } : mintBasis ? {
      kind: 'original_mint',
      at: mintBasis.observedAt,
      tokenId: mintBasis.tokenId,
      priceSource: 'mint_block',
      blockNumber: mintBasis.blockNumber,
      tick: mintBasis.tick,
      txHash: mintBasis.txHash,
    } : null,
    currentPosition,
    unclaimedReward: config.staking?.enabled && rewardReadAvailable ? {
      address: config.staking.rewardToken!,
      symbol: 'UP',
      decimals: 18,
      raw: currentUnclaimedReward.toString(),
      quoteRaw: rewardValuationError ? null : currentUnclaimedRewardQuote.toString(),
    } : null,
    feeTokens,
    profitWithdrawals: profitWithdrawals.reverse(),
    cycles: cycleDetails,
    warnings,
    error: liveError,
    rewardValuationError,
    stableValuationError,
  }
}

/** Capture the same total-assets mark used by the dashboard at strategy start. */
export async function observeStrategyBaseline(
  config: StrategyConfig,
  source: StrategyBaseline['source'] = 'strategy_start',
): Promise<StrategyBaseline> {
  if (!config.activeTokenId) throw new Error('strategy has no active token id')
  const snapshot = await readPerformanceSnapshot(config)
  const fees = config.staking?.enabled
    ? { amount0: BigInt(snapshot.tokensOwed0), amount1: BigInt(snapshot.tokensOwed1) }
    : await readCollectableFees(config)
  const sqrtPriceX96 = BigInt(snapshot.sqrtPriceX96)
  const principal = getAmountsForLiquidity(
    sqrtPriceX96,
    getSqrtRatioAtTick(snapshot.tickLower),
    getSqrtRatioAtTick(snapshot.tickUpper),
    BigInt(snapshot.liquidity),
  )
  const allocations = strategyAllocations(config.id)
  const total0 = principal.amount0 + fees.amount0 + (allocations[low(snapshot.token0)] ?? 0n)
  const total1 = principal.amount1 + fees.amount1 + (allocations[low(snapshot.token1)] ?? 0n)
  let value = quoteTurnover(total0, snapshot.token0, config, snapshot, sqrtPriceX96)
    + quoteTurnover(total1, snapshot.token1, config, snapshot, sqrtPriceX96)
  const rewardOwed = config.staking?.enabled ? BigInt(snapshot.rewardOwed ?? '0') : 0n
  if (rewardOwed > 0n) value += (await quoteRewardToQuote(rewardOwed, config.quoteToken)).amountOut
  const valueUsdgRaw = await quoteValueInUsdg(value, config.quoteToken).then(String).catch(() => undefined)
  return {
    strategyId: config.id,
    valueQuoteRaw: value.toString(),
    valueUsdgRaw,
    quoteToken: config.quoteToken,
    observedAt: snapshot.observedAt,
    blockNumber: snapshot.blockNumber,
    tokenId: snapshot.tokenId,
    tick: snapshot.tick,
    source,
  }
}

/** Accounting still available for archives that predate a frozen final mark. */
export async function archivedAccountingPerformance(config: StrategyConfig, archivedAt: number) {
  const { cycles, ledger } = rowsForStrategy(config.id)
  const prices = new Map(cycles.map((cycle) => [cycle.id, cycleRebalancePrice(cycle)]))
  const referenceSnapshot = cycles[0] ? cycleExitPrice(cycles[0]).snapshot : undefined
  const gasValuation = valueGas(cycles, ledger, config, 0n)
  let grossFeesQuote = 0n, protocolFeesQuote = 0n, incomeTaxQuote = 0n, gasCostQuote = 0n, executionCostQuote = 0n
  const cycleDetails = cycles.map((cycle) => {
    const rows = ledger.filter((row) => row.cycle_id === cycle.id)
    const price = prices.get(cycle.id)!
    const exitPrice = cycleExitPrice(cycle)
    const gross = quotedRows(rows, 'fee_gross', config, price) + sum(rows.filter(isRewardOutput).map((row) => quotedAmount(row, config, price)))
    const protocol = quotedRows(rows, 'protocol_fee', config, price)
    const incomeTax = cycleIncomeTaxQuote(cycle, rows, config, price)
    const gas = gasValuation.cycles.get(cycle.id) ?? 0n
    const gasUsdg = gasValuation.cyclesUsdg.get(cycle.id) ?? 0n
    const execution = cycleExecutionCost(rows, config, price)
    grossFeesQuote += gross; protocolFeesQuote += protocol; incomeTaxQuote += incomeTax; gasCostQuote += gas; executionCostQuote += execution.quote
    let txHashes: string[] = []
    try { txHashes = JSON.parse(cycle.tx_hashes_json) as string[] } catch { txHashes = [] }
    return { id: cycle.id, oldTokenId: cycle.old_token_id, newTokenId: cycle.new_token_id, startedAt: cycle.started_at, completedAt: cycle.completed_at,
      triggerSide: cycle.trigger_side, grossFeesQuoteRaw: gross.toString(), protocolFeesQuoteRaw: protocol.toString(), incomeTaxQuoteRaw: incomeTax.toString(), incomeRetentionQuoteRaw: incomeTax.toString(), netFeesQuoteRaw: (gross - protocol - incomeTax).toString(),
      capitalQuoteRaw: quotedRows(rows, 'principal_exit', config, exitPrice).toString(), gasCostQuoteRaw: gas.toString(), gasValuationComplete: gasValuation.cycleComplete.get(cycle.id) ?? true,
      gasCostUsdgRaw: gasUsdg.toString(), gasStableValuationComplete: gasValuation.cycleUsdgComplete.get(cycle.id) ?? true,
      executionCostQuoteRaw: execution.quote.toString(), maxExecutionImpactBps: execution.maxImpactBps,
      riskDirection: riskDirection(cycle.trigger_side, config, price.snapshot), txHashes }
  }).reverse()
  const quoteDecimals = referenceSnapshot ? (low(config.quoteToken) === low(referenceSnapshot.token0) ? referenceSnapshot.token0Decimals : referenceSnapshot.token1Decimals) : 18
  return {
    strategyId: config.id, calculatedAt: archivedAt, state: 'archived',
    quote: { address: config.quoteToken, symbol: await tokenSymbol(config.quoteToken), decimals: quoteDecimals },
    stable: { address: SETTLEMENT, symbol: EXECUTOR.network.settlementSymbol, decimals: EXECUTOR.network.settlementDecimals },
    risk: { address: config.riskToken, symbol: await tokenSymbol(config.riskToken) },
    summary: { reopens: cycles.filter((cycle) => cycle.new_token_id !== null).length, grossFeesQuoteRaw: grossFeesQuote.toString(),
      protocolFeesQuoteRaw: protocolFeesQuote.toString(), incomeTaxQuoteRaw: incomeTaxQuote.toString(), incomeRetentionQuoteRaw: incomeTaxQuote.toString(), incomeRetentionBps: INCOME_RETENTION_BPS, incomeRetentionCustody: INCOME_RETENTION_CUSTODY, platformRevenueQuoteRaw: '0', netFeesQuoteRaw: (grossFeesQuote - protocolFeesQuote - incomeTaxQuote).toString(), gasCostQuoteRaw: gasCostQuote.toString(),
      openingGasCostQuoteRaw: '0', gasValuationComplete: gasValuation.quoteComplete, executionCostQuoteRaw: executionCostQuote.toString(), marketAndLpQuoteRaw: null, currentValueQuoteRaw: null,
      profitReserveQuoteRaw: null, withdrawnProfitQuoteRaw: '0', withdrawnProfitUsdgRaw: '0',
      currentUncollectedFeesQuoteRaw: null, currentUnclaimedRewardsQuoteRaw: null, currentUnclaimedTotalQuoteRaw: null,
      baselineValueQuoteRaw: null, pnlQuoteRaw: null, pnlPct: null,
      currentValueUsdgRaw: null, baselineValueUsdgRaw: null, gasCostUsdgRaw: null, pnlUsdgRaw: null, pnlUsdgPct: null },
    baseline: null, currentPosition: { tokenId: config.activeTokenId, tick: null, tickLower: null, tickUpper: null },
    uncollectedFees: null,
    unclaimedReward: null, feeTokens: [], profitWithdrawals: [], cycles: cycleDetails, warnings: ['historical_final_valuation_unavailable', ...(!gasValuation.quoteComplete ? ['gas_historical_price_unavailable'] : [])],
  }
}

/** Performance valuation is intentionally much slower than boundary monitoring. */
export async function cachedStrategyPerformance(config: StrategyConfig, state: string) {
  const key = `${config.id}:${config.revision}:${state}`
  const now = Date.now()
  const existing = performanceCache.get(key)
  if (existing?.value && existing.expiresAt > now) return existing.value
  if (existing?.pending) return existing.pending
  for (const staleKey of performanceCache.keys()) if (staleKey.startsWith(`${config.id}:`) && staleKey !== key) performanceCache.delete(staleKey)
  const pending = strategyPerformance(config, state).then((value) => {
    performanceCache.set(key, { value, expiresAt: Date.now() + PERFORMANCE_CACHE_MS })
    return value
  }).catch((error) => {
    performanceCache.delete(key)
    throw error
  })
  performanceCache.set(key, { pending, expiresAt: now + PERFORMANCE_CACHE_MS })
  return pending
}

export function invalidateStrategyPerformance(strategyId: string) {
  for (const key of performanceCache.keys()) if (key.startsWith(`${strategyId}:`)) performanceCache.delete(key)
}
