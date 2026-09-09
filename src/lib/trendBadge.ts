// Presentational helpers for the volume-trend badges and sparklines
// (docs/VOLUME-TREND-PRD.zh-CN.md §5.3 FR-UI-1). Pure so the badge↔class
// mapping and the sparkline geometry are testable without a DOM.

import type { TrendClass, VolumeTrend } from '../hooks/usePoolRank'

/** CSS color class per trend class — `.badge` variants in styles.css. */
export const trendBadgeColor: Record<TrendClass, string> = {
  rising: 'green',
  new_hot: 'cyan',
  stable: '',
  fading: 'amber',
  collapsing: 'red',
  unknown: '',
}

/** One of the badge glyph/key pairs the UI renders; `unknown` renders "—". */
export const trendGlyph: Record<TrendClass, string> = {
  rising: '↗',
  new_hot: '🔥',
  stable: '→',
  fading: '↘',
  collapsing: '↘',
  unknown: '—',
}

/** Trend-sort weight (PRD FR-UI-2): higher sorts first; mirrors the indexer. */
export const trendSortWeight: Record<TrendClass, number> = {
  rising: 5,
  new_hot: 4,
  stable: 3,
  fading: 2,
  collapsing: 1,
  unknown: 0,
}

/**
 * The badge sub-line: "+38%/周 · vs7d ×1.4" — segments with null numbers are
 * omitted entirely, never rendered as "NaN".
 */
export function trendSubline(trend: VolumeTrend): string {
  const parts: string[] = []
  if (trend.slope7dPct !== null && Number.isFinite(trend.slope7dPct))
    parts.push(`${trend.slope7dPct >= 0 ? '+' : ''}${trend.slope7dPct.toFixed(0)}%/周`)
  if (trend.vsBaseline !== null && Number.isFinite(trend.vsBaseline))
    parts.push(`vs7d ×${trend.vsBaseline.toFixed(2)}`)
  return parts.join(' · ')
}

/**
 * Sparkline bars as SVG `<rect>` attributes for a `width×height` viewBox.
 * Bars sit on a common baseline; a missing day (null) is a gap, not a zero —
 * the PRD forbids reading missing data as "no volume".
 */
export function sparklineBars(
  values: readonly (number | null)[],
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number }[] {
  const n = values.length
  if (!n || width <= 0 || height <= 0) return []
  const slot = width / n
  const barW = Math.max(1, slot * 0.72)
  const max = Math.max(0, ...values.filter((v): v is number => v !== null && Number.isFinite(v)))
  if (!(max > 0)) return []
  const out: { x: number; y: number; w: number; h: number }[] = []
  for (let i = 0; i < n; i++) {
    const v = values[i]
    if (v === null || !Number.isFinite(v) || v <= 0) continue
    const h = Math.max(1, (v / max) * (height - 2))
    out.push({ x: i * slot + (slot - barW) / 2, y: height - h, w: barW, h })
  }
  return out
}
