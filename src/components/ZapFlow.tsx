import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ENV } from '../config/env'
import { applySlippage } from '../lib/clmath'
import { fmtAmount } from '../lib/format'
import { slippageTone } from '../lib/swapGate'
import { zapRouteLabel, type ZapPlan } from '../lib/zap'
import type { TokenInfo } from '../types'

/**
 * The zap split, drawn instead of described.
 *
 * One bar the width of the amount you typed, cut into the piles the plan makes
 * of it: a pile that is already the token the range wants is KEPT, the rest is
 * SWAPPED into the counter-token. "Sized so both piles match the deposit ratio"
 * is a sentence about a picture — so the picture is what ships, and the
 * proportions carry it before a number is read.
 *
 * Piles are told apart by DENSITY, not colour: the parked pile is faint and
 * still, the pile being swapped is bright with a highlight running across it.
 * Hue is already committed here (green/red/amber mean up/down/warn in every
 * theme, and MONO has none), which is the same reason the route map writes
 * venue names into its ribbons rather than keying them by colour.
 *
 * The three planner shapes all fall out of one list, so none of them needs its
 * own sentence: funding with a pool token gives keep + one swap, funding with
 * exactly the right token gives keep alone, and funding from outside the pair
 * gives two swaps and no keep.
 */
export function ZapFlow(props: {
  plan: ZapPlan
  tIn: TokenInfo
  t0: TokenInfo
  t1: TokenInfo
  /** effective tolerance; undefined until a choice exists (no impact probe) */
  slipBps?: number
}) {
  const { t } = useTranslation()
  const { plan, tIn, t0, t1, slipBps } = props

  const total = plan.keep + plan.legs.reduce((s, l) => s + l.swapIn, 0n)
  if (total === 0n) return null
  // integer basis points of the whole, so a 0.3% sliver still gets a sliver
  const share = (part: bigint) => Number((part * 10_000n) / total) / 100

  const piles = [
    ...(plan.keep > 0n
      ? [
          {
            key: 'keep',
            kind: 'keep' as const,
            pct: share(plan.keep),
            label: t('zap.keep'),
            value: `${fmtAmount(plan.keep, tIn.decimals)} ${tIn.symbol}`,
            detail: null as ReactNode,
          },
        ]
      : []),
    ...plan.legs.map((leg, i) => {
      const tOut = leg.buyIs0 ? t0 : t1
      return {
        key: `swap${i}`,
        kind: 'swap' as const,
        pct: share(leg.swapIn),
        label: t('zap.swap'),
        value: `${fmtAmount(leg.swapIn, tIn.decimals)} ${tIn.symbol} → ${fmtAmount(leg.estOut, tOut.decimals)} ${tOut.symbol}`,
        detail: (
          /* each fact is its own line-break unit: on a phone this column is
             narrow enough to wrap, and left alone it wraps INSIDE a phrase —
             "min" on one line and the amount on the next reads as two facts,
             neither of them complete */
          <>
            <span className="nw">{zapRouteLabel(leg.via)}</span>
            {' · '}
            {/* a dash, not silence: with no probe there is no AUTO tolerance
                either, and the slippage editor beside this is already forced
                open — the two have to be visibly about the same gap */}
            {leg.impactBps === null ? (
              <span className="nw">{t('zap.impact', { pct: '—' })}</span>
            ) : (
              <span className={`nw ${slippageTone(leg.impactBps)}`}>
                {t('zap.impact', { pct: `${(leg.impactBps / 100).toFixed(2)}%` })}
              </span>
            )}
            {slipBps !== undefined && (
              <>
                {' · '}
                <span className="nw">
                  {t('zap.swapMin', { amt: fmtAmount(applySlippage(leg.estOut, slipBps), tOut.decimals), slip: slipBps / 100 })}
                </span>
              </>
            )}
          </>
        ),
      }
    }),
  ]

  return (
    <div className="zflow">
      <div className="zflow-bar" title={t('zap.flowTip')}>
        {piles.map((p, i) => (
          <div
            key={p.key}
            className={`zseg ${p.kind}`}
            style={{ flexGrow: p.pct, '--zi': i } as CSSProperties}
          />
        ))}
      </div>
      {piles.map((p) => (
        <div className="zleg" key={p.key}>
          <span className={`zsw ${p.kind}`} />
          <span className="zpc">{p.pct < 1 ? '<1' : Math.round(p.pct)}%</span>
          <span className="zv">
            <span className="zk">{p.label}</span> {p.value}
          </span>
          <span className="zd">{p.detail}</span>
        </div>
      ))}
      {/* On screen, not in the bar's tooltip. This is the one charge the
          terminal makes on a flow where market swaps are free, and a phone has
          no hover to find it with — so it keeps a line of its own, and only
          appears when there is a swap leg to charge it on. */}
      {plan.legs.length > 0 && (
        <div className="zfee">{t('zap.terminalFee', { pct: (ENV.zapFeeBps / 100).toFixed(2) })}</div>
      )}
    </div>
  )
}
