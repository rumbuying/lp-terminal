import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useAccount } from 'wagmi'
import { writeContract } from 'wagmi/actions'
import { formatUnits, parseUnits, type Address, type Hex, type ReplacementReason } from 'viem'
import { wethAbi } from '../../abi'
import { ADDR, CHAIN_ID, DEFAULT_BUY, EXPLORER, GOV } from '../../config/addresses'
import { CHAIN } from '../../config/chains'
import { ENV } from '../../config/env'
import { FEATURES } from '../../config/features'
import { wagmiConfig } from '../../config/wagmi'
import { useBalances } from '../../hooks/useBalances'
import { useArmedConfirm } from '../../hooks/useArmedConfirm'
import { useHeldHeight } from '../../hooks/useHeldHeight'
import { usePendingSwaps } from '../../hooks/usePendingSwaps'
import { DIRECT_QUOTE_REFRESH_MS, useDirectQuote, useSolverQuote } from '../../hooks/useQuotes'
import { useTokenList } from '../../hooks/useTokenList'
import { useTokenUsd } from '../../hooks/useTokenUsd'
import { useStockIssuerPair } from '../../hooks/useStockIssuers'
import { applySlippage } from '../../lib/clmath'
import {
  directRouteFeePpm,
  directRouteLabel,
  type DirectCandidate,
  type DirectProtocol,
} from '../../lib/directSwap'
import { bpsDiff, fmtAmount, fmtNum, fmtUsd, sanitizeAmountInput, shortAddr } from '../../lib/format'
import { isSameUnresolvedSwap, isSettled, pendingSwaps } from '../../lib/pendingSwaps'
import { certificateDisplay, solverRouteLabel, type SolverQuote } from '../../lib/solver'
import { selectUsableQuoteData, solverQuoteNeedsManualRefresh } from '../../lib/solverRefresh'
import { executeSolverSwap, executeSwap, SlippageError } from '../../lib/swapExec'
import { swapSubmissionKey, swapSubmissions } from '../../lib/swapSubmissions'
import {
  allInCostBps,
  autoSlippage,
  needsSlippageConfirm,
  retrySlippage,
  slippagePctToBps,
  slippageTone,
  SLIPPAGE_CHOICES,
  type AutoSlippage,
} from '../../lib/swapGate'
import { peekSwapIntent, takeSwapIntent } from '../../lib/swapIntent'
import { defaultSwapOutput, spendSideFor, NATIVE_TOKEN, STABLE_TOKEN } from '../../lib/swapTokens'
import { step, type StepFailWhy } from '../../lib/tx'
import { txlog } from '../../lib/txlog'
import type { TokenInfo } from '../../types'
import { Flash } from '../Flash'
import { RouteMap } from '../RouteMap'
import { SquatBadge, StockBadge } from '../TokenIdentity'
import { TokenSelect } from '../TokenSelect'
import { Badge, Btn, NumInput } from '../ui'

// native units withheld from a MAX so the next transaction can still pay gas
const GAS_BUFFER = CHAIN.gasBuffer

type SlippageChoice = 'auto' | number // bps; a preset chip or the typed custom value
type SwapSource = 'solver' | DirectProtocol

// Token choices survive top-level tab unmounts, but intentionally not reloads.
let rememberedTokenIn: TokenInfo | null = null
let rememberedTokenOut: TokenInfo | null = null
// True only while both sides are still the config-declared pair the form opens
// on before any catalog has answered. Every other way a side gets decided — a
// pick, a clicked market, a swap intent — clears it, so the upgrade to the
// chain's default market never lands on a choice somebody made.
let seededPair = false

function routeDetail(candidate: DirectCandidate): string {
  const label = directRouteLabel(candidate.route)
  // a tick-spacing-keyed pool is not identified by its fee alone, so the label
  // carries the spacing; a fee-keyed one already is
  if (candidate.route.kind === 'cl' && candidate.route.keyedBy === 'tickSpacing')
    return `${label} · ts${candidate.route.tickSpacing}`
  return label
}

/** The quote's optimality-certificate chip: a PROVEN ≤x bp claim when the
 *  certified gap is tight, a neutral numberless chip when it is not, nothing
 *  when there is no certificate worth reading. Loose bounds never print their
 *  number — it measures the certificate search stalling, not the route. */
function CertificateBadge({ quote }: { quote: SolverQuote }) {
  const { t } = useTranslation()
  const cert = certificateDisplay(quote)
  if (!cert) return null
  const proven = cert.kind === 'proven'
  const pools = cert.scannedPools ?? '?'
  const block = quote.routeUniverse?.canonicalBlock.number ?? quote.block
  return (
    <span
      className={`hint mono-sm ${proven ? 'green' : 'dim'}`}
      data-tip={proven
        ? t('swap.certProvenTip', { bps: cert.gapBpsLabel, pools, block })
        : t('swap.certifiedTip', { pools, block })}
    >
      ◆ {proven ? t('swap.certProven', { bps: cert.gapBpsLabel }) : t('swap.certCertified')}
    </span>
  )
}

/**
 * The swap form, standalone or embedded beside a market.
 *
 * `market` is the POOLS page pointing at a row: buy THIS token, and open the
 * spend side on the chain's own coin. It is passed as a whole TokenInfo rather
 * than an address on purpose — a token minted by the launchpad an hour ago is
 * in no catalog yet, so the discovered list cannot be asked to describe it, and
 * a market that cannot be named is a market that cannot be traded.
 *
 * Embedding changes nothing about how the trade is priced. The panel quotes and
 * executes through the same solver and the same direct venues the full tab
 * does, and the pool that was clicked is not privileged in the route: it named
 * the market, and the router still decides where the size actually goes.
 */
export function SwapTab(props: { market?: TokenInfo | null; embedded?: boolean } = {}) {
  const { t } = useTranslation()
  // autoFocus is a desktop courtesy; on a touch device it summons the keyboard
  // the moment the tab opens, which pushes the fixed tab bar up onto the form
  const autoFocusAmt =
    typeof window !== 'undefined' && !window.matchMedia('(pointer: coarse)').matches
  const { address: user } = useAccount()
  const { openConnectModal } = useConnectModal()
  const tokenList = useTokenList()
  const list = tokenList.tokens

  const [tIn, setTInState] = useState<TokenInfo | null>(rememberedTokenIn)
  const [tOut, setTOutState] = useState<TokenInfo | null>(rememberedTokenOut)
  // Named up here rather than beside the cards that render it: the cards sit
  // past an early return, and this is the one screen where "which TSLA is this"
  // is about to become an irreversible transaction. The native coin is never an
  // equity, so it is not worth two reads to confirm it.
  const [issuerIn, issuerOut] = useStockIssuerPair(
    tIn && !tIn.native ? tIn.address : undefined,
    tOut && !tOut.native ? tOut.address : undefined,
  )
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
    seededPair = false
    setTInState(token)
  }
  const setTOut = (token: TokenInfo | null) => {
    rememberedTokenOut = token
    seededPair = false
    setTOutState(token)
  }

  // The clicked market decides both sides at once, and re-decides them whenever
  // the selection moves. Keyed on the ADDRESS rather than the object: the row
  // rebuilds its TokenInfo on every catalog refresh, and re-running this on
  // identity would keep resetting a form the user is typing into.
  const marketKey = props.market?.address.toLowerCase() ?? ''
  useEffect(() => {
    const buy = props.market
    if (!buy) return
    setTOut(buy)
    setTIn(spendSideFor(buy))
    setAmtStr('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketKey])

  // What the two boxes open on.
  //
  // The token list is derived from the pool catalogs, so it answers only once
  // discovery is complete — measured at 1,226ms of empty panel on a warm load,
  // spent establishing what to put in two boxes. The chain's own coin and its
  // dollar are declared in the chain config and cross-checked on-chain by
  // scripts/chain-check, so they can be named with no discovery at all, and
  // seeding them turns that second into a form somebody can already type into.
  // The seed costs no network: quoting needs an amount, and there is none yet.
  //
  // The chain's default market is pinned by ADDRESS and carries no symbol or
  // decimals of its own, so it can only arrive with the catalog. It replaces
  // the seed when it does, and only while the seed is still what is on screen.
  useEffect(() => {
    if (!list.length) {
      if (!tIn && !tOut) {
        setTIn(NATIVE_TOKEN)
        setTOut(STABLE_TOKEN)
        seededPair = true
      }
      return
    }
    const intent = peekSwapIntent()
    if (intent) {
      const input = list.find((token) => token.address.toLowerCase() === intent.tokenIn.toLowerCase())
      const output = list.find((token) => token.address.toLowerCase() === intent.tokenOut.toLowerCase())
      if (input && output) {
        takeSwapIntent()
        setTIn(input)
        setTOut(output)
        setAmtStr(formatUnits(intent.amount, input.decimals))
        return
      }
    }
    // read before the setters below, both of which clear it
    const seeded = seededPair
    const discoveredNative = list.find((token) => token.native)
    const input = (seeded ? discoveredNative : null) ?? tIn ?? discoveredNative ?? list[0]
    if (input !== tIn) setTIn(input)
    if (!tOut || seeded) {
      const buy = defaultSwapOutput(
        list,
        input,
        [DEFAULT_BUY, ...(GOV ? [GOV.UP] : []), ADDR.STABLE, ADDR.WNATIVE],
      )
      if (buy) setTOut(buy)
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
  const isWrap = !!tIn?.native && tOut?.address.toLowerCase() === ADDR.WNATIVE.toLowerCase()
  const isUnwrap = !!tOut?.native && tIn?.address.toLowerCase() === ADDR.WNATIVE.toLowerCase()
  const quote = useDirectQuote(tIn?.address, tOut?.address, amount)
  const solver = useSolverQuote(tIn?.address, tOut?.address, amount, user)
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
  const directNeedsManualRefresh = solverQuoteNeedsManualRefresh(
    quote.autoRefreshExhausted,
    directData != null,
  )
  const bestDirect = directData?.best ?? null
  const automaticProtocol = bestDirect?.route.protocol ?? null
  // the solver routes across every venue with splits, so it wins whenever it
  // answers; the direct venues stay live as comparison rows and fallback
  const automaticSource: SwapSource | null =
    solverData && (!bestDirect || solverData.quote.amountOutNet >= bestDirect.amountOut)
      ? 'solver'
      : automaticProtocol
  const overrideAvailable =
    override === 'solver'
      ? solverData !== null
      : override !== null && directData?.byProtocol[override] != null
  const selectedSource = overrideAvailable ? override : automaticSource
  const solverSel = selectedSource === 'solver' ? solverData : null
  const selected =
    selectedSource && selectedSource !== 'solver' ? directData?.byProtocol[selectedSource] ?? null : null
  // one shape for the details section, whichever kind is selected
  const outAmount = solverSel ? solverSel.quote.amountOutNet : selected?.amountOut ?? null
  const selImpactBps = solverSel ? solverSel.impactBps : selected?.impactBps ?? null
  const selVenueFeeBps = solverSel
    ? solverSel.venueFeeBps
    : selected
      ? directRouteFeePpm(selected.route) / 100
      : null
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
  // Withholding a stale quote empties the panel until the next answer lands:
  // the solver card loses its route map, the details list loses five rows. Each
  // box that empties keeps the height it had, so everything below it — and the
  // SWAP button under all of it — holds still. The SPACE is held; the withheld
  // numbers stay withheld.
  const quotesSettling = solver.isFetching || quote.isFetching || hasStaleData
  const solverHold = useHeldHeight(quotesSettling, tradeSig)
  const detailsHold = useHeldHeight(quotesSettling, tradeSig)
  // A tolerance this wide is signed into the calldata and never asked about
  // again, so the button asks first. The arming is held against the tolerance as
  // well as the trade: AUTO moves with each quote, and a yes given at 11% has
  // said nothing about the 26% the next refresh may derive.
  const wideSlippage = needsSlippageConfirm(effectiveSlippage)
  const swapConfirm = useArmedConfirm(`${tradeSig}|${effectiveSlippage ?? ''}`)

  // 1s ticker driving the quote-refresh countdown (only while a quote is live)
  const ticking = amount > 0n && !isWrap && !isUnwrap
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
      step(
        t('swap.stWrap', { amt: amtStr }),
        () =>
          writeContract(wagmiConfig, {
            abi: wethAbi,
            address: ADDR.WNATIVE,
            functionName: 'deposit',
            value: amount,
            chainId: CHAIN_ID,
          }),
        { invalidate: 'balances' },
      ),
    )

  const doUnwrap = () =>
    run(() =>
      step(
        t('swap.stUnwrap', { amt: amtStr }),
        () =>
          writeContract(wagmiConfig, {
            abi: wethAbi,
            address: ADDR.WNATIVE,
            functionName: 'withdraw',
            args: [amount],
            chainId: CHAIN_ID,
          }),
        { invalidate: 'balances' },
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
      // A trade that reverted on chain is the same measurement as one halted
      // before signing: the tolerance that was signed did not survive to the
      // block it landed in. Both raise the AUTO floor and re-quote, so the retry
      // is offered live numbers and a tolerance that has not already failed —
      // the ZAP panel has treated a reverted swap leg this way since it shipped.
      let stepWhy: StepFailWhy | null = null
      const onStepFail = (why: StepFailWhy) => {
        stepWhy = why
      }
      // Skip once the user has moved on to another trade, and only ever raise.
      const raiseFloorAndRequote = () => {
        if (tradeSigRef.current !== tradeSig) return
        setSlipFloor((prev) => Math.max(prev ?? 0, retrySlippage(effectiveSlippage)))
        void quote.refetch()
        void solver.refetch()
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
            onStepFail,
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
            onStepFail,
          })
        } else return
        // flip the pending row to confirmed at once on the happy path — don't
        // leave it (and the "SWAP PENDING" button) waiting on the poller's next
        // tick; usePendingSwaps still settles reloaded/reverted/stale entries
        if (result) pendingSwaps.settle(result.receipt.transactionHash, 'confirmed')
        // ignore a settlement whose trade the user has already moved past
        if (result && tradeSigRef.current === tradeSig) setSlipFloor(null) // a fill clears the floor
        // it reached the chain and the chain refused it — the min-out baked into
        // the calldata is what it was refused against
        if (!result && stepWhy === 'reverted') raiseFloorAndRequote()
      } catch (error) {
        // halted before signing, on a re-quote already below the floor
        if (error instanceof SlippageError) raiseFloorAndRequote()
        txlog.push('err', (error as Error).message)
      }
    })

  // Page meta, right-aligned: which chain this terminal trades on. Embedded, the
  // panel sits inside a page that already says so at the top of its market list.
  //
  // hide-m, because a phone says it twice: the header's chain switcher is on
  // screen at all times and names the same chain, and this row was 48px of the
  // swap tab's top edge repeating it.
  const modeRow = props.embedded ? null : (
    <div
      className="form-row hide-m"
      style={{ marginBottom: 10, justifyContent: 'flex-end' }}
    >
      <span className="chain-tag" title={t('swap.chainTip', { chain: CHAIN.name, id: CHAIN_ID })}>
        <span className="dot" />
        {CHAIN.name}
      </span>
    </div>
  )
  // standalone the form is a centred column; embedded it fills the pane it was
  // given, and the market list beside it owns the width
  const boxCls = `swap-box ${props.embedded ? 'embedded' : 'narrow'}`

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
          {t('swap.homeRegistryFailed', { err: tokenList.up33Error.message.slice(0, 90) })}
        </div>
      )}
    </>
  )

  if (!tIn || !tOut) {
    return (
      <div className={boxCls}>
        {modeRow}
        {tokenListNotices}
        <div className={tokenList.loading ? 'dim' : 'red'}>
          {t(tokenList.loading ? 'swap.loadingTokens' : 'swap.tokenListUnavailable')}
        </div>
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
    const buffer = pct === 100n && tIn.native ? GAS_BUFFER : 0n
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
  // the countdown promises an automatic refresh, so it only runs while the
  // budget still has one; exhausted quotes show "—" until the button is pressed
  const nextIn = directData && quote.dataUpdatedAt && !quote.autoRefreshExhausted
    ? Math.max(0, Math.ceil((quote.dataUpdatedAt + DIRECT_QUOTE_REFRESH_MS - now) / 1000))
    : null

  const protocolRows: { protocol: DirectProtocol; label: string }[] = [
    { protocol: 'uniswap', label: t('swap.uniswapDirect') },
    // one row per venue, not per pool family: the best of that venue's legs
    // (CL, v2, …) is what the row shows, and the label names the venue
    { protocol: 'home', label: t('swap.homeDirect', { venue: CHAIN.labels.home.toUpperCase() }) },
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
        <span className="side-id">
          <span className="side-lbl">{t('swap.sell')}</span>
          {issuerIn && <StockBadge issuer={issuerIn} />}
        </span>
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
          autoFocus={autoFocusAmt}
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
                title={pct === 100n && tIn.native ? t('common.maxGasTip', {
                        amt: fmtAmount(GAS_BUFFER, CHAIN.nativeCurrency.decimals),
                        sym: CHAIN.nativeCurrency.symbol,
                      }) : undefined}
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
        <span className="side-id">
          <span className="side-lbl">{t('swap.buy')}</span>
          {issuerOut && <StockBadge issuer={issuerOut} />}
        </span>
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
      <div className={boxCls}>
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
              <span className="v dim">{t('swap.wrapNote', { addr: shortAddr(ADDR.WNATIVE) })}</span>
            </div>
          </div>
          {pendingBanner}
          <div className="swap-cta">
            <Btn
              big
              busy={submitting}
              disabled={!!user && (amount === 0n || insufficient)}
              onClick={!user ? () => openConnectModal?.() : isWrap ? doWrap : doUnwrap}
            >
              {cta}
            </Btn>
          </div>
        </div>
      </div>
    )
  }

  // ---- market swap ----
  const quotesNeedRefresh =
    outAmount == null && (solverNeedsManualRefresh || directNeedsManualRefresh || hasStaleData)
  const refreshQuotes = () => {
    void quote.refetch()
    void solver.refetch()
  }
  let cta = t('swap.noRoute')
  let ctaTone: 'amber' | 'danger' | undefined
  let ctaTitle: string | undefined
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
    ctaTone = 'amber'
    ctaDisabled = false
    refreshCta = true
  } else if (outAmount == null && (quote.isFetching || solver.isFetching)) cta = t('swap.ctaQuoting')
  else if (outAmount != null && effectiveSlippage === undefined) cta = t('swap.chooseSlippage')
  else if (outAmount != null && effectiveSlippage !== undefined) {
    ctaDisabled = false
    if (swapConfirm.armed) {
      // the armed press names the tolerance it is about to sign, so what is
      // being agreed to is on the button rather than in the user's memory
      cta = t('swap.ctaConfirmSlip', { pct: effectiveSlippage / 100 })
      ctaTone = 'danger'
      ctaTitle = t('swap.ctaConfirmSlipTip', {
        pct: effectiveSlippage / 100,
        min: fmtAmount(applySlippage(outAmount, effectiveSlippage), tOut.decimals),
        sym: tOut.symbol,
      })
    } else cta = t('swap.execVia', { route: solverSel ? t('swap.solverRoute') : selectedRoute })
  }

  // first press arms, second signs — and any press once the tolerance is back
  // inside the band goes straight through, with nothing left armed behind it
  const swapClick = () => {
    if (wideSlippage && !swapConfirm.armed) {
      swapConfirm.arm()
      return
    }
    swapConfirm.disarm()
    void doSwap()
  }

  return (
    <div className={boxCls}>
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
            {/* The cards answer ONE question — which venue — so they carry the
                output, the shortfall against the best of them, and the route
                that produced it. Cost and the optimality certificate describe
                the trade rather than the choice between venues, and they say it
                once, in DETAILS below. */}
            {FEATURES.solver && (() => {
              const q = solverData?.quote ?? null
              const isSel = selectedSource === 'solver'
              const behindBest =
                q && bestNet !== null && automaticSource !== 'solver' ? bpsDiff(q.amountOutNet, bestNet) / 100 : null
              return (
                <button
                  type="button"
                  aria-pressed={isSel}
                  className={`quote-card ${isSel ? 'sel' : ''}`}
                  ref={solverHold.ref}
                  style={solverHold.style}
                  onClick={() => {
                    if (q) setOverride('solver')
                  }}
                >
                  <div className="l1">
                    <span className="src">
                      {isSel ? '◉' : '○'} {t('swap.solverRoute')}
                    </span>
                    {solver.isError ? (
                      <span className="qstate red mono-sm">{t('swap.solverDown')}</span>
                    ) : q ? null : solver.isFetching ? (
                      // the solver reaches an answer seconds after the direct
                      // venues do, and a bare cursor for that long reads as a
                      // card that failed rather than one still working
                      <span className="qstate dim mono-sm">
                        <span className="spin">▮</span> {t('swap.solverSearching')}
                      </span>
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
                  {q && <RouteMap route={q.route} tokens={tokenList.tokens} />}
                </button>
              )
            })()}
            {protocolRows.map(({ protocol, label }) => {
              const candidate = directData?.byProtocol[protocol] ?? null
              const status = directData?.status[protocol]
              const isSel = selectedSource === protocol
              let state: JSX.Element | null = <span className="qstate dim mono-sm">{t('swap.noDirectPool')}</span>
              if (quote.isError) state = <span className="qstate dim">—</span>
              else if (quote.isFetching && !directData) state = <span className="qstate spin">▮</span>
              else if (protocol === 'home' && tokenList.up33Loading) state = <span className="qstate spin">▮</span>
              else if (status === 'failed') state = <span className="qstate red mono-sm">{t('swap.quoteFailed')}</span>
              else if (candidate) state = null
              // shortfall vs the best route, in the reference-UI style (-1.76%)
              const behindBest =
                candidate && bestNet !== null && automaticSource !== protocol
                  ? bpsDiff(candidate.amountOut, bestNet) / 100
                  : null
              return (
                <button
                  type="button"
                  key={protocol}
                  aria-pressed={isSel}
                  className={`quote-card ${isSel ? 'sel' : ''}`}
                  onClick={() => {
                    if (candidate) setOverride(protocol)
                  }}
                >
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
                  {/* Always drawn: this row is one line whether or not the
                      route is known, and a line that comes and goes is 16px of
                      the panel moving under a card somebody is about to press.
                      The placeholder is U+00A0 — a plain space collapses and
                      takes the line box with it. */}
                  <div className="l2">
                    <span>{candidate ? routeDetail(candidate) : ' '}</span>
                  </div>
                </button>
              )
            })}

            <div className="section-title">{t('swap.details')}</div>
            <div className="kv-list" ref={detailsHold.ref} style={detailsHold.style}>
              {rate !== undefined && (
                <button
                  type="button"
                  className="kv click"
                  onClick={() => setInvRate(!invRate)}
                  title={t('swap.rateTip')}
                >
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
                </button>
              )}
              <button
                type="button"
                className="kv click"
                aria-expanded={slipExpanded}
                onClick={() => setSlipOpen(!slipOpen)}
              >
                <span className="k">{t('swap.slippage')}</span>
                <span className="fill" />
                <span className={`v ${slipTone}`}>
                  {slipValue} <span className="dim">{slipExpanded ? '▴' : '▾'}</span>
                </span>
              </button>
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
                  {solverSel && certificateDisplay(solverSel.quote) && (
                    <div className="kv">
                      <span className="k">{t('swap.kOptimality')}</span>
                      <span className="fill" />
                      <span className="v">
                        <CertificateBadge quote={solverSel.quote} />
                      </span>
                    </div>
                  )}
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
            tone={ctaTone}
            title={ctaTitle}
            // a submitted trade shows "SWAP PENDING" text (not a spinner); the
            // banner above carries the live status + explorer link
            busy={!tradePending && (submitting || (refreshCta && (solver.isFetching || quote.isFetching)))}
            disabled={ctaDisabled}
            onClick={!user ? () => openConnectModal?.() : refreshCta ? refreshQuotes : swapClick}
          >
            {cta}
          </Btn>
        </div>
      </div>
    </div>
  )
}
