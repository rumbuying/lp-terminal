import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { parseStrategyConfig, recommendedSafeguards } from '../../../shared/strategy/schema'
import type { BoundaryAction, BoundaryCondition, StrategyConfig } from '../../../shared/strategy/types'
import { Btn, NumInput } from '../ui'

const n = (value: string, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
const optionalN = (value: string) => value.trim() === '' ? undefined : n(value, 0)

function EditorSection(props: { title: string; hint: string; children: ReactNode }) {
  return <section className="strategy-editor-section">
    <div className="strategy-editor-section-head">
      <strong>{props.title}</strong>
      <span>{props.hint}</span>
    </div>
    <div className="strategy-editor-grid">{props.children}</div>
  </section>
}

function EditorField(props: { label: string; children: ReactNode; wide?: boolean }) {
  return <label className={`strategy-editor-field${props.wide ? ' wide' : ''}`}>
    <span>{props.label}</span>
    {props.children}
  </label>
}

function EditorToggle(props: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="strategy-editor-toggle">
    <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
    <span>{props.label}</span>
  </label>
}

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
      setError(cause instanceof Error ? cause.message : t('strategy.editor.invalidStrategy'))
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
    safeguards: recommendedSafeguards(5),
  })

  return (
    <div className="card strategy-editor">
      <div className="card-head"><span className="card-title">{t('strategy.editorTitle')}</span></div>
      <EditorSection title={t('strategy.editor.rangeSection')} hint={t('strategy.editor.rangeHint')}>
        <EditorField label={t('strategy.editor.rangeMode')}>
          <select className="input" value={draft.range.mode} onChange={(event) => set({ ...draft, range: { ...draft.range, mode: event.target.value as StrategyConfig['range']['mode'] } })}>
            <option value="symmetric">{t('strategy.editor.symmetric')}</option>
            <option value="asymmetric">{t('strategy.editor.asymmetric')}</option>
            <option value="fixed_ticks">{t('strategy.editor.fixedTicks')}</option>
          </select>
        </EditorField>
        <EditorField label={t('strategy.editor.lowerPct')}><NumInput value={String(draft.range.lowerPct)} onChange={(value) => set({ ...draft, range: { ...draft.range, lowerPct: n(value, draft.range.lowerPct) } })} /></EditorField>
        <EditorField label={t('strategy.editor.upperPct')}><NumInput value={String(draft.range.upperPct)} onChange={(value) => set({ ...draft, range: { ...draft.range, upperPct: n(value, draft.range.upperPct) } })} /></EditorField>
        {draft.range.mode === 'fixed_ticks' && <>
          <EditorField label={t('strategy.editor.tickLower')}><NumInput signed value={draft.range.tickLower?.toString() ?? ''} onChange={(value) => set({ ...draft, range: { ...draft.range, tickLower: Math.trunc(n(value, 0)) } })} /></EditorField>
          <EditorField label={t('strategy.editor.tickUpper')}><NumInput signed value={draft.range.tickUpper?.toString() ?? ''} onChange={(value) => set({ ...draft, range: { ...draft.range, tickUpper: Math.trunc(n(value, 0)) } })} /></EditorField>
        </>}
        <EditorField label={t('strategy.editor.defensiveLowerPct')}><NumInput value={draft.range.defensiveLowerPct?.toString() ?? ''} onChange={(value) => set({ ...draft, range: { ...draft.range, defensiveLowerPct: optionalN(value) } })} /></EditorField>
        <EditorField label={t('strategy.editor.defensiveUpperPct')}><NumInput value={draft.range.defensiveUpperPct?.toString() ?? ''} onChange={(value) => set({ ...draft, range: { ...draft.range, defensiveUpperPct: optionalN(value) } })} /></EditorField>
      </EditorSection>

      <EditorSection title={t('strategy.editor.triggerSection')} hint={t('strategy.editor.triggerHint')}>
        <EditorField label={t('strategy.editor.priceSource')}>
          <select className="input" value={draft.trigger.source} onChange={(event) => set({ ...draft, trigger: { ...draft.trigger, source: event.target.value as StrategyConfig['trigger']['source'] } })}>
            <option value="spot">{t('strategy.editor.spot')}</option>
            <option value="sampled_twap">{t('strategy.editor.sampledTwap')}</option>
          </select>
        </EditorField>
        <EditorField label={t('strategy.editor.pollSeconds')}><NumInput value={String(draft.trigger.pollSeconds)} onChange={(value) => set({ ...draft, trigger: { ...draft.trigger, pollSeconds: n(value, draft.trigger.pollSeconds) } })} /></EditorField>
        <EditorField label={t('strategy.editor.confirmationSeconds')}><NumInput value={String(draft.trigger.confirmationSeconds)} onChange={(value) => set({ ...draft, trigger: { ...draft.trigger, confirmationSeconds: n(value, draft.trigger.confirmationSeconds) } })} /></EditorField>
        <EditorField label={t('strategy.editor.cooldownMinutes')}><NumInput value={String(draft.trigger.cooldownMinutes)} onChange={(value) => set({ ...draft, trigger: { ...draft.trigger, cooldownMinutes: n(value, draft.trigger.cooldownMinutes) } })} /></EditorField>
        {(['lower', 'upper'] as const).map((side) => <EditorField wide key={side} label={t(side === 'lower' ? 'strategy.editor.lowerBoundary' : 'strategy.editor.upperBoundary')}>
          <span className="strategy-editor-pair">
            <select className="input" value={draft.boundary[side].condition} onChange={(event) => set({ ...draft, boundary: { ...draft.boundary, [side]: { ...draft.boundary[side], condition: event.target.value as BoundaryCondition } } })}>
              <option value="always">{t('strategy.editor.always')}</option>
              <option value="fee_break_even">{t('strategy.editor.feeBreakEven')}</option>
              <option value="manual_confirm">{t('strategy.editor.manualConfirm')}</option>
            </select>
            <select className="input" value={draft.boundary[side].action} onChange={(event) => set({ ...draft, boundary: { ...draft.boundary, [side]: { ...draft.boundary[side], action: event.target.value as BoundaryAction } } })}>
              <option value="recenter">{t('strategy.editor.recenter')}</option>
              <option value="skew_recenter">{t('strategy.editor.skewRecenter')}</option>
              <option value="hold_quote">{t('strategy.editor.holdQuote')}</option>
              <option value="pause">{t('strategy.editor.pause')}</option>
            </select>
          </span>
        </EditorField>)}
      </EditorSection>

      <EditorSection title={t('strategy.editor.feesSection')} hint={t('strategy.editor.feesHint')}>
        <EditorField label={t('strategy.editor.feeHandling')}>
          <select className="input" value={draft.fees.handling} onChange={(event) => set({ ...draft, fees: { ...draft.fees, handling: event.target.value as StrategyConfig['fees']['handling'] } })}>
            <option value="convert_to_quote">{t('strategy.editor.convertToQuote')}</option>
            <option value="reinvest">{t('strategy.editor.reinvest')}</option>
            <option value="hold_tokens">{t('strategy.editor.holdTokens')}</option>
          </select>
        </EditorField>
        <EditorField label={t('strategy.editor.feeTiming')}>
          <select className="input" value={draft.fees.timing} onChange={(event) => set({ ...draft, fees: { ...draft.fees, timing: event.target.value as StrategyConfig['fees']['timing'] } })}>
            <option value="on_rebalance">{t('strategy.editor.onRebalance')}</option>
            <option value="threshold">{t('strategy.editor.threshold')}</option>
            <option value="interval">{t('strategy.editor.interval')}</option>
          </select>
        </EditorField>
        <EditorField label={t('strategy.editor.thresholdQuote')}><input className="input" value={draft.fees.thresholdQuote ?? ''} onChange={(event) => set({ ...draft, fees: { ...draft.fees, thresholdQuote: event.target.value || undefined } })} /></EditorField>
        <EditorField label={t('strategy.editor.intervalMinutes')}><NumInput value={draft.fees.intervalMinutes?.toString() ?? ''} onChange={(value) => set({ ...draft, fees: { ...draft.fees, intervalMinutes: optionalN(value) } })} /></EditorField>
      </EditorSection>

      <EditorSection title={t('strategy.editor.capitalSection')} hint={t('strategy.editor.capitalHint')}>
        <EditorToggle label={t('strategy.editor.capitalEnabled')} checked={draft.capitalProtection.enabled} onChange={(checked) => set({ ...draft, capitalProtection: { ...draft.capitalProtection, enabled: checked } })} />
        <EditorField label={t('strategy.editor.profitThresholdUsdg')}><input className="input" value={draft.capitalProtection.profitThresholdUsdg} onChange={(event) => set({ ...draft, capitalProtection: { ...draft.capitalProtection, profitThresholdUsdg: event.target.value } })} /></EditorField>
      </EditorSection>

      <EditorSection title={t('strategy.editor.adaptiveSection')} hint={t('strategy.editor.adaptiveHint')}>
        <EditorToggle label={t('strategy.editor.adaptiveEnabled')} checked={draft.adaptiveRange.enabled} onChange={(checked) => set({ ...draft, adaptiveRange: { ...draft.adaptiveRange, enabled: checked } })} />
        <EditorField label={t('strategy.editor.targetMinutes')}><NumInput value={String(draft.adaptiveRange.targetMinutes)} onChange={(value) => set({ ...draft, adaptiveRange: { ...draft.adaptiveRange, targetMinutes: n(value, draft.adaptiveRange.targetMinutes) } })} /></EditorField>
        <EditorField label={t('strategy.editor.maxMultiplier')}><NumInput value={String(draft.adaptiveRange.maxMultiplier)} onChange={(value) => set({ ...draft, adaptiveRange: { ...draft.adaptiveRange, maxMultiplier: n(value, draft.adaptiveRange.maxMultiplier) } })} /></EditorField>
        <EditorField label={t('strategy.editor.recoveryDecay')}><NumInput value={String(draft.adaptiveRange.recoveryDecay)} onChange={(value) => set({ ...draft, adaptiveRange: { ...draft.adaptiveRange, recoveryDecay: n(value, draft.adaptiveRange.recoveryDecay) } })} /></EditorField>
        <EditorField label={t('strategy.editor.contractionReviewMinutes')}><NumInput value={String(draft.adaptiveRange.contractionReviewMinutes)} onChange={(value) => set({ ...draft, adaptiveRange: { ...draft.adaptiveRange, contractionReviewMinutes: n(value, draft.adaptiveRange.contractionReviewMinutes) } })} /></EditorField>
        <EditorField label={t('strategy.editor.contractionStabilityMinutes')}><NumInput value={String(draft.adaptiveRange.contractionStabilityMinutes)} onChange={(value) => set({ ...draft, adaptiveRange: { ...draft.adaptiveRange, contractionStabilityMinutes: n(value, draft.adaptiveRange.contractionStabilityMinutes) } })} /></EditorField>
        <EditorField label={t('strategy.editor.contractionMaxVolatilityBps')}><NumInput value={String(draft.adaptiveRange.contractionMaxVolatilityBps)} onChange={(value) => set({ ...draft, adaptiveRange: { ...draft.adaptiveRange, contractionMaxVolatilityBps: n(value, draft.adaptiveRange.contractionMaxVolatilityBps) } })} /></EditorField>
        <EditorField label={t('strategy.editor.contractionFeeCoverage')}><NumInput value={String(draft.adaptiveRange.contractionFeeCoverage)} onChange={(value) => set({ ...draft, adaptiveRange: { ...draft.adaptiveRange, contractionFeeCoverage: n(value, draft.adaptiveRange.contractionFeeCoverage) } })} /></EditorField>
      </EditorSection>

      <EditorSection title={t('strategy.editor.safeguardsSection')} hint={t('strategy.editor.safeguardsHint')}>
        <EditorToggle label={t('strategy.editor.safeguardsEnabled')} checked={draft.safeguards.enabled} onChange={(checked) => set({ ...draft, safeguards: { ...draft.safeguards, enabled: checked } })} />
        <EditorField label={t('strategy.editor.maxSlippageBps')}><NumInput value={String(draft.safeguards.maxSlippageBps)} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, maxSlippageBps: n(value, draft.safeguards.maxSlippageBps) } })} /></EditorField>
        <EditorField label={t('strategy.editor.maxPlanAgeSeconds')}><NumInput value={String(draft.safeguards.maxPlanAgeSeconds)} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, maxPlanAgeSeconds: n(value, draft.safeguards.maxPlanAgeSeconds) } })} /></EditorField>
        <EditorField label={t('strategy.editor.minCrossingMinutes')}><NumInput value={draft.safeguards.minCrossingMinutes?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, minCrossingMinutes: optionalN(value) } })} /></EditorField>
        <EditorField label={t('strategy.editor.minCycleFeeCoverage')}><NumInput value={draft.safeguards.minCycleFeeCoverage?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, minCycleFeeCoverage: optionalN(value) } })} /></EditorField>
        <EditorField label={t('strategy.editor.economicsHoldMinutes')}><NumInput value={draft.safeguards.economicsHoldMinutes?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, economicsHoldMinutes: optionalN(value) } })} /></EditorField>
        <EditorField label={t('strategy.editor.minNetAprPct')}><NumInput value={draft.safeguards.minNetAprPct?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, minNetAprPct: optionalN(value) } })} /></EditorField>
        <EditorField label={t('strategy.editor.maxRebalancesPerDay')}><NumInput value={draft.safeguards.maxRebalancesPerDay?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, maxRebalancesPerDay: optionalN(value) } })} /></EditorField>
        <EditorField label={t('strategy.editor.maxConsecutiveLowerBreaks')}><NumInput value={draft.safeguards.maxConsecutiveLowerBreaks?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, maxConsecutiveLowerBreaks: optionalN(value) } })} /></EditorField>
        <EditorField label={t('strategy.editor.maxRiskAssetPct')}><NumInput value={draft.safeguards.maxRiskAssetPct?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, maxRiskAssetPct: optionalN(value) } })} /></EditorField>
        <EditorField label={t('strategy.editor.maxSwapImpactBps')}><NumInput value={draft.safeguards.maxSwapImpactBps?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, maxSwapImpactBps: optionalN(value) } })} /></EditorField>
        <EditorField label={t('strategy.editor.volatilityWindowSeconds')}><NumInput value={draft.safeguards.volatilityWindowSeconds?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, volatilityWindowSeconds: optionalN(value) } })} /></EditorField>
        <EditorField label={t('strategy.editor.maxVolatilityBps')}><NumInput value={draft.safeguards.maxVolatilityBps?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, maxVolatilityBps: optionalN(value) } })} /></EditorField>
        <EditorField label={t('strategy.editor.maxSpotTwapDeviationBps')}><NumInput value={draft.safeguards.maxSpotTwapDeviationBps?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, maxSpotTwapDeviationBps: optionalN(value) } })} /></EditorField>
        <EditorField label={t('strategy.editor.stableMarketSeconds')}><NumInput value={draft.safeguards.stableMarketSeconds?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, stableMarketSeconds: optionalN(value) } })} /></EditorField>
        <EditorField label={t('strategy.editor.burstWindowMinutes')}><NumInput value={draft.safeguards.burstWindowMinutes?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, burstWindowMinutes: optionalN(value) } })} /></EditorField>
        <EditorField label={t('strategy.editor.burstTriggerCount')}><NumInput value={draft.safeguards.burstTriggerCount?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, burstTriggerCount: optionalN(value) } })} /></EditorField>
        <EditorField label={t('strategy.editor.burstCooldownMinutes')}><NumInput value={draft.safeguards.burstCooldownMinutes?.toString() ?? ''} onChange={(value) => set({ ...draft, safeguards: { ...draft.safeguards, burstCooldownMinutes: optionalN(value) } })} /></EditorField>
      </EditorSection>

      <EditorSection title={t('strategy.editor.executionSection')} hint={t('strategy.editor.executionHint')}>
        <EditorField label={t('strategy.editor.maxGasPriceWei')}><input className="input" value={draft.execution.maxGasPriceWei ?? ''} onChange={(event) => set({ ...draft, execution: { ...draft.execution, maxGasPriceWei: event.target.value || undefined } })} /></EditorField>
        <EditorField label={t('strategy.editor.maxGasQuotePerTx')}><input className="input" value={draft.execution.maxGasQuotePerTx ?? ''} onChange={(event) => set({ ...draft, execution: { ...draft.execution, maxGasQuotePerTx: event.target.value || undefined } })} /></EditorField>
        <EditorField label={t('strategy.editor.maxDailyTurnoverQuote')}><input className="input" value={draft.execution.maxDailyTurnoverQuote ?? ''} onChange={(event) => set({ ...draft, execution: { ...draft.execution, maxDailyTurnoverQuote: event.target.value || undefined } })} /></EditorField>
        <EditorToggle label={t('strategy.editor.lowTransactionMode')} checked={draft.execution.lowTransactionMode} onChange={(checked) => set({ ...draft, execution: { ...draft.execution, lowTransactionMode: checked } })} />
      </EditorSection>
      {error && <div className="red mono-sm">{error}</div>}
      <div className="card-actions">
        <Btn onClick={resetOriginal}>{t('strategy.resetOriginal')}</Btn>
        <Btn onClick={save}>{t('strategy.saveEditor')}</Btn>
        <Btn tone="ghost" onClick={props.onCancel}>{t('strategy.cancelEditor')}</Btn>
      </div>
    </div>
  )
}
