import { useTranslation } from 'react-i18next'
import { fmtApr, type AddSim } from '../lib/apr'
import { fmtUsd } from '../lib/format'

/**
 * What the deposit becomes — three readings, no sentences.
 *
 * This used to be one long line ("dep ≈ $1,381 · fee APR (if unstaked) ≈ 34.2%
 * · emit APR (if staked) ≈ 12.1% · 0.42% of active liq · while in range"), read
 * left to right for the one number you were after. Three boxes hand each number
 * its own place, and the parenthetical that told fee APR from emit APR is now
 * the position on screen: emissions sit UNDER the fee APR they add to.
 *
 * Out of range there is nothing to project — an empty strip of dashes would
 * look like missing data, so the whole strip is replaced by the reason.
 */
export function AddStats({ sim, emitless }: { sim: AddSim | null; emitless?: boolean }) {
  const { t } = useTranslation()
  if (!sim) return null
  if (!sim.inRange) return <div className="red mono-sm zstats-out">{t('add.projOut')}</div>

  const emit = !emitless && Number.isFinite(sim.emitApr) ? fmtApr(sim.emitApr) : null
  return (
    <div className="zstats">
      <div className="stat">
        <div className="k">{t('add.statDeposit')}</div>
        <div className="v">{fmtUsd(sim.depositUsd)}</div>
      </div>
      <div className="stat">
        <div className="k">{t('add.statFeeApr')}</div>
        <div className="v">{fmtApr(sim.feeApr)}</div>
        {emit && <div className="sub green">{t('add.statEmit', { apr: emit })}</div>}
      </div>
      <div className="stat">
        <div className="k">{t('add.statShare')}</div>
        <div className="v">{sim.sharePct < 0.01 ? '<0.01%' : `${sim.sharePct.toFixed(2)}%`}</div>
      </div>
    </div>
  )
}
