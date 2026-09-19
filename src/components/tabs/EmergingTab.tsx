// The EMERGING tab (docs/EMERGING-POOL-LP-PRD.zh-CN.md §8.2, EMG-B04): a
// dedicated, always-visible page for the young-pool observation feed.
//
// A fact sheet, not a pitch: the PAIR (both sides, symbols when named),
// the pool identity with an explorer link, ages, collection state, trailing
// activity — and a footer that says observation ≠ safety verdict. No action
// buttons; canCreateStrategy is false at the API contract.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { EmergingPoolView } from '../../../shared/emerging/types'
import { fetchCatalog } from '../../lib/catalogFetch'
import { indexerApiPath } from '../../config/chains/routes'
import { ENV } from '../../config/env'
import { ACTIVE_IS_BUILD, CHAIN } from '../../config/chains'
import { Btn } from '../ui'

type Envelope = {
  schemaVersion: 1
  generation: string
  generatedAt: number
  pools: EmergingPoolView[]
  counts: Record<string, number>
  ready: boolean
  readyReason: string | null
}

const ZERO = '0x0000000000000000000000000000000000000000'
const EXPLORER = 'https://robinhoodchain.blockscout.com'

const short = (a: string | null) => {
  if (!a) return '—'
  if (a === ZERO) return 'ETH'
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}
const sideName = (addr: string | null, sym: string | null): string => {
  if (addr === ZERO) return 'ETH'
  return sym && sym !== '?' ? sym : short(addr)
}

const stateClass: Record<string, string> = {
  discovered: 'emerging-state-discovered',
  queued: 'emerging-state-queued',
  backfilling: 'emerging-state-queued',
  tracking: 'emerging-state-queued',
  aged_out: 'emerging-state-aged',
}

const REASON_KEYS = {
  capacity_deferred: 'emerging.page.reason.capacity_deferred',
  data_gap: 'emerging.page.reason.data_gap',
  reorg_repair: 'emerging.page.reason.reorg_repair',
  age_exceeded: 'emerging.page.reason.age_exceeded',
} as const

export function EmergingTab() {
  const { t } = useTranslation()
  const [data, setData] = useState<Envelope | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const path = indexerApiPath('emerging/pools?limit=200', CHAIN.key, ENV.chainGateway, ACTIVE_IS_BUILD)
    if (!path) { setFailed(true); return }
    setBusy(true)
    try {
      const r = await fetchCatalog(new URL(path, location.origin), {}, undefined, 8_000)
      if (!r.ok) { setFailed(true); return }
      const j = (await r.json()) as Envelope
      if (j?.schemaVersion === 1 && Array.isArray(j.pools)) { setData(j); setFailed(false) }
    } catch { setFailed(true) }
    finally { setBusy(false) }
  }, [])

  useEffect(() => {
    void load()
    const id = setInterval(() => void load(), 60_000)
    return () => clearInterval(id)
  }, [load])

  const tNow = Math.floor(Date.now() / 1000)
  const ageText = (birth: number | null): string => {
    if (birth === null) return '—'
    const h = Math.max(1, Math.round((tNow - birth) / 3_600))
    return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
  }
  const generated = data?.generatedAt ? new Date(data.generatedAt * 1000) : null
  const explorerHref = (p: EmergingPoolView): string | null =>
    p.venue === 'univ4' ? null : `${EXPLORER}/address/${p.poolId}`

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <div className="section-title">{t('emerging.page.title')}</div>
          <div className="dim mono-sm">
            {data
              ? t('emerging.page.updated', {
                  time: generated ? generated.toLocaleString() : '—',
                  discovered: data.counts.discovered ?? 0,
                  queued: data.counts.queued ?? 0,
                  aged: data.counts.aged_out ?? 0,
                })
              : t('poolRank.waiting')}
          </div>
        </div>
        <Btn onClick={() => void load()} busy={busy}>{t('poolRank.refresh')}</Btn>
      </div>
      {failed ? (
        <div className="emerging-empty">{t('pools.emerging.unavailable')}</div>
      ) : data === null ? (
        <div className="emerging-empty">…</div>
      ) : data.ready === false ? (
        <div className="emerging-empty">{t('pools.emerging.backfilling')}</div>
      ) : data.pools.length === 0 ? (
        <div className="emerging-empty">{t('pools.emerging.empty')}</div>
      ) : (
        <div className="table-scroll">
          <table className="emerging-table emerging-full">
            <thead>
              <tr>
                <th>{t('emerging.page.colPair')}</th>
                <th>{t('emerging.page.colPool')}</th>
                <th>{t('pools.emerging.colVenue')}</th>
                <th>{t('pools.emerging.colPoolAge')}</th>
                <th>{t('pools.emerging.colTokenAge')}</th>
                <th>{t('emerging.page.colTrades1h')}</th>
                <th>{t('pools.emerging.colState')}</th>
                <th>{t('pools.emerging.colData')}</th>
              </tr>
            </thead>
            <tbody>
              {data.pools.map((p) => {
                const href = explorerHref(p)
                return (
                  <tr key={p.poolKey}>
                    <td className="emerging-pair">
                      {sideName(p.token0, p.token0Symbol ?? null)}
                      <span className="emerging-sep">/</span>
                      {sideName(p.token1, p.token1Symbol ?? null)}
                    </td>
                    <td className="emerging-pair">
                      {href
                        ? <a href={href} target="_blank" rel="noreferrer">{short(p.poolId)}</a>
                        : <span title={p.poolId}>{short(p.poolId)}</span>}
                    </td>
                    <td>{p.venue}</td>
                    <td>{ageText(p.poolCreatedAt)}</td>
                    <td>{ageText(p.tokenCreatedAt)}</td>
                    <td>{p.trades1h ?? '—'}</td>
                    <td>
                      <span className={`emerging-badge ${stateClass[p.observation.state] ?? ''}`}>
                        {t(`pools.emerging.state.${p.observation.state}`)}
                      </span>
                      {p.observation.reasons.filter((r): r is keyof typeof REASON_KEYS => r !== null && r in REASON_KEYS).map((r) => (
                        <span key={r} className="emerging-sep">{t(REASON_KEYS[r])}</span>
                      ))}
                    </td>
                    <td className={`emerging-data emerging-data-${p.dataQuality.status}`}>
                      {t(`pools.emerging.data.${p.dataQuality.status}`)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="emerging-footnote">{t('emerging.page.footnote')}</div>
    </div>
  )
}
