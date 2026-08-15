import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useAccount } from 'wagmi'
import { writeContract } from 'wagmi/actions'
import { formatUnits, parseUnits, type Address, type Hex, type ReplacementReason } from 'viem'
import { wethAbi } from '../../abi'
import { ADDR, CHAIN_ID, EXPLORER } from '../../config/addresses'
import { ENV } from '../../config/env'
import { wagmiConfig } from '../../config/wagmi'
import { useBalances } from '../../hooks/useBalances'
import { usePendingSwaps } from '../../hooks/usePendingSwaps'
import { DIRECT_QUOTE_REFRESH_MS, useDirectQuote, useSolverQuote } from '../../hooks/useQuotes'
import { useTokenList } from '../../hooks/useTokenList'
import { useTokenUsd } from '../../hooks/useTokenUsd'
import { applySlippage } from '../../lib/clmath'
import {
  directRouteLabel,
  type DirectCandidate,
  type DirectProtocol,
} from '../../lib/directSwap'
import { bpsDiff, fmtAmount, fmtNum, fmtUsd, sanitizeAmountInput, shortAddr } from '../../lib/format'
import { isSameUnresolvedSwap, isSettled, pendingSwaps } from '../../lib/pendingSwaps'
import { legSharePct, solverRouteLabel, venueLabel } from '../../lib/solver'
import { selectUsableQuoteData, solverQuoteNeedsManualRefresh } from '../../lib/solverRefresh'
import { executeSolverSwap, executeSwap, SlippageError } from '../../lib/swapExec'
import { swapSubmissionKey, swapSubmissions } from '../../lib/swapSubmissions'
import {
  allInCostBps,
  autoSlippage,
  retrySlippage,
  slippagePctToBps,
  slippageTone,
  SLIPPAGE_CHOICES,
  type AutoSlippage,
} from '../../lib/swapGate'
import { peekSwapIntent, takeSwapIntent } from '../../lib/swapIntent'
import { step } from '../../lib/tx'
import { txlog } from '../../lib/txlog'
import { openWalletPicker } from '../../lib/walletConnect'
import type { TokenInfo } from '../../types'
import { Flash } from '../Flash'
import { TokenSelect } from '../TokenSelect'
import { Badge, Btn, NumInput } from '../ui'
import { LimitPanel } from './LimitPanel'

const ETH_GAS_BUFFER = parseUnits('0.001', 18)

type SwapMode = 'market' | 'limit'
type SlippageChoice = 'auto' | number // bps; a preset chip or the typed custom value
type SwapSource = 'solver' | DirectProtocol

// Token choices survive top-level tab unmounts, but intentionally not reloads.
let rememberedTokenIn: TokenInfo | null = null
let rememberedTokenOut: TokenInfo | null = null

function routeDetail(candidate: DirectCandidate): string {
  const label = directRouteLabel(candidate.route)
  if (candidate.route.protocol === 'up33') return `${label} · ts${candidate.route.tickSpacing}`
  return label
}

export function SwapTab() {
  const { t } = useTranslation()
  const { address: user } = useAccount()
  const tokenList = useTokenList()
  const list = tokenList.tokens

  const [mode, setModeState] = useState<SwapMode>(() => (location.hash === '#limit' ? 'limit' : 'market'))
  const [tIn, setTInState] = useState<TokenInfo | null>(rememberedTokenIn)
  const [tOut, setTOutState] = useState<TokenInfo | null>(rememberedTokenOut)
  const [amtStr, setAmtStr] = useState('')
  const [amount, setAmount] = useState<bigint>(0n)
  const [slippageChoice, setSlippageChoice] = useState<SlippageChoice>('auto')
  const [customSlip, setCustomSlip] = useState('') // raw text of the typed-% field
  const [slipOpen, setSlipOpen] = useState(false)
  const [override, setOverride] = useState<SwapSource | null>(null)
  // AUTO floor after a slippage halt: never re-offer the tolerance that just
  // failed. Cleared when the trade context changes or a swap fills.
  const [slipFloor, setSlipFloor] = useState<number | null>(null)
  const [invRate, setInvRate] = useState(false)
  const [, setClockTick] = useState(0)
  const now = Date.now()
  const setTIn = (token: TokenInfo | null) => {
    rememberedTokenIn = token
    setTInState(token)
  }
  const setTOut = (token: TokenInfo | null) => {
    rememberedTokenOut = token
    setTOutState(token)
  }

  const setMode = (next: SwapMode) => {
    setModeState(next)
    history.replaceState(null, '', next === 'limit' ? '#limit' : '#swap')
  }

  useEffect(() => {
    const onHash = () => {
      if (location.hash === '#limit') setModeState('limit')
      else if (location.hash === '#swap') setModeState('market')
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    if (!list.length) return
    const intent = peekSwapIntent()
    if (intent) {
      const input = list.find((token) => token.address.toLowerCase() === intent.tokenIn.toLowerCase())
      const output = list.find((token) => token.address.toLowerCase() === intent.tokenOut.toLowerCase())
      if (input && output) {
        takeSwapIntent()
        setModeState('market')
        setTIn(input)
        setTOut(output)
        setAmtStr(formatUnits(intent.amount, input.decimals))
        return
      }
    }
    if (!tIn) setTIn(list.find((token) => token.native) ?? list[0])
    if (!tOut) {
      const up = list.find((token) => token.address.toLowerCase() === ADDR.UP.toLowerCase())
      if (up) setTOut(up)
    }
  }, [list, tIn, tOut])

  useEffect(() => {
    const handle = setTimeout(() => {
      try {
        setAmount(tIn ? parseUnits(amtStr === '' ? '0' : amtStr, tIn.decimals) : 0n)
      } catch {
        setAmount(0n)
      }
    }, 350)
    return () => clearTimeout(handle)
  }, [amtStr, tIn])

  useEffect(() => {
    setOverride(null)
    setSlipFloor(null)
  }, [tIn?.address, tOut?.address, amount])

  // latest trade identity — an in-flight swap that fails must not write its
  // retry floor onto a trade the user has since changed to
  const tradeSig = `${tIn?.address ?? ''}|${tOut?.address ?? ''}|${amount}`
  const tradeSigRef = useRef(tradeSig)
  tradeSigRef.current = tradeSig
  const submissionKey = user && tIn && tOut && amount > 0n
    ? swapSubmissionKey(user, tIn.address, tOut.address, amount)
    : null
  const submitting = useSyncExternalStore(
    swapSubmissions.subscribe,
    () => !!submissionKey && swapSubmissions.has(submissionKey),
    () => false,
  )

  // persisted in-flight swaps (survive reload) — the prominent, reload-proof
  // pending display, and the guard against re-submitting a trade already in flight
  const allPending = usePendingSwaps()
  const pending = user
    ? allPending.filter((entry) => entry.account.toLowerCase() === user.toLowerCase())
    : []
  const tradePending = !!user && !!tIn && !!tOut && pending.some((entry) =>
    isSameUnresolvedSwap(entry, user, tIn.address, tOut.address, amount),
  )

  const balances = useBalances(user, [tIn?.address, tOut?.address].filter(Boolean) as Address[])
  const isWrap = !!tIn?.native && tOut?.address.toLowerCase() === ADDR.WETH.toLowerCase()
  const isUnwrap = !!tOut?.native && tIn?.address.toLowerCase() === ADDR.WETH.toLowerCase()
  const quote = useDirectQuote(tIn?.address, tOut?.address, amount)
  const solver = useSolverQuote(tIn?.address, tOut?.address, amount)
  // per-unit USD prices for both sides (display only — quotes stay token-denominated)
  const usdIn = useTokenUsd(tIn)
  const usdOut = useTokenUsd(tOut)
  // Invalid or stale data leaves the selection boundary once; no downstream
  // card, ranking, execution, or cost calculation can accidentally reuse it.
  const { solver: solverData, direct: directData, hasStaleData } = selectUsableQuoteData({
    solverData: solver.data,
    directData: quote.data,
    solverError: solver.isError,
    directError: quote.isError,
    solverDataUpdatedAt: solver.dataUpdatedAt,
    directDataUpdatedAt: quote.dataUpdatedAt,
    now,
  })
  const solverNeedsManualRefresh = solverQuoteNeedsManualRefresh(
    solver.autoRefreshExhausted,
    solverData != null,
  )
  const bestDirect = directData?.best ?? null
  const automaticProtocol = bestDirect?.route.protocol ?? null
  // the solver routes across every venue with splits, so it wins whenever it
  // answers; the direct venues stay live as comparison rows and fallback
  const automaticSource: SwapSource | null =
    solverData && (!bestDirect || solverData.quote.amountOutNet >= bestDirect.amountOut)
      ? 'solver'
      : automaticProtocol
  const selectedSource = override ?? automaticSource
  const solverSel = selectedSource === 'solver' ? solverData : null
  const selected =
    selectedSource && selectedSource !== 'solver' ? directData?.byProtocol[selectedSource] ?? null : null
  // one shape for the details section, whichever kind is selected
  const outAmount = solverSel ? solverSel.quote.amountOutNet : selected?.amountOut ?? null
  const selImpactBps = solverSel ? solverSel.impactBps : selected?.impactBps ?? null
  const selVenueFeeBps = solverSel ? solverSel.venueFeeBps : selected ? selected.route.feePpm / 100 : null
  const autoBase =
    selImpactBps == null || selVenueFeeBps == null ? null : autoSlippage(selImpactBps, selVenueFeeBps)
  // a failed run IS a volatility measurement: floor AUTO at the retry tolerance
  const flooredBps = slipFloor === null ? null : Math.max(autoBase?.bps ?? 0, slipFloor)
  const automaticSlippage: AutoSlippage | null =
    flooredBps === null ? autoBase : { bps: flooredBps, tone: slippageTone(flooredBps) }
  const effectiveSlippage = slippageChoice === 'auto' ? automaticSlippage?.bps : slippageChoice
  const customInvalid = customSlip !== '' && slippagePctToBps(customSlip) === null
  // terminal fee: the solver reports its server-side rate in the response;
  // direct routes charge the client-side configured rate
  const terminalFeeBps = solverSel ? solverSel.quote.feeBps : ENV.swapFeeBps
  // ONE fee-free denominator for every usable row. Prefer the broader solver;
  // direct fallback is exact only when its probe winner is V2.
  const midOut = solverData?.quote.midAmountOut ?? directData?.midOut ?? null
  // headline COST = price move + pool fees + transfer taxes + terminal fee
  const totalCostBps = outAmount == null ? null : allInCostBps(outAmount, midOut)
  // Quote cards carry the SAME all-in number as the details COST row above.
  const solverCardCostBps = solverData ? allInCostBps(solverData.quote.amountOutNet, midOut) : null

  // 1s ticker driving the quote-refresh countdown (only while a quote is live)
  const ticking = mode === 'market' && amount > 0n && !isWrap && !isUnwrap
  useEffect(() => {
    if (!ticking) return
    const tick = () => setClockTick((version) => version + 1)
    const id = setInterval(tick, 1000)
    window.addEventListener('focus', tick)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(id)
      window.removeEventListener('focus', tick)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [ticking])

  const flip = () => {
    setTIn(tOut)
    setTOut(tIn)
    setAmtStr('')
  }

  const run = (fn: () => Promise<unknown>) =>
    submissionKey ? swapSubmissions.run(submissionKey, fn) : Promise.resolve(false)

  const doWrap = () =>
    run(() =>
      step(t('swap.stWrap', { amt: amtStr }), () =>
        writeContract(wagmiConfig, {
          abi: wethAbi,
          address: ADDR.WETH,
          functionName: 'deposit',
          value: amount,
          chainId: CHAIN_ID,
        }),
      ),
    )

  const doUnwrap = () =>
    run(() =>
      step(t('swap.stUnwrap', { amt: amtStr }), () =>
        writeContract(wagmiConfig, {
          abi: wethAbi,
          address: ADDR.WETH,
          functionName: 'withdraw',
          args: [amount],
          chainId: CHAIN_ID,
        }),
      ),
    )

  const doSwap = () =>
    run(async () => {
      if (!user || !tIn || !tOut || amount === 0n || effectiveSlippage === undefined) return
      // register a prominent pending entry the instant the tx is broadcast; it
      // persists across reload, so a user who reloads still sees it in flight
      // (and can't re-submit the same trade — the root of the double-swap)
      const onSubmitted = (hash: Hex) => {
        const persisted = pendingSwaps.add({
          id: hash,
          account: user,
          tokenIn: tIn.address,
          tokenOut: tOut.address,
          amountIn: amount.toString(),
          inSym: tIn.symbol,
          outSym: tOut.symbol,
          amountInDisp: amtStr,
          createdAt: Date.now(),
          status: 'pending',
        })
        if (!persisted) txlog.push('err', t('swap.pendingSaveFailed'), hash)
      }
      const onReplaced = (oldHash: Hex, newHash: Hex, reason: ReplacementReason) => {
        const persisted = pendingSwaps.replaceHash(oldHash, newHash, reason !== 'repriced')
        if (!persisted) txlog.push('err', t('swap.pendingSaveFailed'), newHash)
      }
      try {
        let result: Awaited<ReturnType<typeof executeSwap>> = null
        if (solverSel) {
          result = await executeSolverSwap({
            tokenIn: tIn.address,
            tokenOut: tOut.address,
            amountIn: amount,
            slippageBps: effectiveSlippage,
            minimumAmountOut: applySlippage(solverSel.quote.amountOutNet, effectiveSlippage),
            sender: user,
            recipient: user,
            inputSymbol: tIn.symbol,
            label: t('swap.stSwapSolver', { amt: amtStr, a: tIn.symbol, b: tOut.symbol }),
            onSubmitted,
            onReplaced,
          })
        } else if (selected) {
          result = await executeSwap({
            route: selected.route,
            tokenIn: tIn.address,
            tokenOut: tOut.address,
            amountIn: amount,
            minimumAmountOut: applySlippage(selected.amountOut, effectiveSlippage),
            sender: user,
            recipient: user,
            inputSymbol: tIn.symbol,
            label: t('swap.stSwapDirect', {
              amt: amtStr,
              a: tIn.symbol,
              b: tOut.symbol,
              route: directRouteLabel(selected.route),
            }),
            onSubmitted,
            onReplaced,
          })
        } else return
        // flip the pending row to confirmed at once on the happy path — don't
        // leave it (and the "SWAP PENDING" button) waiting on the poller's next
        // tick; usePendingSwaps still settles reloaded/reverted/stale entries
        if (result) pendingSwaps.settle(result.receipt.transactionHash, 'confirmed')
        // ignore a settlement whose trade the user has already moved past
        if (result && tradeSigRef.current === tradeSig) setSlipFloor(null) // a fill clears the floor
      } catch (error) {
        // slippage halt: re-quote both venues so the shown output/min reflect
        // live prices, and raise AUTO so the retry is not offered the tolerance
        // that just failed — mirrors the ZAP panel's halt handling. Skip if the
        // trade moved on, and only ever raise the floor (never lower it).
        if (error instanceof SlippageError && tradeSigRef.current === tradeSig) {
          setSlipFloor((prev) => Math.max(prev ?? 0, retrySlippage(effectiveSlippage)))
          void quote.refetch()
          void solver.refetch()
        }
        txlog.push('err', (error as Error).message)
      }
    })

  const modeRow = (
    <div className="form-row" style={{ marginBottom: 10 }}>
      <span className="lbl hide-m">{t('swap.mode')}</span>
      <button className={`chip ${mode === 'market' ? 'on' : ''}`} onClick={() => setMode('market')}>
        {t('swap.market')}
      </button>
      <button
        className={`chip ${mode === 'limit' ? 'on' : ''}`}
        onClick={() => setMode('limit')}
        title={t('swap.limitTip')}
      >
        {t('swap.limit')}
      </button>
      <span className="chain-tag" title={t('swap.chainTip', { id: CHAIN_ID })}>
        <span className="dot" />
        Robinhood Chain
      </span>
    </div>
  )

  if (mode === 'limit') {
    return (
      <div className="swap-box">
        {modeRow}
        <LimitPanel />
      </div>
    )
  }

  const tokenListNotices = (
    <>
      {tokenList.uniswapSource === 'fallback' && (
        <div className="amber mono-sm">{t('swap.tokenListFallback')}</div>
      )}
      {tokenList.uniswapError && (
        <div className="red mono-sm">
          {t('swap.tokenListFailed', { err: tokenList.uniswapError.message.slice(0, 90) })}
        </div>
      )}
      {tokenList.up33Error && (
        <div className="red mono-sm">
          {t('swap.up33TokenListFailed', { err: tokenList.up33Error.message.slice(0, 90) })}
        </div>
      )}
    </>
  )

  if (!tIn || !tOut) {
    return (
      <div className="swap-box narrow">
        {modeRow}
        {tokenListNotices}
        <div className="dim">{t('swap.loadingTokens')}</div>
      </div>
    )
  }

  const balIn = balances.data?.[tIn.address.toLowerCase()]
  const balOut = balances.data?.[tOut.address.toLowerCase()]
  const insufficient = balIn !== undefined && amount > balIn
  // gas headroom only gates MAX — a partial percentage already leaves the
  // rest for gas, and reserving it there zeroed out small balances entirely
  const setPct = (pct: bigint) => {
    if (balIn === undefined) return
    const buffer = pct === 100n && tIn.native ? ETH_GAS_BUFFER : 0n
    const spendable = balIn > buffer ? balIn - buffer : 0n
    setAmtStr(formatUnits((spendable * pct) / 100n, tIn.decimals))
  }
  const rate =
    outAmount != null && amount > 0n
      ? Number(formatUnits(outAmount, tOut.decimals)) /
        Number(formatUnits(amount, tIn.decimals))
      : undefined
  const selectedRoute = solverSel
    ? solverRouteLabel(solverSel.quote)
    : selected
      ? directRouteLabel(selected.route)
      : ''
  let outputAmount = '0.0'
  if (isWrap || isUnwrap) outputAmount = amtStr || '0.0'
  else if (outAmount != null) outputAmount = fmtAmount(outAmount, tOut.decimals)
  else if (quote.isFetching || solver.isFetching) outputAmount = '…'
  // full-precision output drives the direction flash, so a price move on a
  // narrow-mover still flashes even when the rounded display looks unchanged
  const outFlashV =
    !isWrap && !isUnwrap && outAmount != null ? Number(formatUnits(outAmount, tOut.decimals)) : undefined

  // USD notionals at per-unit spot (impact is shown separately on each quote)
  const usdValue = (raw: bigint, decimals: number, unit: number | undefined) =>
    unit === undefined ? undefined : Number(formatUnits(raw, decimals)) * unit
  const amtNum = Number(amtStr)
  const inUsd = usdIn.data !== undefined && Number.isFinite(amtNum) && amtNum > 0 ? amtNum * usdIn.data : undefined
  let outUsd: number | undefined
  if (isWrap || isUnwrap) outUsd = usdOut.data !== undefined && Number.isFinite(amtNum) && amtNum > 0 ? amtNum * usdOut.data : undefined
  else if (outAmount != null && amount > 0n) outUsd = usdValue(outAmount, tOut.decimals, usdOut.data)
  // buy-side USD vs sell-side USD at venue spot — surfaces total cost (impact + fees)
  const usdDelta =
    !isWrap && !isUnwrap && outAmount != null && amount > 0n && inUsd !== undefined && outUsd !== undefined && inUsd > 0
      ? ((outUsd - inUsd) / inUsd) * 100
      : undefined
  const minReceived =
    outAmount != null && effectiveSlippage !== undefined ? applySlippage(outAmount, effectiveSlippage) : null
  // best across BOTH kinds — the shortfall chips on non-best rows measure against it
  const bestNet =
    automaticSource === 'solver' && solverData ? solverData.quote.amountOutNet : bestDirect?.amountOut ?? null
  const nextIn = directData && quote.dataUpdatedAt
    ? Math.max(0, Math.ceil((quote.dataUpdatedAt + DIRECT_QUOTE_REFRESH_MS - now) / 1000))
    : null

  const protocolRows: { protocol: DirectProtocol; label: string }[] = [
    { protocol: 'uniswap', label: t('swap.uniswapDirect') },
    { protocol: 'up33', label: t('swap.up33Direct') },
  ]

  // slippage summary line (the expandable DETAILS row)
  const isAutoSlip = slippageChoice === 'auto' && customSlip === ''
  const slipForced = amount > 0n && outAmount != null && effectiveSlippage === undefined && !customInvalid
  const slipExpanded = slipOpen || slipForced || customInvalid
  let slipValue: string
  let slipTone = ''
  if (customInvalid) {
    slipValue = t('common.slipInvalid')
    slipTone = 'red'
  } else if (effectiveSlippage !== undefined) {
    slipValue = `${isAutoSlip ? 'AUTO · ' : ''}${effectiveSlippage / 100}%`
    slipTone = slippageTone(effectiveSlippage)
  } else {
    slipValue = t('swap.chooseSlippage')
    slipTone = amount > 0n && selected ? 'red' : 'dim'
  }

  const sellCard = (
    <div className="swap-card">
      <div className="hd">
        <span className="side-lbl">{t('swap.sell')}</span>
        {balIn !== undefined && (
          <button className={`bal ${insufficient ? 'red' : ''}`} onClick={() => setPct(100n)} title={t('swap.balTip')}>
            {t('common.bal')} {fmtAmount(balIn, tIn.decimals)} {tIn.symbol}
          </button>
        )}
      </div>
      <div className="io">
        <TokenSelect list={list} value={tIn} exclude={tOut.address} onChange={setTIn} />
        <input
          className="amt"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          placeholder="0.0"
          value={amtStr}
          onChange={(event) => {
            const value = sanitizeAmountInput(event.target.value, tIn.decimals)
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
                title={pct === 100n && tIn.native ? t('common.maxGasTip', { amt: fmtAmount(ETH_GAS_BUFFER, 18), sym: 'ETH' }) : undefined}
                onClick={() => setPct(pct)}
              >
                {pct === 100n ? t('common.max') : `${pct}%`}
              </button>
            ))}
        </span>
        <span className="usd">{inUsd !== undefined && <>≈ {fmtUsd(inUsd)}</>}</span>
      </div>
    </div>
  )

  const buyCard = (
    <div className="swap-card">
      <div className="hd">
        <span className="side-lbl">{t('swap.buy')}</span>
        {balOut !== undefined && (
          <span className="bal static">
            {t('common.bal')} {fmtAmount(balOut, tOut.decimals)} {tOut.symbol}
          </span>
        )}
      </div>
      <div className="io">
        <TokenSelect list={list} value={tOut} exclude={tIn.address} onChange={setTOut} />
        <span className={`out ${selected || isWrap || isUnwrap ? '' : 'dim'}`}>
          <Flash v={outFlashV} arrow>
            {outputAmount}
          </Flash>
        </span>
      </div>
      <div className="ft">
        <span />
        <span className="usd">
          {outUsd !== undefined && <>≈ {fmtUsd(outUsd)}</>}
          {usdDelta !== undefined && (
            <span className={`delta ${usdDelta <= -1 ? 'red' : ''}`} title={t('swap.usdDeltaTip')}>
              {' '}
              ({usdDelta > 0 ? '+' : ''}
              {usdDelta.toFixed(2)}%)
            </span>
          )}
        </span>
      </div>
    </div>
  )

  const cards = (
    <>
      {sellCard}
      <div className="swap-flip-row">
        <button className="swap-flip" onClick={flip} title={t('swap.flipTip')}>
          ⇅
        </button>
      </div>
      {buyCard}
    </>
  )

  // reload-proof pending display: unlike the corner activity log (in-memory),
  // these entries survive a reload, so an in-flight swap stays visible and the
  // user isn't tempted to fire it again. Settled by usePendingSwaps' poller.
  const pendingBanner = pending.length > 0 && (
    <div className="pending-swaps">
      {pending.map((p) => {
        const tone =
          p.status === 'confirmed' ? 'green' : p.status === 'failed' ? 'red' : p.status === 'stale' ? 'amber' : ''
        const label =
          p.status === 'confirmed'
            ? t('swap.pendConfirmed')
            : p.status === 'failed'
              ? t('swap.pendFailed')
              : p.status === 'stale'
                ? t('swap.pendStale')
                : t('swap.pendPending')
        return (
          <div key={p.id} className={`pending-row ${tone}`}>
            <span className="ic">
              {p.status === 'pending' ? (
                <span className="spin">▮</span>
              ) : p.status === 'confirmed' ? (
                '✓'
              ) : p.status === 'stale' ? (
                '⚠'
              ) : (
                '✗'
              )}
            </span>
            <span className="pair">
              {p.amountInDisp} {p.inSym} → {p.outSym}
            </span>
            <span className="st mono-sm">{label}</span>
            <a className="view mono-sm" href={`${EXPLORER}/tx/${p.id}`} target="_blank" rel="noreferrer">
              {t('swap.viewTx')} ↗
            </a>
            {isSettled(p.status) && (
              <button className="x" onClick={() => pendingSwaps.dismiss(p.id)} title={t('swap.pendingDismiss')}>
                ✕
              </button>
            )}
          </div>
        )
      })}
    </div>
  )

  // ---- wrap / unwrap: fee-less 1:1, no routes or slippage ----
  if (isWrap || isUnwrap) {
    let cta = isWrap ? t('swap.wrapBtn', { amt: amtStr || '0' }) : t('swap.unwrapBtn', { amt: amtStr || '0' })
    if (!user) cta = t('common.connectWallet')
    else if (amount === 0n) cta = t('swap.ctaEnterAmount')
    else if (insufficient) cta = t('common.insufficientBalance')
    return (
      <div className="swap-box narrow">
        {modeRow}
        <div className="swap-col">
          {tokenListNotices}
          {cards}
          <div className="kv-list">
            <div className="kv">
              <span className="k">{t('swap.kRate')}</span>
              <span className="fill" />
              <span className="v">
                1 {tIn.symbol} = 1 {tOut.symbol}
              </span>
            </div>
            <div className="kv">
              <span className="k">{t('swap.kFee')}</span>
              <span className="fill" />
              <span className="v dim">{t('swap.wrapNote', { addr: shortAddr(ADDR.WETH) })}</span>
            </div>
          </div>
          {pendingBanner}
          <div className="swap-cta">
            <Btn
              big
              busy={submitting}
              disabled={!!user && (amount === 0n || insufficient)}
              onClick={!user ? openWalletPicker : isWrap ? doWrap : doUnwrap}
            >
              {cta}
            </Btn>
          </div>
        </div>
      </div>
    )
  }

  // ---- market swap ----
  const quotesNeedRefresh = outAmount == null && (solverNeedsManualRefresh || hasStaleData)
  const refreshQuotes = () => {
    void quote.refetch()
    void solver.refetch()
  }
  let cta = t('swap.noRoute')
  let ctaDisabled = true
  let refreshCta = false
  if (!user) {
    cta = t('common.connectWallet')
    ctaDisabled = false
  } else if (amount === 0n) cta = t('swap.ctaEnterAmount')
  else if (insufficient) cta = t('common.insufficientBalance')
  else if (tradePending) cta = t('swap.ctaPending') // this exact trade is in flight — block a double
  else if (quotesNeedRefresh) {
    cta = t('swap.ctaRefreshQuote')
    ctaDisabled = false
    refreshCta = true
  } else if (outAmount == null && (quote.isFetching || solver.isFetching)) cta = t('swap.ctaQuoting')
  else if (outAmount != null && effectiveSlippage === undefined) cta = t('swap.chooseSlippage')
  else if (outAmount != null) {
    cta = t('swap.execVia', { route: solverSel ? t('swap.solverRoute') : selectedRoute })
    ctaDisabled = false
  }

  return (
    <div className="swap-box narrow">
      {modeRow}
      <div className="swap-col">
        {tokenListNotices}
        {cards}

        {amount > 0n && (
          <>
            <div className="section-title">
              {t('swap.route')}
              <button
                className="chip aux"
                onClick={refreshQuotes}
                title={t('swap.solverRefreshTip', { s: DIRECT_QUOTE_REFRESH_MS / 1000 })}
              >
                {quote.isFetching || solver.isFetching ? <span className="spin">▮</span> : `↻ ${nextIn ?? '—'}s`}
              </button>
            </div>
            {quote.isError && (
              <div className="red mono-sm">
                {t('swap.unavailable', { err: (quote.error as Error).message.slice(0, 90) })}
              </div>
            )}
            {(() => {
              const q = solverData?.quote ?? null
              const isSel = selectedSource === 'solver'
              const behindBest =
                q && bestNet !== null && automaticSource !== 'solver' ? bpsDiff(q.amountOutNet, bestNet) / 100 : null
              const qUsd = q ? usdValue(q.amountOutNet, tOut.decimals, usdOut.data) : undefined
              return (
                <div className={`quote-card ${isSel ? 'sel' : ''}`} onClick={() => setOverride('solver')}>
                  <div className="l1">
                    <span className="src">
                      {isSel ? '◉' : '○'} {t('swap.solverRoute')}
                    </span>
                    {solver.isError ? (
                      <span className="qstate red mono-sm">{t('swap.solverDown')}</span>
                    ) : q ? null : solver.isFetching ? (
                      <span className="qstate spin">▮</span>
                    ) : (
                      <span className="qstate dim">—</span>
                    )}
                    {q && (
                      <>
                        <span className="qamt green">
                          {fmtAmount(q.amountOutNet, tOut.decimals)} {tOut.symbol}
                        </span>
                        {automaticSource === 'solver' ? (
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
                  {q && (
                    <div className="route-viz" title={solverRouteLabel(q)}>
                      <div className="route-bar">
                        {q.route.map((leg, i) => (
                          <i key={i} style={{ flexGrow: Math.max(leg.shareBps, 40) }} />
                        ))}
                      </div>
                      <div className="route-legs">
                        {q.route.slice(0, 4).map((leg, i) => (
                          <span key={i} className="leg">
                            <b>{legSharePct(leg.shareBps)}%</b>{' '}
                            {leg.hops.map((hop) => venueLabel(hop.protocol)).join(' → ')}
                          </span>
                        ))}
                        {q.route.length > 4 && <span className="leg">+{q.route.length - 4}</span>}
                      </div>
                    </div>
                  )}
                  {q && solverData && (solverCardCostBps !== null || qUsd !== undefined) && (
                    <div className="l2">
                      <span>
                        {solverCardCostBps !== null && (
                          <span
                            className={`${slippageTone(solverCardCostBps)} hint`}
                            data-tip={t('swap.costTip')}
                          >
                            {t('swap.quoteCost', { pct: (solverCardCostBps / 100).toFixed(2) })}
                          </span>
                        )}
                      </span>
                      {qUsd !== undefined && <span>≈ {fmtUsd(qUsd)}</span>}
                    </div>
                  )}
                </div>
              )
            })()}
            {protocolRows.map(({ protocol, label }) => {
              const candidate = directData?.byProtocol[protocol] ?? null
              const status = directData?.status[protocol]
              const isSel = selectedSource === protocol
              let state: JSX.Element | null = <span className="qstate dim mono-sm">{t('swap.noDirectPool')}</span>
              if (quote.isError) state = <span className="qstate dim">—</span>
              else if (quote.isFetching && !directData) state = <span className="qstate spin">▮</span>
              else if (protocol === 'up33' && tokenList.up33Loading) state = <span className="qstate spin">▮</span>
              else if (status === 'failed') state = <span className="qstate red mono-sm">{t('swap.quoteFailed')}</span>
              else if (candidate) state = null
              const candidateUsd = candidate ? usdValue(candidate.amountOut, tOut.decimals, usdOut.data) : undefined
              // same baseline as the solver card, so the rows compare like for like
              const candidateCostBps = candidate ? allInCostBps(candidate.amountOut, midOut) : null
              // shortfall vs the best route, in the reference-UI style (-1.76%)
              const behindBest =
                candidate && bestNet !== null && automaticSource !== protocol
                  ? bpsDiff(candidate.amountOut, bestNet) / 100
                  : null
              return (
                <div key={protocol} className={`quote-card ${isSel ? 'sel' : ''}`} onClick={() => setOverride(protocol)}>
                  <div className="l1">
                    <span className="src">
                      {isSel ? '◉' : '○'} {label}
                    </span>
                    {state}
                    {candidate && (
                      <>
                        <span className="qamt green">
                          {fmtAmount(candidate.amountOut, tOut.decimals)} {tOut.symbol}
                        </span>
                        {automaticSource === protocol && !tokenList.up33Loading ? (
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
                  {candidate && (
                    <div className="l2">
                      <span>
                        {routeDetail(candidate)}
                        {candidateCostBps !== null && (
                          <>
                            {/* the separator stays outside, so the dashed rule
                                underlines the number and not the bullet */}
                            {' · '}
                            <span
                              className={`${slippageTone(candidateCostBps)} hint`}
                              data-tip={t('swap.costTip')}
                            >
                              {t('swap.quoteCost', { pct: (candidateCostBps / 100).toFixed(2) })}
                            </span>
                          </>
                        )}
                      </span>
                      {candidateUsd !== undefined && <span>≈ {fmtUsd(candidateUsd)}</span>}
                    </div>
                  )}
                </div>
              )
            })}

            <div className="section-title">{t('swap.details')}</div>
            <div className="kv-list">
              {rate !== undefined && (
                <div className="kv click" onClick={() => setInvRate(!invRate)} title={t('swap.rateTip')}>
                  <span className="k">{t('swap.kRate')}</span>
                  <span className="fill" />
                  <span className="v">
                    {t('swap.rateV', {
                      a: invRate ? tOut.symbol : tIn.symbol,
                      n: fmtNum(invRate ? 1 / rate : rate),
                      b: invRate ? tIn.symbol : tOut.symbol,
                    })}
                    {(invRate ? usdOut : usdIn).data !== undefined && (
                      <span className="dim"> · ≈ {fmtUsd((invRate ? usdOut : usdIn).data)}</span>
                    )}
                  </span>
                </div>
              )}
              <div className="kv click" onClick={() => setSlipOpen(!slipOpen)}>
                <span className="k">{t('swap.slippage')}</span>
                <span className="fill" />
                <span className={`v ${slipTone}`}>
                  {slipValue} <span className="dim">{slipExpanded ? '▴' : '▾'}</span>
                </span>
              </div>
              {slipExpanded && (
                <div className="kv-sub">
                  <button
                    className={`chip ${isAutoSlip ? 'on' : ''}`}
                    onClick={() => {
                      setSlippageChoice('auto')
                      setCustomSlip('')
                    }}
                  >
                    AUTO {automaticSlippage ? `${automaticSlippage.bps / 100}%` : '—'}
                  </button>
                  {SLIPPAGE_CHOICES.map((bps) => (
                    <button
                      key={bps}
                      className={`chip ${slippageChoice === bps && customSlip === '' ? 'on' : ''}`}
                      onClick={() => {
                        setSlippageChoice(bps)
                        setCustomSlip('')
                      }}
                    >
                      {bps / 100}%
                    </button>
                  ))}
                  <NumInput
                    value={customSlip}
                    onChange={(v) => {
                      setCustomSlip(v)
                      setSlippageChoice(slippagePctToBps(v) ?? 'auto')
                    }}
                    placeholder={t('common.slipCustom')}
                    width={80}
                    invalid={customInvalid}
                  />
                  <span className="dim mono-sm">%</span>
                  {customInvalid && <span className="red mono-sm">{t('common.slipInvalid')}</span>}
                </div>
              )}
              {minReceived !== null && effectiveSlippage !== undefined && (
                <div className="kv">
                  <span className="k">{t('swap.kMinReceived')}</span>
                  <span className="fill" />
                  <span className="v">
                    {fmtAmount(minReceived, tOut.decimals)} {tOut.symbol}
                    {usdOut.data !== undefined && (
                      <span className="dim"> · ≈ {fmtUsd(usdValue(minReceived, tOut.decimals, usdOut.data))}</span>
                    )}
                  </span>
                </div>
              )}
              {/* ONE number. It used to expand into price move + pool fee +
                  terminal fee, which never summed to it and cannot be made to:
                  the pool a blended route pays more fee to can also carry the
                  better mid, so the leftover "price move" goes negative. The
                  terminal fee stays on its own row as disclosure, not as an
                  addend — whose cut this is matters even at 0.00%. */}
              {outAmount != null && (
                <>
                  <div className="kv">
                    <span className="k hint" data-tip={t('swap.costTip')}>
                      {t('swap.kCost')}
                    </span>
                    <span className="fill" />
                    <span className={`v ${totalCostBps === null ? 'dim' : slippageTone(totalCostBps)}`}>
                      {totalCostBps === null ? '—' : `${(totalCostBps / 100).toFixed(2)}%`}
                    </span>
                  </div>
                  <div
                    className="kv"
                    title={t('swap.terminalFeeOfWhich', { pct: (terminalFeeBps / 100).toFixed(2) })}
                  >
                    <span className="k">{t('swap.kTerminalFee')}</span>
                    <span className="fill" />
                    <span className="v dim">{(terminalFeeBps / 100).toFixed(2)}%</span>
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {pendingBanner}
        <div className="swap-cta">
          <Btn
            big
            tone={refreshCta ? 'amber' : undefined}
            // a submitted trade shows "SWAP PENDING" text (not a spinner); the
            // banner above carries the live status + explorer link
            busy={!tradePending && (submitting || (refreshCta && (solver.isFetching || quote.isFetching)))}
            disabled={ctaDisabled}
            onClick={!user ? openWalletPicker : refreshCta ? refreshQuotes : doSwap}
          >
            {cta}
          </Btn>
        </div>
      </div>
    </div>
  )
}
