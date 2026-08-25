import { useTranslation } from 'react-i18next'
import { usePnlUnit } from '../hooks/usePnlUnit'

export function PnlUnitToggle() {
  const { t } = useTranslation()
  const [unit, setUnit] = usePnlUnit()
  return <div className="pnl-unit-control">
    <span>{t('common.pnlUnitLabel')}</span>
    <div className="pnl-unit-toggle" role="group" aria-label={t('common.pnlUnitLabel')}>
      <button type="button" className={unit === 'quote' ? 'active' : ''} aria-pressed={unit === 'quote'} onClick={() => setUnit('quote')}>{t('common.pnlUnitQuote')}</button>
      <button type="button" className={unit === 'stable' ? 'active' : ''} aria-pressed={unit === 'stable'} onClick={() => setUnit('stable')}>{t('common.pnlUnitStable')}</button>
    </div>
  </div>
}
