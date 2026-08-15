// ZAP panel — fund a position with ONE token: a pool-side token, WETH/USDG,
// or ANY token (custom picker). Shared by POOLS (mint/add) and POSITIONS
// (increase): the parent picks the target, this panel solves the split,
// previews it, and walks the execution sequence. See lib/zap.ts for the math.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useAccount, usePublicClient } from 'wagmi'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatUnits, parseUnits, zeroAddress, type Address } from 'viem'
import { ADDR, CHAIN_ID, NATIVE } from '../config/addresses'
import { CHAIN } from '../config/chains'
import { simulateClAdd, simulateV2Add } from '../lib/apr'
import { fmtAmount } from '../lib/format'
import { autoSlippage, needsSlippageConfirm, retrySlippage, slippagePctToBps, slippageTone, SLIPPAGE_CHOICES, type AutoSlippage } from '../lib/swapGate'
import { SOLVER_AUTO_REFRESHES, solverQuoteAutoRefreshExhausted, solverQuoteCanAutoRefresh } from '../lib/solverRefresh'
import { autostake } from '../lib/autostake'
import {
  DEPOSIT_MINS_BPS,
  executeZap,
  planZap,
  stakeableTarget,
  zapStages,
  zapVenueFeeBps,
  type ZapFailReason,
  type ZapPlan,
  type ZapTarget,
} from '../lib/zap'
import { V4_DEPOSIT_BAND_BPS } from '../lib/uniV4'
import { useArmedConfirm } from '../hooks/useArmedConfirm'
import { useBalances } from '../hooks/useBalances'
import { usePools } from '../hooks/usePools'
import { useTokenList } from '../hooks/useTokenList'
import type { PoolStat } from '../lib/poolstats'
import type { TokenInfo } from '../types'
import { AddStats } from './AddStats'
import { StakeAfterToggle } from './StakeAfterToggle'
import { TokenSelect } from './TokenSelect'
import { ZapFlow } from './ZapFlow'
import { Btn, NumInput } from './ui'

// native units withheld from a MAX so the next transaction can still pay gas
const GAS_BUFFER = CHAIN.gasBuffer
const ZAP_PLAN_REFRESH_MS = 30_000

const NATIVE_TOKEN: TokenInfo = {
  address: NATIVE as Address,
  symbol: CHAIN.nativeCurrency.symbol,
  decimals: CHAIN.nativeCurrency.decimals,
  native: true,
}
const WRAPPED_TOKEN: TokenInfo = {
  address: ADDR.WNATIVE,
  symbol: CHAIN.wrappedSymbol,
  decimals: CHAIN.nativeCurrency.decimals,
}
const STABLE_TOKEN: TokenInfo = {
  address: ADDR.STABLE,
  symbol: CHAIN.stable.symbol,
  decimals: CHAIN.stable.decimals,
}

export function ZapPanel(props: {
  target: ZapTarget
  t0: TokenInfo
  t1: TokenInfo
  stat?: PoolStat
  upUsd?: number
  wethUsd?: number | null
}) {
  const { target, t0, t1 } = props
  const { t } = useTranslation()
  const pool = target.pool
  const { address: user } = useAccount()
  const client = usePublicClient({ chainId: CHAIN_ID })
  const pools = usePools()
  const tokenList = useTokenList()
  const autoStake = useSyncExternalStore(autostake.subscribe, autostake.get)
  const stakeable = stakeableTarget(target)

  // v4 represents the chain coin as address(0), while every wallet-facing path
  // uses NATIVE. Canonicalize here so BNB appears once and reads getBalance()
  // rather than attempting balanceOf(address(0)).
  const inputT0 = pool.protocol === 'univ4' && t0.address === zeroAddress ? NATIVE_TOKEN : t0
  const inputT1 = pool.protocol === 'univ4' && t1.address === zeroAddress ? NATIVE_TOKEN : t1
  const candidates = useMemo(() => {
    const seen = new Set<string>()
    return [inputT0, inputT1, NATIVE_TOKEN, WRAPPED_TOKEN, STABLE_TOKEN].filter((tok) => {
      const k = tok.address.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  }, [inputT0, inputT1])
  const [selTok, setSelTok] = useState<TokenInfo | null>(null)
  const tIn = selTok ?? inputT0
  const tokenInAddr: Address = tIn.address
  const customSel = !candidates.some((c) => c.address.toLowerCase() === tokenInAddr.toLowerCase())

  const [amtStr, setAmtStr] = useState('')
  const [amount, setAmount] = useState(0n)
  // slippage: null = AUTO (quote-derived); a bps number = a preset chip or the
  // typed custom value (customSlip holds the raw text so the input can own focus)
  const [manualSlip, setManualSlip] = useState<number | null>(null)
  const [customSlip, setCustomSlip] = useState('')
  const [slipOpen, setSlipOpen] = useState(false)
  // floor under AUTO after a slippage halt: never re-offer the number that
  // just failed. Cleared when the trade context changes or a run succeeds.
  const [slipFloor, setSlipFloor] = useState<number | null>(null)
  const [running, setRunning] = useState(false)
  const [runAt, setRunAt] = useState<{ i: number; failed: boolean; reason?: ZapFailReason; slip?: number } | null>(
    null,
  )
  const [runPlan, setRunPlan] = useState<ZapPlan | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    const h = setTimeout(() => {
      try {
        setAmount(parseUnits(amtStr === '' ? '0' : amtStr, tIn.decimals))
      } catch {
        setAmount(0n)
      }
    }, 350)
    return () => clearTimeout(h)
  }, [amtStr, tIn.decimals])

  const poolKey = pool.kind === 'cl' && pool.poolId ? pool.poolId : pool.address
  // a new pool/token/amount is a new trade — yesterday's failure floor doesn't apply
  useEffect(() => {
    setSlipFloor(null)
  }, [poolKey, tokenInAddr, amount])

  const balAddrs = useMemo(() => {
    const s = new Map<string, Address>()
    for (const c of candidates) s.set(c.address.toLowerCase(), c.address)
    s.set(tokenInAddr.toLowerCase(), tokenInAddr)
    return [...s.values()]
  }, [candidates, tokenInAddr])
  const bal = useBalances(user, balAddrs)
  const balIn = bal.data?.[tokenInAddr.toLowerCase()]
  let spendable = balIn
  if (balIn !== undefined && tIn.native) spendable = balIn > GAS_BUFFER ? balIn - GAS_BUFFER : 0n
  const insufficient = spendable !== undefined && amount > spendable

  // ticks key parts (cl targets re-plan when the parent's range changes)
  const lo = target.kind === 'v2' ? 0 : target.tickLower
  const hi = target.kind === 'v2' ? 0 : target.tickUpper
  const up33State = pools.error ? 'up33-failed' : pools.data ? 'up33-ready' : 'up33-pending'

  const queryClient = useQueryClient()
  const zapPlanKey = ['zapPlan', poolKey, lo, hi, tokenInAddr, amount.toString(), up33State] as const
  const plan = useQuery({
    queryKey: zapPlanKey,
    // same cap as the swap's solver quote: auto-refresh a few times, then pause
    // — execution re-quotes the swap leg fresh regardless, and the manual
    // refresh below revives a paused (or failed-out) preview
    enabled: (query) =>
      !!client && !pools.isPending && amount > 0n && !running && solverQuoteCanAutoRefresh(query.state),
    refetchInterval: ZAP_PLAN_REFRESH_MS,
    staleTime: 15_000,
    retry: false,
    queryFn: () =>
      planZap({
        client: client!,
        pools: pools.error ? null : (pools.data?.pools ?? null),
        target,
        tokenIn: tokenInAddr,
        amountIn: amount,
      }),
  })
  const p = running ? runPlan : (plan.data ?? null)
  // once the auto-refresh cap is hit the preview stops updating — surface a
  // manual refresh. Gate on amount, not on data: four planning FAILURES also
  // exhaust the budget, and that is exactly when a retry control is needed.
  const planRecord = queryClient.getQueryCache().find({ queryKey: zapPlanKey, exact: true })
  const planPaused = amount > 0n && !running && !!planRecord && solverQuoteAutoRefreshExhausted(planRecord.state)
  const autoBase = p?.impactBps == null ? null : autoSlippage(p.impactBps, zapVenueFeeBps(p))
  // post-halt floor wins over the quote-derived number (and stands in for it
  // when the impact probe is unavailable — a failed run IS a measurement)
  const flooredBps = slipFloor === null ? null : Math.max(autoBase?.bps ?? 0, slipFloor)
  const automaticSlippage: AutoSlippage | null =
    flooredBps === null ? autoBase : { bps: flooredBps, tone: slippageTone(flooredBps) }
  const effectiveSlip = manualSlip ?? automaticSlippage?.bps
  const depositBandBps = pool.protocol === 'univ4' ? V4_DEPOSIT_BAND_BPS : DEPOSIT_MINS_BPS
  const customInvalid = customSlip !== '' && slippagePctToBps(customSlip) === null
  const slippageRequired = !!p && p.legs.length > 0 && effectiveSlip === undefined
  // a zap with no swap leg never spends the tolerance — `run` passes 0 — so
  // there is nothing to confirm however wide the editor's number happens to be
  const wideSlippage = needsSlippageConfirm(plan.data?.legs.length === 0 ? 0 : effectiveSlip)
  const runConfirm = useArmedConfirm(`${zapPlanKey.join('|')}|${effectiveSlip ?? ''}`)
  const stages = useMemo(
    () => (p ? zapStages(p, target, tIn, t0, t1, autoStake) : []),
    [p, target, tIn, t0, t1, autoStake],
  )

  // projected APRs on the planned deposit (mint/add previews only — an
  // increase's projection is the parent card's business)
  const sim = useMemo(() => {
    if (!p || target.kind === 'cl-increase') return null
    const a0h = Number(formatUnits(p.dep0, t0.decimals))
    const a1h = Number(formatUnits(p.dep1, t1.decimals))
    if (target.kind === 'cl-mint')
      return simulateClAdd({
        pool: target.pool,
        tickLower: target.tickLower,
        tickUpper: target.tickUpper,
        liquidity: p.liquidity,
        amount0h: a0h,
        amount1h: a1h,
        dec0: t0.decimals,
        dec1: t1.decimals,
        stat: props.stat,
        upUsd: props.upUsd,
        wethUsd: props.wethUsd,
      })
    return simulateV2Add({
      pool: target.pool,
      amount0h: a0h,
      amount1h: a1h,
      dec0: t0.decimals,
      dec1: t1.decimals,
      stat: props.stat,
      upUsd: props.upUsd,
    })
  }, [p, target, t0, t1, props.stat, props.upUsd, props.wethUsd])

  // impact-vs-band honesty: a swap that eats a big slice of the band's width
  // will land the deposit off-ratio (dust) or out of band entirely
  const bandWarn = useMemo(() => {
    if (!p || p.impactBps === null || target.kind === 'v2') return null
    const halfPct = (Math.pow(1.0001, (target.tickUpper - target.tickLower) / 2) - 1) * 100
    const impactPct = p.impactBps / 100
    if (impactPct > Math.max(halfPct / 3, 2))
      return t('zap.bandWarn', { impact: impactPct.toFixed(2), band: halfPct.toFixed(1) })
    return null
  }, [p, target, t])

  const dustNote = (side: 0 | 1): string | null => {
    if (!p) return null
    const dust = side === 0 ? p.dust0 : p.dust1
    const dep = side === 0 ? p.dep0 : p.dep1
    if (dust === 0n || dep === 0n) return null
    if (dust * 200n < dep) return null // <0.5% — noise
    const token = side === 0 ? t0 : t1
    return `${fmtAmount(dust, token.decimals)} ${token.symbol}`
  }
  const dusts = [dustNote(0), dustNote(1)].filter(Boolean)

  const run = async () => {
    const frozen = plan.data
    if (!user || !frozen || amount === 0n || running) return
    const executionSlippage = frozen.legs.length === 0 ? 0 : effectiveSlip
    if (executionSlippage === undefined) return
    setRunPlan(frozen)
    setRunning(true)
    setDone(false)
    setRunAt({ i: 0, failed: false })
    try {
      const res = await executeZap({
        plan: frozen,
        target,
        user,
        slipBps: executionSlippage,
        stake: autoStake,
        tIn,
        t0,
        t1,
        onStage: (i) => setRunAt({ i, failed: false }),
      })
      if (res.ok) {
        setRunAt(null)
        setRunPlan(null)
        setDone(true)
        setSlipFloor(null)
        setAmtStr('')
      } else {
        const reason = res.reason ?? 'other'
        setRunAt({ i: res.failedAt ?? 0, failed: true, reason, slip: executionSlippage })
        // AUTO must not re-offer the tolerance that just failed — only ever raise
        if (reason === 'slippage') setSlipFloor((prev) => Math.max(prev ?? 0, retrySlippage(executionSlippage)))
        // and the retry must re-plan from a live quote, not the ≤30s cached one
        void plan.refetch()
      }
    } finally {
      setRunning(false)
    }
  }

  // first press arms, second runs — and once the tolerance is back inside the
  // band a press goes straight through, with nothing left armed behind it
  const runClick = () => {
    if (wideSlippage && !runConfirm.armed) {
      runConfirm.arm()
      return
    }
    runConfirm.disarm()
    void run()
  }

  const failed = runAt?.failed ?? false
  let runLabel = t('zap.run')
  let runTone: 'danger' | undefined
  let runTitle = t('zap.runHint')
  if (!user) runLabel = t('common.connectWallet')
  else if (slippageRequired) runLabel = t('zap.chooseSlippage')
  else if (runConfirm.armed && effectiveSlip !== undefined) {
    // the armed press names the tolerance it is about to spend on the swap leg
    runLabel = t('zap.confirmSlip', { pct: effectiveSlip / 100 })
    runTone = 'danger'
    runTitle = t('zap.confirmSlipTip', { pct: effectiveSlip / 100 })
  } else if (stages.length > 0) runLabel = t('zap.runSteps', { n: stages.length })

  // slippage: one summary line; the full editor unfolds on demand (or when a
  // choice is REQUIRED — no impact probe / invalid custom value)
  const slipForced = slippageRequired || customInvalid
  const showSlipEditor = slipOpen || slipForced
  const slipSummaryTone = customInvalid
    ? 'red'
    : effectiveSlip !== undefined
      ? slippageTone(effectiveSlip)
      : 'dim'
  const slipSummary = customInvalid
    ? t('common.slipInvalid')
    : effectiveSlip !== undefined
      ? `${manualSlip === null && customSlip === '' ? 'AUTO · ' : ''}${effectiveSlip / 100}%`
      : t('zap.chooseSlippage')

  return (
    <div className="zap">
      {/* The same shape as the range row above it: a closed set of choices as
          one segment group, and beside it the way out of the set. A token
          picked through that door joins the group rather than appearing as a
          seventh loose outline next to it — it is the current choice, and the
          group is where the current choice is shown. */}
      <div className="form-row zap-in">
        <span className="lbl">{t('zap.zapIn')}</span>
        <div className="seg">
          {candidates.map((c) => (
            <button
              key={c.address}
              className={tokenInAddr.toLowerCase() === c.address.toLowerCase() ? 'on' : ''}
              onClick={() => setSelTok(c)}
              disabled={running}
              title={
                c.native
                  ? t('zap.ethTip', {
                      native: CHAIN.nativeCurrency.symbol,
                      wrapped: CHAIN.wrappedSymbol,
                    })
                  : undefined
              }
            >
              {c.symbol}
            </button>
          ))}
          {customSel && <button className="on">{tIn.symbol}</button>}
        </div>
        <TokenSelect list={tokenList.tokens} value={tIn} onChange={setSelTok} label={t('zap.pickOther')} />
      </div>
      <div className="form-row">
        {/* labelled like every other row: an unlabelled input was the one
            control starting at the panel edge, and one broken line down the
            left is what a form reads as "messy" before anything is read */}
        <span className="lbl">{t('zap.amount')}</span>
        <NumInput value={amtStr} onChange={setAmtStr} disabled={running} width={220} />
        {spendable !== undefined && (
          <>
            <button className="chip" disabled={running} onClick={() => setAmtStr(formatUnits(spendable, tIn.decimals))}>
              {t('common.max')}
            </button>
            <span className="dim mono-sm">
              {t('common.bal')} {fmtAmount(spendable, tIn.decimals)} {tIn.symbol}
            </span>
          </>
        )}
        {insufficient && <span className="red mono-sm">{t('common.exceedsBalance')}</span>}
      </div>
      <div className="form-row">
        <span className="lbl">{t('zap.slip')}</span>
        {!showSlipEditor ? (
          <button
            className={`chip ${slipSummaryTone}`}
            onClick={() => setSlipOpen(true)}
            disabled={running}
            title={t('zap.slipHint', { band: depositBandBps / 100 })}
          >
            {slipSummary} ▾
          </button>
        ) : (
          <>
            <button
              className={`chip ${manualSlip === null && customSlip === '' ? 'on' : ''}`}
              onClick={() => {
                setManualSlip(null)
                setCustomSlip('')
              }}
              disabled={running}
            >
              AUTO {automaticSlippage ? `${automaticSlippage.bps / 100}%` : '—'}
            </button>
            {SLIPPAGE_CHOICES.map((b) => (
              <button
                key={b}
                className={`chip ${manualSlip === b && customSlip === '' ? 'on' : ''}`}
                onClick={() => {
                  setManualSlip(b)
                  setCustomSlip('')
                }}
                disabled={running}
              >
                {b / 100}%
              </button>
            ))}
            <NumInput
              value={customSlip}
              onChange={(v) => {
                setCustomSlip(v)
                setManualSlip(slippagePctToBps(v))
              }}
              disabled={running}
              placeholder={t('common.slipCustom')}
              width={96}
              invalid={customInvalid}
            />
            <span className="dim mono-sm">%</span>
            {customInvalid && <span className="red mono-sm">{t('common.slipInvalid')}</span>}
            {effectiveSlip !== undefined && (
              <span className={`${slippageTone(effectiveSlip)} mono-sm`}>→ {effectiveSlip / 100}%</span>
            )}
            {!slipForced && (
              <button className="chip" onClick={() => setSlipOpen(false)} disabled={running} title={t('zap.slipHint')}>
                ▴
              </button>
            )}
          </>
        )}
      </div>

      {amount > 0n && plan.isLoading && (
        <div className="dim mono-sm">
          {t('zap.solving', { home: CHAIN.labels.home })}
          <span className="spin">▮</span>
        </div>
      )}
      {amount > 0n && plan.isError && !running && (
        <div className="red mono-sm">{t('zap.cantPlan', { err: (plan.error as Error).message })}</div>
      )}

      {p && (
        <>
          <ZapFlow plan={p} tIn={tIn} t0={t0} t1={t1} slipBps={effectiveSlip} />
          {/* what stays behind is a number, not a caveat — it only prints when
              there IS dust, so the row's absence is the usual "none" */}
          {dusts.length > 0 && (
            <div className="dim mono-sm" title={t('zap.actualSd')}>
              {t('zap.dust', { dust: dusts.join(' + ') })}
            </div>
          )}
          <AddStats sim={sim} emitless={pool.protocol !== 'home'} />
          {bandWarn && <div className="amber mono-sm">!! {bandWarn}</div>}
        </>
      )}

      {planPaused && (
        <div className="form-row">
          <button
            className="chip amber"
            onClick={() => void plan.refetch()}
            title={t('zap.refreshTip', { s: ZAP_PLAN_REFRESH_MS / 1000, n: SOLVER_AUTO_REFRESHES })}
          >
            {plan.isFetching ? <span className="spin">▮</span> : `↻ ${t('zap.refreshPlan')}`}
          </button>
        </div>
      )}

      {stages.length > 0 && (
        <div className="zap-steps mono-sm">
          {stages.map((s, i) => {
            let state: 'todo' | 'done' | 'fail' | 'run' = 'todo'
            if (runAt && i < runAt.i) state = 'done'
            else if (runAt && i === runAt.i && failed) state = 'fail'
            else if (runAt && i === runAt.i && running) state = 'run'
            let mark = '·'
            if (state === 'done') mark = '✓'
            else if (state === 'run') mark = '▮'
            else if (state === 'fail') mark = '✗'
            return (
              <div key={i} className={`zstep ${state}`}>
                <span className="zn">{i + 1}</span>
                <span className="zm">{mark}</span>
                <span>{s.label}</span>
              </div>
            )
          })}
        </div>
      )}

      {failed && (
        <div className="red mono-sm">
          {runAt?.reason === 'slippage'
            ? t('zap.haltedSwap', {
                n: (runAt.i ?? 0) + 1,
                slip: (runAt.slip ?? 0) / 100,
                next: (automaticSlippage?.bps ?? retrySlippage(runAt.slip ?? 0)) / 100,
              })
            : runAt?.reason === 'deposit-moved'
              ? t('zap.haltedDeposit', { n: (runAt.i ?? 0) + 1, band: depositBandBps / 100 })
              : t('zap.halted', { n: (runAt?.i ?? 0) + 1 })}
        </div>
      )}
      {done && <div className="green mono-sm">{t('zap.done')}</div>}

      <div className="form-row">
        <Btn
          busy={running}
          tone={runTone}
          onClick={runClick}
          disabled={!user || amount === 0n || !plan.data || insufficient || slippageRequired || running}
          title={runTitle}
        >
          {runLabel}
        </Btn>
        {stakeable && <StakeAfterToggle disabled={running} />}
      </div>
    </div>
  )
}
