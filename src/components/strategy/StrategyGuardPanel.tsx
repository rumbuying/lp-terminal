import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { GuardCondition, GuardReport } from '../../lib/executorClient'

const nowSec = () => Math.floor(Date.now() / 1000)

/** Locale-neutral mm:ss / h:mm:ss countdown text. */
const clock = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}

type Translate = TFunction<'translation', undefined>

const conditionLabel = (c: GuardCondition, t: Translate) => {
  const side = c.side === 'upper' ? t('strategy.guardSideUpper') : t('strategy.guardSideLower')
  switch (c.id) {
    case 'sample_history': return t('strategy.guardCondSampleHistory')
    case 'market_volatility': return t('strategy.guardCondMarketVolatility', { threshold: c.threshold ?? '?' })
    case 'spot_twap_deviation': return t('strategy.guardCondSpotTwapDeviation', { threshold: c.threshold ?? '?' })
    case 'guard_recovery_stability': return t('strategy.guardCondRecoveryStability', { total: c.totalSeconds ?? 0 })
    case 'burst_throttle': return t('strategy.guardCondBurstThrottle', { threshold: c.threshold ?? '?' })
    case 'trigger_cooldown': return t('strategy.guardCondTriggerCooldown')
    case 'boundary_confirmation': return t('strategy.guardCondBoundaryConfirmation', { side })
    case 'boundary_pause': return t('strategy.guardCondBoundaryPause', { side })
    case 'apr_available': return t('strategy.guardCondAprAvailable')
    case 'manual_confirm': return t('strategy.guardCondManualConfirm')
    case 'monitor_recheck': return t('strategy.guardCondMonitorRecheck')
    case 'cycle_economics': return t('strategy.guardCondCycleEconomics', { threshold: c.threshold ?? '?' })
    default: return c.id
  }
}

const conditionValue = (c: GuardCondition, remaining: number | undefined, now: number, t: Translate) => {
  switch (c.id) {
    case 'sample_history':
      return t('strategy.guardValueSamples', { count: c.sampleCount ?? 0, threshold: c.threshold ?? 2 })
    case 'market_volatility':
    case 'spot_twap_deviation':
      return c.measured === undefined
        ? t('strategy.guardValueUnevaluated')
        : t('strategy.guardValueBps', { measured: c.measured, threshold: c.threshold ?? '?' })
    case 'guard_recovery_stability': {
      // wait + countdown = hold in progress; wait/fail without one = the
      // market is still violating a metric, so the hold has not started.
      if (c.status === 'wait' && c.waitUntil !== undefined) return t('strategy.guardValueRemaining', { time: clock(c.waitUntil - now) })
      if (c.status !== 'pass') return t('strategy.guardValueStillUnstable')
      return t('strategy.guardValueStable')
    }
    case 'burst_throttle': {
      const base = t('strategy.guardValueBurst', { measured: c.measured ?? 0, threshold: c.threshold ?? '?' })
      return c.status === 'wait' && remaining !== undefined && remaining > 0 ? `${base} · ${t('strategy.guardValueRemaining', { time: clock(remaining) })}` : base
    }
    case 'trigger_cooldown':
    case 'boundary_confirmation':
    case 'monitor_recheck':
      return remaining !== undefined && remaining > 0 ? t('strategy.guardValueRemaining', { time: clock(remaining) }) : t('strategy.guardValueReady')
    case 'boundary_pause':
      return t('strategy.guardValueBoundaryPause')
    case 'apr_available':
      return t('strategy.guardValueAprUnavailable')
    case 'manual_confirm':
      return t('strategy.guardValueManualConfirm')
    case 'cycle_economics': {
      const base = c.measured === undefined
        ? t('strategy.guardValueUnevaluated')
        : t('strategy.guardValueCycleEconomics', { measured: c.measured, threshold: c.threshold ?? '?' })
      return c.status === 'wait' && remaining !== undefined && remaining > 0 ? `${base} · ${t('strategy.guardValueRemaining', { time: clock(remaining) })}` : base
    }
    default:
      return ''
  }
}

/** Comma list of the conditions currently blocking execution, for status lines. */
export function guardBlockingText(report: GuardReport, t: Translate): string {
  const blocking = report.conditions.filter((c) => report.blocking.includes(c.id))
  return (blocking.length ? blocking : report.conditions).map((c) => conditionLabel(c, t)).join(t('strategy.guardJoin'))
}

/**
 * The concrete safety-condition checklist behind a "waiting for safe
 * conditions" state: every automated guard with its current measurement,
 * limit, pass/fail/wait verdict and a live countdown where one applies.
 */
export function StrategyGuardPanel({ report }: { report: GuardReport }) {
  const { t } = useTranslation()
  const hasCountdown = report.conditions.some((c) => c.waitUntil !== undefined)
  const [now, setNow] = useState(nowSec)
  useEffect(() => {
    if (!hasCountdown) return
    const timer = window.setInterval(() => setNow(nowSec()), 1000)
    return () => window.clearInterval(timer)
  }, [hasCountdown])

  const counts = { pass: 0, fail: 0, wait: 0 }
  for (const c of report.conditions) counts[c.status] += 1

  return (
    <div className="strategy-guard-panel">
      <div className="strategy-guard-head">
        <strong>{t('strategy.guardTitle')}</strong>
        <span className="strategy-guard-summary">
          <i className="pass">✓ {counts.pass}</i>
          <i className="fail">✕ {counts.fail}</i>
          <i className="wait">⏳ {counts.wait}</i>
        </span>
        <span className="strategy-guard-note">
          {report.needsManualResume ? t('strategy.guardManualResume') : t('strategy.guardAutoResume')}
        </span>
      </div>
      <ul className="strategy-guard-list">
        {report.conditions.map((c) => {
          const remaining = c.waitUntil !== undefined ? Math.max(0, c.waitUntil - now) : c.remainingSeconds
          const pct = c.waitUntil !== undefined && c.totalSeconds ? Math.min(100, Math.max(0, (1 - remaining! / c.totalSeconds) * 100)) : undefined
          return (
            <li key={c.id} className={`strategy-guard-row ${c.status}`} data-blocking={report.blocking.includes(c.id) || undefined}>
              <span className="strategy-guard-icon" aria-hidden>{c.status === 'pass' ? '✓' : c.status === 'fail' ? '✕' : '⏳'}</span>
              <span className="strategy-guard-label">{conditionLabel(c, t)}</span>
              <span className="strategy-guard-value">{conditionValue(c, remaining, now, t)}</span>
              {pct !== undefined && <span className="strategy-guard-bar"><i style={{ width: `${pct}%` }} /></span>}
            </li>
          )
        })}
      </ul>
      <div className="strategy-guard-checked mono-sm">{t('strategy.guardCheckedAt', { time: new Date(report.checkedAt * 1000).toLocaleTimeString() })}</div>
    </div>
  )
}
