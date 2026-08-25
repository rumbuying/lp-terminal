import { formatUnits } from 'viem'
import { parseStrategyConfig } from '../shared/strategy/schema'
import type { StrategyConfig } from '../shared/strategy/types'
import { preflightStrategy } from './preflight'
import {
  audit,
  createPlannedJob,
  executorPaused,
  setStrategyState,
  setStrategyBaselineIfAbsent,
  strategyById,
  upsertStrategy,
  walletById,
} from './store'
import { unlockPrivateKey } from './vault'
import { ADDR } from '../src/config/addresses'
import { automaticDailyTurnoverLimit } from './limits'
import { observeStrategyBaseline } from './performance'

const max = (a: bigint, b: bigint) => a > b ? a : b

/**
 * Turns a local draft into the user's ORIGINAL strategy and immediately queues
 * one guarded live run. All safety work stays server-side; the browser never
 * receives the executor token or the decrypted private key.
 */
export async function startSimpleStrategy(input: unknown, walletId: string) {
  if (executorPaused()) throw new Error('E_EXECUTOR_PAUSED')
  const draft = parseStrategyConfig(input)
  if (!draft.activeTokenId) throw new Error('E_POSITION_REQUIRED')
  const current = strategyById(draft.id)
  if (current && ['planned', 'executing', 'recovery', 'recovery_quarantined'].includes(current.state)) throw new Error('E_STRATEGY_BUSY')

  const wallet = walletById(walletId)
  if (!wallet) throw new Error('E_WALLET_UNKNOWN')
  if (wallet.address.toLowerCase() !== draft.owner.toLowerCase()) throw new Error('E_OWNER')
  const unlocked = unlockPrivateKey(walletId)
  if (unlocked.address.toLowerCase() !== draft.owner.toLowerCase()) throw new Error('E_OWNER')

  const now = Math.floor(Date.now() / 1000)
  const revision = Math.max(draft.revision, current?.config.revision ?? 0) + 1
  const draftHasWeth = [draft.riskToken, draft.quoteToken].some((token) => token.toLowerCase() === ADDR.WETH.toLowerCase())
  const quoteToken = draftHasWeth ? ADDR.WETH : draft.quoteToken
  const riskToken = draftHasWeth
    ? [draft.riskToken, draft.quoteToken].find((token) => token.toLowerCase() !== ADDR.WETH.toLowerCase())!
    : draft.riskToken
  const common: StrategyConfig = {
    ...draft,
    riskToken,
    quoteToken,
    staking: draft.staking?.enabled ? { ...draft.staking, rewardQuoteToken: quoteToken } : draft.staking,
    preset: 'original',
    sourcePreset: 'original',
    enabled: false,
    // Keep the user's selected symmetric band (the quick flow defaults to 5%).
    // All other ORIGINAL execution semantics remain fixed and server-owned.
    range: {
      mode: 'symmetric',
      lowerPct: draft.range.lowerPct,
      upperPct: draft.range.upperPct,
    },
    trigger: { source: 'spot', pollSeconds: 4, confirmationSeconds: 0, cooldownMinutes: 0 },
    boundary: {
      lower: { condition: 'always', action: 'recenter' },
      upper: { condition: 'always', action: 'recenter' },
    },
    // Quick ORIGINAL compounds both LP fees and converted staking rewards on
    // the next ordinary recenter so the NFT principal does not steadily shrink.
    fees: { handling: 'reinvest', timing: 'on_rebalance' },
    safeguards: { enabled: false, maxSlippageBps: 100, maxPlanAgeSeconds: 30 },
    execution: {
      mode: 'executor_auto',
      executorId: 'local',
      walletId,
      signerAddress: unlocked.address,
      dryRun: true,
      gasReserveMultiplier: 1.5,
      lowTransactionMode: draft.execution.lowTransactionMode,
    },
    revision,
    updatedAt: now,
  }
  const checkedDraft = parseStrategyConfig(common)
  const initial = await preflightStrategy(checkedDraft)
  const positionValue = BigInt(initial.expected.positionValueQuoteRaw)
  const projectedTurnover = BigInt(initial.expected.projectedTurnoverWithHeadroomQuoteRaw)
  // Each strategy has its own finite guard. Narrow bands receive proportionally
  // more room because their intended behavior is to recenter more frequently.
  const dailyLimitRaw = automaticDailyTurnoverLimit(checkedDraft, positionValue, projectedTurnover)
  // Accommodate ordinary gas spikes but retain a finite hard ceiling.
  const gasCapWei = max(BigInt(initial.gas.gasPriceWei) * 5n, 100_000_000n)
  const live = parseStrategyConfig({
    ...checkedDraft,
    enabled: true,
    execution: {
      ...checkedDraft.execution,
      dryRun: false,
      maxGasPriceWei: gasCapWei.toString(),
      maxDailyTurnoverQuote: formatUnits(dailyLimitRaw, initial.expected.quoteDecimals),
    },
  })
  // Re-run the full check with the live limits before any durable live state is
  // exposed to the monitor or runner.
  const preflight = await preflightStrategy(live)
  const baseline = current ? undefined : await observeStrategyBaseline(live)

  if (preflight.position.observedSide === 'in') {
    upsertStrategy(live)
    if (baseline) setStrategyBaselineIfAbsent(baseline)
    audit('api', 'simple_strategy_monitoring', 'strategy', live.id, {
      tokenId: live.activeTokenId,
      revision: live.revision,
    })
    return {
      config: live,
      job: null,
      preflight,
      appliedDefaults: {
        maxGasPriceWei: live.execution.maxGasPriceWei,
        maxDailyTurnoverQuote: live.execution.maxDailyTurnoverQuote,
      },
    }
  }

  // These calls are synchronous and intentionally adjacent: the monitor cannot
  // observe an enabled strategy before its first planned job exists.
  upsertStrategy(live)
  if (baseline) setStrategyBaselineIfAbsent(baseline)
  if (!createPlannedJob(preflight.plan)) {
    setStrategyState(live.id, current?.state ?? 'disabled')
    throw new Error('E_STRATEGY_BUSY')
  }
  setStrategyState(live.id, 'planned')
  audit('api', 'simple_strategy_started', 'strategy', live.id, {
    planId: preflight.plan.id,
    tokenId: live.activeTokenId,
    revision: live.revision,
  })
  return {
    config: live,
    job: { id: preflight.plan.id, dryRun: false },
    preflight,
    appliedDefaults: {
      maxGasPriceWei: live.execution.maxGasPriceWei,
      maxDailyTurnoverQuote: live.execution.maxDailyTurnoverQuote,
    },
  }
}
