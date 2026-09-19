// The EMERGING tab (docs/EMERGING-POOL-LP-PRD.zh-CN.md §8.2, EMG-B04): a
// dedicated, always-visible page for the young-pool observation feed.
//
// A fact sheet, not a pitch: the PAIR (both sides, symbols when named),
// the pool identity with an explorer link, ages, collection state, trailing
// activity — and a footer that says observation ≠ safety verdict. No action
// buttons; canCreateStrategy is false at the API contract. Every column
// sorts client-side over the fetched page; default is newest pool first.
import { useCallback, useEffect, useMemo, useState } from 'react'
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
// OKX Web3 token page (user-facing link). The slug is this chain's, and the
// page is gated to Robinhood — the majors excluded here are the ones whose
// OKX pages say nothing about a NEW token (the side worth inspecting).
const OKX_TOKEN = 'https://web3.okx.com/zh-hans/token/robinhood-chain'
const MAJORS = new Set(
  [ZERO, CHAIN.addr.WNATIVE, CHAIN.addr.STABLE].map((a) => a.toLowerCase()),
)

/** The speculative side of the pair — first side that is not ETH/WETH/USDG. */
function candidateToken(p: EmergingPoolView): string | null {
  for (const t of [p.token0, p.token1]) {
    if (t !== null && !MAJORS.has(t.toLowerCase())) return t
  }
  return null
}
const okxHref = (p: EmergingPoolView): string | null => {
  const token = candidateToken(p)
  return token === null ? null : `${OKX_TOKEN}/${token}`
}

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
  quiet_demoted: 'emerging.page.reason.quiet_demoted',
} as const

const DATA_RANK: Record<string, number> = { complete: 3, partial: 2, stale: 1, unsupported: 0 }
const STATE_RANK: Record<string, number> = {
  discovered: 0, queued: 1, backfilling: 2, tracking: 3, aged_out: 4,
}

type SortKey = 'pair' | 'pool' | 'venue' | 'poolAge' | 'tokenAge' | 'trades1h' | 'liq' | 'mcap' | 'state' | 'data'

const COMPARATORS: Record<SortKey, (a: EmergingPoolView, b: EmergingPoolView) => number> = {
  pair: (a, b) =>
    (sideName(a.token0, a.token0Symbol ?? null) + sideName(a.token1, a.token1Symbol ?? null))
      .localeCompare(sideName(b.token0, b.token0Symbol ?? null) + sideName(b.token1, b.token1Symbol ?? null)),
  pool: (a, b) => a.poolId.localeCompare(b.poolId),
  venue: (a, b) => a.venue.localeCompare(b.venue),
  poolAge: (a, b) => (a.poolCreatedAt ?? 0) - (b.poolCreatedAt ?? 0),
  tokenAge: (a, b) => (a.tokenCreatedAt ?? 0) - (b.tokenCreatedAt ?? 0),
  trades1h: (a, b) => (a.trades1h ?? 0) - (b.trades1h ?? 0),
  liq: (a, b) => (a.liquidityUsd ?? 0) - (b.liquidityUsd ?? 0),
  mcap: (a, b) => (a.marketCapUsd ?? 0) - (b.marketCapUsd ?? 0),
  state: (a, b) => (STATE_RANK[a.observation.state] ?? 9) - (STATE_RANK[b.observation.state] ?? 9),
  data: (a, b) => (DATA_RANK[a.dataQuality.status] ?? 9) - (DATA_RANK[b.dataQuality.status] ?? 9),
}

export function EmergingTab() {
  const { t } = useTranslation()
  const [data, setData] = useState<Envelope | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; dir: 'desc' | 'asc' }>({ key: 'poolAge', dir: 'desc' })

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

  const rows = useMemo(() => {
    const list = [...(data?.pools ?? [])]
    const cmp = COMPARATORS[sort.key]
    list.sort((a, b) => (sort.dir === 'desc' ? cmp(b, a) : cmp(a, b)))
    return list
  }, [data, sort])

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }))

  const tNow = Math.floor(Date.now() / 1000)
  /** Exact age to the minute while young — the PRD's own unit for this page. */
  const ageText = (birth: number | null): string => {
    if (birth === null) return '—'
    const m = Math.max(0, Math.round((tNow - birth) / 60))
    if (m < 60) return `${m}分`
    const h = Math.floor(m / 60)
    if (h < 48) return `${h}时${String(m % 60).padStart(2, '0')}分`
    return `${Math.floor(h / 24)}天${h % 24}时`
  }
  const fmtUsd = (v: number | null | undefined): string => {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—'
    if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`
    return v.toFixed(0)
  }
  const generated = data?.generatedAt ? new Date(data.generatedAt * 1000) : null
  const explorerHref = (p: EmergingPoolView): string | null =>
    p.venue === 'univ4' ? null : `${EXPLORER}/address/${p.poolId}`

  const th = (key: SortKey, label: string) => (
    <th className="emerging-th">
      <button className={`pr-sort ${sort.key === key ? 'on' : ''}`} onClick={() => toggleSort(key)}>
        {label}
        {sort.key === key && <span aria-hidden="true">{sort.dir === 'desc' ? ' ▼' : ' ▲'}</span>}
      </button>
    </th>
  )

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
      ) : rows.length === 0 ? (
        <div className="emerging-empty">{t('pools.emerging.empty')}</div>
      ) : (
        <div className="table-scroll">
          <table className="emerging-table emerging-full">
            <thead>
              <tr>
                {th('pair', t('emerging.page.colPair'))}
                {th('pool', t('emerging.page.colPool'))}
                {th('venue', t('pools.emerging.colVenue'))}
                {th('poolAge', t('pools.emerging.colPoolAge'))}
                {th('tokenAge', t('pools.emerging.colTokenAge'))}
                {th('trades1h', t('emerging.page.colTrades1h'))}
                {th('liq', t('emerging.page.colLiq'))}
                {th('mcap', t('emerging.page.colMcap'))}
                {th('state', t('pools.emerging.colState'))}
                {th('data', t('pools.emerging.colData'))}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const href = explorerHref(p)
                return (
                  <tr key={p.poolKey}>
                    <td className="emerging-pair">
                      {sideName(p.token0, p.token0Symbol ?? null)}
                      <span className="emerging-sep">/</span>
                      {sideName(p.token1, p.token1Symbol ?? null)}
                      {(() => {
                        const okx = okxHref(p)
                        return okx
                          ? <a className="emerging-okx" href={okx} target="_blank" rel="noreferrer">{t('emerging.page.okx')}</a>
                          : null
                      })()}
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
                    <td>{fmtUsd(p.liquidityUsd)}</td>
                    <td title={p.totalSupply ? `FDV口径 · totalSupply ${p.totalSupply}` : undefined}>
                      {fmtUsd(p.marketCapUsd)}
                    </td>
                    <td>
                      <span className={`emerging-badge ${stateClass[p.observation.state] ?? ''}`}>
                        {t(`pools.emerging.state.${p.observation.state}`)}
                      </span>
                      {p.observation.reasons.filter((r): r is keyof typeof REASON_KEYS => typeof r === 'string' && r in REASON_KEYS).map((r) => (
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
