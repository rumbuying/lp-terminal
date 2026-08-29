import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFunctionData } from 'viem'
import { originalStrategyDraft, parseStrategyConfig } from '../shared/strategy/schema'
import { collectCall, decreaseCall, exactApprovalCall, mintCall } from '../executor/steps'
import { allocateSwapExecution, allocateSwapOutput, planCycleSwaps } from '../executor/rebalance'
import { FEE_TAX_THRESHOLD_USDG, planFeeTax } from '../executor/fee-tax'
import { makeRebalancePlan } from '../shared/strategy/planner'
import { ADDR, UNI } from '../src/config/addresses'
import { uniV3PmAbi } from '../src/abi'

const dir = mkdtempSync(join(tmpdir(), 'lp-executor-smoke-'))
process.env.LP_EXECUTOR_DATA_DIR = dir
process.env.LP_EXECUTOR_MASTER_KEY = 'test-master-key-with-at-least-32-bytes!'
delete process.env.LP_EXECUTOR_MASTER_KEY_FILE

try {
  const { importPrivateKey, unlockPrivateKey, tokenMatches } = await import('../executor/vault')
  const { EXECUTOR } = await import('../executor/config')
  assert.equal(EXECUTOR.confirmations, 2)
  const master = Buffer.from(process.env.LP_EXECUTOR_MASTER_KEY)
  const imported = importPrivateKey('wallet_test', `0x${'11'.repeat(32)}`, master)
  assert.equal(imported.address.toLowerCase(), '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a')
  assert.equal(statSync(imported.path).mode & 0o777, 0o600)
  assert.equal(unlockPrivateKey('wallet_test', master).privateKey, `0x${'11'.repeat(32)}`)
  const noPrefix = importPrivateKey('wallet_no_prefix', '22'.repeat(32), master)
  assert.equal(noPrefix.address.toLowerCase(), '0x1563915e194d8cfba1943570603f7606a3115508')
  assert.equal(unlockPrivateKey('wallet_no_prefix', master).privateKey, `0x${'22'.repeat(32)}`)
  assert.throws(() => unlockPrivateKey('wallet_test', Buffer.from('wrong-master-key-with-at-least-32-bytes!')))
  const originalVault = readFileSync(imported.path, 'utf8')
  const tamperedVault = JSON.parse(originalVault)
  tamperedVault.tag = `${tamperedVault.tag.slice(0, -2)}AA`
  writeFileSync(imported.path, JSON.stringify(tamperedVault), { mode: 0o600 })
  assert.throws(() => unlockPrivateKey('wallet_test', master))
  writeFileSync(imported.path, originalVault, { mode: 0o600 })
  assert.equal(tokenMatches('secret', Buffer.from('secret')), true)
  assert.equal(tokenMatches('different', Buffer.from('secret')), false)
  const config = originalStrategyDraft({
    owner: imported.address,
    protocol: 'univ3',
    pool: '0x0000000000000000000000000000000000000002',
    positionManager: UNI.V3_NPM,
    riskToken: '0x0000000000000000000000000000000000000004',
    quoteToken: '0x0000000000000000000000000000000000000005',
    activeTokenId: '9',
  })
  const snapshot = {
    chainId: 4663 as const, observedAt: 1, blockNumber: '1', owner: imported.address, protocol: 'univ3' as const,
    pool: config.pool, positionManager: config.positionManager, tokenId: '9', token0: config.riskToken, token1: config.quoteToken,
    token0Decimals: 18, token1Decimals: 18, tickSpacing: 10, feePpm: 3000, unstakedFeePpm: 0, tick: 0, sqrtPriceX96: (1n << 96n).toString(), tickLower: -100, tickUpper: 100,
    liquidity: '1000000', tokensOwed0: '0', tokensOwed1: '0',
  }
  const unguardedDecrease = decodeFunctionData({ abi: uniV3PmAbi, data: decreaseCall(config, snapshot).data })
  assert.equal((unguardedDecrease.args?.[0] as { amount0Min: bigint }).amount0Min, 0n)
  assert.equal((unguardedDecrease.args?.[0] as { amount1Min: bigint }).amount1Min, 0n)
  const guardedConfig = { ...config, safeguards: { ...config.safeguards, enabled: true, maxSlippageBps: 10 } }
  const guardedDecrease = decodeFunctionData({ abi: uniV3PmAbi, data: decreaseCall(guardedConfig, snapshot).data })
  assert.ok((guardedDecrease.args?.[0] as { amount0Min: bigint }).amount0Min > 0n)
  assert.ok((guardedDecrease.args?.[0] as { amount1Min: bigint }).amount1Min > 0n)
  assert.ok(collectCall(config, '9').data.startsWith('0x'))
  assert.ok(exactApprovalCall(config.riskToken, config.positionManager, 123n).data.startsWith('0x095ea7b3'))
  const unguardedMint = decodeFunctionData({ abi: uniV3PmAbi, data: mintCall({ config, snapshot, tickLower: -50, tickUpper: 50, amount0Desired: 1n, amount1Desired: 1n, feePpm: 3000 }).data })
  assert.equal((unguardedMint.args?.[0] as { amount0Min: bigint }).amount0Min, 0n)
  assert.equal((unguardedMint.args?.[0] as { amount1Min: bigint }).amount1Min, 0n)
  assert.throws(() => mintCall({ config, snapshot, tickLower: -50, tickUpper: 50, amount0Desired: 1n, amount1Desired: 1n }))
  const swaps = await planCycleSwaps({
    config,
    snapshot,
    sqrtPriceX96: 1n << 96n,
    tickLower: -50,
    tickUpper: 50,
    funds: { principal0: 1_000_000n, principal1: 0n, fee0: 100_000n, fee1: 0n },
    quote: async (tokenIn, tokenOut, amountIn) => ({
      amountOut: amountIn,
      routeSummary: { tokenIn, tokenOut, amountIn: amountIn.toString(), amountOut: amountIn.toString(), route: [] },
    }),
  })
  assert.equal(swaps.swaps.length, 1)
  assert.ok(swaps.swaps[0].principalIn > 0n)
  assert.equal(swaps.swaps[0].feeIn, 100_000n)
  const split = allocateSwapOutput(swaps.swaps[0], swaps.swaps[0].amountIn)
  assert.equal(split.principalOut + split.feeOut, swaps.swaps[0].amountIn)

  const partialFillIntent = {
    ...swaps.swaps[0],
    amountIn: 1_000n,
    principalIn: 900n,
    feeIn: 100n,
  }
  const partialFill = allocateSwapExecution(partialFillIntent, 995n, 1_970n, 1_950n)
  assert.equal(partialFill.principalSpent + partialFill.feeSpent, 995n)
  assert.equal(partialFill.principalOut + partialFill.feeOut, 1_970n)
  assert.equal(partialFill.unspentPrincipal + partialFill.unspentFee, 5n)
  assert.throws(() => allocateSwapExecution(partialFillIntent, 1_001n, 1_970n, 1_950n), /E_UNSUPPORTED_TOKEN/)
  assert.throws(() => allocateSwapExecution(partialFillIntent, 995n, 1_949n, 1_950n), /E_UNSUPPORTED_TOKEN/)

  const exactlyOneUsdg = await planFeeTax({
    token0: config.riskToken,
    token1: ADDR.STABLE,
    fee0: 0n,
    fee1: FEE_TAX_THRESHOLD_USDG,
    quote: async () => { throw new Error('unexpected quote') },
  })
  assert.equal(exactlyOneUsdg.applied, false)
  assert.equal(exactlyOneUsdg.fee1AfterTax, FEE_TAX_THRESHOLD_USDG)

  const usdgFee = await planFeeTax({
    token0: config.riskToken,
    token1: ADDR.STABLE,
    fee0: 0n,
    fee1: FEE_TAX_THRESHOLD_USDG + 1n,
    quote: async () => { throw new Error('unexpected quote') },
  })
  assert.equal(usdgFee.applied, true)
  assert.equal(usdgFee.tax1, 100_000n)
  assert.equal(usdgFee.retainedUsdg, 100_000n)
  assert.equal(usdgFee.swaps.length, 0)

  const convertedFee = await planFeeTax({
    token0: config.riskToken,
    token1: config.quoteToken,
    fee0: 1_000n,
    fee1: 0n,
    quote: async (tokenIn, tokenOut, amountIn) => ({
      amountOut: amountIn * 2_000n,
      routeSummary: { tokenIn, tokenOut, amountIn: amountIn.toString(), amountOut: (amountIn * 2_000n).toString(), route: [] },
    }),
  })
  assert.equal(convertedFee.applied, true)
  assert.equal(convertedFee.tax0, 100n)
  assert.equal(convertedFee.fee0AfterTax, 900n)
  assert.equal(convertedFee.swaps[0].purpose, 'fee_tax')
  assert.equal(convertedFee.swaps[0].tokenOut.toLowerCase(), ADDR.STABLE.toLowerCase())

  const stableFundedTax = await planFeeTax({
    token0: config.riskToken,
    token1: ADDR.WNATIVE,
    fee0: 10_000n,
    fee1: 1_000n,
    quote: async (tokenIn, tokenOut, amountIn) => ({
      // The volatile leg is larger, but the canonical WETH leg is still more
      // than sufficient to fund 10% of combined income.
      amountOut: tokenIn.toLowerCase() === ADDR.WNATIVE.toLowerCase() ? amountIn * 2_000n : amountIn * 1_000n,
      routeSummary: { tokenIn, tokenOut, amountIn: amountIn.toString(), amountOut: (tokenIn.toLowerCase() === ADDR.WNATIVE.toLowerCase() ? amountIn * 2_000n : amountIn * 1_000n).toString(), route: [] },
    }),
  })
  assert.equal(stableFundedTax.applied, true)
  assert.equal(stableFundedTax.tax0, 0n)
  assert.ok(stableFundedTax.tax1 > 0n)
  assert.equal(stableFundedTax.swaps[0].tokenIn.toLowerCase(), ADDR.WNATIVE.toLowerCase())

  const stableBalanceTax = await planFeeTax({
    token0: config.riskToken,
    token1: ADDR.STABLE,
    fee0: 10_000n,
    fee1: 2_000_000n,
    quote: async (tokenIn, tokenOut, amountIn) => ({
      amountOut: amountIn * 1_000n,
      routeSummary: { tokenIn, tokenOut, amountIn: amountIn.toString(), amountOut: (amountIn * 1_000n).toString(), route: [] },
    }),
  })
  assert.equal(stableBalanceTax.tax0, 0n)
  assert.equal(stableBalanceTax.retainedUsdg, stableBalanceTax.tax1)
  assert.equal(stableBalanceTax.swaps.length, 0)

  const rewardOnlyTax = await planFeeTax({
    token0: config.riskToken,
    token1: config.quoteToken,
    fee0: 0n,
    fee1: 0n,
    rewardToken: config.quoteToken,
    rewardAmount: 2_000n,
    quote: async (tokenIn, tokenOut, amountIn) => ({
      amountOut: amountIn * 1_000n,
      routeSummary: { tokenIn, tokenOut, amountIn: amountIn.toString(), amountOut: (amountIn * 1_000n).toString(), route: [] },
    }),
  })
  assert.equal(rewardOnlyTax.applied, true)
  assert.equal(rewardOnlyTax.totalIncomeUsdg, 2_000_000n)
  assert.equal(rewardOnlyTax.rewardTax, 200n)
  assert.equal(rewardOnlyTax.rewardAfterTax, 1_800n)

  const combinedIncomeTax = await planFeeTax({
    token0: config.riskToken,
    token1: ADDR.STABLE,
    fee0: 0n,
    fee1: 600_000n,
    rewardToken: config.quoteToken,
    rewardAmount: 500n,
    quote: async (tokenIn, tokenOut, amountIn) => ({
      amountOut: amountIn * 1_000n,
      routeSummary: { tokenIn, tokenOut, amountIn: amountIn.toString(), amountOut: (amountIn * 1_000n).toString(), route: [] },
    }),
  })
  assert.equal(combinedIncomeTax.totalIncomeUsdg, 1_100_000n)
  assert.equal(combinedIncomeTax.applied, true)
  assert.equal(combinedIncomeTax.tax1, 110_000n)
  assert.equal(combinedIncomeTax.rewardTax, 0n)

  const store = await import('../executor/store')
  const { walletBusy, withWalletLock } = await import('../executor/wallet-lock')
  const { clearStrategyRetry, deferStrategyRetry, strategyRetryReady } = await import('../executor/retry-state')
  assert.equal(strategyRetryReady(config.id), true)
  assert.equal(deferStrategyRetry(config.id), 5_000)
  assert.equal(strategyRetryReady(config.id), false)
  clearStrategyRetry(config.id)
  assert.equal(strategyRetryReady(config.id), true)
  const { classifyRecovery } = await import('../executor/recovery')
  const { gatedKyberTx, validateKyberRoute } = await import('../executor/kyber')
  const validRoute = {
    routerAddress: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5' as const,
    routeSummary: { tokenIn: config.riskToken, tokenOut: config.quoteToken, amountIn: '10', amountOut: '9', route: [] },
  }
  assert.equal(validateKyberRoute(validRoute, config.riskToken, config.quoteToken, 10n), validRoute)
  assert.throws(() => validateKyberRoute({ ...validRoute, routeSummary: { ...validRoute.routeSummary, tokenOut: config.riskToken } }, config.riskToken, config.quoteToken, 10n))
  const nativeTx = await gatedKyberTx({
    routeSummary: { tokenIn: config.riskToken, tokenOut: config.quoteToken, amountIn: '10', amountOut: '9', route: [], executorSource: 'up33_cl', tickSpacing: 10 },
    tokenIn: config.riskToken,
    tokenOut: config.quoteToken,
    sender: imported.address,
    recipient: imported.address,
    amountIn: 10n,
    slippageBps: 100,
    nativeIn: false,
  })
  assert.equal(nativeTx.to, ADDR.CL_SWAP_ROUTER)
  const univ3Tx = await gatedKyberTx({
    routeSummary: { tokenIn: config.riskToken, tokenOut: config.quoteToken, amountIn: '10', amountOut: '9', route: [], executorSource: 'univ3', feePpm: 3000 },
    tokenIn: config.riskToken,
    tokenOut: config.quoteToken,
    sender: imported.address,
    recipient: imported.address,
    amountIn: 10n,
    slippageBps: 100,
    nativeIn: false,
  })
  assert.equal(univ3Tx.to, UNI.V3_SWAP_ROUTER)
  await assert.rejects(() => gatedKyberTx({
    routeSummary: { tokenIn: config.riskToken, tokenOut: config.quoteToken, amountIn: '10', amountOut: '9', route: [], executorSource: 'univ3', feePpm: 0 },
    tokenIn: config.riskToken,
    tokenOut: config.quoteToken,
    sender: imported.address,
    recipient: imported.address,
    amountIn: 10n,
    slippageBps: 100,
    nativeIn: false,
  }))
  await assert.rejects(() => gatedKyberTx({
    routeSummary: { tokenIn: config.riskToken, tokenOut: config.quoteToken, amountIn: '10', amountOut: '9', route: [], executorSource: 'up33_cl', tickSpacing: 10 },
    tokenIn: config.riskToken,
    tokenOut: config.quoteToken,
    sender: imported.address,
    recipient: imported.address,
    amountIn: 11n,
    slippageBps: 100,
    nativeIn: false,
  }))
  const now = Math.floor(Date.now() / 1000)
  store.addWallet({ id: 'wallet_test', label: 'Test account', address: imported.address, vaultPath: imported.path, createdAt: now, updatedAt: now })
  assert.equal(store.listWallets()[0].label, 'Test account')
  assert.equal(store.updateWalletLabel('wallet_test', 'Renamed account'), true)
  assert.equal(store.walletById('wallet_test')?.label, 'Renamed account')
  const autoConfig = {
    ...config,
    enabled: true,
    execution: { ...config.execution, mode: 'executor_auto' as const, walletId: 'wallet_test', signerAddress: imported.address, maxGasPriceWei: '1000000000', maxDailyTurnoverQuote: '100' },
  }
  assert.throws(() => parseStrategyConfig({ ...autoConfig, execution: { ...autoConfig.execution, maxGasPriceWei: undefined } }))
  store.upsertStrategy(autoConfig)
  const outSnapshot = { ...snapshot, observedAt: now, tick: 101 }
  const plan = makeRebalancePlan({ config: autoConfig, snapshot: outSnapshot, now })
  assert.equal(store.createPlannedJob(plan), true)
  store.reserveDailyTurnover({ jobId: plan.id, walletId: 'wallet_test', quoteToken: autoConfig.quoteToken, amount: 100n, limit: 100n, now })
  store.reserveDailyTurnover({ jobId: plan.id, walletId: 'wallet_test', quoteToken: autoConfig.quoteToken, amount: 100n, limit: 100n, now })
  const independentConfig = { ...autoConfig, id: `${autoConfig.id}-independent`, name: 'independent daily limit' }
  store.upsertStrategy(independentConfig)
  const independentPlan = makeRebalancePlan({ config: independentConfig, snapshot: { ...outSnapshot, pool: independentConfig.pool }, now })
  assert.equal(store.createPlannedJob(independentPlan), true)
  assert.doesNotThrow(() => store.reserveDailyTurnover({ jobId: independentPlan.id, walletId: 'wallet_test', quoteToken: independentConfig.quoteToken, amount: 100n, limit: 100n, now }))
  assert.equal(store.dailyTurnoverUsed('wallet_test', autoConfig.quoteToken, now), 200n)
  assert.equal(store.dailyTurnoverUsed('wallet_test', autoConfig.quoteToken, now, autoConfig.id), 100n)
  assert.equal(store.dailyTurnoverUsed('wallet_test', autoConfig.quoteToken, now, independentConfig.id), 100n)
  store.releaseDailyTurnover(independentPlan.id)
  store.setJobState(independentPlan.id, 'failed')
  store.upsertStrategy({ ...independentConfig, enabled: false })
  assert.throws(() => store.reserveDailyTurnover({ jobId: plan.id, walletId: 'wallet_test', quoteToken: autoConfig.quoteToken, amount: 101n, limit: 100n, now }))
  const nextUtcDay = now + 86_400
  store.reserveDailyTurnover({ jobId: plan.id, walletId: 'wallet_test', quoteToken: autoConfig.quoteToken, amount: 100n, limit: 100n, now: nextUtcDay })
  const rolledReservation = store.db.prepare('SELECT utc_day,amount,state FROM daily_turnover_reservations WHERE job_id=?').get(plan.id) as { utc_day: number; amount: string; state: string }
  assert.equal(rolledReservation.utc_day, Math.floor(nextUtcDay / 86_400) * 86_400)
  assert.equal(rolledReservation.amount, '100')
  assert.equal(rolledReservation.state, 'reserved')
  assert.throws(() => store.reserveDailyTurnover({ jobId: plan.id, walletId: 'wallet_test', quoteToken: autoConfig.quoteToken, amount: 101n, limit: 100n, now: nextUtcDay }))
  store.db.prepare('INSERT INTO allocations(strategy_id,token,amount,updated_at) VALUES(?,?,?,?)').run(autoConfig.id, autoConfig.riskToken.toLowerCase(), '7', now)
  assert.deepEqual(store.walletAllocationTokens('wallet_test'), [autoConfig.riskToken.toLowerCase()])
  assert.doesNotThrow(() => store.assertWalletAllocations('wallet_test', { [autoConfig.riskToken.toLowerCase()]: 7n }))
  assert.throws(() => store.assertWalletAllocations('wallet_test', { [autoConfig.riskToken.toLowerCase()]: 6n }))
  assert.doesNotThrow(() => store.assertWalletAllocationUpdate('wallet_test', autoConfig.id, { [autoConfig.riskToken.toLowerCase()]: 6n }, { [autoConfig.riskToken.toLowerCase()]: 6n }))
  assert.throws(() => store.assertWalletAllocationUpdate('wallet_test', autoConfig.id, { [autoConfig.riskToken.toLowerCase()]: 6n }, { [autoConfig.riskToken.toLowerCase()]: 7n }))
  const archivedConfig = { ...autoConfig, id: `${autoConfig.id}-archived`, name: 'archived allocation history' }
  store.upsertStrategy(archivedConfig)
  store.db.prepare('INSERT INTO allocations(strategy_id,token,amount,updated_at) VALUES(?,?,?,?)').run(archivedConfig.id, autoConfig.riskToken.toLowerCase(), '1000', now)
  store.db.prepare("UPDATE strategies SET state='archived' WHERE id=?").run(archivedConfig.id)
  assert.doesNotThrow(() => store.assertWalletAllocations('wallet_test', { [autoConfig.riskToken.toLowerCase()]: 7n }))
  assert.doesNotThrow(() => store.assertWalletAllocationUpdate('wallet_test', autoConfig.id, { [autoConfig.riskToken.toLowerCase()]: 6n }, { [autoConfig.riskToken.toLowerCase()]: 6n }))
  store.db.prepare('INSERT INTO allocations(strategy_id,token,amount,updated_at) VALUES(?,?,?,?)').run(autoConfig.id, autoConfig.quoteToken.toLowerCase(), '99', now)
  assert.doesNotThrow(() => store.assertWalletAllocationUpdate('wallet_test', autoConfig.id, { [autoConfig.riskToken.toLowerCase()]: 6n }, { [autoConfig.riskToken.toLowerCase()]: 6n }))
  const profitConfig = { ...autoConfig, id: `${autoConfig.id}-profit`, name: 'profit withdrawal accounting' }
  store.upsertStrategy(profitConfig)
  store.db.prepare('INSERT INTO allocations(strategy_id,token,amount,updated_at) VALUES(?,?,?,?)').run(profitConfig.id, autoConfig.riskToken.toLowerCase(), '100', now)
  store.db.prepare('INSERT INTO allocation_components(strategy_id,token,principal_amount,held_fee_amount,held_profit_amount,updated_at) VALUES(?,?,?,?,?,?)').run(
    profitConfig.id, autoConfig.riskToken.toLowerCase(), '20', '30', '50', now,
  )
  store.commitProfitAllocationMutation({
    strategyId: profitConfig.id,
    walletId: 'wallet_test',
    expected: { [autoConfig.riskToken.toLowerCase()]: { principal: 20n, heldFee: 30n, heldProfit: 50n }, [autoConfig.quoteToken.toLowerCase()]: { principal: 0n, heldFee: 0n, heldProfit: 0n } },
    next: { [autoConfig.riskToken.toLowerCase()]: { principal: 20n, heldFee: 30n, heldProfit: 0n }, [autoConfig.quoteToken.toLowerCase()]: { principal: 0n, heldFee: 0n, heldProfit: 45n } },
    balances: { [autoConfig.riskToken.toLowerCase()]: 1_000n, [autoConfig.quoteToken.toLowerCase()]: 1_000n },
  })
  assert.deepEqual(store.strategyAllocationComponents(profitConfig.id), {
    [autoConfig.riskToken.toLowerCase()]: { principal: 20n, heldFee: 30n, heldProfit: 0n },
    [autoConfig.quoteToken.toLowerCase()]: { principal: 0n, heldFee: 0n, heldProfit: 45n },
  })
  assert.throws(() => store.commitProfitAllocationMutation({
    strategyId: profitConfig.id,
    walletId: 'wallet_test',
    expected: { [autoConfig.quoteToken.toLowerCase()]: { principal: 0n, heldFee: 0n, heldProfit: 44n } },
    next: { [autoConfig.quoteToken.toLowerCase()]: { principal: 0n, heldFee: 0n, heldProfit: 0n } },
    balances: { [autoConfig.quoteToken.toLowerCase()]: 1_000n },
  }), /E_ALLOCATION_CHANGED/)
  store.commitProfitAllocationMutation({
    strategyId: profitConfig.id,
    walletId: 'wallet_test',
    expected: { [autoConfig.quoteToken.toLowerCase()]: { principal: 0n, heldFee: 0n, heldProfit: 45n } },
    next: { [autoConfig.quoteToken.toLowerCase()]: { principal: 0n, heldFee: 0n, heldProfit: 0n } },
    balances: { [autoConfig.quoteToken.toLowerCase()]: 1_000n },
    ledger: [{ id: 'profit-withdrawal-fixture', strategyId: profitConfig.id, ts: now, kind: 'profit_withdrawal', token: autoConfig.quoteToken, amount: '45', quoteValue: '45', meta: { target: 'WETH', decimals: 18, usdgValueRaw: '90' } }],
  })
  assert.equal(store.strategyAllocationComponents(profitConfig.id)[autoConfig.riskToken.toLowerCase()].principal, 20n)
  assert.equal(store.strategyAllocationComponents(profitConfig.id)[autoConfig.riskToken.toLowerCase()].heldFee, 30n)
  assert.equal(store.strategyAllocationComponents(profitConfig.id)[autoConfig.quoteToken.toLowerCase()].heldProfit, 0n)
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE strategy_id=? AND kind='profit_withdrawal'").get(profitConfig.id) as { n: number }).n, 1)
  const withdrawalJobId = 'profit-withdrawal-recovery-fixture'
  assert.equal(store.createProfitWithdrawalJob({
    id: withdrawalJobId,
    strategyId: profitConfig.id,
    target: 'WETH',
    steps: [{ index: 1, kind: 'profit_swap' }, { index: 11, kind: 'profit_withdrawal_commit' }],
  }), true)
  store.markStep({ jobId: withdrawalJobId, index: 1, state: 'confirmed' })
  assert.equal(store.failProfitWithdrawalJob(withdrawalJobId, 'E_FIXTURE'), 'recovery')
  assert.equal(store.strategyById(profitConfig.id)?.state, 'recovery')
  store.abandonProfitWithdrawalJob(withdrawalJobId)
  assert.equal(store.strategyById(profitConfig.id)?.state, 'monitoring')
  assert.equal((store.db.prepare('SELECT state FROM jobs WHERE id=?').get(withdrawalJobId) as { state: string }).state, 'failed')
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  const lockOrder: string[] = []
  const firstLock = withWalletLock('wallet_test', async () => { lockOrder.push('first-start'); await firstGate; lockOrder.push('first-end') })
  assert.equal(walletBusy('wallet_test'), true)
  const secondLock = withWalletLock('wallet_test', async () => { lockOrder.push('second') })
  await Promise.resolve()
  assert.deepEqual(lockOrder, ['first-start'])
  releaseFirst()
  await Promise.all([firstLock, secondLock])
  assert.deepEqual(lockOrder, ['first-start', 'first-end', 'second'])
  assert.equal(walletBusy('wallet_test'), false)
  store.commitRebalance({
    jobId: plan.id,
    config: autoConfig,
    oldTokenId: '9',
    newTokenId: '10',
    triggerSide: 'upper',
    rangeScale: 1,
    allocations: { [autoConfig.riskToken.toLowerCase()]: 5n },
    ledger: [],
    txHashes: [],
    commitResult: { newTokenId: '10' },
  })
  const committed = store.db.prepare('SELECT state FROM jobs WHERE id=?').get(plan.id) as { state: string }
  const commitStep = store.db.prepare('SELECT state,result_json FROM job_steps WHERE job_id=? AND step_index=11').get(plan.id) as { state: string; result_json: string }
  const reservation = store.db.prepare('SELECT state FROM daily_turnover_reservations WHERE job_id=?').get(plan.id) as { state: string }
  assert.equal(committed.state, 'completed')
  assert.equal(commitStep.state, 'confirmed')
  assert.equal(JSON.parse(commitStep.result_json).newTokenId, '10')
  assert.equal(reservation.state, 'confirmed')
  const interruptedConfig = { ...autoConfig, id: `${autoConfig.id}-interrupted`, name: 'Interrupted fixture' }
  store.upsertStrategy(interruptedConfig)
  const interruptedPlan = makeRebalancePlan({ config: interruptedConfig, snapshot: { ...outSnapshot, pool: interruptedConfig.pool }, now })
  assert.equal(store.createPlannedJob(interruptedPlan), true)
  store.setJobState(interruptedPlan.id, 'running')
  store.setStrategyState(interruptedConfig.id, 'executing')
  assert.equal(store.quarantineInterruptedJobs(), 1)
  assert.equal(store.recoveryJobById(interruptedPlan.id)?.id, interruptedPlan.id)
  assert.equal(store.walletHasUnfinishedMutation('wallet_test'), false)
  store.db.prepare(`INSERT INTO job_transactions(job_id,step_index,tx_index,state,nonce,tx_hash,tx_to,calldata_hash,confirmed_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(interruptedPlan.id, 1, 0, 'sent', '1', `0x${'22'.repeat(32)}`, autoConfig.positionManager, `0x${'33'.repeat(32)}`, now)
  assert.equal(store.walletHasUnfinishedMutation('wallet_test'), true)
  const blockedConfig = { ...autoConfig, id: `${autoConfig.id}-blocked`, name: 'Temporarily blocked by uncertain wallet transaction' }
  store.upsertStrategy(blockedConfig)
  const blockedPlan = makeRebalancePlan({ config: blockedConfig, snapshot: { ...outSnapshot, pool: blockedConfig.pool }, now })
  assert.equal(store.createPlannedJob(blockedPlan), false)
  store.db.prepare(`UPDATE job_transactions SET state='confirmed' WHERE job_id=? AND step_index=1 AND tx_index=0`).run(interruptedPlan.id)
  assert.equal(store.walletHasUnfinishedMutation('wallet_test'), false)
  assert.equal(store.createPlannedJob(blockedPlan), true)
  assert.equal(store.scheduleRecoveryRetry(interruptedPlan.id, 'E_DETERMINISTIC_FIXTURE', true).quarantined, false)
  assert.equal(store.scheduleRecoveryRetry(interruptedPlan.id, 'E_DETERMINISTIC_FIXTURE', true).quarantined, false)
  const isolated = store.scheduleRecoveryRetry(interruptedPlan.id, 'E_DETERMINISTIC_FIXTURE', true)
  assert.equal(isolated.quarantined, true)
  assert.equal(store.strategyById(interruptedConfig.id)?.state, 'recovery_quarantined')
  assert.equal(store.recoveryAttemptReady(interruptedPlan.id), false)
  store.reactivateRecoveryJob(interruptedPlan.id)
  assert.equal(store.strategyById(interruptedConfig.id)?.state, 'recovery')
  assert.equal(store.recoveryAttemptReady(interruptedPlan.id), true)
  store.clearRecoverySchedule(interruptedPlan.id)
  store.abandonRecoveryJob(interruptedPlan.id)
  assert.equal((store.db.prepare('SELECT state FROM jobs WHERE id=?').get(interruptedPlan.id) as { state: string }).state, 'failed')
  assert.equal(classifyRecovery([]), 'restart_safe')
  assert.equal(classifyRecovery([{ stepIndex: 1, txIndex: 0, state: 'confirmed' }]), 'resume_collect')
  assert.equal(classifyRecovery([{ stepIndex: 2, txIndex: 0, state: 'confirmed' }]), 'resume_from_wallet')
  assert.equal(classifyRecovery([{ stepIndex: 12, txIndex: 0, state: 'confirmed' }]), 'resume_staking_exit')
  assert.equal(classifyRecovery([{ stepIndex: 14, txIndex: 0, state: 'confirmed' }]), 'resume_staking_exit')
  assert.equal(classifyRecovery([{ stepIndex: 8, txIndex: 0, state: 'confirmed' }]), 'resume_revoke')
  assert.equal(classifyRecovery([{ stepIndex: 8, txIndex: 0, state: 'confirmed' }], [9, 10]), 'commit_ready')
  assert.equal(classifyRecovery([{ stepIndex: 5, txIndex: 0, state: 'pending' }]), 'wait_pending')
  assert.equal(classifyRecovery([{ stepIndex: 5, txIndex: 0, state: 'ambiguous' }]), 'manual_review')
  console.log('executor smoke: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
