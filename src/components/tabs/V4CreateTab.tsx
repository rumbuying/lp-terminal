import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAccount } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { useQuery } from '@tanstack/react-query'
import { formatUnits, isAddress, parseUnits, type Address } from 'viem'
import { CHAIN } from '../../config/chains'
import { EXPLORER, NATIVE } from '../../config/addresses'
import { UNI_V4, v4PoolId } from '../../lib/uniV4'
import { fmtAmount, fmtNum } from '../../lib/format'
import { readTokenInfo } from '../../lib/tokenMeta'
import { publicRpcClient } from '../../lib/publicRpcClient'
import { useBalances } from '../../hooks/useBalances'
import { useArmedConfirm } from '../../hooks/useArmedConfirm'
import { AmountRow, Badge, Btn, NumInput } from '../ui'
import {
  createV4Pool,
  initialSqrtPriceX96,
  newPoolKey,
  previewAtInitPrice,
  priceTickInRange,
  probeTokenEthPrice,
  rangeTicks,
  tokenPerEthOf,
  v4PoolState,
  type CreateStep,
} from '../../lib/v4PoolCreate'

/**
 * The v4 pool-creation desk: one panel that walks a token from "an address on
 * the clipboard" to "a live pool with the wallet's seed liquidity in it".
 *
 * The flow mirrors lib/v4PoolCreate.ts: pick the pair (native is always
 * currency0), let the venue probe seed a starting price the user can override,
 * type both sides and a range, and the CREATE press runs approvals,
 * initialize and mint in order. Nothing here invents a parameter silently —
 * fee, spacing, price and range are all on screen before the arming press.
 */

/** a price seeded into the field, in plain digits (enough for a tick) */
function plainPrice(x: number): string {
  if (!Number.isFinite(x) || x <= 0) return ''
  let s = x.toPrecision(9)
  if (s.includes('e')) {
    const exp = Math.ceil(-Math.log10(x))
    s = x.toFixed(Math.min(exp + 9, 18))
  }
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

function parseDec(v: string): number | null {
  if (!/^\d*\.?\d+$/.test(v)) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const EMPTY_STATE = { initialized: false, sqrtPriceX96: 0n, tick: 0 }

export function V4CreateTab() {
  const { t } = useTranslation()
  const { address: user } = useAccount()
  const qc = useQueryClient()

  const [addrInput, setAddrInput] = useState('')
  const [feePct, setFeePct] = useState('2')
  const [tsInput, setTsInput] = useState('200')
  const [priceInput, setPriceInput] = useState('')
  const [priceDirty, setPriceDirty] = useState(false)
  const [amtEth, setAmtEth] = useState('')
  const [amtTok, setAmtTok] = useState('')
  const [fullRange, setFullRange] = useState(true)
  const [rangeMin, setRangeMin] = useState('')
  const [rangeMax, setRangeMax] = useState('')
  const [slipPct, setSlipPct] = useState('1')
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<CreateStep | null>(null)

  const addrOk = isAddress(addrInput)
  const token = addrOk ? (addrInput as Address) : null

  // a new address starts the form over — a stale price or range is a silent
  // poison the user stopped looking at paragraphs ago
  useEffect(() => {
    setPriceInput('')
    setPriceDirty(false)
    setAmtTok('')
    setRangeMin('')
    setRangeMax('')
  }, [addrInput])

  const tokenInfo = useQuery({
    queryKey: ['v4create.token', token],
    enabled: !!token,
    retry: false,
    staleTime: 300_000,
    queryFn: () => readTokenInfo(publicRpcClient, token!),
  })

  const feeNum = parseDec(feePct)
  const feePpm = feeNum !== null && feeNum > 0 && feeNum < 838.8608 ? Math.round(feeNum * 10_000) : null
  const tsNum = parseDec(tsInput)
  const tickSpacing = tsNum !== null && Number.isInteger(tsNum) && tsNum >= 1 && tsNum <= 2 ** 23 ? tsNum : null

  const key = useMemo(
    () => (token && tokenInfo.data && feePpm !== null && tickSpacing !== null ? newPoolKey(token, feePpm, tickSpacing) : null),
    [token, tokenInfo.data, feePpm, tickSpacing],
  )
  const poolId = key ? v4PoolId(key) : null

  const poolState = useQuery({
    queryKey: ['v4create.pool', poolId],
    enabled: !!poolId,
    retry: false,
    staleTime: 15_000,
    queryFn: () => v4PoolState(poolId!),
  })

  const dec = tokenInfo.data?.decimals ?? null
  const symbol = tokenInfo.data?.symbol ?? '…'
  const probe = useQuery({
    queryKey: ['v4create.probe', token, dec],
    enabled: !!token && dec !== null,
    retry: false,
    staleTime: 60_000,
    queryFn: () => probeTokenEthPrice(token!, dec!),
  })

  // the probe seeds the field once; after the user types, it never overwrites
  useEffect(() => {
    const p = probe.data?.ethPerToken
    if (p !== undefined && !priceDirty) setPriceInput(plainPrice(p))
  }, [probe.data, priceDirty])

  const balances = useBalances(user ?? undefined, token ? [NATIVE, token] : [NATIVE])
  const balEth = user ? (balances.data?.[NATIVE.toLowerCase()] ?? 0n) : 0n
  const balTok = user && token ? (balances.data?.[token.toLowerCase()] ?? 0n) : 0n

  const exists = poolState.data?.initialized ?? false
  const livePrice = exists && dec !== null ? tokenPerEthOf(poolState.data!.sqrtPriceX96, dec) : null

  // the write needs an init price even when the pool already exists (it is
  // only USED when this flow initializes) — the opening price fills that slot
  const initPrice = useMemo(() => {
    const p = parseDec(priceInput)
    if (p === null || p <= 0) return { ok: false as const, value: null }
    try {
      const v = initialSqrtPriceX96(p, dec ?? 18)
      return { ok: priceTickInRange(v.tick), value: v }
    } catch {
      return { ok: false as const, value: null }
    }
  }, [priceInput, dec])

  const amt0 = useMemo(() => {
    try {
      return amtEth ? parseUnits(amtEth, 18) : 0n
    } catch {
      return 0n
    }
  }, [amtEth])
  const amt1 = useMemo(() => {
    try {
      return amtTok && dec !== null ? parseUnits(amtTok, dec) : 0n
    } catch {
      return 0n
    }
  }, [amtTok, dec])

  const slipBps = useMemo(() => {
    const s = parseDec(slipPct)
    return s !== null && s >= 0 ? Math.min(Math.round(s * 100), 5_000) : null
  }, [slipPct])

  const ticks = useMemo(() => {
    if (tickSpacing === null || dec === null) return null
    const spec = fullRange
      ? ({ mode: 'full' } as const)
      : {
          mode: 'band' as const,
          priceMin: parseDec(rangeMin) ?? NaN,
          priceMax: parseDec(rangeMax) ?? NaN,
        }
    try {
      return rangeTicks(spec, tickSpacing, dec)
    } catch {
      return null
    }
  }, [fullRange, rangeMin, rangeMax, tickSpacing, dec])

  const preview = useMemo(() => {
    if (ticks === null || amt0 === 0n || amt1 === 0n || slipBps === null) return null
    const sqrtP = exists && poolState.data ? poolState.data.sqrtPriceX96 : initPrice.value?.sqrtPriceX96
    if (sqrtP === undefined || sqrtP === 0n) return null
    return previewAtInitPrice(sqrtP, ticks.lower, ticks.upper, amt0, amt1, slipBps)
  }, [ticks, amt0, amt1, slipBps, exists, poolState.data, initPrice.value])

  const gasAfter = balEth > amt0 ? balEth - amt0 : 0n
  const gasShort = amt0 > 0n && gasAfter < CHAIN.gasBuffer
  const tokShort = amt1 > balTok

  const rangeOutside = !fullRange && ticks !== null && initPrice.ok && initPrice.value !== null
    ? initPrice.value.tick <= ticks.lower || initPrice.value.tick >= ticks.upper
    : false

  const ready =
    !!user &&
    !!key &&
    !!ticks &&
    !!slipBps &&
    amt0 > 0n &&
    amt1 > 0n &&
    (exists || initPrice.ok) &&
    !!preview &&
    !busy &&
    !tokShort

  const txCount = exists ? 3 : 4 // approvals(≤2) + initialize? + mint
  const confirm = useArmedConfirm(
    `${user ?? ''}|${poolId ?? ''}|${priceInput}|${amtEth}|${amtTok}|${slipPct}|${fullRange ? 'f' : `${rangeMin}-${rangeMax}`}`,
  )

  const run = async () => {
    if (!user || !key || !ticks || slipBps === null || !preview) return
    setBusy(true)
    try {
      const ok = await createV4Pool({
        user,
        key,
        preState: poolState.data ?? EMPTY_STATE,
        // when the pool exists the init price is a formality — hand the write
        // whatever the field holds, it will not be used
        initPrice: initPrice.value ?? initialSqrtPriceX96(1, dec ?? 18),
        tickLower: ticks.lower,
        tickUpper: ticks.upper,
        amount0Max: amt0,
        amount1Max: amt1,
        slipBps,
        tokenSymbol: symbol,
        onStep: setStep,
      })
      if (ok) {
        confirm.disarm()
        void qc.invalidateQueries({ queryKey: ['v4create.pool', poolId] })
      }
    } finally {
      setBusy(false)
      setStep(null)
    }
  }

  const bandChip = (f: number) => {
    const p = exists ? livePrice : parseDec(priceInput)
    if (p === null || p === undefined || !(p > 0)) return
    setFullRange(false)
    setRangeMin(plainPrice(p * f))
    setRangeMax(plainPrice(p / f))
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <div className="section-title">{t('v4create.title')}</div>
          <div className="dim mono-sm">{t('v4create.subtitle', { native: CHAIN.nativeCurrency.symbol })}</div>
        </div>
        {!UNI_V4 && <Badge tone="red">{t('v4create.noV4')}</Badge>}
      </div>

      {/* ① the token */}
      <div className="form-row">
        <span className="lbl">{t('v4create.token')}</span>
        <input
          className="input"
          style={{ width: 420, fontFamily: 'monospace' }}
          placeholder="0x…"
          spellCheck={false}
          autoComplete="off"
          value={addrInput}
          onChange={(e) => setAddrInput(e.target.value.trim())}
        />
        {tokenInfo.isPending && <span className="dim mono-sm">{t('v4create.tokenResolve')}</span>}
        {token && !tokenInfo.isPending && !tokenInfo.data && (
          <Badge tone="red">{t('v4create.tokenBad')}</Badge>
        )}
        {tokenInfo.data && (
          <>
            <Badge tone="cyan">{tokenInfo.data.symbol}</Badge>
            <span className="dim mono-sm">{dec} dec</span>
          </>
        )}
      </div>

      {/* ② pool identity */}
      <div className="form-row">
        <span className="lbl">{t('v4create.fee')}</span>
        <NumInput value={feePct} onChange={setFeePct} decimals={4} width={90} invalid={feePpm === null} />
        <span className="dim mono-sm">{feePpm !== null ? `${(feePpm / 10_000).toFixed(2)}%` : t('v4create.feeBad')}</span>
        <span className="lbl">{t('v4create.ts')}</span>
        <NumInput value={tsInput} onChange={setTsInput} decimals={0} width={90} invalid={tickSpacing === null} />
        <span className="lbl">{t('v4create.hooks')}</span>
        <Badge tone="dim">{t('v4create.hooksOff')}</Badge>
      </div>

      {key && poolId && (
        <div className="form-row">
          <span className="lbl">{t('v4create.poolKey')}</span>
          <span className="mono-sm">
            ETH + {symbol} · {feePpm}ppm · ts{tickSpacing}
          </span>
          <Badge tone={exists ? 'amber' : 'green'}>{exists ? t('v4create.stateExists') : t('v4create.stateNew')}</Badge>
          <span className="dim mono-sm" title={poolId}>{poolId.slice(0, 10)}…</span>
          {exists && livePrice !== null && (
            <span className="mono-sm">{t('v4create.livePrice', { n: fmtNum(livePrice), tok: symbol })}</span>
          )}
        </div>
      )}

      {/* ③ starting price */}
      {!exists && (
        <div className="form-row">
          <span className="lbl">{t('v4create.price', { tok: symbol })}</span>
          <NumInput
            value={priceInput}
            onChange={(v) => {
              setPriceInput(v)
              setPriceDirty(true)
            }}
            disabled={dec === null}
            width={220}
            invalid={priceInput !== '' && !initPrice.ok}
          />
          <button
            className="chip"
            disabled={!probe.isEnabled || probe.isFetching}
            onClick={() => void probe.refetch()}
            title={probe.data ? t('v4create.priceSource', { src: probe.data.source }) : undefined}
          >
            {probe.isFetching ? '…' : t('v4create.priceProbe')}
          </button>
          {probe.data && (
            <span className="dim mono-sm">{t('v4create.priceSource', { src: probe.data.source })}</span>
          )}
          {probe.data === null && !probe.isFetching && probe.isFetched && (
            <span className="amber mono-sm">{t('v4create.priceNone')}</span>
          )}
          {initPrice.ok && initPrice.value !== null && dec !== null && (
            <span className="dim mono-sm">
              {t('v4create.priceImplied', { amt: fmtNum(1 / parseDec(priceInput)!, 6), n: fmtNum(parseDec(priceInput)!) })}
            </span>
          )}
        </div>
      )}

      {/* ④ amounts */}
      <div className="form-row">
        <span className="lbl">{t('v4create.amounts')}</span>
      </div>
      <AmountRow
        sym={`${CHAIN.nativeCurrency.symbol} (currency0)`}
        value={amtEth}
        onChange={setAmtEth}
        bal={user ? balEth : undefined}
        dec={18}
        onMax={() => setAmtEth(formatUnits(balEth > CHAIN.gasBuffer ? balEth - CHAIN.gasBuffer : 0n, 18))}
        maxTip={t('v4create.maxGasTip', { native: CHAIN.nativeCurrency.symbol })}
      />
      <AmountRow
        sym={`${symbol} (currency1)`}
        value={amtTok}
        onChange={setAmtTok}
        bal={user && token ? balTok : undefined}
        dec={dec ?? 18}
        onMax={(v) => setAmtTok(v)}
        disabled={dec === null}
        note={tokShort ? t('common.exceedsBalance') : undefined}
      />
      {gasShort && <div className="amber mono-sm">{t('v4create.gasWarn', { native: CHAIN.nativeCurrency.symbol })}</div>}

      {/* ⑤ range */}
      <div className="form-row">
        <span className="lbl">{t('v4create.range')}</span>
        <button className={`chip ${fullRange ? 'active' : ''}`} onClick={() => setFullRange(true)}>
          {t('v4create.rangeFull')}
        </button>
        <button className={`chip ${!fullRange ? 'active' : ''}`} onClick={() => setFullRange(false)}>
          {t('v4create.rangeBand')}
        </button>
        {!fullRange && (
          <>
            <NumInput
              value={rangeMin}
              onChange={setRangeMin}
              decimals={18}
              width={170}
              placeholder={`${symbol}/ETH min`}
              disabled={dec === null}
            />
            <span className="dim">—</span>
            <NumInput
              value={rangeMax}
              onChange={setRangeMax}
              decimals={18}
              width={170}
              placeholder={`${symbol}/ETH max`}
              disabled={dec === null}
            />
            {ticks && (
              <span className="dim mono-sm">
                [{ticks.lower}, {ticks.upper}]
              </span>
            )}
          </>
        )}
        {(exists ? livePrice !== null : priceInput !== '' && initPrice.ok) && (
          <>
            {[0.25, 0.5, 2, 4].map((f) => (
              <button key={f} className="chip" onClick={() => bandChip(f)} title={t('v4create.bandTip')}>
                ×{f < 1 ? 1 / f : f}
              </button>
            ))}
          </>
        )}
      </div>
      {rangeOutside && <div className="amber mono-sm">{t('v4create.rangeOutside')}</div>}

      {/* ⑥ slippage */}
      <div className="form-row">
        <span className="lbl">{t('v4create.slip')}</span>
        <NumInput value={slipPct} onChange={setSlipPct} decimals={2} width={90} invalid={slipBps === null} />
        <span className="dim mono-sm">{t('v4create.slipNote', { native: CHAIN.nativeCurrency.symbol })}</span>
      </div>

      {/* ⑦ preview */}
      {preview && ticks && dec !== null && (
        <div className="grid2">
          <div className="stat">
            <div className="k">{t('v4create.dep')}</div>
            <div className="v">
              {fmtAmount(preview.amount0, 18)} {CHAIN.nativeCurrency.symbol} + {fmtAmount(preview.amount1, dec)} {symbol}
            </div>
            <div className="sub">{t('v4create.refund')}</div>
          </div>
          <div className="stat">
            <div className="k">{t('v4create.liq')}</div>
            <div className="v mono-sm" style={{ fontSize: '0.92em' }}>{preview.liquidity.toString()}</div>
            <div className="sub">
              [{ticks.lower}, {ticks.upper}] · {exists ? t('v4create.atLive') : t('v4create.atOpen')}
            </div>
          </div>
        </div>
      )}

      {/* ⑧ create */}
      <div className="form-row">
        {!user ? (
          <Btn disabled>{t('v4create.connect')}</Btn>
        ) : (
          <Btn
            big
            busy={busy}
            disabled={!ready || busy}
            onClick={() => (confirm.armed ? void run() : confirm.arm())}
            tone={confirm.armed ? 'danger' : 'default'}
          >
            {confirm.armed ? t('v4create.confirm', { n: txCount }) : t('v4create.create')}
          </Btn>
        )}
        {busy && step && (
          <span className="mono-sm">
            {([
              ['approve', t('v4create.stepApprove')],
              ['initialize', t('v4create.stepInitialize')],
              ['mint', t('v4create.stepMint')],
            ] as const)
              .filter(([s]) => s !== 'initialize' || !exists)
              .map(([s, label]) => (
                <Badge key={s} tone={step === s ? 'cyan' : 'dim'}>
                  {label}
                </Badge>
              ))}
          </span>
        )}
      </div>
      <div className="dim mono-sm">
        <a href={`${EXPLORER}/address/${UNI_V4?.POOL_MANAGER}`} target="_blank" rel="noreferrer">
          PoolManager
        </a>{' '}
        ·{' '}
        <a href={`${EXPLORER}/address/${UNI_V4?.POSITION_MANAGER}`} target="_blank" rel="noreferrer">
          PositionManager
        </a>
      </div>
    </div>
  )
}
