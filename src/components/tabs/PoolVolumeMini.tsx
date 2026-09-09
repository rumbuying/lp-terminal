import { useTranslation } from 'react-i18next'
import { fmtCompact } from '../../lib/format'
import { TrendBadge, VolumeSparkline } from './PairAttributionPanel'
import { usePoolRank } from '../../hooks/usePoolRank'

/**
 * 近期量能速览（用户反馈：想在仓位/策略卡上直接看到池子的近期成交量）。
 * 数据来自 usePoolRank 的共享缓存 —— 与池排名页同一个 query，挂多少张卡都
 * 不发额外请求。池子不在排名监测内（v4、v2、尘埃、过小）时保持安静：
 * 没有数据就不渲染，绝不编一个数字。
 */
export function PoolVolumeMini({ identity }: { identity: string | null | undefined }) {
  const { t } = useTranslation()
  const query = usePoolRank()
  if (!identity) return null
  const id = identity.toLowerCase()
  const row = query.data?.rows.find((r) => r.address.toLowerCase() === id)
  if (!row) return null
  return (
    <span
      className="pv-mini mono-sm"
      title={t('poolRank.volumeMiniTip', { vol: fmtCompact(row.volDayUsd) })}
    >
      <VolumeSparkline values={row.trend.dailyVol} />
      <TrendBadge trend={row.trend} />
      <span className="dim">${fmtCompact(row.volDayUsd)}/d</span>
    </span>
  )
}
