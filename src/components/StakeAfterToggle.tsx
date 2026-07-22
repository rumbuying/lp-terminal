import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { autostake } from '../lib/autostake'

// "Stake after adding" — shown only for stakeable (gauge-live) targets. The
// checked/unchecked state is remembered (localStorage) and shared across every
// add surface, so toggling here sticks everywhere. Disabled while its flow is
// running: the preference is captured at click time, so a mid-run change could
// only desync the progress display from what actually executes.
export function StakeAfterToggle(props: { disabled?: boolean }) {
  const { t } = useTranslation()
  const on = useSyncExternalStore(autostake.subscribe, autostake.get)
  return (
    <label
      className={`stake-toggle mono-sm${props.disabled ? ' off' : ''}`}
      title={t('add.stakeAfterTip')}
    >
      <input
        type="checkbox"
        checked={on}
        disabled={props.disabled}
        onChange={(e) => autostake.set(e.target.checked)}
      />
      {t('add.stakeAfter')}
    </label>
  )
}
