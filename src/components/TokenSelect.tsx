import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import { erc20Abi, getAddress, type Address } from 'viem'
import { CHAIN_ID, NATIVE } from '../config/addresses'
import { shortAddr } from '../lib/format'
import type { TokenInfo } from '../types'

export function TokenSelect(props: {
  list: TokenInfo[]
  value: TokenInfo
  exclude?: Address
  onChange: (t: TokenInfo) => void
  /** fixed button text (e.g. "other") — default shows the selected symbol */
  label?: string
}) {
  const { t } = useTranslation()
  const client = usePublicClient({ chainId: CHAIN_ID })
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const filtered = useMemo(() => {
    const ex = props.exclude?.toLowerCase()
    let l = props.list.filter((t) => t.address.toLowerCase() !== ex)
    if (q) {
      const s = q.toLowerCase()
      l = l.filter((t) => t.symbol.toLowerCase().includes(s) || t.address.toLowerCase() === s)
    }
    return l.slice(0, 80)
  }, [props.list, props.exclude, q])

  // a pasted address that no listed token matches → read its ERC-20 identity
  // from the chain, so ANY token is selectable, not just discovered ones
  const unlisted = useMemo(() => {
    const s = q.trim()
    if (filtered.length > 0 || !/^0x[0-9a-fA-F]{40}$/.test(s)) return null
    try {
      return getAddress(s)
    } catch {
      return null
    }
  }, [q, filtered.length])
  const meta = useQuery({
    queryKey: ['tokenMeta', unlisted],
    enabled: !!unlisted && !!client && open,
    staleTime: Infinity,
    retry: false,
    queryFn: async (): Promise<TokenInfo> => {
      const [symbol, decimals] = await Promise.all([
        client!.readContract({ abi: erc20Abi, address: unlisted!, functionName: 'symbol' }),
        client!.readContract({ abi: erc20Abi, address: unlisted!, functionName: 'decimals' }),
      ])
      return { address: unlisted!, symbol, decimals }
    },
  })

  const pick = (tok: TokenInfo) => {
    props.onChange(tok)
    setOpen(false)
    setQ('')
  }

  return (
    <div className="tsel">
      <button className="tsel-btn" onClick={() => setOpen(!open)}>
        {props.label ?? props.value.symbol} ▾
      </button>
      {open && (
        <>
          <div className="tsel-backdrop" onClick={() => setOpen(false)} />
          <div className="tsel-pop">
            <div className="filter">
              <input
                className="input"
                autoFocus
                placeholder={t('common.tokenSearch')}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
              />
            </div>
            {filtered.map((tok) => (
              <div key={tok.address} className="tsel-item" onClick={() => pick(tok)}>
                <span>
                  {tok.symbol} {tok.native && <span className="dim">{t('common.gasToken')}</span>}
                </span>
                <span className="dim mono-sm">{tok.native ? NATIVE.slice(0, 8) : shortAddr(tok.address)}</span>
              </div>
            ))}
            {unlisted && meta.data && (
              <div className="tsel-item" onClick={() => pick(meta.data)}>
                <span>{meta.data.symbol}</span>
                <span className="dim mono-sm">{shortAddr(meta.data.address)}</span>
              </div>
            )}
            {unlisted && meta.isLoading && <div className="tsel-item dim">{t('common.tokenResolving')}</div>}
            {unlisted && meta.isError && <div className="tsel-item red">{t('common.tokenNotErc20')}</div>}
            {filtered.length === 0 && !unlisted && <div className="tsel-item dim">{t('common.noMatch')}</div>}
          </div>
        </>
      )}
    </div>
  )
}
