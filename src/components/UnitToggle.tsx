import { useTranslation } from 'react-i18next'
import type { PriceUnit } from '../hooks/usePriceUnit'

/**
 * The two controls that decide how a price reads, drawn as one.
 *
 * ⇄ is only there while the pool's own quote is showing: once dollars are on the
 * orientation is settled (see usePriceUnit) and an arrow that flips nothing is
 * worse than no arrow. $ carries a border where ⇄ does not — an arrow glyph
 * reads as an action wherever it lands, while a bare $ beside a price reads as
 * part of the price.
 */
export function UnitToggle({ unit }: { unit: PriceUnit }) {
  const { t } = useTranslation()
  return (
    <>
      {!unit.usd && (
        <button className="rbar-flip" title={t('rbar.flipTip')} onClick={unit.toggleFlip}>
          ⇄
        </button>
      )}
      {unit.available && (
        <button
          className={`rbar-flip lr-unit${unit.usdOn ? ' on' : ''}`}
          title={t('lrange.usdTip')}
          onClick={unit.toggleUsd}
        >
          $
        </button>
      )}
    </>
  )
}
