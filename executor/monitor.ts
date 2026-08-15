import { parseUnits } from 'viem'
import { makeFeeCollectionPlan, makeRebalancePlan } from '../shared/strategy/planner'
import { StrategyError } from '../shared/strategy/errors'
import { rangeSide } from '../shared/strategy/range'
import { decideBoundaryTrigger } from '../shared/strategy/trigger'
import { evaluateMarketQuality, shouldStartBurstWait } from '../shared/strategy/market-guard'
import { publicClient, readCollectableFees, readMonitorSnapshots, readStrategySnapshot } from './chain'
import { EXECUTOR } from './config'
import { quoteTurnover } from './risk'
import {
  audit,
  completedCyclesSince,
  createPlannedJob,
  enabledExecutorStrategies,
  executorPaused,
  latestCompletedCycleAt,
  latestFeeCollectionAt,
  monitorState,
  recordPriceSample,
  sampledAverageTick,
  sampledTickStats,
  setStrategyState,
  updateMonitorState,
} from './store'
import { clearStrategyRetry, deferStrategyRetry, strategyRetryReady } from './retry-state'

let running = false
const low = (value: string) => value.toLowerCase()
const nextMonitorAt = new Map<string, number>()

async function feeCollectionDue(config: Parameters<typeof readStrategySnapshot>[0], snapshot: Awaited<ReturnType<typeof readStrategySnapshot>>, now: number) {
  if (config.fees.timing === 'on_rebalance' || config.fees.handling === 'reinvest') return false
  const fees = await readCollectableFees(config)
  if (fees.amount0 === 0n && fees.amount1 === 0n) return false
  if (config.fees.timing === 'interval') {
    const last = latestFeeCollectionAt(config.id) ?? config.updatedAt
    return now - last >= (config.fees.intervalMinutes ?? 0) * 60
  }
  const quoteDecimals = low(config.quoteToken) === low(snapshot.token0) ? snapshot.token0Decimals : snapshot.token1Decimals
  const quoteValue = (low(snapshot.token0) === low(config.quoteToken)
    ? fees.amount0
    : quoteTurnover(fees.amount0, snapshot.token0, config, snapshot, BigInt(snapshot.sqrtPriceX96))) +
    (low(snapshot.token1) === low(config.quoteToken)
      ? fees.amount1
      : quoteTurnover(fees.amount1, snapshot.token1, config, snapshot, BigInt(snapshot.sqrtPriceX96)))
  return quoteValue >= parseUnits(config.fees.thresholdQuote!, quoteDecimals)
}

/** One global, non-overlapping monitor pass. It creates plans; the runner owns signing. */
export async function monitorOnce(options: { ignoreSchedule?: boolean } = {}) {
  if (running) return
  if (executorPaused()) return
  running = true
  try {
    const nowMs = Date.now()
    const due = enabledExecutorStrategies().filter(({ config }) => options.ignoreSchedule || nowMs >= (nextMonitorAt.get(config.id) ?? 0))
    if (due.length === 0) return
    for (const { config } of due) {
      const intervalSeconds = Math.max(config.trigger.pollSeconds, EXECUTOR.monitorMinSeconds)
      nextMonitorAt.set(config.id, nowMs + intervalSeconds * 1000)
    }
    const ready = due.filter(({ config }) => strategyRetryReady(config.id))
    if (ready.length === 0) return
    let blockNumber: bigint
    try {
      blockNumber = await publicClient.getBlockNumber()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'block head read failed'
      for (const { config } of ready) {
        const delayMs = deferStrategyRetry(config.id)
        setStrategyState(config.id, 'monitoring')
        audit('monitor', 'monitor_retry', 'strategy', config.id, {
          code: 'E_RPC_BLOCK_HEAD',
          message: message.slice(0, 160),
          delayMs,
        })
      }
      return
    }
    const snapshots = await readMonitorSnapshots(ready.map(({ config }) => config), blockNumber)
    for (const { config } of ready) {
      try {
        const snapshot = snapshots.get(config.id)
        if (snapshot instanceof Error) throw snapshot
        if (!snapshot) throw new Error('E_MONITOR_SNAPSHOT')
        const now = Math.floor(Date.now() / 1000)
        const previous = monitorState(config.id)
        if (previous && previous.revision === config.revision && previous.lastTokenId === snapshot.tokenId && previous.lastLiquidity !== undefined && previous.lastLiquidity !== snapshot.liquidity)
          throw new Error('E_POSITION_CHANGED')

        recordPriceSample(config.id, now, snapshot.tick, snapshot.blockNumber)
        let triggerTick = snapshot.tick
        let marketStats: ReturnType<typeof sampledTickStats>
        if (config.trigger.source === 'sampled_twap') {
          const windowSeconds = Math.max(60, config.trigger.confirmationSeconds, config.trigger.pollSeconds * 3)
          const average = sampledAverageTick(config.id, now - windowSeconds)
          if (!average || average.count < 2 || average.firstTs > now - windowSeconds + config.trigger.pollSeconds * 2) {
            updateMonitorState(config.id, { revision: config.revision, lastTick: snapshot.tick, lastLiquidity: snapshot.liquidity, lastTokenId: snapshot.tokenId })
            setStrategyState(config.id, 'monitoring')
            continue
          }
          triggerTick = average.tick
        }

        const volatilityWindowSeconds = config.safeguards.enabled ? config.safeguards.volatilityWindowSeconds : undefined
        if (volatilityWindowSeconds && (config.safeguards.maxVolatilityBps !== undefined || config.safeguards.maxSpotTwapDeviationBps !== undefined)) {
          marketStats = sampledTickStats(config.id, now - volatilityWindowSeconds)
          if (!marketStats || marketStats.count < 2 || marketStats.firstTs > now - volatilityWindowSeconds + config.trigger.pollSeconds * 2) {
            updateMonitorState(config.id, {
              revision: config.revision,
              guardReason: previous?.guardReason,
              lastTick: snapshot.tick,
              lastLiquidity: snapshot.liquidity,
              lastTokenId: snapshot.tokenId,
            })
            setStrategyState(config.id, 'guard_wait')
            continue
          }
          const quality = evaluateMarketQuality({
            spotTick: snapshot.tick,
            averageTick: marketStats.tick,
            minTick: marketStats.minTick,
            maxTick: marketStats.maxTick,
            maxVolatilityBps: config.safeguards.maxVolatilityBps,
            maxSpotTwapDeviationBps: config.safeguards.maxSpotTwapDeviationBps,
          })
          if (!quality.healthy) {
            const newlyTripped = previous?.guardReason !== quality.reason
            updateMonitorState(config.id, {
              revision: config.revision,
              guardReason: quality.reason,
              burstWaitUntil: previous?.burstWaitUntil,
              burstResetAt: previous?.burstResetAt,
              lastTick: snapshot.tick,
              lastLiquidity: snapshot.liquidity,
              lastTokenId: snapshot.tokenId,
            })
            setStrategyState(config.id, 'guard_wait')
            if (newlyTripped) audit('monitor', 'market_guard_wait', 'strategy', config.id, {
              reason: quality.reason,
              volatilityBps: quality.volatilityBps,
              spotTwapDeviationBps: quality.spotTwapDeviationBps,
            })
            continue
          }
          if (previous?.guardReason) {
            const stableSince = previous.guardStableSince ?? now
            if (now - stableSince < (config.safeguards.stableMarketSeconds ?? 0)) {
              updateMonitorState(config.id, {
                revision: config.revision,
                guardReason: previous.guardReason,
                guardStableSince: stableSince,
                burstWaitUntil: previous.burstWaitUntil,
                burstResetAt: previous.burstResetAt,
                lastTick: snapshot.tick,
                lastLiquidity: snapshot.liquidity,
                lastTokenId: snapshot.tokenId,
              })
              setStrategyState(config.id, 'guard_wait')
              continue
            }
            audit('monitor', 'market_guard_resumed', 'strategy', config.id, {
              reason: previous.guardReason,
              stableSeconds: now - stableSince,
            })
          }
        }

        const side = rangeSide(triggerTick, snapshot.tickLower, snapshot.tickUpper)
        const reset = !previous || previous.revision !== config.revision || previous.lastTokenId !== snapshot.tokenId
        const outSince = side === 'in' ? undefined : reset || previous.outSide !== side ? now : previous.outSince ?? now
        const latestCompleted = latestCompletedCycleAt(config.id)
        const cooldownUntil = latestCompleted && config.trigger.cooldownMinutes > 0 ? latestCompleted + config.trigger.cooldownMinutes * 60 : undefined
        const confirmationSeconds = Math.max(
          config.trigger.confirmationSeconds,
          config.safeguards.enabled ? (config.safeguards.minCrossingMinutes ?? 0) * 60 : 0,
        )
        if (side === 'in' && await feeCollectionDue(config, snapshot, now)) {
          updateMonitorState(config.id, {
            revision: config.revision,
            lastTick: snapshot.tick,
            lastLiquidity: snapshot.liquidity,
            lastTokenId: snapshot.tokenId,
          })
          const feePlan = makeFeeCollectionPlan({ config, snapshot, now })
          if (createPlannedJob(feePlan)) {
            audit('monitor', 'fee_plan_created', 'strategy', config.id, { planId: feePlan.id, timing: config.fees.timing })
            setStrategyState(config.id, 'planned')
          } else setStrategyState(config.id, 'monitoring')
          continue
        }
        const decision = decideBoundaryTrigger({
          tick: triggerTick,
          tickLower: snapshot.tickLower,
          tickUpper: snapshot.tickUpper,
          lower: config.boundary.lower,
          upper: config.boundary.upper,
          now,
          outOfRangeSince: outSince,
          confirmationSeconds,
          cooldownUntil,
          netAprPct: null,
          minNetAprPct: config.safeguards.enabled ? config.safeguards.minNetAprPct : undefined,
        })
        updateMonitorState(config.id, {
          revision: config.revision,
          outSide: side === 'in' ? undefined : side,
          outSince,
          cooldownUntil,
          burstWaitUntil: previous?.burstWaitUntil,
          burstResetAt: previous?.burstResetAt,
          lastTick: snapshot.tick,
          lastLiquidity: snapshot.liquidity,
          lastTokenId: snapshot.tokenId,
        })
        if (decision.kind === 'none') {
          clearStrategyRetry(config.id)
          setStrategyState(config.id, (previous?.burstWaitUntil ?? 0) > now ? 'guard_wait' : 'monitoring')
          continue
        }
        if (decision.kind === 'pause') {
          const state = decision.detail?.reason === 'manual_confirm' ? 'awaiting_manual' : 'paused_guard'
          setStrategyState(config.id, state)
          audit('monitor', 'strategy_paused', 'strategy', config.id, { code: decision.code, detail: decision.detail ?? {} })
          continue
        }
        const burstWindowSeconds = (config.safeguards.enabled ? config.safeguards.burstWindowMinutes : undefined) !== undefined
          ? config.safeguards.burstWindowMinutes! * 60
          : undefined
        const burstTriggerCount = config.safeguards.enabled ? config.safeguards.burstTriggerCount : undefined
        const burstCooldownSeconds = config.safeguards.enabled && config.safeguards.burstCooldownMinutes !== undefined
          ? config.safeguards.burstCooldownMinutes * 60
          : undefined
        if (burstWindowSeconds && burstTriggerCount && burstCooldownSeconds) {
          if ((previous?.burstWaitUntil ?? 0) > now) {
            updateMonitorState(config.id, {
              revision: config.revision,
              outSide: side === 'in' ? undefined : side,
              outSince,
              cooldownUntil,
              burstWaitUntil: previous!.burstWaitUntil,
              burstResetAt: previous?.burstResetAt,
              lastTick: snapshot.tick,
              lastLiquidity: snapshot.liquidity,
              lastTokenId: snapshot.tokenId,
            })
            setStrategyState(config.id, 'guard_wait')
            continue
          }
          const resetAt = previous?.burstResetAt
          const since = Math.max(now - burstWindowSeconds, resetAt ?? 0)
          const recent = completedCyclesSince(config.id, since)
          if (shouldStartBurstWait(recent, burstTriggerCount)) {
            const waitUntil = now + burstCooldownSeconds
            updateMonitorState(config.id, {
              revision: config.revision,
              outSide: side === 'in' ? undefined : side,
              outSince,
              cooldownUntil,
              burstWaitUntil: waitUntil,
              burstResetAt: waitUntil,
              lastTick: snapshot.tick,
              lastLiquidity: snapshot.liquidity,
              lastTokenId: snapshot.tokenId,
            })
            setStrategyState(config.id, 'guard_wait')
            audit('monitor', 'burst_guard_wait', 'strategy', config.id, {
              recentTriggers: recent + 1,
              windowSeconds: burstWindowSeconds,
              waitUntil,
            })
            continue
          }
        }
        const plan = makeRebalancePlan({ config, snapshot, triggerSide: decision.side })
        if (createPlannedJob(plan)) {
          audit('monitor', 'plan_created', 'strategy', config.id, { planId: plan.id, side: plan.triggerSide })
          setStrategyState(config.id, 'planned')
        } else setStrategyState(config.id, 'monitoring')
      } catch (error) {
        const message = error instanceof Error ? error.message : 'monitor error'
        const transient = /RPC Request failed|HTTP request failed|fetch failed|network|socket|timeout|timed out|rate limit|\b429\b|\b502\b|\b503\b|\b504\b/i.test(message)
        if (transient) {
          // A temporary provider/transport outage must not permanently disable
          // unattended automation. No transaction is signed in a failed read
          // pass; leave the strategy monitoring so the next poll retries.
          const delayMs = deferStrategyRetry(config.id)
          setStrategyState(config.id, 'monitoring')
          audit('monitor', 'monitor_retry', 'strategy', config.id, { message: message.slice(0, 160), delayMs })
          continue
        }
        const code = error instanceof StrategyError ? error.code : /^E_[A-Z0-9_]+$/.test(message) ? message : 'E_MONITOR'
        const delayMs = deferStrategyRetry(config.id)
        // An enabled automation remains enabled. Deterministic read/config
        // failures use the same bounded retry loop as provider outages instead
        // of becoming a permanent operator-only pause.
        setStrategyState(config.id, 'monitoring')
        audit('monitor', 'monitor_retry', 'strategy', config.id, { code, message: message.slice(0, 160), delayMs })
      }
    }
  } finally {
    running = false
  }
}
