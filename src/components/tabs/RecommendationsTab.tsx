import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAccount } from 'wagmi'
import { useExecutorWalletAuth } from '../../hooks/useExecutorWalletAuth'
import { executorRecommendations, savedExecutorAccessToken } from '../../lib/executorClient'
import { fmtUsd } from '../../lib/format'
import { recommendationDisplayItems, type RecommendationObservationReason } from '../../lib/recommendationDisplay'
import { queueRecommendationPrefill } from '../../lib/recommendationPrefill'
import type { RecommendationItem, RecommendationMode, RecommendationResponse, RecommendationRisk } from '../../../shared/recommendation/types'
import { ProtoBadge } from '../ProtoBadge'
import { Btn, NumInput } from '../ui'

const MODES: readonly RecommendationMode[] = ['fees', 'rewards']
type ModeMap<T> = Record<RecommendationMode, T>

export function RecommendationsTab(props: { onOpenPool: () => void }) {
  const { t } = useTranslation()
  const { address: user } = useAccount()
  const [capital, setCapital] = useState('1000')
  const [risk, setRisk] = useState<RecommendationRisk>('balanced')
  const [authEnabled, setAuthEnabled] = useState(false)
  const walletAuth = useExecutorWalletAuth(user, authEnabled && !savedExecutorAccessToken(user))
  const token = walletAuth.token || savedExecutorAccessToken(user)
  const [data, setData] = useState<ModeMap<RecommendationResponse | null>>({ fees: null, rewards: null })
  const [errors, setErrors] = useState<ModeMap<string | null>>({ fees: null, rewards: null })
  const [loading, setLoading] = useState<ModeMap<boolean>>({ fees: false, rewards: false })
  const requestedCapitalUsd = Number(capital)
  const freshData = (mode: RecommendationMode) => {
    const response = data[mode]
    return response?.capitalUsd === requestedCapitalUsd && response.risk === risk ? response : null
  }
  const recommendationLoaded = MODES.every((mode) => freshData(mode) !== null || errors[mode] !== null)
  const best = recommendationLoaded
    ? MODES.flatMap((mode) => freshData(mode)?.items ?? [])
      .sort((a, b) => b.projection24h.riskAdjustedNetUsd - a.projection24h.riskAdjustedNetUsd)[0]
    : undefined

  useEffect(() => {
    if (!token) return
    let cancelled = false
    const load = async () => {
      const capitalUsd = Number(capital)
      if (!Number.isFinite(capitalUsd) || capitalUsd < 10) return
      setLoading({ fees: true, rewards: true })
      await Promise.all(MODES.map(async (mode) => {
        try {
          const response = await executorRecommendations(token, { capitalUsd, mode, risk, limit: 3 })
          if (!cancelled) {
            setData((current) => ({ ...current, [mode]: response }))
            setErrors((current) => ({ ...current, [mode]: null }))
          }
        } catch (loadError) {
          if (!cancelled) setErrors((current) => ({
            ...current,
            [mode]: loadError instanceof Error ? loadError.message : t('pools.recUnavailable'),
          }))
        } finally {
          if (!cancelled) setLoading((current) => ({ ...current, [mode]: false }))
        }
      }))
    }
    const debounce = setTimeout(() => void load(), 300)
    const refresh = setInterval(() => void load(), 60_000)
    return () => { cancelled = true; clearTimeout(debounce); clearInterval(refresh) }
  }, [token, capital, risk, t])

  const apply = (mode: RecommendationMode, item: RecommendationItem, status: 'recommended' | 'observed') => {
    queueRecommendationPrefill(item, data[mode]?.capitalUsd ?? Number(capital), status)
    props.onOpenPool()
  }

  return (
    <div className="recommendations-page">
      <section className="recommender" aria-labelledby="recommender-title">
        <div className="recommender-head">
          <div>
            <div className="recommender-kicker">{t('pools.recKicker')}</div>
            <h2 id="recommender-title">{t('pools.recTitle')}</h2>
            <p>{t('pools.recSubtitle')}</p>
          </div>
          <div className="recommender-controls">
            <label><span>{t('pools.recCapital')}</span><NumInput value={capital} onChange={setCapital} width={100} /><i>USD</i></label>
            <label><span>{t('pools.recRisk')}</span><select className="input" value={risk} onChange={(event) => setRisk(event.target.value as RecommendationRisk)}>
              <option value="conservative">{t('pools.recRiskConservative')}</option><option value="balanced">{t('pools.recRiskBalanced')}</option><option value="aggressive">{t('pools.recRiskAggressive')}</option>
            </select></label>
          </div>
        </div>
        {!token ? (
          <div className="recommender-empty">
            <span className="dim">{walletAuth.status === 'signing' || walletAuth.status === 'verifying' ? t('pools.recSigning') : t('pools.recAuth')}</span>
            <Btn onClick={() => { setAuthEnabled(true); if (authEnabled) walletAuth.retry() }}>{t('pools.recConnect')}</Btn>
          </div>
        ) : (
          <>
            {best ? (
              <section className="recommendation-best" aria-label={t('pools.recBestNow')}>
                <div>
                  <span className="recommendation-best-kicker">{t('pools.recBestNow')}</span>
                  <h3>{best.pair} <ProtoBadge proto={best.protocol} mini /></h3>
                  <p>{best.mode === 'fees' ? t('pools.recModeFees') : t('pools.recModeRewards')} · {best.lookback.window.toUpperCase()} · ±{best.range.lowerPct}% · {best.projection24h.reopens.toFixed(1)} {t('pools.recReopens')}</p>
                </div>
                <div className="recommendation-best-return"><span>{t('pools.recNet24h')}</span><b>{fmtUsd(best.projection24h.netUsd)}</b><small>{t('pools.recAfterRisk', { value: fmtUsd(best.projection24h.riskAdjustedNetUsd) })}</small></div>
                <Btn onClick={() => apply(best.mode, best, 'recommended')}>{t('pools.recOpenBest')}</Btn>
              </section>
            ) : recommendationLoaded && !loading.fees && !loading.rewards ? (
              <div className="recommendation-no-open amber"><strong>{t('pools.recNoBest')}</strong><span>{t('pools.recNoBestDetail')}</span></div>
            ) : null}
            <div className="recommendation-mode-sections">
              {MODES.map((mode) => (
                <RecommendationModeSection
                  key={mode}
                  mode={mode}
                  data={data[mode]}
                  loading={loading[mode]}
                  error={errors[mode] ?? walletAuth.error}
                  onApply={(item, status) => apply(mode, item, status)}
                />
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  )
}

function RecommendationModeSection(props: {
  mode: RecommendationMode
  data: RecommendationResponse | null
  loading: boolean
  error: string | null
  onApply: (item: RecommendationItem, status: 'recommended' | 'observed') => void
}) {
  const { t } = useTranslation()
  const displayed = recommendationDisplayItems(props.data, 3)
  const recommendedCount = displayed.filter((row) => row.status === 'recommended').length
  const modeTitle = props.mode === 'fees' ? t('pools.recModeFees') : t('pools.recModeRewards')
  const modeSubtitle = props.mode === 'fees' ? t('pools.recModeFeesSubtitle') : t('pools.recModeRewardsSubtitle')
  const windowReason = (item: RecommendationItem) => {
    if (item.lookback.reason === 'walk_forward') return t('pools.recReasonWalkForward')
    if (item.lookback.reason === 'short_spike') return t('pools.recReasonSpike')
    if (item.lookback.reason === 'slowing') return t('pools.recReasonSlowing')
    if (item.lookback.reason === 'stable_intraday') return t('pools.recReasonStable')
    if (item.lookback.reason === 'h24_fallback') return t('pools.recReasonFallback')
    return t('pools.recReasonBootstrap')
  }
  const confidence = (level: RecommendationItem['confidence']['level']) =>
    level === 'high' ? t('pools.recConfidenceHigh') : level === 'medium' ? t('pools.recConfidenceMedium') : t('pools.recConfidenceLow')
  const observationReason = (reasons: RecommendationObservationReason[]) => {
    const labels = reasons.map((reason) => {
      if (reason === 'low_confidence') return t('pools.recObservedLowConfidence')
      if (reason === 'non_positive_net') return t('pools.recObservedNonPositive')
      if (reason === 'excessive_reopens') return t('pools.recObservedReopens')
      if (reason === 'insufficient_tick_history') return t('pools.recObservedHistory')
      if (reason === 'unanchored_quote_risk') return t('pools.recObservedQuoteRisk')
      return t('pools.recObservedRiskNet')
    })
    return t('pools.recObservedReason', { reason: labels.join(' · ') || t('pools.recObservedBelowCutoff') })
  }

  return (
    <section className={`recommendation-mode-section ${props.mode}`} aria-labelledby={`recommendation-mode-${props.mode}`}>
      <div className="recommendation-mode-head">
        <div>
          <h3 id={`recommendation-mode-${props.mode}`}>{modeTitle}</h3>
          <p>{modeSubtitle}</p>
        </div>
        {props.loading && props.data && <span className="dim mono-sm">{t('pools.recRefreshing')} <span className="spin">▮</span></span>}
      </div>
      {props.loading && !props.data ? (
        <div className="recommender-empty dim">{t('pools.recCalculating')} <span className="spin">▮</span></div>
      ) : props.error ? (
        <div className="recommender-empty amber">{t('pools.recUnavailable')}: {props.error}</div>
      ) : displayed.length === 0 ? (
        <div className="recommender-empty dim">{t('pools.recWarming')}</div>
      ) : (
        <>
          {recommendedCount < displayed.length && (
            <div className="recommender-note amber">
              {recommendedCount === 0 ? t('pools.recObservationOnly') : t('pools.recMixedResults', { n: recommendedCount })}
            </div>
          )}
          <div className="recommender-grid">
            {displayed.map(({ item, status, observationReasons }, index) => (
              <article className={`recommendation-card ${status}`} key={`${item.pool}:${item.mode}`}>
                <div className="recommendation-card-head">
                  <span className="rec-rank">#{index + 1}</span><strong>{item.pair}</strong><ProtoBadge proto={item.protocol} mini />
                  <span className={`rec-status ${status}`}>{status === 'recommended' ? t('pools.recRecommended') : t('pools.recObserved')}</span>
                  <span className={`rec-confidence ${item.confidence.level}`}>{confidence(item.confidence.level)} {Math.round(item.confidence.score * 100)}%</span>
                </div>
                <div className="recommendation-main">
                  <div><span>{t('pools.recWindow')}</span><b>{item.lookback.window.toUpperCase()}</b><small>{windowReason(item)}</small></div>
                  <div><span>{t('pools.recRange')}</span><b>±{item.range.lowerPct}%</b><small>{item.range.tickLower} → {item.range.tickUpper}</small></div>
                  <div><span>{t('pools.recNet24h')}</span><b className={item.projection24h.netUsd >= 0 ? 'green' : 'red'}>{fmtUsd(item.projection24h.netUsd)}</b><small>{item.projection24h.reopens.toFixed(1)} {t('pools.recReopens')}</small></div>
                </div>
                {status === 'observed' && <div className="rec-observation-reason">{observationReason(observationReasons)}</div>}
                <details>
                  <summary>{t('pools.recExplain')}</summary>
                  <div className="recommendation-breakdown mono-sm">
                    <span>{props.mode === 'fees' ? t('pools.recGrossFees') : t('pools.recRewards')}<b>{fmtUsd(props.mode === 'fees' ? item.projection24h.grossFeeUsd : item.projection24h.rewardUsd)}</b></span>
                    <span>{t('pools.recGas')}<b>−{fmtUsd(item.projection24h.gasUsd)}</b></span>
                    <span>{t('pools.recExecution')}<b>−{fmtUsd(item.projection24h.executionUsd)}</b></span>
                    <span>{t('pools.recTailRisk')}<b>{fmtUsd(item.projection24h.cvar95Usd)}</b></span>
                    <span>1H / 6H / 24H<b>{item.market.vol1hUsd == null ? '—' : fmtUsd(item.market.vol1hUsd)} / {item.market.vol6hUsd == null ? '—' : fmtUsd(item.market.vol6hUsd)} / {item.market.vol24hUsd == null ? '—' : fmtUsd(item.market.vol24hUsd)}</b></span>
                    <span>{t('pools.recCoverage')}<b>{item.market.tickCoverageHours.toFixed(1)}h · {item.cost.sampleCycles} cycles</b></span>
                  </div>
                </details>
                <Btn onClick={() => props.onApply(item, status)}>{status === 'recommended' ? t('pools.recApply') : t('pools.recInspect')}</Btn>
              </article>
            ))}
          </div>
          {props.data && <div className="recommender-foot mono-sm">{t('pools.recAsOf', { time: new Date(props.data.marketAsOf * 1000).toLocaleTimeString() })} · {props.data.modelVersion}</div>}
        </>
      )}
    </section>
  )
}
