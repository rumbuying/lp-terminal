import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import { getAddress, type Address } from 'viem'
import { CHAIN_ID, NATIVE } from '../config/addresses'
import { shortAddr } from '../lib/format'
import { readTokenInfo } from '../lib/tokenMeta'
import { useStockIssuer, useStockIssuers } from '../hooks/useStockIssuers'
import { TokenSymbol } from './TokenIdentity'
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
    queryKey: ['tokenMeta', CHAIN_ID, unlisted],
    enabled: !!unlisted && !!client && open,
    staleTime: Infinity,
    retry: false,
    queryFn: (): Promise<TokenInfo> => readTokenInfo(client!, unlisted!),
  })

  // The picker is where impersonation actually bites: a list filtered to "TSLA"
  // is a column of identical-looking rows differing only by an address nobody
  // reads. Only probed while the list is open — a closed picker shows one
  // symbol and has no rows to mark.
  const listed = useMemo(
    () => (open ? filtered.map((tok) => tok.address) : []),
    [open, filtered],
  )
  const issuers = useStockIssuers(listed)
  const selectedIssuer = useStockIssuer(props.value.native ? undefined : props.value.address)
  // a pasted address is the one case where the user has no list to compare
  // against, so who issued it is the only thing that can answer "is this it?"
  const unlistedIssuer = useStockIssuer(unlisted ?? undefined)

  const pick = (tok: TokenInfo) => {
    props.onChange(tok)
    setOpen(false)
    setQ('')
  }

  /**
   * Arrow keys walk the rows, from the filter field down into the list and back.
   *
   * The rows are buttons, so Tab and Enter already work; this exists because a
   * filtered list still runs to 80 entries and tabbing through them to reach
   * one is not the same thing as being able to choose it. Handled on the
   * popover so one listener covers the input and every row.
   */
  const arrows = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button.tsel-item')]
    if (!rows.length) return
    e.preventDefault()

    const down = e.key === 'ArrowDown'
    const at = rows.indexOf(document.activeElement as HTMLButtonElement)
    // the filter field is not one of the rows, so from there the list is
    // entered at whichever end the key points to
    if (at === -1) {
      rows[down ? 0 : rows.length - 1].focus()
      return
    }
    const step = down ? 1 : -1
    rows[(at + step + rows.length) % rows.length].focus()
  }

  return (
    <div className="tsel">
      {/* A fixed caption never changes width, so it is not what the 110px
          minimum is for — that exists to stop the button jumping as the
          SELECTED symbol changes under it. Charged to a caption it is 50px of
          nothing, taken from the token strip beside it. */}
      <button
        className={`tsel-btn${props.label ? ' fixed' : ''}`}
        onClick={() => setOpen(!open)}
      >
        {props.label ?? (
          <TokenSymbol
            symbol={props.value.symbol}
            address={props.value.address}
            issuer={selectedIssuer}
          />
        )}{' '}
        ▾
      </button>
      {open && (
        <>
          <div className="tsel-backdrop" onClick={() => setOpen(false)} />
          <div className="tsel-pop" onKeyDown={arrows}>
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
              <button
                type="button"
                key={tok.address}
                className="tsel-item"
                onClick={() => pick(tok)}
              >
                <span>
                  <TokenSymbol
                    symbol={tok.symbol}
                    address={tok.address}
                    issuer={issuers.get(tok.address.toLowerCase()) ?? null}
                  />{' '}
                  {tok.native && <span className="dim">{t('common.gasToken')}</span>}
                </span>
                <span className="dim mono-sm">{tok.native ? NATIVE.slice(0, 8) : shortAddr(tok.address)}</span>
              </button>
            ))}
            {unlisted && meta.data && (
              <button type="button" className="tsel-item" onClick={() => pick(meta.data)}>
                <span>
                  <TokenSymbol
                    symbol={meta.data.symbol}
                    address={meta.data.address}
                    issuer={unlistedIssuer}
                  />
                </span>
                <span className="dim mono-sm">{shortAddr(meta.data.address)}</span>
              </button>
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
