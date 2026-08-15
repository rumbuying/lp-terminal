import assert from 'node:assert/strict'
import { simulateStrategy } from '../shared/strategy/simulator'
import { originalStrategyDraft, parseStrategyConfig } from '../shared/strategy/schema'
import { decideBoundaryTrigger } from '../shared/strategy/trigger'
import { quoteRangeToTicks } from '../shared/strategy/range'
import { attributeCollect, estimateUnstakedLevy } from '../shared/strategy/accounting'
import { makeRebalancePlan } from '../shared/strategy/planner'
import { chooseSwapDirection, planBalanceSwap, solveSwapInput } from '../shared/strategy/rebalance'
import { ADDR, UNI } from '../src/config/addresses'

const base = {
  initialValue: 100,
  startPrice: 100,
  durationDays: 1,
  aprPct: 8000,
  lowerPct: 5,
  upperPct: 5,
  lowerAction: 'recenter' as const,
  upperAction: 'recenter' as const,
  feeHandling: 'convert_to_quote' as const,
  steps: 14_400,
}

const flat = simulateStrategy({ ...base, endPrice: 100 })
const up10 = simulateStrategy({ ...base, endPrice: 110 })
const up20 = simulateStrategy({ ...base, endPrice: 120 })
const down30 = simulateStrategy({ ...base, endPrice: 70 })

const close = (actual: number, expected: number, tolerance = 0.08) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual.toFixed(4)} != ${expected.toFixed(4)} ± ${tolerance}`)

close(flat.pnlPct, 21.9178)
close(up10.pnlPct, 24.6455)
close(up20.pnlPct, 27.2931)
close(down30.pnlPct, -3.7636)
assert.equal(up10.rebalances, 1)
assert.equal(up20.rebalances, 3)
assert.equal(down30.rebalances, 6)

const range0 = quoteRangeToTicks({
  centerQuotePerRisk: 100,
  lowerPct: 5,
  upperPct: 5,
  currentTick: 46_054,
  tickSpacing: 10,
  token0IsRisk: true,
  token0Decimals: 18,
  token1Decimals: 18,
})
const range1 = quoteRangeToTicks({
  centerQuotePerRisk: 100,
  lowerPct: 5,
  upperPct: 5,
  currentTick: -46_054,
  tickSpacing: 10,
  token0IsRisk: false,
  token0Decimals: 18,
  token1Decimals: 18,
})
assert.ok(range0.tickLower < 46_054 && range0.tickUpper > 46_054)
assert.ok(range1.tickLower < -46_054 && range1.tickUpper > -46_054)

const trigger = decideBoundaryTrigger({
  tick: 100,
  tickLower: 101,
  tickUpper: 200,
  lower: { condition: 'always', action: 'recenter' },
  upper: { condition: 'always', action: 'recenter' },
  now: 1000,
  confirmationSeconds: 0,
})
assert.deepEqual(trigger, { kind: 'execute', side: 'lower', action: 'recenter', observedAt: 1000 })

const cfg = originalStrategyDraft({
  owner: '0x0000000000000000000000000000000000000001',
  protocol: 'univ3',
  pool: '0x0000000000000000000000000000000000000002',
  positionManager: UNI.V3_NPM,
  riskToken: '0x0000000000000000000000000000000000000004',
  quoteToken: '0x0000000000000000000000000000000000000005',
})
assert.equal(parseStrategyConfig(JSON.parse(JSON.stringify(cfg))).preset, 'original')

const stableQuotedStake = originalStrategyDraft({
  owner: cfg.owner,
  protocol: 'up33',
  pool: '0x0000000000000000000000000000000000000010',
  positionManager: ADDR.CL_PM,
  riskToken: cfg.riskToken,
  quoteToken: ADDR.USDG,
  activeTokenId: '77',
  staking: { enabled: true, gauge: '0x0000000000000000000000000000000000000011' },
})
const parsedStableStake = parseStrategyConfig(JSON.parse(JSON.stringify(stableQuotedStake)))
assert.equal(parsedStableStake.quoteToken, ADDR.USDG)
assert.equal(parsedStableStake.staking?.rewardQuoteToken, ADDR.USDG)

const plannedConfig = { ...cfg, activeTokenId: '42', updatedAt: 1, createdAt: 1 }
const snapshot = {
  chainId: 4663 as const,
  observedAt: 1_000,
  blockNumber: '99',
  owner: cfg.owner,
  protocol: 'univ3' as const,
  pool: cfg.pool,
  positionManager: cfg.positionManager,
  tokenId: '42',
  token0: cfg.riskToken,
  token1: cfg.quoteToken,
  token0Decimals: 18,
  token1Decimals: 18,
  tickSpacing: 10,
  feePpm: 3000,
  unstakedFeePpm: 0,
  tick: 200,
  sqrtPriceX96: '80024378775772204256025656563',
  tickLower: -100,
  tickUpper: 100,
  liquidity: '1000000000000000',
  tokensOwed0: '0',
  tokensOwed1: '0',
}
const plan = makeRebalancePlan({ config: plannedConfig, snapshot, now: 1_001 })
assert.equal(plan.triggerSide, 'upper')
assert.equal(plan.steps.length, 12)
assert.equal(plan.steps[1].intent.amount0Min, '0')
assert.equal(plan.steps[1].intent.amount1Min, '0')
assert.ok(plan.nextRange.tickLower < snapshot.tick && plan.nextRange.tickUpper > snapshot.tick)
assert.equal(plan.hash, makeRebalancePlan({ config: plannedConfig, snapshot, now: 1_001 }).hash)
const guardedPlan = makeRebalancePlan({ config: { ...plannedConfig, safeguards: { ...plannedConfig.safeguards, enabled: true } }, snapshot, now: 1_001 })
assert.ok(BigInt(String(guardedPlan.steps[1].intent.amount1Min)) > 0n)
const fixedConfig = { ...plannedConfig, range: { ...plannedConfig.range, mode: 'fixed_ticks' as const, tickLower: -120, tickUpper: 340 } }
const fixedPlan = makeRebalancePlan({ config: fixedConfig, snapshot, now: 1_001 })
assert.deepEqual(fixedPlan.nextRange, { tickLower: -120, tickUpper: 340 })
assert.throws(() => makeRebalancePlan({ config: { ...fixedConfig, range: { ...fixedConfig.range, tickLower: -121 } }, snapshot, now: 1_001 }))
const holdConfig = { ...plannedConfig, boundary: { ...plannedConfig.boundary, upper: { ...plannedConfig.boundary.upper, action: 'hold_quote' as const } } }
assert.equal(makeRebalancePlan({ config: holdConfig, snapshot, now: 1_001 }).action, 'hold_quote')
assert.throws(() => parseStrategyConfig({ ...cfg, fees: { handling: 'hold_tokens', timing: 'interval' } }))
const levy = estimateUnstakedLevy(970n, 30_000)
assert.equal(levy.grossFee, 1_000n)
assert.equal(levy.levy, 30n)
const entries = attributeCollect({
  strategyId: cfg.id,
  ts: 1,
  token0: cfg.riskToken,
  token1: cfg.quoteToken,
  principal0: '10',
  principal1: '20',
  collected0: '107',
  collected1: '214',
  unstakedLevyPpm: 30_000,
})
assert.equal(entries.filter((x) => x.kind === 'principal_exit').length, 2)
assert.equal(entries.filter((x) => x.kind === 'fee_gross').map((x) => x.amount).join(','), '100,200')
assert.equal(entries.filter((x) => x.kind === 'protocol_fee').map((x) => x.amount).join(','), '3,6')

const equalUnits = { amount0: 1n, amount1: 1n }
assert.equal(chooseSwapDirection(100n, 0n, equalUnits), 'token0_to_token1')
assert.equal(chooseSwapDirection(0n, 100n, equalUnits), 'token1_to_token0')
assert.equal(chooseSwapDirection(50n, 50n, equalUnits), null)
assert.equal(solveSwapInput({ balance0: 100n, balance1: 0n, unit0: 1n, unit1: 1n, quoteIn: 1n, quoteOut: 1n, direction: 'token0_to_token1' }), 50n)
const balanced = await planBalanceSwap({
  token0: cfg.riskToken,
  token1: cfg.quoteToken,
  balance0: 1_000_000n,
  balance1: 0n,
  units: equalUnits,
  quote: async (_tokenIn, _tokenOut, amountIn) => ({ amountOut: amountIn, route: { test: true } }),
})
assert.equal(balanced?.amountIn, 500_000n)

console.log('strategy smoke: ok', {
  flat: flat.pnlPct.toFixed(3),
  up10: up10.pnlPct.toFixed(3),
  up20: up20.pnlPct.toFixed(3),
  down30: down30.pnlPct.toFixed(3),
})
