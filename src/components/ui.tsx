import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { formatUnits } from 'viem'
import { fmtAmount, sanitizeAmountInput } from '../lib/format'

/**
 * Enter and Space on a row that behaves like a control but cannot be a button.
 *
 * Most controls here ARE buttons. These are the ones that cannot be: a table
 * row is a `<tr>`, and a position group's header carries its own links inside
 * it. Both keep the semantics they have — forcing `role="button"` onto a `<tr>`
 * costs the table its rows, and onto a header it swallows the controls nested
 * within — and gain the keyboard half of what a button gives away free.
 *
 * A keypress that started inside a nested control belongs to that control, the
 * same rule the click handlers state as `closest('button, a')`.
 */
export function activateOnKey(run: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    if (e.target !== e.currentTarget) return
    e.preventDefault() // Space would scroll the table out from under the row
    run()
  }
}

/**
 * Everything that makes a table row behave like the control it already is:
 * focus, its expanded state, and both ways of taking it.
 *
 * The two click guards are about respecting what the row contains. A click
 * that landed on a nested control belongs to that control — the pair label
 * opens the address card, ↗ goes to the explorer — and a click that ends a
 * drag-select is the user copying a number rather than asking to trade.
 */
export function rowToggleProps(open: boolean, toggle: () => void) {
  return {
    tabIndex: 0,
    'aria-expanded': open,
    onKeyDown: activateOnKey(toggle),
    onClick: (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('button, a')) return
      if (window.getSelection()?.toString()) return
      toggle()
    },
  }
}

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
  /** what MAX means here, when it means more than "all of this balance" */
  maxTip?: string
  /**
   * Makes the note the way OUT of the state it reports.
   *
   * The note that says a side is over balance used to be the end of the road:
   * it named the problem and left the reader to work out, by hand, which of two
   * coupled amounts to lower and by how much. Where the app can compute that
   * answer, the sentence saying so is the button that applies it.
   */
  onNote?: () => void
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
            title={props.maxTip}
          >
            {t('common.max')}
          </button>
        </>
      )}
      {props.note &&
        (props.onNote ? (
          <button className="amber mono-sm note-fix" onClick={props.onNote}>
            {props.note}
          </button>
        ) : (
          <span className="amber mono-sm">{props.note}</span>
        ))}
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
  /** Allow a leading minus sign for ticks and simulation deltas. */
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
        const negative = props.signed && raw.startsWith('-')
        const unsigned = negative ? raw.slice(1) : raw
        const v = sanitizeAmountInput(unsigned, props.decimals ?? 18)
        if (v !== null) props.onChange(negative ? `-${v}` : v)
      }}
    />
  )
}
