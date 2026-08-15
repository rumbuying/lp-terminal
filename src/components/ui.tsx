import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { formatUnits } from 'viem'
import { fmtAmount, sanitizeAmountInput } from '../lib/format'

export function Btn(props: {
  onClick?: () => void
  disabled?: boolean
  tone?: 'default' | 'danger' | 'ghost' | 'amber'
  big?: boolean
  busy?: boolean
  title?: string
  children: ReactNode
}) {
  const cls = ['btn', props.tone === 'default' ? '' : props.tone, props.big ? 'big' : '']
    .filter(Boolean)
    .join(' ')
  return (
    <button className={cls} onClick={props.onClick} disabled={props.disabled || props.busy} title={props.title}>
      {props.busy ? <span className="spin">▮</span> : props.children}
    </button>
  )
}

export function Badge(props: { tone?: 'green' | 'amber' | 'red' | 'cyan' | 'dim'; children: ReactNode }) {
  return <span className={`badge ${props.tone ?? ''}`}>{props.children}</span>
}

export function Stat(props: { k: string; v: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="k">{props.k}</div>
      <div className="v">{props.v}</div>
      {props.sub !== undefined && <div className="sub">{props.sub}</div>}
    </div>
  )
}

/** amount input row: label + NumInput + wallet balance + MAX chip */
export function AmountRow(props: {
  sym: string
  value: string
  onChange: (v: string) => void
  bal?: bigint
  dec: number
  onMax: (v: string) => void
  disabled?: boolean
  note?: string
}) {
  const { t } = useTranslation()
  return (
    <div className="form-row">
      <span className="lbl">{props.sym}</span>
      <NumInput value={props.value} onChange={props.onChange} disabled={props.disabled} width={220} />
      {props.bal !== undefined && (
        <>
          <span className="dim mono-sm">
            {t('common.bal')} {fmtAmount(props.bal, props.dec)}
          </span>
          <button
            className="chip"
            onClick={() => props.onMax(formatUnits(props.bal!, props.dec))}
            disabled={props.disabled}
          >
            {t('common.max')}
          </button>
        </>
      )}
      {props.note && <span className="amber mono-sm">{props.note}</span>}
    </div>
  )
}

/** numeric text input that only accepts decimal strings */
export function NumInput(props: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  disabled?: boolean
  width?: number
  invalid?: boolean
  /** clamp typed fraction digits (token precision); 18 = EVM max */
  decimals?: number
  signed?: boolean
}) {
  return (
    <input
      className={`input${props.invalid ? ' invalid' : ''}`}
      style={props.width ? { width: props.width } : undefined}
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      placeholder={props.placeholder ?? '0.0'}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => {
        const raw = e.target.value
        const negative = props.signed && /^\s*-/.test(raw)
        const v = sanitizeAmountInput(negative ? raw.replace(/^\s*-/, '') : raw, props.decimals ?? 18)
        if (v !== null) props.onChange(negative ? `-${v}` : v)
      }}
    />
  )
}
