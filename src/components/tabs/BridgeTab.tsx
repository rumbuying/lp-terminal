import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useAccount } from 'wagmi'
import { formatUnits, parseUnits } from 'viem'
import { CHAIN_ID, NATIVE } from '../../config/addresses'
import { CHAIN } from '../../config/chains'
import {
  NATIVE_SENTINEL,
  REMOTE_CHAINS,
  explorerOf,
  remoteById,
  resolveIntent,
  type BridgeDir,
  type BridgeIntent,
  type BridgeTokenOption,
  type RemoteChain,
} from '../../config/bridge'
import { ENV } from '../../config/env'
import { useBridgeBalance } from '../../hooks/useBridgeBalance'
import { BRIDGE_QUOTE_REFRESH_MS, bestProvider, useBridgeQuotes } from '../../hooks/useBridgeQuotes'
import { useBridgeTokens } from '../../hooks/useBridgeTokens'
import { recheckPending, usePendingBridges } from '../../hooks/usePendingBridges'
import { useTokenUsd } from '../../hooks/useTokenUsd'
import { executeBridge, type BridgeStage } from '../../lib/bridge/exec'
import { fmtEtaShort, nextCheckAt, pendingBridges, type PendingTransfer } from '../../lib/bridge/pending'
import { toTokenOption } from '../../lib/bridge/tokens'
import type { BridgeProviderId } from '../../lib/bridge/types'
import { bpsDiff, fmtAmount, fmtNum, fmtUsd, sanitizeAmountInput } from '../../lib/format'
import { slippageTone } from '../../lib/swapGate'
import { txlog } from '../../lib/txlog'
import type { TokenInfo } from '../../types'
import { Badge, Btn } from '../ui'

// native MAX keeps gas headroom on the origin chain (L1 needs real room)
const GAS_BUFFER: Record<number, bigint> = { 1: parseUnits('0.004', 18) }
const DEFAULT_GAS_BUFFER = parseUnits('0.0015', 18)

const PROVIDER_LABEL: Record<BridgeProviderId, string> = {
  portal: 'PORTAL',
  relay: 'RELAY',
  across: 'ACROSS',
}

/** progress strip state: live stage, or 'done' once the deposit is sent
 *  (fill tracking then lives in the PENDING list, not in the strip) */
type RunState = { stage: BridgeStage | 'done'; hasApprove: boolean } | null

export function BridgeTab() {
  // same rule as SwapTab: focusing on mount is a desktop courtesy — on touch
  // it opens the keyboard unasked and the fixed tab bar lands on the form
  const autoFocusAmt =
    typeof window !== 'undefined' && !window.matchMedia('(pointer: coarse)').matches
  const { t } = useTranslation()
  const { address: user } = useAccount()
  const { openConnectModal } = useConnectModal()

  const [dir, setDir] = useState<BridgeDir>('in')
  const [symWanted, setSymWanted] = useState('ETH')
  const [remote, setRemote] = useState<RemoteChain>(REMOTE_CHAINS[0])
  const [amtStr, setAmtStr] = useState('')
  const [amount, setAmount] = useState(0n)
  const [override, setOverride] = useState<BridgeProviderId | null>(null)
  const [feesOpen, setFeesOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [run, setRun] = useState<RunState>(null)
  const [now, setNow] = useState(() => Date.now())
  const runStartRef = useRef(0)
  const runEndRef = useRef(0)

  const pending = usePendingBridges()

  // tokens are DISCOVERED per remote from the engines' own support surfaces —
  // the dropdown only ever offers same-token routes someone can actually quote
  const discovery = useBridgeTokens(remote)
  const options: BridgeTokenOption[] = useMemo(
    () => (discovery.data ?? []).map((s) => toTokenOption(s, dir)).filter((o) => o.providers.length > 0),
    [discovery.data, dir],
  )
  // keep the user's pick when it exists here; otherwise fall back (and restore
  // automatically when they switch back to a pair that has it)
  const token = options.find((o) => o.symbol === symWanted) ?? options[0] ?? null

  const intent: BridgeIntent | null = useMemo(
    () => (token ? { dir, token, remote, amount } : null),
    [dir, token, remote, amount],
  )
  const leg = intent ? resolveIntent(intent) : null

  useEffect(() => {
    const handle = setTimeout(() => {
      try {
        setAmount(parseUnits(amtStr === '' ? '0' : amtStr, token?.decimals ?? 18))
      } catch {
        setAmount(0n)
      }
    }, 350)
    return () => clearTimeout(handle)
  }, [amtStr, token?.decimals])

  // switching to a lower-precision token trims typed excess — a 6-decimal
  // USDG box must not keep an 18-decimal fraction that silently quotes zero
  useEffect(() => {
    setAmtStr((s) => (s === '' ? s : sanitizeAmountInput(s, token?.decimals ?? 18) ?? ''))
  }, [token?.decimals])

  useEffect(() => {
    setOverride(null)
    setRun(null)
  }, [dir, token?.symbol, remote.chain.id, amount])

  // quotes freeze during execution: the run works off a snapshot, and refreshing
  // mid-run would burn rate budget and repaint "best" under the user's feet
  const quotes = useBridgeQuotes(amount > 0n && !busy ? intent : null, user)
  const balance = useBridgeBalance(leg ? user : undefined, leg?.originChainId ?? CHAIN_ID, leg?.inputToken ?? NATIVE_SENTINEL)
  const balanceOut = useBridgeBalance(leg ? user : undefined, leg?.destChainId ?? CHAIN_ID, leg?.outputToken ?? NATIVE_SENTINEL)
  const usdRef: TokenInfo | null = token
    ? token.robinhoodToken.toLowerCase() === NATIVE_SENTINEL.toLowerCase()
      ? { address: NATIVE, symbol: 'ETH', decimals: 18, native: true }
      : { address: token.robinhoodToken, symbol: token.symbol, decimals: token.decimals }
    : null
  const usd = useTokenUsd(usdRef)

  const providerIds = token?.providers ?? []
  const automatic = bestProvider(quotes, providerIds)
  const selectedProvider = override ?? automatic
  const selected = selectedProvider ? quotes[selectedProvider].data ?? null : null
  const anyFetching = providerIds.some((id) => quotes[id].isFetching)

  const hasLivePending = pending.some((p) => p.status === 'pending')
  const ticking = amount > 0n || run !== null || hasLivePending
  useEffect(() => {
    if (!ticking) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [ticking])

  const originName = dir === 'in' ? remote.label : CHAIN.shortName
  const destName = dir === 'in' ? CHAIN.shortName : remote.label
  const balIn = balance.data
  const insufficient = balIn !== undefined && amount > balIn
  const isNativeIn = !!leg && leg.inputToken.toLowerCase() === NATIVE_SENTINEL.toLowerCase()
  const guard = (fn: () => void) => () => {
    if (!busy) fn()
  }

  const gasBuffer = leg ? GAS_BUFFER[leg.originChainId] ?? DEFAULT_GAS_BUFFER : DEFAULT_GAS_BUFFER
  const setPct = (pct: bigint) => {
    if (balIn === undefined || !leg) return
    // gas headroom only gates MAX — a partial percentage already leaves the
    // rest for gas, and reserving it there zeroed out small balances entirely
    const buffer = pct === 100n && isNativeIn ? gasBuffer : 0n
    const spendable = balIn > buffer ? balIn - buffer : 0n
    setAmtStr(formatUnits((spendable * pct) / 100n, leg.inputDecimals))
  }

  const fmtEtaDisplay = (sec: number): string =>
    sec >= 90 ? t('bridge.etaMin', { m: Math.max(1, Math.round(sec / 60)) }) : t('bridge.etaS', { s: Math.max(1, sec) })

  // token-ratio economics (same-token legs: what arrives vs what was sent)
  const inNum = amount > 0n && leg ? Number(formatUnits(amount, leg.inputDecimals)) : 0
  const outNum = selected && leg ? Number(formatUnits(selected.outputAmount, leg.outputDecimals)) : 0
  const rate = selected && inNum > 0 ? outNum / inNum : undefined
  const impactPct = rate !== undefined ? (rate - 1) * 100 : undefined
  const costBps = impactPct !== undefined ? Math.max(0, Math.round(-impactPct * 100)) : null
  const inUsd = usd.data !== undefined && inNum > 0 ? inNum * usd.data : undefined
  const outUsd = usd.data !== undefined && selected ? outNum * usd.data : undefined

  let outputDisplay = '0.0'
  if (selected && leg) outputDisplay = fmtAmount(selected.outputAmount, leg.outputDecimals)
  else if (anyFetching && amount > 0n) outputDisplay = '…'

  // refresh countdown tracks the NETWORK quotes — the portal quote is a local
  // 1:1 construction and never refreshes
  const netIds = providerIds.filter((id) => id !== 'portal')
  const lastNet = Math.max(0, ...netIds.map((id) => quotes[id].dataUpdatedAt || 0))
  const nextIn = lastNet > 0 ? Math.max(0, Math.ceil((lastNet + BRIDGE_QUOTE_REFRESH_MS - now) / 1000)) : null

  const doBridge = async () => {
    if (!user || !selected || !leg || amount === 0n) return
    setBusy(true)
    runStartRef.current = Date.now()
    const hasApprove = selected.steps.some((s) => s.kind === 'approve')
    try {
      const outcome = await executeBridge(
        selected,
        user,
        {
          leg,
          amountInStr: amtStr,
          depositLabel: t('bridge.stDeposit', { amt: amtStr, sym: leg.inputSymbol, from: originName, to: destName }),
        },
        (stage) => setRun({ stage, hasApprove }),
      )
      runEndRef.current = Date.now()
      // sent = deposit confirmed, transfer now tracked in PENDING; null = the
      // log line already told the rejection/revert story
      setRun(outcome === 'sent' ? { stage: 'done', hasApprove } : null)
    } catch (error) {
      txlog.push('err', (error as Error).message)
      setRun(null)
    } finally {
      setBusy(false)
    }
  }

  // ---- CTA state machine (mirrors the swap tab) ----
  let cta = t('bridge.noRoute')
  let ctaDisabled = true
  if (!user) {
    cta = t('common.connectWallet')
    ctaDisabled = false
  } else if (!token) cta = discovery.isError ? t('bridge.discoverFailed') : t('bridge.discovering')
  else if (amount === 0n) cta = t('swap.ctaEnterAmount')
  else if (insufficient) cta = t('common.insufficientBalance')
  else if (!selected && anyFetching) cta = t('swap.ctaQuoting')
  else if (selected && selectedProvider) {
    cta = t('bridge.execVia', { provider: PROVIDER_LABEL[selectedProvider] })
    ctaDisabled = false
  }

  // canonical bridge model: direction is WHERE the chains sit, not a mode. Each
  // card carries its own chain selector; the home chain always occupies one side, so
  // placing a chain on this card snaps the opposite card to the other end.
  const chainTip = t('bridge.chainTip', { chain: CHAIN.name, id: CHAIN_ID })
  const pickChain = (side: 'from' | 'to') => (id: number) => {
    if (busy) return
    if (id === CHAIN_ID) {
      setDir(side === 'from' ? 'out' : 'in')
    } else {
      const r = remoteById(id)
      if (!r) return
      setRemote(r)
      setDir(side === 'from' ? 'in' : 'out')
    }
  }

  const pendingSection = pending.length > 0 && (
    <>
      <div className="section-title">{t('bridge.pendingTitle')}</div>
      <div className="pend-list">
        {pending.map((p) => (
          <PendingRow key={p.id} p={p} now={now} />
        ))}
      </div>
    </>
  )

  const sendCard = (
    <div className="swap-card">
      <div className="hd">
        <span className="side">
          <span className="side-lbl">{t('bridge.from')}</span>
          <ChainSel current={leg?.originChainId ?? (dir === 'in' ? remote.chain.id : CHAIN_ID)} busy={busy} tip={chainTip} onPick={pickChain('from')} />
        </span>
        {balIn !== undefined && leg ? (
          <button
            className={`bal ${insufficient ? 'red' : ''}`}
            onClick={guard(() => setPct(100n))}
            title={t('swap.balTip')}
          >
            {t('common.bal')} {fmtAmount(balIn, leg.inputDecimals)} {leg.inputSymbol}
          </button>
        ) : balance.isError ? (
          // a failed read must say so — an invisible balance reads as "you have none"
          <button
            className="bal red"
            onClick={guard(() => void balance.refetch())}
            title={t('bridge.balFailed', { err: (balance.error as Error).message.slice(0, 80) })}
          >
            {t('common.bal')} — ↻
          </button>
        ) : null}
      </div>
      <div className="io">
        <TokenSel options={options} value={token} busy={busy} loading={discovery.isLoading} onPick={setSymWanted} />
        <input
          className="amt"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocusAmt}
          placeholder="0.0"
          value={amtStr}
          disabled={busy}
          onChange={(event) => {
            const value = sanitizeAmountInput(event.target.value, token?.decimals ?? 18)
            if (value !== null) setAmtStr(value)
          }}
        />
      </div>
      <div className="ft">
        <span className="pcts">
          {balIn !== undefined &&
            balIn > 0n &&
            [25n, 50n, 75n, 100n].map((pct) => (
              <button
                key={pct.toString()}
                className="chip"
                title={pct === 100n && isNativeIn ? t('common.maxGasTip', { amt: fmtAmount(gasBuffer, 18), sym: 'ETH' }) : undefined}
                onClick={guard(() => setPct(pct))}
              >
                {pct === 100n ? t('common.max') : `${pct}%`}
              </button>
            ))}
        </span>
        <span className="usd">{inUsd !== undefined && <>≈ {fmtUsd(inUsd)}</>}</span>
      </div>
      {discovery.isError && options.length === 0 && (
        <div className="ft">
          <span className="red mono-sm">{t('bridge.discoverFailed')}</span>
          <button className="chip aux" onClick={guard(() => void discovery.refetch())}>
            {t('bridge.retry')}
          </button>
        </div>
      )}
    </div>
  )

  const receiveCard = (
    <div className="swap-card">
      <div className="hd">
        <span className="side">
          <span className="side-lbl">{t('bridge.to')}</span>
          <ChainSel current={leg?.destChainId ?? (dir === 'in' ? CHAIN_ID : remote.chain.id)} busy={busy} tip={chainTip} onPick={pickChain('to')} />
        </span>
        {balanceOut.data !== undefined && leg && (
          <span className="bal static">
            {t('common.bal')} {fmtAmount(balanceOut.data, leg.outputDecimals)} {leg.outputSymbol}
          </span>
        )}
      </div>
      <div className="io">
        <span className="tsel-btn static">{token?.symbol ?? '—'}</span>
        <span className={`out ${selected ? '' : 'dim'}`}>{outputDisplay}</span>
      </div>
      <div className="ft">
        <span />
        <span className="usd">
          {outUsd !== undefined && <>≈ {fmtUsd(outUsd)}</>}
          {impactPct !== undefined && (
            <span className={`delta ${impactPct <= -1 ? 'red' : ''}`} title={t('bridge.impactTip')}>
              {' '}
              ({impactPct > 0 ? '+' : ''}
              {impactPct.toFixed(2)}%)
            </span>
          )}
        </span>
      </div>
    </div>
  )

  // provider rows sorted by destination output — price decides the order, so
  // the lossless canonical route leads whenever it quotes (even at ~10 min)
  const sortedIds = useMemo(() => {
    const score = (id: BridgeProviderId) => quotes[id].data?.outputAmount ?? null
    return [...providerIds].sort((a, b) => {
      const qa = score(a)
      const qb = score(b)
      if (qa !== null && qb !== null) return qb > qa ? 1 : qb < qa ? -1 : 0
      if (qa !== null) return -1
      if (qb !== null) return 1
      return (quotes[a].isFetching ? 0 : 1) - (quotes[b].isFetching ? 0 : 1)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerIds.join(), quotes.relay.data, quotes.across.data, quotes.portal.data, quotes.relay.isFetching, quotes.across.isFetching, quotes.portal.isFetching])

  const bestQuote = automatic ? quotes[automatic].data ?? null : null
  const runOver = run?.stage === 'done'
  const elapsed = run
    ? Math.max(0, Math.floor(((runOver ? runEndRef.current : now) - runStartRef.current) / 1000))
    : 0
  const runStages: (BridgeStage | 'done')[] = run?.hasApprove ? ['approve', 'deposit', 'done'] : ['deposit', 'done']
  const stageLabel: Record<BridgeStage | 'done', string> = {
    approve: t('bridge.stgApprove'),
    deposit: t('bridge.stgDeposit'),
    done: t('bridge.stgSent'),
  }

  const progressStrip = run && (
    <div className="bridge-progress mono-sm">
      {runStages.map((s, i) => {
        const cur = runStages.indexOf(run.stage)
        const isDone = run.stage === 'done' || i < cur
        const isCurrent = i === cur && run.stage !== 'done'
        const cls = isDone ? 'done' : isCurrent ? 'on' : ''
        return (
          <span key={s} style={{ display: 'contents' }}>
            {i > 0 && <span className="sep">→</span>}
            <span className={`stg ${cls}`}>
              {isDone && '✓'}
              {isCurrent && <span className="spin">▮</span>} {stageLabel[s]}
            </span>
          </span>
        )
      })}
      {runOver && <span className="dim">{t('bridge.sentNote')}</span>}
      <span className="elapsed">{elapsed}s</span>
    </div>
  )

  return (
    <div className="swap-box narrow">
      <div className="swap-col">
        {pendingSection}
        {sendCard}
        <div className="swap-flip-row">
          <button
            className="swap-flip"
            onClick={guard(() => setDir(dir === 'in' ? 'out' : 'in'))}
            title={t('bridge.flipTip')}
          >
            ⇅
          </button>
        </div>
        {receiveCard}

        {amount > 0n && token && leg && (
          <>
            <div className="section-title">
              {t('bridge.route')}
              <button
                className="chip aux"
                onClick={guard(() => {
                  for (const id of netIds) void quotes[id].refetch()
                })}
                title={t('swap.refreshTip', { s: BRIDGE_QUOTE_REFRESH_MS / 1000 })}
              >
                {anyFetching ? <span className="spin">▮</span> : `↻ ${nextIn ?? '—'}s`}
              </button>
            </div>
            {sortedIds.map((id) => {
              const query = quotes[id]
              const quote = query.data ?? null
              const isSel = selectedProvider === id
              const behindBest =
                quote && bestQuote && automatic !== id ? bpsDiff(quote.outputAmount, bestQuote.outputAmount) / 100 : null
              const qImpact =
                quote && inNum > 0
                  ? (Number(formatUnits(quote.outputAmount, leg.outputDecimals)) / inNum - 1) * 100
                  : null
              return (
                <button
                  type="button"
                  key={id}
                  aria-pressed={isSel}
                  className={`quote-card ${isSel ? 'sel' : ''}`}
                  onClick={guard(() => setOverride(id))}
                >
                  <div className="l1">
                    <span className="src">
                      {isSel ? '◉' : '○'} {PROVIDER_LABEL[id]}
                    </span>
                    {id === 'portal' && (
                      <span className="dim mono-sm" title={t('bridge.canonicalTip')}>
                        {t('bridge.canonical')}
                      </span>
                    )}
                    {query.isFetching && !quote && <span className="qstate spin">▮</span>}
                    {query.isError && !quote && (
                      <span className="qstate red mono-sm">
                        {((query.error as Error).message ?? '').slice(0, 70) || t('bridge.quoteFailed')}
                      </span>
                    )}
                    {quote && (
                      <>
                        <span className="qamt green">
                          {fmtAmount(quote.outputAmount, leg.outputDecimals)} {leg.outputSymbol}
                        </span>
                        {automatic === id ? (
                          <Badge tone="green">{t('swap.best')}</Badge>
                        ) : (
                          behindBest !== null &&
                          Math.abs(behindBest) >= 0.005 && (
                            <span className={`${behindBest < 0 ? 'red' : 'green'} mono-sm`}>
                              {behindBest > 0 ? '+' : ''}
                              {behindBest.toFixed(2)}%
                            </span>
                          )
                        )}
                      </>
                    )}
                  </div>
                  {quote && (
                    <div className="l2">
                      <span>
                        {fmtEtaDisplay(quote.etaSec)}
                        {qImpact !== null && (
                          <span className={slippageTone(Math.max(0, Math.round(-qImpact * 100)))}>
                            {' '}
                            · {t('swap.quoteImpact', { pct: qImpact.toFixed(2) })}
                          </span>
                        )}
                      </span>
                      <span>
                        {t('bridge.minShort', {
                          amt: fmtAmount(quote.minOutput, leg.outputDecimals),
                          sym: leg.outputSymbol,
                        })}
                      </span>
                    </div>
                  )}
                </button>
              )
            })}

            {impactPct !== undefined && impactPct <= -1 && (
              <div className="amber mono-sm">{t('bridge.impactWarn', { pct: impactPct.toFixed(2) })}</div>
            )}

            {selected && (
              <>
                <div className="section-title">{t('swap.details')}</div>
                <div className="kv-list">
                  {rate !== undefined && (
                    <div className="kv">
                      <span className="k">{t('swap.kRate')}</span>
                      <span className="fill" />
                      <span className="v">
                        {t('swap.rateV', { a: leg.inputSymbol, n: fmtNum(rate), b: leg.outputSymbol })}
                      </span>
                    </div>
                  )}
                  <div className="kv">
                    <span className="k">{t('swap.kMinReceived')}</span>
                    <span className="fill" />
                    <span className="v">
                      {fmtAmount(selected.minOutput, leg.outputDecimals)} {leg.outputSymbol}
                    </span>
                  </div>
                  <div className="kv">
                    <span className="k">{t('bridge.kEta')}</span>
                    <span className="fill" />
                    <span className="v">{fmtEtaDisplay(selected.etaSec)}</span>
                  </div>
                  {/* fee breakdown only exists with a terminal fee — at 0 the
                      provider-cost row would just repeat IMPACT */}
                  <div
                    className={ENV.bridgeFeeBps > 0 ? 'kv click' : 'kv'}
                    onClick={ENV.bridgeFeeBps > 0 ? () => setFeesOpen(!feesOpen) : undefined}
                    title={t('bridge.impactTip')}
                  >
                    <span className="k">{t('swap.kImpact')}</span>
                    <span className="fill" />
                    <span className={`v ${costBps === null ? 'dim' : slippageTone(costBps)}`}>
                      {impactPct === undefined ? '—' : `${impactPct.toFixed(2)}%`}
                      {ENV.bridgeFeeBps > 0 && <span className="dim"> {feesOpen ? '▴' : '▾'}</span>}
                    </span>
                  </div>
                  {ENV.bridgeFeeBps > 0 && feesOpen && (
                    <>
                      <div className="kv sub">
                        <span className="k">{t('bridge.kProviderCost')}</span>
                        <span className="fill" />
                        <span className="v dim">
                          {impactPct === undefined
                            ? '—'
                            : `${(impactPct + ENV.bridgeFeeBps / 100).toFixed(2)}%`}
                        </span>
                      </div>
                      <div
                        className="kv sub"
                        title={t('bridge.terminalFeeTip', { pct: (ENV.bridgeFeeBps / 100).toFixed(2) })}
                      >
                        <span className="k">{t('swap.kTerminalFee')}</span>
                        <span className="fill" />
                        <span className="v dim">{(ENV.bridgeFeeBps / 100).toFixed(2)}%</span>
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {progressStrip}

        <div className="swap-cta">
          <Btn big busy={busy} disabled={ctaDisabled} onClick={!user ? () => openConnectModal?.() : doBridge}>
            {cta}
          </Btn>
        </div>

      </div>
    </div>
  )
}

function chainName(id: number): string {
  return id === CHAIN_ID ? CHAIN.shortName : remoteById(id)?.label ?? `#${id}`
}

/** one persisted transfer: countdown while inside the ETA, conservative
 *  verification after it, terminal states with the fill link */
function PendingRow({ p, now }: { p: PendingTransfer; now: number }) {
  const { t } = useTranslation()
  const etaLeftSec = Math.ceil((p.createdAt + p.etaSec * 1000 - now) / 1000)
  const canRecheck = p.status === 'stale' || (p.status === 'pending' && etaLeftSec <= 0)
  return (
    <div className="pend-row">
      <span className={p.status === 'filled' ? 'green' : p.status === 'pending' ? '' : 'amber'}>
        {p.status === 'pending' && <span className="spin">▮</span>}
        {p.status === 'filled' && '✓'}
        {(p.status === 'refunded' || p.status === 'failed' || p.status === 'stale') && '⚠'}
      </span>
      <span className="amt">
        {p.amountIn} {p.symbol}
      </span>
      <span className="prov">
        {chainName(p.originChainId)}→{chainName(p.destChainId)} · {PROVIDER_LABEL[p.provider]}
      </span>
      <a
        className="dim"
        href={`${explorerOf(p.originChainId)}/tx/${p.depositTxHash}`}
        target="_blank"
        rel="noopener noreferrer"
        title={p.depositTxHash}
      >
        ↗
      </a>
      <span className={`eta ${p.status === 'stale' ? 'amber' : ''}`} title={p.status === 'stale' ? t('bridge.stale') : undefined}>
        {p.status === 'pending' &&
          (etaLeftSec > 0
            ? t('bridge.etaLeft', { eta: fmtEtaShort(etaLeftSec) })
            : `${t('bridge.verifying')} ${Math.max(0, Math.ceil((nextCheckAt(p) - now) / 1000))}s`)}
        {p.status === 'filled' &&
          (p.fillTxHash ? (
            <a
              className="green"
              href={`${explorerOf(p.destChainId)}/tx/${p.fillTxHash}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('bridge.pFilled')} ↗
            </a>
          ) : (
            t('bridge.pFilled')
          ))}
        {p.status === 'refunded' && t('bridge.pRefunded')}
        {p.status === 'failed' && t('bridge.pFailed')}
        {p.status === 'stale' && t('bridge.pStale')}
      </span>
      {canRecheck && (
        <button className="x" onClick={() => recheckPending(p)} title={t('bridge.recheckTip')}>
          ↻
        </button>
      )}
      <button className="x" onClick={() => pendingBridges.dismiss(p.id)} title={t('bridge.dismissTip')}>
        ✕
      </button>
    </div>
  )
}

/** token dropdown fed by live route discovery (tsel popover chrome) */
function TokenSel(props: {
  options: BridgeTokenOption[]
  value: BridgeTokenOption | null
  busy: boolean
  loading: boolean
  onPick: (symbol: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div className="tsel">
      <button
        className="tsel-btn"
        title={t('bridge.tokenTip')}
        onClick={() => setOpen(!props.busy && !open)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      >
        {props.value?.symbol ?? (props.loading ? '…' : '—')} ▾
      </button>
      {open && (
        <>
          <div className="tsel-backdrop" onClick={() => setOpen(false)} />
          <div className="tsel-pop">
            {props.options.map((o) => (
              <button
                type="button"
                key={o.symbol}
                className="tsel-item"
                onClick={() => {
                  props.onPick(o.symbol)
                  setOpen(false)
                }}
              >
                <span>
                  {props.value?.symbol === o.symbol ? '◉' : '○'} {o.symbol}
                </span>
                <span className="dim mono-sm">
                  {o.providers.length === 1 ? t('bridge.nRoute1') : t('bridge.nRoutes', { n: o.providers.length })}
                </span>
              </button>
            ))}
            {props.options.length === 0 && (
              <div className="tsel-item dim">{props.loading ? t('bridge.discovering') : t('bridge.noTokens')}</div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** per-card chain endpoint selector (tsel popover chrome, five fixed entries) */
function ChainSel(props: { current: number; busy: boolean; tip: string; onPick: (id: number) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <span className="chain-sel" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button className="chain-btn" title={props.tip} onClick={() => setOpen(!props.busy && !open)}>
        {chainName(props.current)} <span className="caret">▾</span>
      </button>
      {open && (
        <>
          <div className="tsel-backdrop" onClick={() => setOpen(false)} />
          <div className="chain-pop">
            {[CHAIN_ID, ...REMOTE_CHAINS.map((r) => r.chain.id)].map((id) => (
              <button
                key={id}
                className={`tsel-item ${id === props.current ? 'cur' : ''}`}
                onClick={() => {
                  setOpen(false)
                  if (id !== props.current) props.onPick(id)
                }}
              >
                <span>
                  {id === props.current ? '◉' : '○'} {chainName(id)}
                </span>
                {id === CHAIN_ID && <span className="dim mono-sm">{t('bridge.homeTag')}</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  )
}
