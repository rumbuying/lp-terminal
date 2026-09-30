import { encodeFunctionData, parseUnits, zeroAddress, type Address, type Hex, type TransactionReceipt } from 'viem'
import { clFactoryAbi, clPoolAbi, erc20Abi } from '../src/abi'
import { fablesHookAbi } from '../src/abi/fables'
import { ADDR } from '../src/config/addresses'
import { buildDirectTransaction, type DirectRoute } from '../src/lib/directSwap'
import { applySlippage } from '../src/lib/clmath'
import { FABLES_AUTO_POOL_IDS } from '../src/config/fables'
import { readFablesPosition } from '../src/lib/fables'
import { quoteFablesExit } from '../src/lib/fablesExitQuote'
import { prepareFablesClaimCall, prepareFablesDepositCall, prepareFablesExitCall } from '../src/lib/fablesWrite'
import { planBalanceSwap } from '../shared/strategy/rebalance'
import { fablesRangeId } from '../src/lib/fables'
import { quoteKyber, quoteNativeExecutable, gatedKyberTx } from './kyber'
import { publicClient, readAllowance, readTokenBalances } from './chain'
import { EXECUTOR } from './config'
import { allocateFablesFees, claimedFablesFees, cycleOwnedAmounts, cycleSpendableAmounts, fablesSweepFloor, fablesSwapImpactBps, freshFablesRange, mintedFablesShares, type FablesAmounts } from './fablesCycle'
import { completedFablesCyclesSince, activeFablesJobs, appendFablesLedger, cancelFablesJobBackInRange, completeFablesJob,
  failFablesJobBeforeMutation, fablesJobById, fablesJobTransactions, markFablesTurnover,
  reserveFablesTurnover, setFablesJobProgress,
  type FablesCycleFact, type FablesJob, type FablesJobStage } from './fablesJobs'
import { fablesTokenDecimals } from './fablesPlan'
import { FABLES_APPROVAL_LIMIT, fablesApprovalAmount, directBuildCurrency } from './fablesLimits'
import { fablesRecoveryRequiresReview, reconcileFablesTransactions } from './fablesRecovery'
import { sendFablesTracked, type FablesSafeTx } from './fablesSigner'
import { audit, executorPaused } from './store'
import { unlockPrivateKey } from './vault'
import { walletBusy, withWalletLock } from './wallet-lock'

const lower = (address: string) => address.toLowerCase()
const routeCurrency = (address: Address) => lower(address) === lower(zeroAddress) ? ADDR.WNATIVE : address
async function quoteFablesRoute(tokenIn: Address, tokenOut: Address, amountIn: bigint, maxLagBps: number) {
  const native = lower(tokenIn) === lower(zeroAddress) || lower(tokenOut) === lower(zeroAddress)
  const route = native
    ? await quoteNativeExecutable(routeCurrency(tokenIn), routeCurrency(tokenOut), amountIn, maxLagBps)
    : await quoteKyber(routeCurrency(tokenIn), routeCurrency(tokenOut), amountIn)
  if (native && !['up33_cl', 'univ3'].includes(route.routeSummary.executorSource ?? ''))
    throw new Error('E_FABLES_NATIVE_ROUTE')
  return route
}
const nextOrdinal = (job: FablesJob) => fablesJobTransactions(job.id).reduce((max, tx) => Math.max(max, tx.ordinal + 1), 0)
const lastConfirmed = (job: FablesJob, stage: FablesJobStage) =>
  fablesJobTransactions(job.id).filter(tx => tx.stage === stage && tx.state === 'confirmed').at(-1)
const nextContext = (job: FablesJob, patch: Record<string, unknown>) => ({ ...job.context, ...patch })

type StoredAmounts = { amount0: string; amount1: string }
const savedAmounts = (value: unknown, name: string): FablesAmounts => {
  if (!value || typeof value !== 'object') throw new Error(`E_FABLES_CONTEXT_${name}`)
  const row = value as StoredAmounts
  return { amount0: BigInt(row.amount0), amount1: BigInt(row.amount1) }
}
const serializeAmounts = (value: FablesAmounts): StoredAmounts => ({ amount0: value.amount0.toString(), amount1: value.amount1.toString() })
const nativeCycleGasBudget = async (job: FablesJob) => {
  const estimatedGas = await publicClient.getGasPrice() * 5_000_000n
  const reserve = BigInt(job.config.safeguards.minNativeGasReserveWei)
  return { estimatedGas, reserve: estimatedGas > reserve ? estimatedGas : reserve }
}

async function walletAmounts(owner: Address, currency0: Address, currency1: Address): Promise<FablesAmounts> {
  const balances = await readTokenBalances(owner, [currency0, currency1])
  return { amount0: balances[lower(currency0)], amount1: balances[lower(currency1)] }
}

async function spendableCycleAmounts(job: FablesJob, currencies: { currency0: Address; currency1: Address },
  current: FablesAmounts): Promise<FablesAmounts> {
  const { estimatedGas, reserve } = await nativeCycleGasBudget(job)
  return cycleSpendableAmounts({ ...currencies, current,
    nativeGasReserve: fablesSweepFloor(reserve, estimatedGas) })
}

async function receiptFor(job: FablesJob, stage: FablesJobStage): Promise<TransactionReceipt | undefined> {
  const tx = lastConfirmed(job, stage)
  return tx ? publicClient.getTransactionReceipt({ hash: tx.hash }) : undefined
}

function ensureIdentity(job: FablesJob, position: Awaited<ReturnType<typeof readFablesPosition>>): void {
  const ref = job.config.positionRef
  if (lower(position.owner) !== lower(job.config.owner)
    || lower(position.pool.id) !== lower(ref.poolId)
    || lower(position.pool.key.hooks) !== lower(ref.hook)
    || position.tickLower !== ref.tickLower || position.tickUpper !== ref.tickUpper)
    throw new Error('E_FABLES_POSITION_CHANGED')
}

async function precheck(job: FablesJob): Promise<void> {
  if (!FABLES_AUTO_POOL_IDS.has(lower(job.config.positionRef.poolId))) throw new Error('E_FABLES_AUTO_POOL_NOT_APPROVED')
  const position = await readFablesPosition(publicClient, {
    owner: job.config.owner, hook: job.config.positionRef.hook, rangeId: BigInt(job.config.positionRef.rangeId),
  })
  ensureIdentity(job, position)
  if (position.shares <= 0n || position.staked !== 0n || position.claimPaused)
    throw new Error('E_FABLES_PRECHECK_POSITION')
  const currencies = [position.pool.key.currency0, position.pool.key.currency1].map(lower)
  if (!currencies.includes(lower(job.config.riskToken))
    || !currencies.includes(lower(job.config.quoteToken)))
    throw new Error('E_FABLES_TOKENS')
  if (position.inRange) throw new Error('E_FABLES_BACK_IN_RANGE')
  const exitQuote = await quoteFablesExit(publicClient, { owner: job.config.owner,
    hook: job.config.positionRef.hook, rangeId: BigInt(job.config.positionRef.rangeId),
    slippageBps: job.config.safeguards.maxSlippageBps })
  if (exitQuote.principal0 === 0n && exitQuote.principal1 === 0n)
    throw new Error('E_FABLES_EMPTY_PRINCIPAL')
  const { estimatedGas, reserve } = await nativeCycleGasBudget(job)
  const [latestNonce, pendingNonce, balance] = await Promise.all([
    publicClient.getTransactionCount({ address: job.config.owner, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: job.config.owner, blockTag: 'pending' }),
    walletAmounts(job.config.owner, position.pool.key.currency0, position.pool.key.currency1),
  ])
  if (latestNonce !== pendingNonce) throw new Error('E_FABLES_WALLET_PENDING_TX')
  const nativeBalance = lower(position.pool.key.currency0) === lower(zeroAddress)
    ? balance.amount0 : await publicClient.getBalance({ address: job.config.owner })
  // The wallet must already cover an estimated cycle of gas plus its final
  // reserve; then principal from this LP can be used without taking unrelated
  // wallet capital. Post-receipt spending still checks the live balance.
  if (nativeBalance < reserve + estimatedGas) throw new Error('E_FABLES_GAS_RESERVE')
  const spendable0 = exitQuote.principal0
  const spendable1 = exitQuote.principal1
  if (spendable0 === 0n || spendable1 === 0n) {
    const tokenIn = spendable0 > 0n ? position.pool.key.currency0 : position.pool.key.currency1
    const tokenOut = spendable0 > 0n ? position.pool.key.currency1 : position.pool.key.currency0
    await quoteFablesRoute(tokenIn, tokenOut, (spendable0 > 0n ? spendable0 : spendable1) / 4n || 1n,
      job.config.safeguards.maxSlippageBps)
  }
  if (completedFablesCyclesSince(job.strategyId, Math.floor(Date.now() / 1000) - 86_400)
    >= job.config.safeguards.maxRebalancesPerDay) throw new Error('E_FABLES_DAILY_COUNT')
  setFablesJobProgress(job.id, { stage: 'exit', context: nextContext(job, {
    oldShares: position.shares.toString(), baseline: serializeAmounts(balance),
    currency0: position.pool.key.currency0, currency1: position.pool.key.currency1,
    precheckBlock: position.observedBlock.toString(),
  }) })
}

async function exitOldRange(job: FablesJob, privateKey: Hex): Promise<void> {
  const confirmed = lastConfirmed(job, 'exit')
  if (!confirmed) {
    const call = await prepareFablesExitCall(publicClient, {
      owner: job.config.owner, hook: job.config.positionRef.hook,
      rangeId: BigInt(job.config.positionRef.rangeId),
      expectedShares: BigInt(String(job.context.oldShares)),
      requireOutOfRange: true,
      slippageBps: job.config.safeguards.maxSlippageBps,
      maxClaimFeeBps: job.config.safeguards.maxClaimFeeBps,
      lifetimeSeconds: job.config.safeguards.maxPlanAgeSeconds,
      allowLegacyUnboundedFeeExit: job.config.safeguards.allowLegacyUnboundedFeeExit,
    })
    setFablesJobProgress(job.id, { context: nextContext(job, { exitMinimum: serializeAmounts({
      amount0: call.amount0Min, amount1: call.amount1Min,
    }) }) })
    await sendFablesTracked({ job, stage: 'exit', ordinal: nextOrdinal(job), privateKey,
      tx: { to: call.to, data: call.data, value: call.value } })
  }
  const position = await readFablesPosition(publicClient, {
    owner: job.config.owner, hook: job.config.positionRef.hook,
    rangeId: BigInt(job.config.positionRef.rangeId), allowEmpty: true,
  })
  ensureIdentity(job, position)
  if (position.shares !== 0n) throw new Error('E_FABLES_EXIT_NOT_COMPLETE')
  const minimum = savedAmounts(fablesJobById(job.id)!.context.exitMinimum, 'EXIT_MINIMUM')
  const baseline = savedAmounts(job.context.baseline, 'BASELINE')
  const current = await walletAmounts(job.config.owner,
    position.pool.key.currency0, position.pool.key.currency1)
  const exitReceipt = await receiptFor(job, 'exit')
  if (!exitReceipt) throw new Error('E_FABLES_EXIT_RECEIPT_MISSING')
  const gas = exitReceipt.gasUsed * exitReceipt.effectiveGasPrice
  const paid0 = current.amount0 - baseline.amount0
    + (lower(position.pool.key.currency0) === lower(zeroAddress) ? gas : 0n)
  const paid1 = current.amount1 - baseline.amount1
    + (lower(position.pool.key.currency1) === lower(zeroAddress) ? gas : 0n)
  if (paid0 < minimum.amount0 || paid1 < minimum.amount1)
    throw new Error('E_FABLES_EXIT_UNDERPAID')
  setFablesJobProgress(job.id, { stage: 'claim' })
}

async function claimOldFees(job: FablesJob, privateKey: Hex): Promise<void> {
  const position = await readFablesPosition(publicClient, {
    owner: job.config.owner, hook: job.config.positionRef.hook,
    rangeId: BigInt(job.config.positionRef.rangeId), allowEmpty: true,
  })
  ensureIdentity(job, position)
  if (position.shares !== 0n) throw new Error('E_FABLES_EXIT_NOT_COMPLETE')
  if (position.claimable0 > 0n || position.claimable1 > 0n) {
    if (position.claimPaused) throw new Error('E_FABLES_CLAIM_PAUSED')
    if (lastConfirmed(job, 'claim')) throw new Error('E_FABLES_FEES_STILL_OWED')
    const call = await prepareFablesClaimCall(publicClient, {
      owner: job.config.owner, hook: job.config.positionRef.hook,
      rangeId: BigInt(job.config.positionRef.rangeId),
      maxClaimFeeBps: job.config.safeguards.maxClaimFeeBps,
    })
    await sendFablesTracked({ job, stage: 'claim', ordinal: nextOrdinal(job), privateKey,
      tx: { to: call.to, data: call.data, value: call.value } })
  }
  const after = await readFablesPosition(publicClient, {
    owner: job.config.owner, hook: job.config.positionRef.hook,
    rangeId: BigInt(job.config.positionRef.rangeId), allowEmpty: true,
  })
  if (after.shares !== 0n || after.claimable0 !== 0n || after.claimable1 !== 0n)
    throw new Error('E_FABLES_CLAIM_NOT_COMPLETE')
  const [exitReceipt, claimReceipt] = await Promise.all([receiptFor(job, 'exit'), receiptFor(job, 'claim')])
  if (!exitReceipt) throw new Error('E_FABLES_EXIT_RECEIPT_MISSING')
  const exitFees = claimedFablesFees(exitReceipt, position.pool.key.hooks, job.config.owner, position.rangeId)
  const claimFees = claimReceipt
    ? claimedFablesFees(claimReceipt, position.pool.key.hooks, job.config.owner, position.rangeId)
    : { amount0: 0n, amount1: 0n }
  const fees = { amount0: exitFees.amount0 + claimFees.amount0, amount1: exitFees.amount1 + claimFees.amount1 }
  setFablesJobProgress(job.id, { stage: 'balance', context: nextContext(job, { fees: serializeAmounts(fees) }) })
}

type StoredSwap = { tokenIn: Address; tokenOut: Address; amountIn: string; quotedOut: string;
  spender?: Address; minOut?: string; before?: StoredAmounts; txHash?: Hex }

async function balanceAndPlan(job: FablesJob): Promise<void> {
  const position = await readFablesPosition(publicClient, {
    owner: job.config.owner, hook: job.config.positionRef.hook,
    rangeId: BigInt(job.config.positionRef.rangeId), allowEmpty: true,
  })
  ensureIdentity(job, position)
  if (position.shares !== 0n || position.claimable0 !== 0n || position.claimable1 !== 0n)
    throw new Error('E_FABLES_OLD_RANGE_NOT_SETTLED')
  const key = position.pool.key
  const [current, dec0, dec1] = await Promise.all([
    walletAmounts(job.config.owner, key.currency0, key.currency1),
    fablesTokenDecimals(key.currency0, position.observedBlock),
    fablesTokenDecimals(key.currency1, position.observedBlock),
  ])
  if (dec0 < 0 || dec0 > 36 || dec1 < 0 || dec1 > 36)
    throw new Error('E_FABLES_TOKEN_DECIMALS')
  const baseline = savedAmounts(job.context.baseline, 'BASELINE')
  const funds = await spendableCycleAmounts(job, key, current)
  const fees = savedAmounts(job.context.fees, 'FEES')
  const realized = job.context.feeConversionDone
    ? savedAmounts(job.context.realized, 'REALIZED')
    : (() => {
        const gas = fablesJobTransactions(job.id).filter(tx => tx.state === 'confirmed')
          .reduce((sum, tx) => sum + (tx.gasUsed ?? 0n) * (tx.gasPrice ?? 0n), 0n)
        return {
          amount0: current.amount0 - baseline.amount0 + (key.currency0 === zeroAddress ? gas : 0n),
          amount1: current.amount1 - baseline.amount1 + (key.currency1 === zeroAddress ? gas : 0n),
        }
      })()
  if (realized.amount0 < fees.amount0 || realized.amount1 < fees.amount1)
    throw new Error('E_FABLES_FEE_ACCOUNTING')
  const principal = job.context.feeConversionDone
    ? savedAmounts(job.context.principal, 'PRINCIPAL')
    : { amount0: realized.amount0 - fees.amount0, amount1: realized.amount1 - fees.amount1 }
  const initialAllocation = allocateFablesFees(funds, fees, job.config.fees.handling)
  const storedHeld = job.context.feeConversionDone
    ? savedAmounts(job.context.heldFees, 'HELD_FEES')
    : initialAllocation.held
  const held = {
    amount0: storedHeld.amount0 < funds.amount0 ? storedHeld.amount0 : funds.amount0,
    amount1: storedHeld.amount1 < funds.amount1 ? storedHeld.amount1 : funds.amount1,
  }
  const lp = { amount0: funds.amount0 - held.amount0, amount1: funds.amount1 - held.amount1 }
  const contextBase = nextContext(job, {
    principal: serializeAmounts(principal), realized: serializeAmounts(realized),
    heldFees: serializeAmounts(held), dec0, dec1,
  })
  if (job.config.fees.handling === 'convert_to_quote' && !job.context.feeConversionDone) {
    const riskIs0 = lower(job.config.riskToken) === lower(key.currency0)
    const feeRisk = riskIs0 ? held.amount0 : held.amount1
    if (feeRisk > 0n) {
      const route = await quoteFablesRoute(job.config.riskToken,
        job.config.quoteToken, feeRisk, job.config.safeguards.maxSlippageBps)
      const impact = fablesSwapImpactBps({ amountIn: feeRisk,
        quotedOut: BigInt(route.routeSummary.amountOut), tokenIn: job.config.riskToken,
        currency0: key.currency0, sqrtPriceX96: position.sqrtPriceX96 })
      if (impact > BigInt(job.config.safeguards.maxSwapImpactBps)) throw new Error('E_FABLES_SWAP_IMPACT')
      setFablesJobProgress(job.id, { stage: 'fee_conversion_approval', context: {
        ...contextBase,
        feeSwap: { tokenIn: job.config.riskToken, tokenOut: job.config.quoteToken,
          amountIn: feeRisk.toString(), quotedOut: route.routeSummary.amountOut } satisfies StoredSwap,
      } })
      return
    }
  }
  const range = freshFablesRange(job.config, position, dec0, dec1)
  const swap = await planBalanceSwap({
    token0: key.currency0, token1: key.currency1,
    balance0: lp.amount0, balance1: lp.amount1,
    units: range.units,
    quote: async (tokenIn, tokenOut, amountIn) => {
      const result = await quoteFablesRoute(tokenIn, tokenOut, amountIn,
        job.config.safeguards.maxSlippageBps)
      return { amountOut: BigInt(result.routeSummary.amountOut), route: result.routeSummary }
    },
  })
  const context = {
    ...contextBase,
    previewRange: { tickLower: range.tickLower, tickUpper: range.tickUpper,
      observedBlock: position.observedBlock.toString() },
  }
  if (!swap) {
    // A prior quote may have reserved turnover before a price change sent the
    // job back to balance planning. No LP swap will be sent for this plan.
    const limit = job.config.execution.maxDailyTurnoverQuote
    if (limit) reserveFablesTurnover({ jobId: job.id, ordinal: 0, walletId: job.walletId,
      quoteToken: job.config.quoteToken, amount: 0n,
      limit: parseUnits(limit, lower(job.config.quoteToken) === lower(key.currency0) ? dec0 : dec1) })
    setFablesJobProgress(job.id, { stage: 'deposit_approval', context: { ...context, swap: null } })
    return
  }
  const impact = fablesSwapImpactBps({ amountIn: swap.amountIn, quotedOut: swap.amountOut,
    tokenIn: swap.tokenIn, currency0: key.currency0, sqrtPriceX96: position.sqrtPriceX96 })
  if (impact > BigInt(job.config.safeguards.maxSwapImpactBps)) throw new Error('E_FABLES_SWAP_IMPACT')
  const quoteDecimals = lower(job.config.quoteToken) === lower(key.currency0) ? dec0 : dec1
  const turnover = lower(swap.tokenIn) === lower(job.config.quoteToken) ? swap.amountIn : swap.amountOut
  const limit = job.config.execution.maxDailyTurnoverQuote
  if (!limit) throw new Error('E_FABLES_DAILY_LIMIT_MISSING')
  reserveFablesTurnover({ jobId: job.id, ordinal: 0, walletId: job.walletId,
    quoteToken: job.config.quoteToken, amount: turnover, limit: parseUnits(limit, quoteDecimals) })
  const storedSwap: StoredSwap = { tokenIn: swap.tokenIn, tokenOut: swap.tokenOut,
    amountIn: swap.amountIn.toString(), quotedOut: swap.amountOut.toString() }
  setFablesJobProgress(job.id, { stage: 'swap_approval', context: { ...context, swap: storedSwap } })
}

type SwapPurpose = 'fee' | 'lp'
const swapField = (purpose: SwapPurpose) => purpose === 'fee' ? 'feeSwap' : 'swap'
const swapStage = (purpose: SwapPurpose): FablesJobStage => purpose === 'fee' ? 'fee_conversion' : 'swap'
const approvalStage = (purpose: SwapPurpose): FablesJobStage => purpose === 'fee' ? 'fee_conversion_approval' : 'swap_approval'

function storedSwapOf(job: FablesJob, purpose: SwapPurpose): StoredSwap {
  const swap = job.context[swapField(purpose)]
  if (!swap || typeof swap !== 'object') throw new Error('E_FABLES_SWAP_CONTEXT')
  return swap as StoredSwap
}

async function approveToken(job: FablesJob, privateKey: Hex, stage: FablesJobStage,
  token: Address, spender: Address, amount: bigint): Promise<boolean> {
  if (lower(token) === lower(zeroAddress) || amount === 0n) return false
  const allowance = await readAllowance(token, job.config.owner, spender)
  if (allowance >= amount) return false
  const attempts = fablesJobTransactions(job.id).filter(tx => tx.stage === stage && tx.state === 'confirmed').length
  if (attempts >= FABLES_APPROVAL_LIMIT) throw new Error('E_FABLES_APPROVAL_CHURN')
  // Zero first for ERC-20 tokens that reject a nonzero-to-nonzero approval.
  // The covering amount carries a pad so a re-plan that raises the swap by a
  // few percent reuses this allowance instead of paying for another pair.
  const approval = allowance === 0n ? fablesApprovalAmount(amount) : 0n
  const tx: FablesSafeTx = { to: token, value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, approval] }) }
  await sendFablesTracked({ job, stage, ordinal: nextOrdinal(job), privateKey, tx })
  return true
}

async function prepareSwapRoute(job: FablesJob, swap: StoredSwap) {
  const amountIn = BigInt(swap.amountIn)
  const tokenIn = routeCurrency(swap.tokenIn)
  const tokenOut = routeCurrency(swap.tokenOut)
  const route = await quoteFablesRoute(swap.tokenIn, swap.tokenOut, amountIn,
    job.config.safeguards.maxSlippageBps)
  const isNative = lower(swap.tokenIn) === lower(zeroAddress)
    || lower(swap.tokenOut) === lower(zeroAddress)
  let gated
  if (isNative) {
    let directRoute: DirectRoute
    if (route.routeSummary.executorSource === 'up33_cl') {
      const spacing = Number(route.routeSummary.tickSpacing)
      const pool = await publicClient.readContract({ address: ADDR.CL_FACTORY,
        abi: clFactoryAbi, functionName: 'getPool', args: [tokenIn, tokenOut, spacing] })
      if (lower(pool) === lower(zeroAddress)) throw new Error('E_FABLES_NATIVE_POOL')
      const feePpm = Number(await publicClient.readContract({ address: pool,
        abi: clPoolAbi, functionName: 'fee' }))
      directRoute = { protocol: 'home', kind: 'cl', keyedBy: 'tickSpacing',
        tickSpacing: spacing, feePpm }
    } else if (route.routeSummary.executorSource === 'univ3') {
      directRoute = { protocol: 'uniswap', kind: 'v3',
        feePpm: Number(route.routeSummary.feePpm) }
    } else throw new Error('E_FABLES_NATIVE_ROUTE')
    const minOut = applySlippage(BigInt(route.routeSummary.amountOut), job.config.safeguards.maxSlippageBps)
    const direct = buildDirectTransaction({ tokenIn: directBuildCurrency(swap.tokenIn),
      tokenOut: directBuildCurrency(swap.tokenOut), amountIn, minimumAmountOut: minOut,
      recipient: job.config.owner,
      deadline: BigInt(Math.floor(Date.now() / 1000) + job.config.safeguards.maxPlanAgeSeconds),
      route: directRoute, fee: { bps: 0, receiver: job.config.owner } })
    gated = { to: direct.to, approvalTarget: direct.spender ?? zeroAddress,
      data: direct.data, value: direct.value, minOut }
  } else gated = await gatedKyberTx({ routeSummary: route.routeSummary,
    tokenIn, tokenOut, sender: job.config.owner, recipient: job.config.owner,
    amountIn, slippageBps: job.config.safeguards.maxSlippageBps, nativeIn: false })
  return { route, gated }
}

async function approveSwap(job: FablesJob, privateKey: Hex, purpose: SwapPurpose): Promise<void> {
  const swap = storedSwapOf(job, purpose)
  const { gated } = await prepareSwapRoute(job, swap)
  if (await approveToken(job, privateKey, approvalStage(purpose), swap.tokenIn, gated.approvalTarget, BigInt(swap.amountIn)))
    return
  setFablesJobProgress(job.id, { stage: swapStage(purpose), context: nextContext(job, {
    [swapField(purpose)]: { ...swap, spender: gated.approvalTarget },
  }) })
}

async function executeSwap(job: FablesJob, privateKey: Hex, purpose: SwapPurpose): Promise<void> {
  const swap = storedSwapOf(job, purpose)
  const stage = swapStage(purpose)
  const key = { currency0: job.context.currency0 as Address, currency1: job.context.currency1 as Address }
  const confirmed = lastConfirmed(job, stage)
  if (!confirmed) {
    const position = await readFablesPosition(publicClient, {
      owner: job.config.owner, hook: job.config.positionRef.hook,
      rangeId: BigInt(job.config.positionRef.rangeId), allowEmpty: true,
    })
    ensureIdentity(job, position)
    if (position.shares !== 0n || position.claimable0 !== 0n || position.claimable1 !== 0n)
      throw new Error('E_FABLES_OLD_RANGE_NOT_SETTLED')
    if (purpose === 'lp') {
      const freshRange = freshFablesRange(job.config, position,
        Number(job.context.dec0), Number(job.context.dec1))
      const plannedRange = job.context.previewRange as { tickLower?: number; tickUpper?: number } | undefined
      if (freshRange.tickLower !== plannedRange?.tickLower || freshRange.tickUpper !== plannedRange?.tickUpper) {
        setFablesJobProgress(job.id, { stage: 'balance' })
        return
      }
    }
    const before = await walletAmounts(job.config.owner, key.currency0, key.currency1)
    const cycle = await spendableCycleAmounts(job, key, before)
    const held = savedAmounts(job.context.heldFees, 'HELD_FEES')
    const available = purpose === 'fee' ? held : {
      amount0: cycle.amount0 > held.amount0 ? cycle.amount0 - held.amount0 : 0n,
      amount1: cycle.amount1 > held.amount1 ? cycle.amount1 - held.amount1 : 0n,
    }
    const amountIn = BigInt(swap.amountIn)
    if (amountIn > (lower(swap.tokenIn) === lower(key.currency0) ? available.amount0 : available.amount1))
      throw new Error('E_FABLES_SWAP_BUDGET')
    const { route, gated } = await prepareSwapRoute(job, swap)
    if (lower(gated.approvalTarget) !== lower(swap.spender ?? zeroAddress)) {
      setFablesJobProgress(job.id, { stage: approvalStage(purpose), context: nextContext(job, {
        [swapField(purpose)]: { ...swap, spender: gated.approvalTarget },
      }) })
      return
    }
    const quotedOut = BigInt(route.routeSummary.amountOut)
    const impact = fablesSwapImpactBps({ amountIn, quotedOut,
      tokenIn: swap.tokenIn, currency0: key.currency0, sqrtPriceX96: position.sqrtPriceX96 })
    if (impact > BigInt(job.config.safeguards.maxSwapImpactBps)) throw new Error('E_FABLES_SWAP_IMPACT')
    const quoteDecimals = lower(job.config.quoteToken) === lower(key.currency0)
      ? Number(job.context.dec0) : Number(job.context.dec1)
    const turnover = lower(swap.tokenIn) === lower(job.config.quoteToken) ? amountIn : quotedOut
    reserveFablesTurnover({ jobId: job.id, ordinal: purpose === 'fee' ? 1 : 0, walletId: job.walletId,
      quoteToken: job.config.quoteToken, amount: turnover,
      limit: parseUnits(job.config.execution.maxDailyTurnoverQuote!, quoteDecimals) })
    setFablesJobProgress(job.id, { context: nextContext(job, { [swapField(purpose)]: {
      ...swap, quotedOut: quotedOut.toString(), minOut: gated.minOut.toString(),
      before: serializeAmounts(before),
    } }) })
    await sendFablesTracked({ job, stage, ordinal: nextOrdinal(job), privateKey,
      tx: { to: gated.to, data: gated.data, value: gated.value } })
  }
  const receipt = await receiptFor(job, stage)
  const tx = lastConfirmed(job, stage)
  if (!receipt || !tx) throw new Error('E_FABLES_SWAP_RECEIPT_MISSING')
  const refreshed = fablesJobById(job.id)!
  const stored = storedSwapOf(refreshed, purpose)
  const before = savedAmounts(stored.before, 'SWAP_BEFORE')
  const after = await walletAmounts(job.config.owner, key.currency0, key.currency1)
  const gas = receipt.gasUsed * receipt.effectiveGasPrice
  const inIs0 = lower(stored.tokenIn) === lower(key.currency0)
  const beforeIn = inIs0 ? before.amount0 : before.amount1
  const afterIn = inIs0 ? after.amount0 : after.amount1
  const beforeOut = inIs0 ? before.amount1 : before.amount0
  const afterOut = inIs0 ? after.amount1 : after.amount0
  const spent = beforeIn - afterIn - (lower(stored.tokenIn) === lower(zeroAddress) ? gas : 0n)
  const gained = afterOut - beforeOut + (lower(stored.tokenOut) === lower(zeroAddress) ? gas : 0n)
  if (spent <= 0n || spent > BigInt(stored.amountIn) || gained < BigInt(stored.minOut ?? '0'))
    throw new Error('E_FABLES_SWAP_SETTLEMENT')
  markFablesTurnover(job.id, purpose === 'fee' ? 1 : 0, 'confirmed')
  if (purpose === 'fee') {
    const held = savedAmounts(refreshed.context.heldFees, 'HELD_FEES')
    const inIs0 = lower(stored.tokenIn) === lower(key.currency0)
    const adjusted = inIs0
      ? { amount0: held.amount0 - spent, amount1: held.amount1 + gained }
      : { amount0: held.amount0 + gained, amount1: held.amount1 - spent }
    if (adjusted.amount0 < 0n || adjusted.amount1 < 0n) throw new Error('E_FABLES_FEE_ALLOCATION')
    setFablesJobProgress(job.id, { stage: 'balance', context: nextContext(refreshed, {
      heldFees: serializeAmounts(adjusted), feeConversionDone: true,
      feeSwap: { ...stored, spent: spent.toString(), gained: gained.toString(), txHash: tx.hash },
    }) })
  } else setFablesJobProgress(job.id, { stage: 'deposit_approval', context: nextContext(refreshed, {
    swap: { ...stored, spent: spent.toString(), gained: gained.toString(), txHash: tx.hash },
  }) })
}

async function freshDeposit(job: FablesJob) {
  const position = await readFablesPosition(publicClient, {
    owner: job.config.owner, hook: job.config.positionRef.hook,
    rangeId: BigInt(job.config.positionRef.rangeId), allowEmpty: true,
  })
  ensureIdentity(job, position)
  if (position.shares !== 0n || position.claimable0 !== 0n || position.claimable1 !== 0n)
    throw new Error('E_FABLES_OLD_RANGE_NOT_SETTLED')
  const key = position.pool.key
  const wallet = await walletAmounts(job.config.owner, key.currency0, key.currency1)
  const cycle = await spendableCycleAmounts(job, key, wallet)
  const held = savedAmounts(job.context.heldFees, 'HELD_FEES')
  const funds = {
    amount0: cycle.amount0 > held.amount0 ? cycle.amount0 - held.amount0 : 0n,
    amount1: cycle.amount1 > held.amount1 ? cycle.amount1 - held.amount1 : 0n,
  }
  const range = freshFablesRange(job.config, position, Number(job.context.dec0), Number(job.context.dec1))
  const rangeId = fablesRangeId(position.pool.id, range.tickLower, range.tickUpper)
  if (rangeId === BigInt(job.config.positionRef.rangeId)) throw new Error('E_FABLES_RANGE_NOT_MOVED')
  const call = await prepareFablesDepositCall(publicClient, {
    owner: job.config.owner, poolId: position.pool.id,
    tickLower: range.tickLower, tickUpper: range.tickUpper,
    expectedTick: position.tick,
    budget0: funds.amount0, budget1: funds.amount1,
    slippageBps: job.config.safeguards.maxSlippageBps,
    nativeGasReserve: BigInt(job.config.safeguards.minNativeGasReserveWei),
    lifetimeSeconds: job.config.safeguards.maxPlanAgeSeconds,
  })
  if (call.rangeId !== rangeId) throw new Error('E_FABLES_NEW_RANGE_ID')
  return { position, wallet, funds, range, rangeId, call }
}

async function approveDeposit(job: FablesJob, privateKey: Hex): Promise<void> {
  const deposit = await freshDeposit(job)
  const key = deposit.position.pool.key
  if (await approveToken(job, privateKey, 'deposit_approval', key.currency0,
    key.hooks, deposit.call.max0)) return
  if (await approveToken(job, privateKey, 'deposit_approval', key.currency1,
    key.hooks, deposit.call.max1)) return
  setFablesJobProgress(job.id, { stage: 'deposit' })
}

async function executeDeposit(job: FablesJob, privateKey: Hex): Promise<void> {
  if (!lastConfirmed(job, 'deposit')) {
    const deposit = await freshDeposit(job)
    const key = deposit.position.pool.key
    for (const [token, amount] of [[key.currency0, deposit.call.max0], [key.currency1, deposit.call.max1]] as const) {
      if (lower(token) !== lower(zeroAddress)
        && await readAllowance(token, job.config.owner, key.hooks) < amount) {
        setFablesJobProgress(job.id, { stage: 'deposit_approval' })
        return
      }
    }
    const sharesBefore = await publicClient.readContract({ address: key.hooks, abi: fablesHookAbi,
      functionName: 'balanceOf', args: [job.config.owner, deposit.rangeId] })
    const newRef = { kind: 'fables_range' as const, poolId: deposit.position.pool.id,
      hook: key.hooks, rangeId: deposit.rangeId.toString(),
      tickLower: deposit.range.tickLower, tickUpper: deposit.range.tickUpper }
    setFablesJobProgress(job.id, { context: nextContext(job, {
      newRef, newSharesBefore: sharesBefore.toString(),
      depositBefore: serializeAmounts(deposit.wallet),
      depositBudget: serializeAmounts({ amount0: deposit.call.max0, amount1: deposit.call.max1 }),
      depositExpected: serializeAmounts({ amount0: deposit.call.expected0, amount1: deposit.call.expected1 }),
      depositObservedBlock: deposit.call.observedBlock.toString(),
    }) })
    await sendFablesTracked({ job, stage: 'deposit', ordinal: nextOrdinal(job), privateKey,
      tx: { to: deposit.call.to, data: deposit.call.data, value: deposit.call.value } })
  }
  setFablesJobProgress(job.id, { stage: 'verify' })
}

async function verifyAndComplete(job: FablesJob): Promise<void> {
  const newRef = job.context.newRef as FablesJob['config']['positionRef'] | undefined
  if (!newRef || newRef.kind !== 'fables_range') throw new Error('E_FABLES_NEW_REF_MISSING')
  const old = await readFablesPosition(publicClient, {
    owner: job.config.owner, hook: job.config.positionRef.hook,
    rangeId: BigInt(job.config.positionRef.rangeId), allowEmpty: true,
  })
  ensureIdentity(job, old)
  if (old.shares !== 0n || old.claimable0 !== 0n || old.claimable1 !== 0n)
    throw new Error('E_FABLES_OLD_RANGE_NOT_SETTLED')
  const fresh = await readFablesPosition(publicClient, {
    owner: job.config.owner, hook: newRef.hook, rangeId: BigInt(newRef.rangeId),
  })
  if (lower(fresh.pool.id) !== lower(job.config.positionRef.poolId)
    || fresh.tickLower !== newRef.tickLower || fresh.tickUpper !== newRef.tickUpper
    || fresh.shares <= BigInt(String(job.context.newSharesBefore)))
    throw new Error('E_FABLES_DEPOSIT_NOT_CONFIRMED')
  const receipt = await receiptFor(job, 'deposit')
  if (!receipt) throw new Error('E_FABLES_DEPOSIT_RECEIPT_MISSING')
  const minted = mintedFablesShares(receipt, newRef.hook, job.config.owner, BigInt(newRef.rangeId))
  if (minted <= 0n || fresh.shares - BigInt(String(job.context.newSharesBefore)) !== minted)
    throw new Error('E_FABLES_MINT_SHARES_MISMATCH')
  const before = savedAmounts(job.context.depositBefore, 'DEPOSIT_BEFORE')
  const after = await walletAmounts(job.config.owner, old.pool.key.currency0, old.pool.key.currency1)
  const gas = receipt.gasUsed * receipt.effectiveGasPrice
  const deposited0 = before.amount0 - after.amount0 - (old.pool.key.currency0 === zeroAddress ? gas : 0n)
  const deposited1 = before.amount1 - after.amount1 - (old.pool.key.currency1 === zeroAddress ? gas : 0n)
  const budget = savedAmounts(job.context.depositBudget, 'DEPOSIT_BUDGET')
  if (deposited0 < 0n || deposited1 < 0n
    || deposited0 > budget.amount0 || deposited1 > budget.amount1)
    throw new Error('E_FABLES_DEPOSIT_ACCOUNTING')
  const principal = savedAmounts(job.context.principal, 'PRINCIPAL')
  const fees = savedAmounts(job.context.fees, 'FEES')
  const baseline = savedAmounts(job.context.baseline, 'BASELINE')
  // The idle sweep may legitimately take the wallet below its pre-cycle
  // balance — everything above the protected floor belongs to the LP now.
  // What remains is the wallet's own idle, which the next cycle sweeps again.
  const { estimatedGas, reserve } = await nativeCycleGasBudget(job)
  const floor = fablesSweepFloor(reserve, estimatedGas)
  const floorBaseline = {
    amount0: lower(old.pool.key.currency0) === lower(zeroAddress)
      ? (baseline.amount0 < floor ? baseline.amount0 : floor) : 0n,
    amount1: lower(old.pool.key.currency1) === lower(zeroAddress)
      ? (baseline.amount1 < floor ? baseline.amount1 : floor) : 0n,
  }
  const remainder = cycleOwnedAmounts({ currency0: old.pool.key.currency0,
    currency1: old.pool.key.currency1, baseline: floorBaseline, current: after })
  const plannedHeld = savedAmounts(job.context.heldFees, 'HELD_FEES')
  const held = { amount0: plannedHeld.amount0 < remainder.amount0 ? plannedHeld.amount0 : remainder.amount0,
    amount1: plannedHeld.amount1 < remainder.amount1 ? plannedHeld.amount1 : remainder.amount1 }
  const exit = lastConfirmed(job, 'exit')
  const claim = lastConfirmed(job, 'claim')
  const deposit = lastConfirmed(job, 'deposit')
  if (!exit || !deposit || !exit.blockNumber || !deposit.blockNumber)
    throw new Error('E_FABLES_RECEIPT_FACTS')
  const exitReceipt = await receiptFor(job, 'exit')
  const claimReceipt = await receiptFor(job, 'claim')
  if (!exitReceipt) throw new Error('E_FABLES_EXIT_RECEIPT_MISSING')
  const exitFees = claimedFablesFees(exitReceipt, old.pool.key.hooks, job.config.owner, old.rangeId)
  const claimFees = claimReceipt
    ? claimedFablesFees(claimReceipt, old.pool.key.hooks, job.config.owner, old.rangeId)
    : { amount0: 0n, amount1: 0n }
  if (exitFees.amount0 + claimFees.amount0 !== fees.amount0
    || exitFees.amount1 + claimFees.amount1 !== fees.amount1)
    throw new Error('E_FABLES_FEE_RECEIPT_MISMATCH')
  const facts: FablesCycleFact[] = []
  for (const [token, principalAmount, exitFee, claimFee, depositedAmount, heldAmount, leftoverAmount] of [
    [old.pool.key.currency0, principal.amount0, exitFees.amount0, claimFees.amount0, deposited0, held.amount0, remainder.amount0 - held.amount0],
    [old.pool.key.currency1, principal.amount1, exitFees.amount1, claimFees.amount1, deposited1, held.amount1, remainder.amount1 - held.amount1],
  ] as const) {
    facts.push({ kind: 'principal_exited', token, amount: principalAmount,
      txHash: exit.hash, blockNumber: exit.blockNumber })
    if (exitFee > 0n) facts.push({ kind: 'fees_claimed', token, amount: exitFee,
      txHash: exit.hash, blockNumber: exit.blockNumber })
    if (claimFee > 0n) {
      if (!claim?.blockNumber) throw new Error('E_FABLES_CLAIM_RECEIPT_MISSING')
      facts.push({ kind: 'fees_claimed', token, amount: claimFee,
        txHash: claim.hash, blockNumber: claim.blockNumber })
    }
    facts.push({ kind: 'principal_deposited', token, amount: depositedAmount,
      txHash: deposit.hash, blockNumber: deposit.blockNumber,
      meta: { rangeId: newRef.rangeId, sharesMinted: minted.toString() } })
    if (heldAmount > 0n) facts.push({ kind: 'fees_retained', token, amount: heldAmount,
      txHash: deposit.hash, blockNumber: deposit.blockNumber })
    if (leftoverAmount > 0n) facts.push({ kind: 'wallet_remainder', token, amount: leftoverAmount,
      txHash: deposit.hash, blockNumber: deposit.blockNumber })
  }
  const feeSwap = job.context.feeSwap as (StoredSwap & { spent?: string; gained?: string }) | undefined
  const feeSwapTx = lastConfirmed(job, 'fee_conversion')
  if (feeSwap && feeSwapTx?.blockNumber && feeSwap.spent && feeSwap.gained) {
    facts.push({ kind: 'fee_conversion_input', token: feeSwap.tokenIn, amount: BigInt(feeSwap.spent),
      txHash: feeSwapTx.hash, blockNumber: feeSwapTx.blockNumber })
    facts.push({ kind: 'fee_conversion_output', token: feeSwap.tokenOut, amount: BigInt(feeSwap.gained),
      txHash: feeSwapTx.hash, blockNumber: feeSwapTx.blockNumber })
  }
  const swap = job.context.swap as (StoredSwap & { spent?: string; gained?: string }) | null
  const swapTx = lastConfirmed(job, 'swap')
  if (swap && swapTx?.blockNumber && swap.spent && swap.gained) {
    facts.push({ kind: 'swap_input', token: swap.tokenIn, amount: BigInt(swap.spent),
      txHash: swapTx.hash, blockNumber: swapTx.blockNumber })
    facts.push({ kind: 'swap_output', token: swap.tokenOut, amount: BigInt(swap.gained),
      txHash: swapTx.hash, blockNumber: swapTx.blockNumber })
  }
  const next = completeFablesJob(job.id, newRef, facts)
  audit('fables_runner', 'cycle_completed', 'strategy', job.strategyId, {
    jobId: job.id, oldRangeId: job.config.positionRef.rangeId,
    newRangeId: newRef.rangeId, sharesMinted: minted.toString(),
    revision: next.revision,
  })
}

// Remaining stages are intentionally separate so each receipt can be recovered
// and checked against chain state before moving the job forward.

let running = false
export async function runFablesOnce(): Promise<void> {
  if (running || executorPaused() || EXECUTOR.chainId !== 4663) return
  running = true
  try {
    for (const item of activeFablesJobs()) {
      // Share the same signer lock as ordinary LP jobs. The database prevents
      // a new ordinary job while this Fables job is open; the process lock
      // also covers the tail of an already completing ordinary job.
      if (walletBusy(item.walletId)) continue
      await withWalletLock(item.walletId, async () => {
        try {
          const recovery = await reconcileFablesTransactions(item)
          if (recovery.unresolved) return
          if (fablesJobTransactions(item.id).some(tx => tx.state === 'failed')) {
            setFablesJobProgress(item.id, { state: 'recovery', errorCode: 'E_FABLES_TX_REVERTED_REVIEW' })
            return
          }
          if (item.state === 'recovery' && fablesRecoveryRequiresReview(item.errorCode)) return
          if (item.state !== 'running') setFablesJobProgress(item.id, { state: 'running', errorCode: null })
          const unlocked = unlockPrivateKey(item.walletId)
          for (let step = 0; step < 10; step += 1) {
            const job = fablesJobById(item.id)
            if (!job || job.state !== 'running') break
            if (job.stage === 'precheck') await precheck(job)
            else if (job.stage === 'exit') await exitOldRange(job, unlocked.privateKey)
            else if (job.stage === 'claim') await claimOldFees(job, unlocked.privateKey)
            else if (job.stage === 'balance') await balanceAndPlan(job)
            else if (job.stage === 'fee_conversion_approval') await approveSwap(job, unlocked.privateKey, 'fee')
            else if (job.stage === 'fee_conversion') await executeSwap(job, unlocked.privateKey, 'fee')
            else if (job.stage === 'swap_approval') await approveSwap(job, unlocked.privateKey, 'lp')
            else if (job.stage === 'swap') await executeSwap(job, unlocked.privateKey, 'lp')
            else if (job.stage === 'deposit_approval') await approveDeposit(job, unlocked.privateKey)
            else if (job.stage === 'deposit') await executeDeposit(job, unlocked.privateKey)
            else if (job.stage === 'verify') { await verifyAndComplete(job); break }
            else break
          }
        } catch (error) {
          const job = fablesJobById(item.id)
          const code = error instanceof Error ? error.message.slice(0, 160) : 'E_FABLES_RUNNER'
          let cancelled = false
          if (job && ['planned','running','recovery'].includes(job.state)) {
            try {
              if (job.stage === 'precheck' && code === 'E_FABLES_BACK_IN_RANGE') {
                cancelFablesJobBackInRange(job.id)
                cancelled = true
              } else if (job.stage === 'precheck') failFablesJobBeforeMutation(job.id, code)
              else setFablesJobProgress(job.id, { state: 'recovery', errorCode: code })
            } catch { setFablesJobProgress(job.id, { state: 'recovery', errorCode: code }) }
          }
          audit('fables_runner', cancelled ? 'job_cancelled' : 'job_attention', 'job', item.id, { code })
        }
      })
    }
  } finally { running = false }
}
