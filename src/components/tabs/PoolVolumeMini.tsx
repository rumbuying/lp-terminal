import { useTranslation } from 'react-i18next'
import { fmtCompact } from '../../lib/format'
import { TrendBadge, VolumeSparkline } from './PairAttributionPanel'
import { usePoolRank } from '../../hooks/usePoolRank'
import { useVolumePairByTokens } from '../../hooks/useVolumePair'

const VENUE_LABEL: Record<string, string> = {
  'up33-cl': 'UP33 CL',
  univ3: 'Uni v3',
  univ4: 'Uni v4',
}

/**
 * 近期量能速览（用户反馈：想在仓位/策略卡上直接看到池子的近期成交量）。
 *
 * 两级匹配：
 *  1. 精确命中排名快照的池 —— 直接用该池自己的趋势；
 *  2. 本池不在快照（发射盘代币的未排名兄弟池、v2 等）但同 token PAIR 的
 *     家族有数据 —— 经 /api/volume/pair?token0&token1 回退，显示量能最大
 *     的兄弟池数据并标注来源 venue。量的迁移本来就是 pair 级现象：兄弟池
 *     在涨而你的池没份，恰恰是要看的信号。
 *
 * 数据来自 usePoolRank 的共享缓存；家族回退按 pairKey 单独缓存。两级都落
 * 空时保持安静 —— 没有数据就不渲染，绝不编一个数字。
 */
export function PoolVolumeMini(props: { identity?: string | null; token0?: string | null; token1?: string | null }) {
  const { t } = useTranslation()
  const rank = usePoolRank()
  const id = props.identity?.toLowerCase() ?? null
  const exact = id ? rank.data?.rows.find((r) => r.address.toLowerCase() === id) : undefined

  // fallback query only mounts when the exact lookup missed
  const family = useVolumePairByTokens(!exact ? props.token0 : null, !exact ? props.token1 : null)
  const sibling = (() => {
    if (exact || !family.data?.ready) return null
    // the pool itself, when the family knows it (snapshot-derived member) —
    // its own trend, no provenance marker needed
    const self = id ? family.data.pools.find((m) => m.identity === id) : undefined
    if (self) return self
    // a classified member speaks for the pair; a dust member's "unknown" says
    // nothing and would render as a bare dash
    const classified = family.data.pools.filter((m) => m.trend.class !== 'unknown' && m.dailyVol.some((v) => v !== null))
    const pool = classified.length ? classified : family.data.pools.filter((m) => m.dailyVol.some((v) => v !== null))
    if (!pool.length) return null
    return pool.reduce((a, b) => (b.dailyVol.at(-1) ?? 0) > (a.dailyVol.at(-1) ?? 0) ? b : a)
  })()

  const row = exact ?? null
  const trend = row?.trend ?? sibling?.trend ?? null
  if (!trend) return null
  const volDay = row?.volDayUsd ?? sibling?.dailyVol.at(-1) ?? null
  const fromSibling = !exact && sibling !== null
  return (
    <span
      className="pv-mini mono-sm"
      title={t('poolRank.volumeMiniTip', { vol: fmtCompact(volDay ?? 0) })}
    >
      <VolumeSparkline values={trend.dailyVol} />
      <TrendBadge trend={trend} />
      {volDay !== null && <span className="dim">${fmtCompact(volDay)}/d</span>}
      {fromSibling && sibling && sibling.identity !== id && (
        <span className="dim" title={t('poolRank.volumeMiniSiblingTip')}>
          ≡ {VENUE_LABEL[sibling.proto] ?? sibling.proto}
          {sibling.feeBps !== null ? ` ${sibling.feeBps < 1 ? sibling.feeBps.toFixed(2) : sibling.feeBps}bp` : ''}
        </span>
      )}
    </span>
  )
}
