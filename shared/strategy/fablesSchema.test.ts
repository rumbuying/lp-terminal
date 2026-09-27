import assert from 'node:assert/strict'
import test from 'node:test'
import { zeroAddress } from 'viem'
import { robinhoodConfig } from '../../src/config/chains/robinhood'
import { FABLES_AUTO_POOL_IDS } from '../../src/config/fables'
import { fablesRangeId } from '../../src/lib/fables'
import { parseFablesStrategyConfig } from './fablesSchema'

const poolId = '0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551' as const
const hook = '0x06a889870c8f83640d6816319f72e2aa579b6080' as const
const owner = '0x0000000000000000000000000000000000000001' as const
const token = '0x0000000000000000000000000000000000000002' as const

const draft = () => ({
  version: 2, protocol: 'fables', chainId: 4663, id: 'test', name: 'Test Fables', enabled: true,
  owner, poolManager: robinhoodConfig.uniV4!.POOL_MANAGER,
  positionRef: { kind: 'fables_range', poolId, hook, tickLower: -100, tickUpper: 100,
    rangeId: fablesRangeId(poolId, -100, 100).toString() },
  riskToken: token, quoteToken: zeroAddress,
  range: { lowerPct: 5, upperPct: 5 },
  trigger: { pollSeconds: 4, confirmationSeconds: 300, cooldownMinutes: 5 },
  fees: { handling: 'reinvest' },
  safeguards: { maxSlippageBps: 100, maxSwapImpactBps: 150, maxRebalancesPerDay: 6,
    maxPlanAgeSeconds: 60, maxClaimFeeBps: 1000, allowLegacyUnboundedFeeExit: false,
    minNativeGasReserveWei: '1000000000000000' },
  execution: { mode: 'notify_only', dryRun: false },
  revision: 1, createdAt: 1, updatedAt: 1,
})

test('Fables v2 share identity parses separately from NFT strategies', () => {
  const config = parseFablesStrategyConfig(draft())
  assert.equal(config.positionRef.rangeId, fablesRangeId(poolId, -100, 100).toString())
  assert.equal(config.positionRef.kind, 'fables_range')
})

test('Fables refuses a mismatched range ID or unreviewed hook', () => {
  assert.throws(() => parseFablesStrategyConfig({ ...draft(), positionRef: { ...draft().positionRef, rangeId: '1' } }), /rangeId/)
  assert.throws(() => parseFablesStrategyConfig({ ...draft(), positionRef: { ...draft().positionRef, hook: owner } }), /hook/)
})

test('Fables auto signing remains gated while the production allowlist is empty', () => {
  assert.throws(() => parseFablesStrategyConfig({ ...draft(), execution: {
    mode: 'executor_auto', walletId: 'wallet', signerAddress: owner, dryRun: false,
  } }), /not approved/)
})

test('Fables accepts fractional quote-denominated daily turnover limits', () => {
  FABLES_AUTO_POOL_IDS.add(poolId)
  try {
    const config = parseFablesStrategyConfig({ ...draft(), execution: {
      mode: 'executor_auto', walletId: 'wallet', signerAddress: owner, dryRun: false,
      maxDailyTurnoverQuote: '0.05',
    } })
    assert.equal(config.execution.maxDailyTurnoverQuote, '0.05')
  } finally { FABLES_AUTO_POOL_IDS.delete(poolId) }
  for (const invalid of ['0', '0.000', '-0.05', '1e-2', '0.']) {
    assert.throws(() => parseFablesStrategyConfig({ ...draft(), execution: {
      ...draft().execution, maxDailyTurnoverQuote: invalid,
    } }), /maxDailyTurnoverQuote/)
  }
})

test('Fables config rejects fee prediction and NFT fields', () => {
  assert.throws(() => parseFablesStrategyConfig({ ...draft(), fees: { handling: 'reinvest', timing: 'threshold' } }), /fee timing/)
  assert.throws(() => parseFablesStrategyConfig({ ...draft(), activeTokenId: '1' }), /NFT/)
})

test('Fables fee handling can retain or convert realized fees without a forecast trigger', () => {
  for (const handling of ['hold_tokens', 'convert_to_quote'] as const)
    assert.equal(parseFablesStrategyConfig({ ...draft(), fees: { handling } }).fees.handling, handling)
})
