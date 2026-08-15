import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { parseStrategyConfig } from '../../../shared/strategy/schema'
import type { BoundaryAction, BoundaryCondition, StrategyConfig } from '../../../shared/strategy/types'
import { Btn, NumInput } from '../ui'

const n = (value: string, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
const optionalN = (value: string) => value.trim() === '' ? undefined : n(value, 0)

export function StrategyEditor(props: { strategy: StrategyConfig; onSave: (strategy: StrategyConfig) => void; onCancel: () => void }) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(props.strategy)
  const [error, setError] = useState<string | null>(null)
  const set = (next: StrategyConfig) => setDraft({ ...next, preset: 'custom', updatedAt: Math.floor(Date.now() / 1000) })
  const save = () => {
    try {
      const parsed = parseStrategyConfig({ ...draft, revision: props.strategy.revision + 1, updatedAt: Math.floor(Date.now() / 1000) })
      props.onSave(parsed)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'invalid strategy')
    }
  }
  const resetOriginal = () => setDraft({
    ...draft,
    preset: 'original',
    sourcePreset: 'original',
    range: { mode: 'symmetric', lowerPct: 5, upperPct: 5 },
    trigger: { source: 'spot', pollSeconds: 4, confirmationSeconds: 0, cooldownMinutes: 0 },
    boundary: { lower: { condition: 'always', action: 'recenter' }, upper: { condition: 'always', action: 'recenter' } },
    fees: { handling: 'convert_to_quote', timing: 'on_rebalance' },
    safeguards: { enabled: false, maxSlippageBps: 100, maxPlanAgeSeconds: 30 },
  })

  return (
    <div className="card">
      <div className="card-head"><span className="card-title">{t('strategy.editorTitle')}</span></div>
      <div className="form-row">
        <span className="lbl">range mode</span>
        <select className="input" value={draft.range.mode} onChange={(event) => set({ ...draft, range: { ...draft.range, mode: event.target.value as StrategyConfig['range']['mode'] } })}>
          <option value="symmetric">symmetric</option><option value="asymmetric">asymmetric</option><option value="fixed_ticks">fixed ticks</option>
        </select>
        <span className="lbl">lower / upper %</span>
        <NumInput value={String(draft.range.lowerPct)} onChange={(value) => set({ ...draft, range: { ...draft.range, lowerPct: n(value, draft.range.lowerPct) } })} width={90} />
        <NumInput value={String(draft.range.upperPct)} onChange={(value) => set({ ...draft, range: { ...draft.range, upperPct: n(value, draft.range.upperPct) } })} width={90} />
      </div>
      {draft.range.mode === 'fixed_ticks' && <div className="form-row">
        <span className="lbl">fixed ticks</span>
        <NumInput signed value={draft.range.tickLower?.toString() ?? ''} onChange={(value) => set({ ...draft, range: { ...draft.range, tickLower: Math.trunc(n(value, 0)) } })} width={120} />
        <NumInput signed value={draft.range.tickUpper?.toString() ?? ''} onChange={(value) => set({ ...draft, range: { ...draft.range, tickUpper: Math.trunc(n(value, 0)) } })} width={120} />
      </div>}
      <div className="form-row">
        <span className="lbl">defensive lower / upper %</span>
        <NumInput value={draft.range.defensiveLowerPct?.toString() ?? ''} onChange={(value) => set({ ...draft, range: { ...draft.range, defensiveLowerPct: optionalN(value) } })} width={90} />
        <NumInput value={draft.range.defensiveUpperPct?.toString() ?? ''} onChange={(value) => set({ ...draft, range: { ...draft.range, defensiveUpperPct: optionalN(value) } })} width={90} />
      </div>
      <div className="form-row">
        <span className="lbl">trigger</span>
        <select className="input" value={draft.trigger.source} onChange={(event) => set({ ...draft, trigger: { ...draft.trigger, source: event.target.value as StrategyConfig['trigger']['source'] } })}>
          <option value="spot">spot</option><option value="sampled_twap">sampled TWAP</option>
        </select>
        <span className="lbl">poll / confirm sec / cooldown min</span>
        <NumInput value={String(draft.trigger.pollSeconds)} onChange={(value) => set({ ...draft, trigger: { ...draft.trigger, pollSeconds: n(value, draft.trigger.pollSeconds) } })} width={80} />
        <NumInput value={String(draft.trigger.confirmationSeconds)} onChange={(value) => set({ ...draft, trigger: { ...draft.trigger, confirmationSeconds: n(value, draft.trigger.confirmationSeconds) } })} width={80} />
        <NumInput value={String(draft.trigger.cooldownMinutes)} onChange={(value) => set({ ...draft, trigger: { ...draft.trigger, cooldownMinutes: n(value, draft.trigger.cooldownMinutes) } })} width={80} />
      </div>
      {(['lower', 'upper'] as const).map((side) => <div className="form-row" key={side}>
        <span className="lbl">{side} boundary</span>
        <select className="input" value={draft.boundary[side].condition} onChange={(event) => set({ ...draft, boundary: { ...draft.boundary, [side]: { ...draft.boundary[side], condition: event.target.value as BoundaryCondition } } })}>
          <option value="always">always</option><option value="fee_break_even">fee break-even</option><option value="manual_confirm">manual confirm</option>
        </select>
        <select className="input" value={draft.boundary[side].action} onChange={(event) => set({ ...draft, boundary: { ...draft.boundary, [side]: { ...draft.boundary[side], action: event.target.value as BoundaryAction } } })}>
          <option value="recenter">recenter</option><option value="skew_recenter">skew recenter</option><option value="hold_quote">hold quote</option><option value="pause">pause</option>
        </select>
      </div>)}
      <div className="form-row">
        <span className="lbl">fees</span>
        <select className="input" value={draft.fees.handling} onChange={(event) => set({ ...draft, fees: { ...draft.fees, handling: event.target.value as StrategyConfig['fees']['handling'] } })}>
          <option value="convert_to_quote">convert to quote</option><option value="reinvest">reinvest</option><option value="hold_tokens">hold tokens</option>
        </select>
        <select className="input" value={draft.fees.timing} onChange={(event) => set({ ...draft, fees: { ...draft.fees, timing: event.target.value as StrategyConfig['fees']['timing'] } })}>
          <option value="on_rebalance">on rebalance</option><option value="threshold">threshold</option><option value="interval">interval</option>
        </select>
        <input className="input" placeholder="threshold quote" value={draft.fees.thresholdQuote ?? ''} onChange={(event) => set({ ...draft, fees: { ...draft.fees, thresholdQuote: event.target.value || undefined } })} />
        <NumInput placeholder="interval min" value={draft.fees.intervalMinutes?.toString() ?? ''} onChange={(value) => set({ ...draft, fees: { ...draft.fees, intervalMinutes: optionalN(value) } })} width={100} />
      </div>
      <div className="form-row">
        <label><input type="checkbox" checked={draft.safeguards.enabled} onChange={(event) => set({ ...draft, safeguards: { ...draft.safeguards, enabled: event.target.checked } })} /> safeguards</label>
        <span className="lbl">slippage bps / plan age sec</span>
        <NumInput value={String(draft.safeguards.maxSlippageBps)} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, maxSlippageBps: n(value, draft.safeguards.maxSlippageBps) } })} width={90} />
        <NumInput value={String(draft.safeguards.maxPlanAgeSeconds)} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, maxPlanAgeSeconds: n(value, draft.safeguards.maxPlanAgeSeconds) } })} width={90} />
      </div>
      <div className="form-row">
        <span className="lbl">min crossing min / min net APR</span>
        <NumInput value={draft.safeguards.minCrossingMinutes?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, minCrossingMinutes: optionalN(value) } })} width={90} />
        <NumInput value={draft.safeguards.minNetAprPct?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, minNetAprPct: optionalN(value) } })} width={90} />
        <span className="lbl">max rebalances/day / lower breaks</span>
        <NumInput value={draft.safeguards.maxRebalancesPerDay?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, maxRebalancesPerDay: optionalN(value) } })} width={90} />
        <NumInput value={draft.safeguards.maxConsecutiveLowerBreaks?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, maxConsecutiveLowerBreaks: optionalN(value) } })} width={90} />
      </div>
      <div className="form-row">
        <span className="lbl">max risk % / swap impact bps</span>
        <NumInput value={draft.safeguards.maxRiskAssetPct?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, maxRiskAssetPct: optionalN(value) } })} width={90} />
        <NumInput value={draft.safeguards.maxSwapImpactBps?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, maxSwapImpactBps: optionalN(value) } })} width={90} />
      </div>
      <div className="form-row">
        <span className="lbl">vol window sec / max vol bps / spot-TWAP bps / stable sec</span>
        <NumInput value={draft.safeguards.volatilityWindowSeconds?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, volatilityWindowSeconds: optionalN(value) } })} width={80} />
        <NumInput value={draft.safeguards.maxVolatilityBps?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, maxVolatilityBps: optionalN(value) } })} width={80} />
        <NumInput value={draft.safeguards.maxSpotTwapDeviationBps?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, maxSpotTwapDeviationBps: optionalN(value) } })} width={80} />
        <NumInput value={draft.safeguards.stableMarketSeconds?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, stableMarketSeconds: optionalN(value) } })} width={80} />
      </div>
      <div className="form-row">
        <span className="lbl">burst window min / trigger count / wait min</span>
        <NumInput value={draft.safeguards.burstWindowMinutes?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, burstWindowMinutes: optionalN(value) } })} width={80} />
        <NumInput value={draft.safeguards.burstTriggerCount?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, burstTriggerCount: optionalN(value) } })} width={80} />
        <NumInput value={draft.safeguards.burstCooldownMinutes?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, burstCooldownMinutes: optionalN(value) } })} width={80} />
      </div>
      <div className="form-row">
        <span className="lbl">max gas wei / gas quote / daily turnover quote</span>
        <input className="input" value={draft.execution.maxGasPriceWei ?? ''} onChange={(event) => set({ ...draft, execution: { ...draft.execution, maxGasPriceWei: event.target.value || undefined } })} />
        <input className="input" value={draft.execution.maxGasQuotePerTx ?? ''} onChange={(event) => set({ ...draft, execution: { ...draft.execution, maxGasQuotePerTx: event.target.value || undefined } })} />
        <input className="input" value={draft.execution.maxDailyTurnoverQuote ?? ''} onChange={(event) => set({ ...draft, execution: { ...draft.execution, maxDailyTurnoverQuote: event.target.value || undefined } })} />
      </div>
      <div className="form-row">
        <label><input type="checkbox" checked={draft.execution.lowTransactionMode} onChange={(event) => set({ ...draft, execution: { ...draft.execution, lowTransactionMode: event.target.checked } })} /> low transaction mode (persistent approvals)</label>
      </div>
      {error && <div className="red mono-sm">{error}</div>}
      <div className="card-actions">
        <Btn onClick={resetOriginal}>{t('strategy.resetOriginal')}</Btn>
        <Btn onClick={save}>{t('strategy.saveEditor')}</Btn>
        <Btn tone="ghost" onClick={props.onCancel}>{t('strategy.cancelEditor')}</Btn>
      </div>
    </div>
  )
}
