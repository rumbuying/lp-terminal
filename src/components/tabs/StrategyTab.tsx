import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAccount } from 'wagmi'
import { formatUnits, type Address } from 'viem'
import { originalStrategyDraft, recommendedSafeguards } from '../../../shared/strategy/schema'
import { simulateStrategy } from '../../../shared/strategy/simulator'
import { makeRebalancePlan } from '../../../shared/strategy/planner'
import { scaledRangePcts } from '../../../shared/strategy/adaptive-range'
import { strategyName } from '../../../shared/strategy/name'
import type { StrategyConfig, StrategyExecutionPlan } from '../../../shared/strategy/types'
import { ADDR, CHAIN_ID } from '../../config/addresses'
import { CHAIN } from '../../config/chains'
import { positionManagerFor, strategyProtocolFor } from '../../config/networks'
import { usePositions } from '../../hooks/usePositions'
import { usePools } from '../../hooks/usePools'
import { useExecutorWalletAuth } from '../../hooks/useExecutorWalletAuth'
import { usePnlUnit } from '../../hooks/usePnlUnit'
import { tokenUsdMapOf, useTokenPrices } from '../../hooks/useTokenPrices'
import { loadStrategies, removeStrategy, syncStrategyArchiveState, upsertStrategy } from '../../lib/strategyStore'
import { snapshotFromPosition } from '../../lib/strategyPlanner'
import { strategyDisplayValue, strategyStableValue } from '../../lib/strategyValuation'
import {
  executorHealth,
  executorAdminTokenStorageKey,
  executorPerformance,
  executorPnlCalendar,
  executorPnlCurve,
  executorRecovery,
  executorStrategies,
  executorWallets,
  deleteExecutorStrategy,
  importExecutorWallet,
  renameExecutorWallet,
  resumeExecutorMonitoring,
  resumeExecutorRecovery,
  executeExecutorStrategy,
  planExecutorStrategy,
  saveExecutorStrategy,
  setExecutorEmergencyPause,
  startSimpleExecutorStrategy,
  withdrawExecutorProfit,
  type ExecutorStrategy,
  type ExecutorCalendarRow,
  type ExecutorPerformance,
  type ExecutorPnlCurvePoint,
  type ExecutorPreflight,
  type ExecutorWallet,
  type RecoveryJob,
} from '../../lib/executorClient'
import { Badge, Btn, NumInput } from '../ui'
import { StrategyEditor } from '../strategy/StrategyEditor'
import { StrategyPnlCurve } from '../strategy/StrategyPnlCurve'
import { PnlUnitToggle } from '../PnlUnitToggle'
import { mergePnlCurveSnapshots } from '../../lib/pnlCurve'
import { dailyCycleTotals, weightedDailyReturnPct } from '../../lib/strategyOverview'
import { shanghaiDay } from '../../../shared/strategy/calendar'
import { fmtNum } from '../../lib/format'

const ACTIVE_EXECUTOR_STATES = new Set(['planned', 'executing', 'monitoring', 'guard_wait', 'recovery', 'recovery_quarantined', 'paused_guard', 'awaiting_manual'])
const PNL_CURVE_WINDOW_SECONDS = 30 * 24 * 60 * 60

const savedExecutorAdminToken = () => {
  if (typeof window === 'undefined') return ''
  try { return window.localStorage.getItem(executorAdminTokenStorageKey())?.trim() ?? '' } catch { return '' }
}

const number = (s: string, fallback: number) => {
  const n = Number(s)
  return Number.isFinite(n) ? n : fallback
}

const compactNumber = (value: number, digits = 2) => new Intl.NumberFormat(undefined, {
  maximumFractionDigits: digits,
}).format(value)

export function StrategyTab() {
  const { t } = useTranslation()
  const [pnlUnit] = usePnlUnit()
  const { address: user } = useAccount()
  // Creating from a newly minted NFT is not latency-sensitive. Do not keep the
  // full UP33 catalog and every wallet position on the executor's fast cadence.
  const positions = usePositions(user)
  const pools = usePools()
  const [items, setItems] = useState<StrategyConfig[]>(() => loadStrategies())
  const [endMove, setEndMove] = useState('-30')
  const [apr, setApr] = useState('8000')
  const [lower, setLower] = useState('5')
  const [upper, setUpper] = useState('5')
  const [plan, setPlan] = useState<StrategyExecutionPlan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [adminToken, setAdminToken] = useState(savedExecutorAdminToken)
  const [authRole, setAuthRole] = useState<'none' | 'wallet' | 'admin'>('none')
  const walletAuth = useExecutorWalletAuth(user, authRole === 'wallet' || (authRole === 'none' && !adminToken.trim()))
  const accessToken = authRole === 'admin' ? adminToken.trim() : walletAuth.token
  const [privateKey, setPrivateKey] = useState('')
  const [accountLabel, setAccountLabel] = useState('')
  const [executorOnline, setExecutorOnline] = useState(false)
  const [executorPaused, setExecutorPaused] = useState(false)
  const [executorWalletList, setExecutorWalletList] = useState<ExecutorWallet[]>([])
  const [executorStrategyList, setExecutorStrategyList] = useState<ExecutorStrategy[]>([])
  const [executorPerformanceList, setExecutorPerformanceList] = useState<ExecutorPerformance[]>([])
  const [executorCalendarRows, setExecutorCalendarRows] = useState<ExecutorCalendarRow[]>([])
  const [pnlCurveRows, setPnlCurveRows] = useState<ExecutorPnlCurvePoint[]>([])
  const pnlCurveSyncedAt = useRef(0)
  const pnlCurveRowsByStrategy = useMemo(() => {
    const grouped = new Map<string, ExecutorPnlCurvePoint[]>()
    for (const point of pnlCurveRows) {
      const points = grouped.get(point.strategyId)
      if (points) points.push(point)
      else grouped.set(point.strategyId, [point])
    }
    return grouped
  }, [pnlCurveRows])
  const [recoveryJobs, setRecoveryJobs] = useState<RecoveryJob[]>([])
  const [selectedWalletId, setSelectedWalletId] = useState('')
  const [renamingWalletId, setRenamingWalletId] = useState<string | null>(null)
  const [renameLabel, setRenameLabel] = useState('')
  const [liveConfirm, setLiveConfirm] = useState('')
  const [executorBusy, setExecutorBusy] = useState(false)
  const [executorError, setExecutorError] = useState<string | null>(null)
  const [executorPreflight, setExecutorPreflight] = useState<ExecutorPreflight | null>(null)
  const [editingStrategyId, setEditingStrategyId] = useState<string | null>(null)
  const [profitTargets, setProfitTargets] = useState<Record<string, 'USDG' | 'WETH' | 'ETH'>>({})
  const [overviewWithdrawTarget, setOverviewWithdrawTarget] = useState<'USDG' | 'WETH' | 'ETH'>('WETH')
  const performanceQuoteAddresses = useMemo(() => {
    // Most strategies retain WETH. Start its USD mark in parallel with the
    // executor performance request instead of discovering it afterwards and
    // turning the first render into two sequential network waits.
    const addresses = new Map<string, Address>([[ADDR.WNATIVE.toLowerCase(), ADDR.WNATIVE]])
    for (const performance of executorPerformanceList) {
      if (!performance.quote) continue
      const address = performance.quote.address.toLowerCase()
      if (address !== ADDR.STABLE.toLowerCase()) addresses.set(address, performance.quote.address as Address)
    }
    return [...addresses.values()]
  }, [executorPerformanceList])
  const performanceQuotePrices = useTokenPrices(performanceQuoteAddresses)
  const quoteUsdByAddress = new Map(Object.entries(tokenUsdMapOf(performanceQuotePrices.data)))
  const quotePriceResult = (address: string) => performanceQuotePrices.data?.[address.toLowerCase()]
  const loadPnlCurveRows = async (token: string, from?: number) => {
    const now = Math.floor(Date.now() / 1000)
    return { now, data: await executorPnlCurve(token, from ?? now - PNL_CURVE_WINDOW_SECONDS, now) }
  }
  const loadTodayRows = (token: string) => {
    const today = shanghaiDay(Math.floor(Date.now() / 1000))
    return executorPnlCalendar(token, today, today)
  }

  const sim = useMemo(
    () =>
      simulateStrategy({
        initialValue: 100,
        startPrice: 100,
        endPrice: 100 * (1 + number(endMove, -30) / 100),
        durationDays: 1,
        aprPct: number(apr, 8000),
        lowerPct: number(lower, 5),
        upperPct: number(upper, 5),
        lowerAction: 'recenter',
        upperAction: 'recenter',
        feeHandling: 'convert_to_quote',
      }),
    [apr, endMove, lower, upper],
  )

  const eligible = positions.data?.cl.filter((p) => p.liquidity > 0n && (!p.staked || (p.pool.protocol === 'home' && !!p.pool.gauge && p.pool.gaugeAlive))) ?? []
  const tokenSymbols = useMemo(() => {
    const tokens = { ...(pools.data?.tokens ?? {}), ...(positions.data?.tokens ?? {}) }
    return new Map(Object.entries(tokens).map(([address, token]) => [address.toLowerCase(), token.symbol]))
  }, [pools.data?.tokens, positions.data?.tokens])
  const displayStrategyName = (strategy: StrategyConfig, performance?: ExecutorPerformance) => strategyName(
    strategy,
    (address) => address.toLowerCase() === strategy.quoteToken.toLowerCase()
      ? performance?.quote?.symbol ?? tokenSymbols.get(address.toLowerCase())
      : performance?.risk?.symbol ?? tokenSymbols.get(address.toLowerCase()),
  )
  const canEnterPrivateKey = typeof window !== 'undefined' && (window.isSecureContext || ['127.0.0.1', 'localhost'].includes(window.location.hostname))
  const walletForOwner = (owner: string) => executorWalletList.find((wallet) => wallet.address.toLowerCase() === owner.toLowerCase())
  const walletTitle = (wallet: ExecutorWallet) => `${wallet.label} · ${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`
  const connectedExecutorWallets = user ? executorWalletList.filter((wallet) => wallet.address.toLowerCase() === user.toLowerCase()) : []
  const connectedRecoveryJobs = user ? recoveryJobs.filter((job) => executorStrategyList.some(
    (strategy) => strategy.config.id === job.strategyId && strategy.config.owner.toLowerCase() === user.toLowerCase(),
  )) : []
  const refreshExecutor = async (token = accessToken) => {
    const [walletData, strategyData, recoveryData, performanceData, curveData, calendarData] = await Promise.all([
      executorWallets(token),
      executorStrategies(token),
      executorRecovery(token),
      executorPerformance(token),
      loadPnlCurveRows(token),
      loadTodayRows(token),
    ])
    setExecutorWalletList(walletData.wallets)
    setExecutorStrategyList(strategyData.strategies)
    setItems(syncStrategyArchiveState(
      strategyData.strategies.map((strategy) => strategy.config.id),
      strategyData.archivedStrategyIds ?? [],
    ))
    setRecoveryJobs(recoveryData.jobs)
    setExecutorPerformanceList(performanceData.strategies)
    setExecutorCalendarRows(calendarData.rows)
    setPnlCurveRows(curveData.data.points)
    pnlCurveSyncedAt.current = curveData.now
    setSelectedWalletId((current) => current || walletData.wallets[0]?.id || '')
  }
  const connectExecutor = async (token = accessToken, role: 'wallet' | 'admin' = 'admin') => {
    const normalizedToken = token.trim()
    setExecutorBusy(true)
    setExecutorError(null)
    try {
      const health = await executorHealth()
      if (!health.ok || !(health.signerReady ?? health.vaultReady) || !health.apiAuthReady) throw new Error('executor is not ready')
      setExecutorPaused(health.paused)
      await refreshExecutor(normalizedToken)
      if (role === 'admin') setAdminToken(normalizedToken)
      if (role === 'admin' && normalizedToken) {
        try { window.localStorage.setItem(executorAdminTokenStorageKey(), normalizedToken) } catch { /* storage can be unavailable */ }
      }
      setAuthRole(role)
      setExecutorOnline(true)
    } catch (error) {
      setExecutorOnline(false)
      setAuthRole('none')
      if (role === 'admin' && normalizedToken && normalizedToken === savedExecutorAdminToken()) {
        try { window.localStorage.removeItem(executorAdminTokenStorageKey()) } catch { /* storage can be unavailable */ }
        setAdminToken('')
      }
      setExecutorError(error instanceof Error ? error.message : 'executor connection failed')
    } finally {
      setExecutorBusy(false)
    }
  }
  useEffect(() => {
    const saved = savedExecutorAdminToken()
    if (saved) void connectExecutor(saved, 'admin')
  }, [])
  useEffect(() => {
    const syncFromAnotherTab = () => setItems(loadStrategies())
    window.addEventListener('storage', syncFromAnotherTab)
    return () => window.removeEventListener('storage', syncFromAnotherTab)
  }, [])
  useEffect(() => {
    if (authRole === 'admin' || !walletAuth.token) return
    void connectExecutor(walletAuth.token, 'wallet')
  }, [authRole, walletAuth.token, user])
  useEffect(() => {
    if (!user) return
    const match = walletForOwner(user)
    if (match) setSelectedWalletId(match.id)
  }, [user, executorWalletList])
  useEffect(() => {
    if (!executorOnline) return
    const refreshStatus = () => {
      if (document.hidden) return
      void Promise.all([
        executorWallets(accessToken),
        executorStrategies(accessToken),
        executorRecovery(accessToken),
        executorHealth(),
      ]).then(([walletData, strategyData, recoveryData, health]) => {
        setExecutorWalletList(walletData.wallets)
        setExecutorStrategyList(strategyData.strategies)
        setItems(syncStrategyArchiveState(
          strategyData.strategies.map((strategy) => strategy.config.id),
          strategyData.archivedStrategyIds ?? [],
        ))
        setRecoveryJobs(recoveryData.jobs)
        setExecutorPaused(health.paused)
      }).catch(() => undefined)
    }
    const refreshPerformance = () => {
      if (document.hidden) return
      const now = Math.floor(Date.now() / 1000)
      const from = Math.max(now - PNL_CURVE_WINDOW_SECONDS, (pnlCurveSyncedAt.current || now - 10 * 60) - 5 * 60)
      void Promise.all([executorPerformance(accessToken), loadPnlCurveRows(accessToken, from), loadTodayRows(accessToken)]).then(([data, curveData, calendarData]) => {
        setExecutorPerformanceList(data.strategies)
        setExecutorCalendarRows(calendarData.rows)
        setPnlCurveRows((current) => mergePnlCurveSnapshots(current, curveData.data.points, curveData.now - PNL_CURVE_WINDOW_SECONDS))
        pnlCurveSyncedAt.current = curveData.now
      }).catch(() => undefined)
    }
    const statusTimer = window.setInterval(refreshStatus, 8_000)
    const performanceTimer = window.setInterval(refreshPerformance, 30_000)
    return () => {
      window.clearInterval(statusTimer)
      window.clearInterval(performanceTimer)
    }
  }, [executorOnline, accessToken])
  const toggleExecutorPause = async () => {
    setExecutorBusy(true)
    setExecutorError(null)
    try {
      const result = await setExecutorEmergencyPause(adminToken, !executorPaused)
      setExecutorPaused(result.paused)
    } catch (error) {
      setExecutorError(error instanceof Error ? error.message : 'executor pause failed')
    } finally {
      setExecutorBusy(false)
    }
  }
  const importWallet = async () => {
    if (!canEnterPrivateKey) return setExecutorError('private-key import requires HTTPS or a loopback page')
    if (!user) return setExecutorError(t('strategy.accountConnectFirst'))
    setExecutorBusy(true)
    setExecutorError(null)
    try {
      const result = await importExecutorWallet(adminToken, accountLabel, privateKey, user)
      setPrivateKey('')
      setAccountLabel('')
      await refreshExecutor()
      setSelectedWalletId(result.wallet.id)
    } catch (error) {
      setPrivateKey('')
      setExecutorError(error instanceof Error ? error.message : 'wallet import failed')
    } finally {
      setExecutorBusy(false)
    }
  }
  const renameWallet = async (walletId: string) => {
    setExecutorBusy(true)
    setExecutorError(null)
    try {
      await renameExecutorWallet(adminToken, walletId, renameLabel)
      setRenamingWalletId(null)
      setRenameLabel('')
      await refreshExecutor()
    } catch (error) {
      setExecutorError(error instanceof Error ? error.message : t('strategy.accountRenameFailed'))
    } finally {
      setExecutorBusy(false)
    }
  }
  const startSimple = async (strategy: StrategyConfig) => {
    const wallet = walletForOwner(strategy.owner)
    if (!wallet) return setExecutorError(t('strategy.accountMissingForOwner'))
    const stakingFlow = strategy.staking?.enabled ? '系统还会先解质押并把本次领取的 UP 卖为留存 WETH，重建后重新质押。' : ''
    const guardFlow = strategy.safeguards.enabled ? t('strategy.safeguardsOnNote') : t('strategy.safeguardsOffNote')
    if (!window.confirm(`将启动 #${strategy.activeTokenId ?? ''} 的真实自动策略。价格离开 −${strategy.range.lowerPct}% / +${strategy.range.upperPct}% 后，系统会撤出、兑换并重建仓位。${stakingFlow}${guardFlow}继续？`)) return
    setExecutorBusy(true)
    setExecutorError(null)
    try {
      const result = await startSimpleExecutorStrategy(adminToken, strategy, wallet.id)
      setItems(upsertStrategy(result.config))
      setExecutorPreflight(result.preflight)
      await refreshExecutor()
    } catch (error) {
      setExecutorError(error instanceof Error ? error.message : '策略启动失败')
    } finally {
      setExecutorBusy(false)
    }
  }
  const submitExecutorStrategy = async (strategy: StrategyConfig, dryRun: boolean) => {
    const wallet = walletForOwner(strategy.owner)
    if (!wallet) return setExecutorError(t('strategy.accountMissingForOwner'))
    if (!dryRun && liveConfirm !== `LIVE ${strategy.activeTokenId ?? ''}`) return setExecutorError(`type LIVE ${strategy.activeTokenId ?? ''} to enable signing`)
    const remote = executorStrategyList.find((item) => item.config.id === strategy.id)
    const now = Math.floor(Date.now() / 1000)
    const next: StrategyConfig = {
      ...strategy,
      enabled: true,
      execution: { ...strategy.execution, mode: 'executor_auto', executorId: 'local', walletId: wallet.id, signerAddress: wallet.address, dryRun },
      revision: Math.max(strategy.revision, remote?.config.revision ?? 0) + 1,
      updatedAt: now,
    }
    setExecutorBusy(true)
    setExecutorError(null)
    try {
      await saveExecutorStrategy(adminToken, next)
      setItems(upsertStrategy(next))
      setLiveConfirm('')
      await refreshExecutor()
    } catch (error) {
      setExecutorError(error instanceof Error ? error.message : 'strategy submission failed')
    } finally {
      setExecutorBusy(false)
    }
  }
  const manualExecutorAction = async (strategy: StrategyConfig, execute: boolean) => {
    const remote = executorStrategyList.find((item) => item.config.id === strategy.id)
    if (!remote) return setExecutorError('submit the strategy to executor first')
    if (execute && !remote.config.execution.dryRun && liveConfirm !== `LIVE ${remote.config.activeTokenId ?? ''}`)
      return setExecutorError(`type LIVE ${remote.config.activeTokenId ?? ''} before a live manual trigger`)
    setExecutorBusy(true)
    setExecutorError(null)
    try {
      if (execute) {
        const result = await executeExecutorStrategy(adminToken, strategy.id)
        setExecutorError(`job ${result.job.id} created · ${result.job.dryRun ? 'dry run' : 'live signing'}`)
      } else {
        const result = await planExecutorStrategy(adminToken, strategy.id)
        setExecutorPreflight(result.preflight)
        setExecutorError(`fresh plan: ${String(result.plan.hash ?? 'ready')}`)
      }
      await refreshExecutor()
    } catch (error) {
      setExecutorError(error instanceof Error ? error.message : 'executor action failed')
    } finally {
      setExecutorBusy(false)
    }
  }
  const withdrawProfit = async (strategy: StrategyConfig, performance: ExecutorPerformance) => {
    const target = profitTargets[strategy.id] ?? 'WETH'
    const available = performance.summary?.profitReserveQuoteRaw
    if (!available || BigInt(available) <= 0n) return setExecutorError(t('strategy.profitWithdrawNone'))
    if (!window.confirm(t('strategy.profitWithdrawConfirm', { amount: quoteAmount(available, performance), target }))) return
    setExecutorBusy(true)
    setExecutorError(null)
    try {
      const { withdrawal } = await withdrawExecutorProfit(adminToken, strategy.id, target)
      await refreshExecutor()
      setExecutorError(t('strategy.profitWithdrawSuccess', {
        amount: tokenAmount(withdrawal.amountRaw, withdrawal.decimals, withdrawal.target),
      }))
    } catch (error) {
      setExecutorError(error instanceof Error ? error.message : t('strategy.profitWithdrawFailed'))
    } finally {
      setExecutorBusy(false)
    }
  }
  const addOriginal = (p: (typeof eligible)[number]) => {
    if (!user) return
    const token0IsWrapped = p.pool.token0.toLowerCase() === ADDR.WNATIVE.toLowerCase()
    const protocol = strategyProtocolFor(CHAIN_ID, p.pool.protocol)
    const draft = originalStrategyDraft({
      chainId: CHAIN_ID,
      owner: user,
      protocol,
      pool: p.pool.address,
      poolId: p.pool.poolId,
      hooks: p.pool.hooks,
      positionManager: positionManagerFor(CHAIN_ID, protocol),
      activeTokenId: p.tokenId.toString(),
      riskToken: token0IsWrapped ? p.pool.token1 : p.pool.token0,
      quoteToken: token0IsWrapped ? p.pool.token0 : p.pool.token1,
      staking: p.staked ? { enabled: true, gauge: p.pool.gauge ?? undefined } : { enabled: false },
    })
    const config = { ...draft, name: displayStrategyName(draft), safeguards: recommendedSafeguards(draft.range.lowerPct) }
    setItems(upsertStrategy(config))
  }
  const setSimpleBand = (strategy: StrategyConfig, pct: number) => {
    const now = Math.floor(Date.now() / 1000)
    // A band change rescales the recommended limits with it, but a draft whose
    // safeguards were hand-edited in the full editor keeps those edits.
    const customized = strategy.safeguards.enabled
      && JSON.stringify(strategy.safeguards) !== JSON.stringify(recommendedSafeguards(strategy.range.lowerPct))
    const next: StrategyConfig = {
      ...strategy,
      range: { mode: 'symmetric', lowerPct: pct, upperPct: pct },
      safeguards: customized ? strategy.safeguards : recommendedSafeguards(pct),
      revision: strategy.revision + 1,
      updatedAt: now,
    }
    next.name = displayStrategyName(next)
    setItems(upsertStrategy(next))
  }
  const applyRecommendedSafeguards = (strategy: StrategyConfig) => {
    const now = Math.floor(Date.now() / 1000)
    const next: StrategyConfig = {
      ...strategy,
      safeguards: recommendedSafeguards(Math.min(strategy.range.lowerPct, strategy.range.upperPct)),
      revision: strategy.revision + 1,
      updatedAt: now,
    }
    setItems(upsertStrategy(next))
  }
  const setLowTransactionMode = async (strategy: StrategyConfig, enabled: boolean) => {
    const remote = executorStrategyList.find((item) => item.config.id === strategy.id)
    if (!window.confirm(t(enabled ? 'strategy.lowTxConfirm' : 'strategy.lowTxDisableConfirm'))) return
    const next: StrategyConfig = {
      ...strategy,
      execution: { ...strategy.execution, lowTransactionMode: enabled },
      revision: (remote?.config.revision ?? strategy.revision) + 1,
      updatedAt: Math.floor(Date.now() / 1000),
    }
    if (!remote) {
      setItems(upsertStrategy(next))
      return
    }
    setExecutorBusy(true)
    setExecutorError(null)
    try {
      await saveExecutorStrategy(adminToken, next)
      setItems(upsertStrategy(next))
      await refreshExecutor()
    } catch (error) {
      setExecutorError(error instanceof Error ? error.message : t('strategy.lowTxFailed'))
    } finally {
      setExecutorBusy(false)
    }
  }
  const toggle = (strategy: StrategyConfig) => {
    const next = { ...strategy, enabled: !strategy.enabled, updatedAt: Math.floor(Date.now() / 1000), revision: strategy.revision + 1 }
    setItems(upsertStrategy(next))
  }
  const remove = async (strategy: StrategyConfig) => {
    const remote = executorStrategyList.find((item) => item.config.id === strategy.id)
    if (!window.confirm(t('strategy.simpleDeleteConfirm', { name: strategy.name }))) return
    if (!remote) {
      setItems(removeStrategy(strategy.id))
      return
    }
    setExecutorBusy(true)
    setExecutorError(null)
    try {
      await deleteExecutorStrategy(adminToken, strategy.id)
      setItems(removeStrategy(strategy.id))
      await refreshExecutor()
    } catch (error) {
      setExecutorError(error instanceof Error ? error.message : t('strategy.simpleDeleteFailed'))
    } finally {
      setExecutorBusy(false)
    }
  }
  const retryRecovery = async (job: RecoveryJob) => {
    if (!accessToken) return
    setExecutorBusy(true)
    setExecutorError(null)
    try {
      await resumeExecutorRecovery(accessToken, job.id)
      await refreshExecutor()
    } catch (error) {
      setExecutorError(error instanceof Error ? error.message : t('strategy.simpleDeleteFailed'))
    } finally {
      setExecutorBusy(false)
    }
  }
  const resumeMonitoring = async (strategy: StrategyConfig) => {
    if (!accessToken) return
    setExecutorBusy(true)
    setExecutorError(null)
    try {
      await resumeExecutorMonitoring(accessToken, strategy.id)
      await refreshExecutor()
    } catch (error) {
      setExecutorError(error instanceof Error ? error.message : t('strategy.simpleResumeFailed'))
    } finally {
      setExecutorBusy(false)
    }
  }
  const saveEditedStrategy = (strategy: StrategyConfig) => {
    setItems(upsertStrategy(strategy))
    setEditingStrategyId(null)
  }
  const createPlan = (strategy: StrategyConfig) => {
    if (!user || !strategy.activeTokenId) return
    const position = positions.data?.cl.find(
      (p) => p.staked === !!strategy.staking?.enabled && p.tokenId.toString() === strategy.activeTokenId && p.pool.address.toLowerCase() === strategy.pool.toLowerCase(),
    )
    if (!position) {
      setPlan(null)
      setPlanError('active position was not found; refresh and confirm ownership')
      return
    }
    try {
      const tokens = { ...(pools.data?.tokens ?? {}), ...(positions.data?.tokens ?? {}) }
      const snapshot = snapshotFromPosition({ config: strategy, position, owner: user, tokens })
      setPlan(makeRebalancePlan({ config: strategy, snapshot }))
      setPlanError(null)
    } catch (error) {
      setPlan(null)
      setPlanError(error instanceof Error ? error.message : 'unexpected planning error')
    }
  }

  const allDisplayedStrategies = [
    ...items.map((local) => executorStrategyList.find((remote) => remote.config.id === local.id)?.config ?? local),
    ...executorStrategyList
      .filter((remote) => !items.some((local) => local.id === remote.config.id))
      .map((remote) => remote.config)
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)),
  ]
  const displayedStrategies = user
    ? allDisplayedStrategies.filter((strategy) => strategy.owner.toLowerCase() === user.toLowerCase())
    : []
  const configuredTokenIds = new Set(displayedStrategies.map((strategy) => strategy.activeTokenId).filter(Boolean))
  const strategyStatus = (remote: ExecutorStrategy | undefined) => {
    if (!remote) return { tone: 'dim' as const, title: t('strategy.simpleNotStarted'), detail: t('strategy.simpleNotStartedDetail') }
    const job = remote.latestJob
    if (remote.state === 'planned') return { tone: 'amber' as const, title: t('strategy.simplePreparing'), detail: t('strategy.simplePreparingDetail') }
    if (remote.state === 'executing') return {
      tone: 'amber' as const,
      title: t('strategy.simpleExecuting'),
      detail: t('strategy.simpleProgress', { done: job?.confirmedSteps ?? 0, total: job?.totalSteps ?? 12, tx: job?.transactionCount ?? 0 }),
    }
    if (remote.state === 'recovery') return {
      tone: 'amber' as const,
      title: t('strategy.simpleNeedsAttention'),
      detail: `${job?.errorCode ? `${job.errorCode} · ` : ''}${t('strategy.simpleNeedsAttentionDetail')}`,
    }
    if (remote.state === 'recovery_quarantined') return {
      tone: 'red' as const,
      title: t('strategy.simpleRecoveryQuarantined'),
      detail: `${job?.recoveryLastError ? `${job.recoveryLastError} · ` : ''}${t('strategy.simpleRecoveryQuarantinedDetail')}`,
    }
    if (remote.state === 'guard_wait' || remote.state === 'paused_guard') return {
      tone: 'amber' as const,
      title: t('strategy.simpleSafetyPaused'),
      detail: t('strategy.simpleSafetyPausedDetail'),
    }
    if (remote.config.execution.dryRun) return {
      tone: 'amber' as const,
      title: t('strategy.simpleDryRunOnly'),
      detail: t('strategy.simpleDryRunOnlyDetail'),
    }
    if (job?.state === 'completed' && job.result?.newTokenId) return {
      tone: 'green' as const,
      title: t('strategy.simpleSuccess'),
      detail: t('strategy.simpleSuccessDetail', { tokenId: String(job.result.newTokenId), tx: job.transactionCount }),
    }
    return {
      tone: 'green' as const,
      title: t('strategy.simpleMonitoring'),
      detail: t('strategy.simpleMonitoringDetail', { lower: remote.config.range.lowerPct, upper: remote.config.range.upperPct }),
    }
  }

  const quoteAmount = (raw: string | null | undefined, performance: ExecutorPerformance, signed = false) => {
    if (raw == null || !performance.quote) return '—'
    const value = Number(formatUnits(BigInt(raw), performance.quote.decimals))
    const abs = Math.abs(value)
    const digits = abs >= 100 ? 2 : abs >= 1 ? 4 : 6
    const text = new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(abs)
    const sign = value < 0 ? '−' : signed && value > 0 ? '+' : ''
    return `${sign}${text} ${performance.quote.symbol}`
  }

  const tokenAmount = (raw: string, decimals: number, symbol: string) => {
    const value = Number(formatUnits(BigInt(raw), decimals))
    const digits = Math.abs(value) >= 1 ? 4 : 6
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value)} ${symbol}`
  }

  const stableAmount = (raw: string | null | undefined, performance: ExecutorPerformance, signed = false) => {
    if (raw == null || !performance.quote) return '—'
    const quoteValue = Number(formatUnits(BigInt(raw), performance.quote.decimals))
    const quoteAddress = performance.quote.address.toLowerCase()
    const display = strategyDisplayValue(quoteValue, quoteAddress, quoteUsdByAddress.get(quoteAddress))
    if (!Number.isFinite(display.value)) return '—'
    const abs = Math.abs(display.value)
    const digits = abs >= 100 ? 2 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6
    const text = new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(abs)
    const sign = display.value < 0 ? '−' : signed && display.value > 0 ? '+' : ''
    return `${sign}${text} ${display.unit === 'USDG' ? 'USDG' : performance.quote.symbol}`
  }

  const stableValue = (raw: string | null | undefined, performance: ExecutorPerformance) => {
    if (raw == null || !performance.quote) return null
    const quoteValue = Number(formatUnits(BigInt(raw), performance.quote.decimals))
    return strategyStableValue(quoteValue, performance.quote.address, quoteUsdByAddress.get(performance.quote.address.toLowerCase()))
  }

  const stableTotal = (value: number | null, signed = false) => {
    if (value == null) return '—'
    const abs = Math.abs(value)
    const digits = abs >= 100 ? 2 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6
    const sign = value < 0 ? '−' : signed && value > 0 ? '+' : ''
    return `${sign}${new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(abs)} USDG`
  }

  const usdgAmount = (raw: string | null | undefined, signed = false) => {
    if (raw == null) return '—'
    const value = Number(formatUnits(BigInt(raw), 6))
    const abs = Math.abs(value)
    const digits = abs >= 100 ? 2 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6
    const sign = value < 0 ? '−' : signed && value > 0 ? '+' : ''
    return `${sign}${new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(abs)} USDG`
  }

  const performancePnl = (performance: ExecutorPerformance) => {
    const summary = performance.summary
    if (!summary) return { raw: null, text: '—', pct: null }
    return pnlUnit === 'stable'
      ? { raw: summary.pnlUsdgRaw, text: usdgAmount(summary.pnlUsdgRaw, true), pct: summary.pnlUsdgPct }
      : { raw: summary.pnlQuoteRaw, text: quoteAmount(summary.pnlQuoteRaw, performance, true), pct: summary.pnlPct }
  }

  const runningStrategies = executorStrategyList
    .filter((remote) => !!user && remote.config.owner.toLowerCase() === user.toLowerCase() && ACTIVE_EXECUTOR_STATES.has(remote.state) && !remote.config.execution.dryRun)
    .map((remote) => ({
      remote,
      performance: executorPerformanceList.find((row) => row.strategyId === remote.config.id),
    }))
  const dashboardPnlRows = runningStrategies.flatMap(({ performance }) => performance?.summary && performance.quote
    ? [{ performance, metric: performancePnl(performance) }]
    : [])
  const dashboardAssetValues = runningStrategies
    .map(({ performance }) => performance?.summary ? stableValue(performance.summary.currentValueQuoteRaw, performance) : null)
    .filter((value): value is number => value != null)
  const dashboardPnlKnown = dashboardPnlRows.filter((row) => row.metric.raw != null)
  const dashboardPnl = pnlUnit === 'stable'
    ? (dashboardPnlKnown.length ? dashboardPnlKnown.reduce((sum, row) => sum + Number(formatUnits(BigInt(row.metric.raw!), 6)), 0) : null)
    : null
  const dashboardQuoteAddress = new Set(dashboardPnlKnown.map((row) => row.performance.quote!.address.toLowerCase()))
  const dashboardQuoteRaw = pnlUnit === 'quote' && dashboardPnlKnown.length && dashboardQuoteAddress.size === 1
    ? dashboardPnlKnown.reduce((sum, row) => sum + BigInt(row.metric.raw!), 0n).toString()
    : null
  const dashboardPnlText = pnlUnit === 'stable'
    ? stableTotal(dashboardPnl, true)
    : dashboardQuoteRaw === null ? '—' : quoteAmount(dashboardQuoteRaw, dashboardPnlKnown[0].performance, true)
  const dashboardPnlPositive = pnlUnit === 'stable'
    ? dashboardPnl == null ? null : dashboardPnl >= 0
    : dashboardQuoteRaw === null ? null : BigInt(dashboardQuoteRaw) >= 0n
  const dashboardAssets = dashboardAssetValues.length ? dashboardAssetValues.reduce((sum, value) => sum + value, 0) : null
  const runningStrategyIds = new Set(runningStrategies.map(({ remote }) => remote.config.id))
  const performanceByStrategy = new Map(runningStrategies.flatMap(({ remote, performance }) => performance
    ? [[remote.config.id, performance] as const]
    : []))
  const dashboardTodayRows = executorCalendarRows.filter((row) => runningStrategyIds.has(row.strategyId))
  const dashboardTodayKnown = dashboardTodayRows.filter((row) => row.pnlRaw !== null && row.pnlUsdgRaw !== null)
  const dashboardTodayStableRaw = dashboardTodayKnown.length
    ? dashboardTodayKnown.reduce((sum, row) => sum + BigInt(row.pnlUsdgRaw!), 0n).toString()
    : null
  const dashboardTodayQuoteAddresses = new Set(dashboardTodayKnown.map((row) => row.quote.address.toLowerCase()))
  const dashboardTodayQuoteRaw = dashboardTodayKnown.length && dashboardTodayQuoteAddresses.size === 1
    ? dashboardTodayKnown.reduce((sum, row) => sum + BigInt(row.pnlRaw!), 0n).toString()
    : null
  const dashboardTodayQuotePerformance = dashboardTodayKnown.length ? performanceByStrategy.get(dashboardTodayKnown[0].strategyId) : undefined
  const dashboardTodayPnlText = pnlUnit === 'stable'
    ? usdgAmount(dashboardTodayStableRaw, true)
    : dashboardTodayQuoteRaw === null || !dashboardTodayQuotePerformance ? '—' : quoteAmount(dashboardTodayQuoteRaw, dashboardTodayQuotePerformance, true)
  const dashboardTodayPnlPositive = pnlUnit === 'stable'
    ? dashboardTodayStableRaw === null ? null : BigInt(dashboardTodayStableRaw) >= 0n
    : dashboardTodayQuoteRaw === null ? null : BigInt(dashboardTodayQuoteRaw) >= 0n
  const dashboardDailyReturn = weightedDailyReturnPct(dashboardTodayRows.map((row) => {
    const performance = performanceByStrategy.get(row.strategyId)
    return {
      pnlRaw: row.pnlRaw,
      openingAssetsRaw: row.openingAssetsRaw,
      openingAssetsStable: performance ? stableValue(row.openingAssetsRaw, performance) : null,
    }
  }))
  const dashboardMetricText = (rows: { performance: ExecutorPerformance; raw: string }[]) => {
    if (!rows.length) return '—'
    if (pnlUnit === 'stable') {
      const values = rows.map(({ performance, raw }) => stableValue(raw, performance)).filter((value): value is number => value !== null)
      return values.length ? stableTotal(values.reduce((sum, value) => sum + value, 0)) : '—'
    }
    const addresses = new Set(rows.map(({ performance }) => performance.quote?.address.toLowerCase()).filter(Boolean))
    if (addresses.size !== 1 || !rows[0].performance.quote) return '—'
    return quoteAmount(rows.reduce((sum, row) => sum + BigInt(row.raw), 0n).toString(), rows[0].performance)
  }
  const dashboardMetric = (field: 'currentUncollectedFeesQuoteRaw' | 'profitReserveQuoteRaw') => dashboardMetricText(
    runningStrategies.flatMap(({ performance }) => {
      const raw = performance?.summary?.[field]
      return performance && raw !== null && raw !== undefined ? [{ performance, raw }] : []
    }),
  )
  const today = shanghaiDay(Math.floor(Date.now() / 1000))
  const dashboardCycleRows = runningStrategies.flatMap(({ performance }) => performance?.summary && performance.quote && performance.cycles
    ? [{ performance, ...dailyCycleTotals(performance.cycles, shanghaiDay, today) }]
    : [])
  const dashboardTodayCollectedFees = dashboardMetricText(dashboardCycleRows.map(({ performance, grossFeesRaw }) => ({ performance, raw: grossFeesRaw })))
  const dashboardTodayIncomeTax = dashboardMetricText(dashboardCycleRows.map(({ performance, incomeTaxRaw }) => ({ performance, raw: incomeTaxRaw })))
  const dashboardUnclaimedFees = dashboardMetric('currentUncollectedFeesQuoteRaw')
  const dashboardWithdrawableProfit = dashboardMetric('profitReserveQuoteRaw')
  const dashboardTodayGas = dashboardMetricText(dashboardTodayRows.flatMap((row) => {
    const performance = performanceByStrategy.get(row.strategyId)
    return performance ? [{ performance, raw: row.gasRaw }] : []
  }))
  const withdrawableStrategies = runningStrategies.filter(({ remote, performance }) => {
    const available = performance?.summary?.profitReserveQuoteRaw
    return available && BigInt(available) > 0n && !['planned', 'executing', 'recovery', 'recovery_quarantined'].includes(remote.state)
  })
  const canManage = executorOnline && authRole === 'admin'

  const executionImpact = (bps: number | null) => {
    if (bps == null) return null
    return bps < 1 ? `${bps.toFixed(2)} bp` : `${(bps / 100).toFixed(2)}%`
  }

  const withdrawAllProfit = async (target: 'USDG' | 'WETH' | 'ETH') => {
    if (!withdrawableStrategies.length) return setExecutorError(t('strategy.profitWithdrawNone'))
    if (!window.confirm(t('strategy.overviewWithdrawAllConfirm', {
      count: withdrawableStrategies.length,
      amount: dashboardWithdrawableProfit,
      target,
    }))) return
    setExecutorBusy(true)
    setExecutorError(null)
    const succeeded: string[] = []
    const failed: string[] = []
    try {
      for (const { remote } of withdrawableStrategies) {
        try {
          await withdrawExecutorProfit(adminToken, remote.config.id, target)
          succeeded.push(remote.config.id)
        } catch (error) {
          failed.push(error instanceof Error ? error.message : 'withdrawal failed')
        }
      }
      await refreshExecutor()
      if (failed.length) {
        setExecutorError(t('strategy.overviewWithdrawAllPartial', {
          success: succeeded.length,
          failed: failed.length,
          first: failed[0],
        }))
      } else {
        setExecutorError(t('strategy.overviewWithdrawAllSuccess', { count: succeeded.length, target }))
      }
    } catch (error) {
      setExecutorError(error instanceof Error ? error.message : t('strategy.profitWithdrawFailed'))
    } finally {
      setExecutorBusy(false)
    }
  }

  return (
    <div>
      <section className="strategy-overview" aria-labelledby="strategy-overview-title">
        <div className="strategy-overview-head">
          <div>
            <div className="strategy-overview-kicker">{t('strategy.overviewKicker')}</div>
            <h2 id="strategy-overview-title">{t('strategy.overviewTitle')}</h2>
          </div>
          <div className="strategy-overview-controls">
            <PnlUnitToggle />
            <Badge tone={executorPaused ? 'red' : runningStrategies.length ? 'green' : 'dim'}>
              {t('strategy.overviewRunning', { n: runningStrategies.length })}
            </Badge>
          </div>
        </div>
        <div className="strategy-overview-actions">
          <select
            className="input"
            aria-label={t('strategy.overviewWithdrawTarget')}
            value={overviewWithdrawTarget}
            onChange={(event) => setOverviewWithdrawTarget(event.target.value as 'USDG' | 'WETH' | 'ETH')}
            disabled={!canManage || executorBusy}
          >
            <option value="USDG">{CHAIN.stable.symbol}</option>
            <option value="WETH">{CHAIN.wrappedSymbol}</option>
            <option value="ETH">{CHAIN.nativeCurrency.symbol}</option>
          </select>
          <Btn
            onClick={() => void withdrawAllProfit(overviewWithdrawTarget)}
            busy={executorBusy}
            disabled={!canManage || executorPaused || withdrawableStrategies.length === 0}
          >
            {t('strategy.overviewWithdrawAll')}
          </Btn>
        </div>
        <div className="strategy-overview-totals" aria-label={t('strategy.overviewTotals')}>
          <div>
            <span>{t('strategy.overviewTodayPnl')}</span>
            <strong className={dashboardTodayPnlPositive == null ? 'dim' : dashboardTodayPnlPositive ? 'green' : 'red'}>{dashboardTodayPnlText}</strong>
          </div>
          <div>
            <span>{t('strategy.overviewDailyReturn')}</span>
            <strong className={dashboardDailyReturn == null ? 'dim' : dashboardDailyReturn >= 0 ? 'green' : 'red'}>
              {dashboardDailyReturn == null ? '—' : `${dashboardDailyReturn >= 0 ? '+' : ''}${dashboardDailyReturn.toFixed(2)}%`}
            </strong>
          </div>
          <div>
            <span>{t('strategy.overviewTodayCollectedFees')}</span>
            <strong>{dashboardTodayCollectedFees}</strong>
          </div>
          <div>
            <span>{t('strategy.overviewTodayIncomeTax')}</span>
            <strong>{dashboardTodayIncomeTax}</strong>
          </div>
          <div>
            <span>{t('strategy.overviewTodayGas')}</span>
            <strong>{dashboardTodayGas}</strong>
          </div>
          <div>
            <span>{t('strategy.overviewUnclaimedFees')}</span>
            <strong>{dashboardUnclaimedFees}</strong>
          </div>
          <div>
            <span>{t('strategy.overviewWithdrawableProfit')}</span>
            <strong>{dashboardWithdrawableProfit}</strong>
          </div>
          <div>
            <span>{t('strategy.overviewTotalPnl')}</span>
            <strong className={dashboardPnlPositive == null ? 'dim' : dashboardPnlPositive ? 'green' : 'red'}>{dashboardPnlText}</strong>
          </div>
          <div>
            <span>{t('strategy.overviewAssets')}</span>
            <strong>{stableTotal(dashboardAssets)}</strong>
          </div>
        </div>
        {!executorOnline ? (
          <div className="strategy-overview-empty dim">{t('strategy.overviewConnecting')}</div>
        ) : runningStrategies.length === 0 ? (
          <div className="strategy-overview-empty dim">{t('strategy.overviewEmpty')}</div>
        ) : (
          <div className="strategy-overview-grid">
            {runningStrategies.map(({ remote, performance }) => {
              const status = strategyStatus(remote)
              const pnlMetric = performance ? performancePnl(performance) : { raw: null, text: '—', pct: null }
              const pnlRaw = pnlMetric.raw
              const pnlPositive = pnlRaw != null && BigInt(pnlRaw) >= 0n
              return (
                <article className="strategy-overview-card" key={remote.config.id}>
                  <div className="strategy-overview-card-head">
                    <strong title={displayStrategyName(remote.config, performance)}>{displayStrategyName(remote.config, performance)}</strong>
                    <Badge tone={status.tone}>{status.title}</Badge>
                  </div>
                  <div className="strategy-overview-pnl">
                    <span>{t('strategy.perfPnl')}</span>
                    <strong className={pnlRaw == null ? 'dim' : pnlPositive ? 'green' : 'red'}>
                      {performance?.summary ? pnlMetric.text : '—'}
                    </strong>
                    <small>{performance?.summary
                      ? `${pnlUnit === 'stable' ? quoteAmount(performance.summary.pnlQuoteRaw, performance, true) : usdgAmount(performance.summary.pnlUsdgRaw, true)} · ${pnlMetric.pct == null ? t('strategy.perfCalculating') : `${pnlMetric.pct >= 0 ? '+' : ''}${pnlMetric.pct.toFixed(2)}%`}`
                      : t('strategy.perfUnavailable')}</small>
                  </div>
                  {performance?.summary && performance.quote ? <StrategyPnlCurve
                    strategyId={remote.config.id}
                    rows={pnlCurveRowsByStrategy.get(remote.config.id) ?? []}
                    performance={performance}
                    unit={pnlUnit}
                    title={t('strategy.pnlCurve30d')}
                    empty={t('strategy.pnlCurveEmpty')}
                    compact
                  /> : null}
                  <div className="strategy-overview-meta">
                    <span><i>{t('strategy.overviewNetValue')}</i>{performance?.summary ? stableAmount(performance.summary.currentValueQuoteRaw, performance) : '—'}</span>
                    <span><i>{t('strategy.overviewNetIncome')}</i>{performance?.summary ? stableAmount(performance.summary.netFeesQuoteRaw, performance, true) : '—'}</span>
                    <span><i>{t('strategy.overviewPosition')}</i>#{performance?.currentPosition?.tokenId ?? remote.config.activeTokenId ?? '—'}</span>
                  </div>
                </article>
              )
            })}
          </div>
        )}
        <div className="strategy-overview-foot mono-sm">
          <span>{t('strategy.overviewRefresh')}</span>
          {dashboardPnlKnown.length < runningStrategies.length && runningStrategies.length > 0 ? <span className="amber">{t('strategy.overviewPartial', { n: runningStrategies.length - dashboardPnlKnown.length })}</span> : null}
          {dashboardTodayKnown.length < runningStrategies.length && runningStrategies.length > 0 ? <span className="amber">{t('strategy.overviewDailyPartial', { n: runningStrategies.length - dashboardTodayKnown.length })}</span> : null}
        </div>
      </section>

      <div className="section-title">{t('strategy.simpleTitle')}</div>
      <div className="card">
        <div className="card-head">
          <span className="card-title">{t('strategy.simpleExecutor')}</span>
          <Badge tone={executorOnline ? (executorPaused ? 'red' : 'green') : 'dim'}>
            {executorOnline ? (executorPaused ? t('strategy.executorPaused') : t('strategy.executorOnline')) : t('strategy.simpleConnecting')}
          </Badge>
          {canManage && (
            <div className="card-actions">
              <Btn tone={executorPaused ? 'ghost' : 'danger'} onClick={toggleExecutorPause} busy={executorBusy}>
                {executorPaused ? t('strategy.resumeExecutor') : t('strategy.simpleEmergencyStop')}
              </Btn>
            </div>
          )}
        </div>
        {!executorOnline ? <div className="strategy-auth-prompt">
          <div className="dim mono-sm">{!user
            ? t('strategy.accountConnectFirst')
            : walletAuth.status === 'signing' ? t('strategy.walletAuthSigning')
            : walletAuth.status === 'verifying' ? t('strategy.walletAuthVerifying')
            : t('strategy.walletAuthPrompt')}</div>
          {user && walletAuth.status === 'error' ? <Btn onClick={walletAuth.retry}>{t('strategy.walletAuthRetry')}</Btn> : null}
        </div> : (
          <>
            {authRole === 'wallet' ? <div className="dim mono-sm">{t('strategy.walletReadOnly')}</div> : null}
            {!user ? <div className="dim mono-sm">{t('strategy.accountConnectFirst')}</div> : connectedExecutorWallets.length === 0 ? <div className="dim mono-sm">{t('strategy.accountNoneConnected')}</div> : <div className="strategy-account-list">
              {connectedExecutorWallets.map((wallet) => {
                const strategyCount = executorStrategyList.filter((strategy) => strategy.config.execution.walletId === wallet.id).length
                const connected = user?.toLowerCase() === wallet.address.toLowerCase()
                return <div className={`strategy-account ${connected ? 'selected' : ''}`} key={wallet.id}>
                  <div>
                    <strong>{wallet.label}</strong>{connected ? <Badge tone="green">{t('strategy.accountConnected')}</Badge> : null}
                    <span className="mono-sm">{wallet.address}</span>
                    <small>{t('strategy.accountStrategies', { n: strategyCount })}</small>
                  </div>
                  {renamingWalletId === wallet.id ? <div className="strategy-account-actions">
                    <input className="input" maxLength={48} value={renameLabel} onChange={(event) => setRenameLabel(event.target.value)} />
                    <Btn onClick={() => renameWallet(wallet.id)} disabled={!renameLabel.trim()} busy={executorBusy}>{t('strategy.accountSave')}</Btn>
                    <Btn tone="ghost" onClick={() => setRenamingWalletId(null)}>{t('strategy.cancelEditor')}</Btn>
                  </div> : <Btn tone="ghost" onClick={() => { setRenamingWalletId(wallet.id); setRenameLabel(wallet.label) }}>{t('strategy.accountRename')}</Btn>}
                </div>
              })}
            </div>}
            {canManage ? <details className="strategy-account-import" open={!!user && connectedExecutorWallets.length === 0}>
              <summary>{connectedExecutorWallets.length === 0 ? t('strategy.accountFirst') : t('strategy.accountReplace')}</summary>
              <div className="form-row">
                <span className="lbl">{t('strategy.accountName')}</span>
                <input className="input" maxLength={48} autoComplete="off" placeholder={t('strategy.accountNamePlaceholder')} value={accountLabel} onChange={(event) => setAccountLabel(event.target.value)} disabled={!canEnterPrivateKey || !user} />
                <span className="lbl">{t('strategy.privateKey')}</span>
                <input className="input" type="password" autoComplete="new-password" placeholder={t('strategy.privateKeyPlaceholder')} value={privateKey} onChange={(event) => setPrivateKey(event.target.value.trim())} disabled={!canEnterPrivateKey || !user} />
                <Btn onClick={importWallet} disabled={!accountLabel.trim() || !privateKey || !canEnterPrivateKey || !user} busy={executorBusy}>{t('strategy.simpleImportWallet')}</Btn>
              </div>
              <div className="amber mono-sm">{t('strategy.privateKeyHint')}</div>
            </details> : null}
          </>
        )}
        {executorError && <div className="amber mono-sm">{executorError}</div>}
      </div>

      <div className="section-title">{t('strategy.newTitle')}</div>
      {!user ? (
        <div className="dim">{t('strategy.connect')}</div>
      ) : positions.isLoading ? (
        <div className="dim">{t('strategy.scanning')}</div>
      ) : eligible.filter((p) => !configuredTokenIds.has(p.tokenId.toString())).length === 0 ? (
        <div className="dim">{displayedStrategies.length ? t('strategy.simpleAllConfigured') : t('strategy.noEligible')}</div>
      ) : (
        eligible.filter((p) => !configuredTokenIds.has(p.tokenId.toString())).map((p) => (
          <div className="card" key={`${p.pool.protocol}-${p.tokenId.toString()}`}>
            <div className="card-head">
              <span className="card-title">{p.pool.protocol.toUpperCase()} #{p.tokenId.toString()}</span>
              <Badge tone="green">{p.staked ? t('pos.staked') : t('strategy.unstaked')}</Badge>
              <div className="card-actions"><Btn onClick={() => addOriginal(p)}>{t('strategy.createOriginal')}</Btn></div>
            </div>
            <div className="dim mono-sm">{t('strategy.simpleOriginalHint')}</div>
          </div>
        ))
      )}

      <div className="section-title">{t('strategy.simpleStrategies', { n: displayedStrategies.length })}</div>
      {displayedStrategies.length === 0 ? <div className="dim">{t('strategy.empty')}</div> : displayedStrategies.map((strategy) => {
        const remote = executorStrategyList.find((row) => row.config.id === strategy.id)
        const status = strategyStatus(remote)
        const job = remote?.latestJob
        const performance = executorPerformanceList.find((row) => row.strategyId === strategy.id)
        const performanceQuotePrice = performance?.quote ? quotePriceResult(performance.quote.address) : undefined
        const running = remote && ['planned', 'executing', 'monitoring', 'guard_wait', 'recovery', 'recovery_quarantined', 'paused_guard', 'awaiting_manual'].includes(remote.state) && !remote.config.execution.dryRun
        const currentTokenId = performance?.currentPosition?.tokenId ?? strategy.activeTokenId
        const currentRangeCycle = performance?.cycles?.find((cycle) => cycle.newTokenId === currentTokenId)
        const currentRangeScale = currentRangeCycle?.rangeScale ?? 1
        const effectiveRange = scaledRangePcts(strategy.range.lowerPct, strategy.range.upperPct, currentRangeScale)
        const rangeExpanded = currentRangeScale > 1.000001
        const cardPnl = performance ? performancePnl(performance) : { raw: null, text: '—', pct: null }
        const startPrice = performance?.price?.startQuotePerRisk ?? null
        const currentPrice = performance?.price?.currentQuotePerRisk ?? null
        const priceChangePct = startPrice && currentPrice !== null ? (currentPrice / startPrice - 1) * 100 : null
        const withdrawalTotals = [...(performance?.profitWithdrawals ?? [])].reduce((totals, withdrawal) => {
          totals[withdrawal.target] = (totals[withdrawal.target] ?? 0n) + BigInt(withdrawal.amountRaw)
          return totals
        }, {} as Record<'USDG' | 'WETH' | 'ETH', bigint>)
        const profitWithdrawalBlocked = !remote
          || ['planned', 'executing', 'recovery', 'recovery_quarantined'].includes(remote.state)
          || !performance?.summary?.profitReserveQuoteRaw
          || BigInt(performance.summary.profitReserveQuoteRaw) <= 0n
        return (
          <div className="card" key={strategy.id}>
            <div className="card-head">
              <span className="card-title">{displayStrategyName(strategy, performance)}</span>
              <Badge tone={status.tone}>{status.title}</Badge>
              {strategy.staking?.enabled && <Badge tone="green">{t('strategy.autoStaking')}</Badge>}
              {strategy.execution.lowTransactionMode && <Badge tone="amber">{t('strategy.lowTxBadge')}</Badge>}
              {rangeExpanded && <Badge tone="amber">{t('strategy.rangeExpandedBadge', { scale: compactNumber(currentRangeScale) })}</Badge>}
              {walletForOwner(strategy.owner) ? <Badge tone="dim">{walletForOwner(strategy.owner)!.label}</Badge> : <Badge tone="red">{t('strategy.accountMissing')}</Badge>}
              <div className="card-actions">
                {remote?.state === 'paused_guard' && (
                  <Btn tone="danger" onClick={() => resumeMonitoring(strategy)} busy={executorBusy} disabled={!accessToken}>
                    {t('strategy.simpleRetryMonitoring')}
                  </Btn>
                )}
                {!running && !['recovery', 'paused_guard'].includes(remote?.state ?? '') && (
                  <Btn tone="danger" onClick={() => startSimple(strategy)} busy={executorBusy} disabled={!canManage || executorPaused || !walletForOwner(strategy.owner)}>
                    {t('strategy.simpleStart')}
                  </Btn>
                )}
                {!['planned', 'executing', 'recovery', 'recovery_quarantined'].includes(remote?.state ?? '') && (
                  <Btn onClick={() => setLowTransactionMode(strategy, !strategy.execution.lowTransactionMode)} busy={executorBusy} disabled={!canManage}>
                    {strategy.execution.lowTransactionMode ? t('strategy.lowTxDisable') : t('strategy.lowTxEnable')}
                  </Btn>
                )}
                <Btn tone="danger" onClick={() => remove(strategy)} busy={executorBusy} disabled={!!remote && !canManage}>{t('strategy.delete')}</Btn>
              </div>
            </div>
            <div className="kv mono-sm">
              <span>{t('strategy.tokenId')} {strategy.activeTokenId ?? '—'}</span>
              <span>{t('strategy.rangeBase', { lower: compactNumber(strategy.range.lowerPct), upper: compactNumber(strategy.range.upperPct) })}</span>
              {rangeExpanded && <span className="strategy-range-expanded">{t('strategy.rangeEffective', { lower: compactNumber(effectiveRange.lowerPct), upper: compactNumber(effectiveRange.upperPct) })}</span>}
              {!remote && (
                <label>
                  {t('strategy.simpleBand')}{' '}
                  <select className="input" value={strategy.range.lowerPct} onChange={(event) => setSimpleBand(strategy, Number(event.target.value))}>
                    {[1, 2, 3, 5, 8, 10].map((pct) => <option key={pct} value={pct}>±{pct}%</option>)}
                  </select>
                </label>
              )}
            </div>
            {!remote && (
              <details className="strategy-safeguards-brief" open={!strategy.safeguards.enabled}>
                <summary>
                  {t('strategy.safeguardsBriefTitle')}
                  {!strategy.safeguards.enabled && <span className="amber"> · {t('strategy.safeguardsOffTag')}</span>}
                </summary>
                {strategy.safeguards.enabled ? (
                  <div className="kv mono-sm">
                    <span>{t('strategy.sbCrossing', { minutes: strategy.safeguards.minCrossingMinutes ?? '—' })}</span>
                    <span>{t('strategy.sbDailyCap', { n: strategy.safeguards.maxRebalancesPerDay ?? '—' })}</span>
                    <span>{t('strategy.sbLowerBreaks', { n: strategy.safeguards.maxConsecutiveLowerBreaks ?? '—' })}</span>
                    <span>{t('strategy.sbBurst', { count: strategy.safeguards.burstTriggerCount ?? '—', window: strategy.safeguards.burstWindowMinutes ?? '—', cooldown: strategy.safeguards.burstCooldownMinutes ?? '—' })}</span>
                    <span>{t('strategy.sbVolatility', { bps: strategy.safeguards.maxVolatilityBps ?? '—', window: strategy.safeguards.volatilityWindowSeconds ?? '—' })}</span>
                    <span>{t('strategy.sbDeviation', { bps: strategy.safeguards.maxSpotTwapDeviationBps ?? '—' })}</span>
                    <span>{t('strategy.sbStable', { seconds: strategy.safeguards.stableMarketSeconds ?? '—' })}</span>
                    <span>{t('strategy.sbRiskAsset', { pct: strategy.safeguards.maxRiskAssetPct ?? '—' })}</span>
                    <span>{t('strategy.sbSwapImpact', { bps: strategy.safeguards.maxSwapImpactBps ?? '—' })}</span>
                  </div>
                ) : (
                  <div className="amber mono-sm">
                    {t('strategy.safeguardsOffNote')}
                    <div className="strategy-safeguards-actions">
                      <Btn onClick={() => applyRecommendedSafeguards(strategy)}>{t('strategy.safeguardsApply')}</Btn>
                    </div>
                  </div>
                )}
              </details>
            )}
            <div className={status.tone === 'green' ? 'green mono-sm' : 'dim mono-sm'}>{status.detail}</div>
            {startPrice !== null && performance?.quote && performance.risk && (
              <div className="strategy-price-comparison mono-sm">
                <span className="strategy-price-pair">{performance.risk.symbol}/{performance.quote.symbol}</span>
                <span><i>{t('strategy.perfStartPrice')}</i><strong>{fmtNum(startPrice, 7)}</strong></span>
                <span><i>{t('strategy.perfCurrentPrice')}</i><strong>{currentPrice === null ? '—' : fmtNum(currentPrice, 7)}</strong></span>
                <span className={priceChangePct === null ? 'dim' : priceChangePct >= 0 ? 'green' : 'red'}>
                  <i>{t('strategy.perfPriceChange')}</i><strong>{priceChangePct === null ? '—' : `${priceChangePct >= 0 ? '+' : ''}${priceChangePct.toFixed(2)}%`}</strong>
                </span>
              </div>
            )}
            {performance?.summary && performance.quote && (
              <div className="strategy-performance">
                <div className="performance-grid">
                  <div className="performance-metric">
                    <span>{t('strategy.perfReopens')}</span>
                    <strong>{performance.summary.reopens}</strong>
                    <small>{t('strategy.perfCurrentPosition', { tokenId: performance.currentPosition?.tokenId ?? '—' })}</small>
                  </div>
                  <div className="performance-metric">
                    <span>{t('strategy.perfFees')}</span>
                    <strong className="green">≈ {stableAmount(performance.summary.grossFeesQuoteRaw, performance)}</strong>
                    <small>{quoteAmount(performance.summary.grossFeesQuoteRaw, performance)} · {t('strategy.perfNetFees')} ≈ {stableAmount(performance.summary.netFeesQuoteRaw, performance)}</small>
                  </div>
                  <div className="performance-metric">
                    <span>{t('strategy.perfPnl')}</span>
                    <strong className={cardPnl.raw == null ? 'dim' : BigInt(cardPnl.raw) >= 0n ? 'green' : 'red'}>
                      {cardPnl.text}
                    </strong>
                    <small>{pnlUnit === 'stable' ? quoteAmount(performance.summary.pnlQuoteRaw, performance, true) : usdgAmount(performance.summary.pnlUsdgRaw, true)} · {cardPnl.pct == null ? t('strategy.perfCalculating') : `${cardPnl.pct >= 0 ? '+' : ''}${cardPnl.pct.toFixed(2)}%`}</small>
                  </div>
                  <div className="performance-metric">
                    <span>{t('strategy.perfAssets')}</span>
                    <strong>≈ {stableAmount(performance.summary.currentValueQuoteRaw, performance)}</strong>
                    <small>{quoteAmount(performance.summary.currentValueQuoteRaw, performance)} · {t('strategy.perfUncollected')} ≈ {stableAmount(performance.summary.currentUnclaimedTotalQuoteRaw, performance)}</small>
                  </div>
                </div>
                <StrategyPnlCurve
                  strategyId={strategy.id}
                  rows={pnlCurveRowsByStrategy.get(strategy.id) ?? []}
                  performance={performance}
                  unit={pnlUnit}
                  title={t('strategy.pnlCurve30d')}
                  empty={t('strategy.pnlCurveEmpty')}
                />
                <div className="pmetrics compact">
                  <div className="pcell">
                    <span className="k">{t('strategy.perfReconcile')} · {t('strategy.perfNetFees')}</span>
                    <span className="v green">+≈ {stableAmount(performance.summary.netFeesQuoteRaw, performance)}</span>
                  </div>
                  <div className="pcell">
                    <span className="k">{t('strategy.perfIncomeTax')}</span>
                    <span className="v red">≈ {stableAmount((-BigInt(performance.summary.incomeTaxQuoteRaw)).toString(), performance, true)}</span>
                  </div>
                  <div className="pcell">
                    <span className="k">{t('strategy.perfMarketAndLp')}</span>
                    <span className={`v ${performance.summary.marketAndLpQuoteRaw && BigInt(performance.summary.marketAndLpQuoteRaw) >= 0n ? 'green' : 'red'}`}>
                      ≈ {stableAmount(performance.summary.marketAndLpQuoteRaw, performance, true)}
                    </span>
                  </div>
                  <div className="pcell">
                    <span className="k">{t('strategy.perfExecutionCost')}</span>
                    <span className="v red">≈ {stableAmount((-BigInt(performance.summary.executionCostQuoteRaw)).toString(), performance, true)}</span>
                  </div>
                  <div className="pcell">
                    <span className="k">{t('strategy.perfGas')}</span>
                    <span className="v red">≈ {stableAmount((-BigInt(performance.summary.gasCostQuoteRaw)).toString(), performance, true)}</span>
                  </div>
                </div>
                <div className="performance-foot mono-sm">
                  <span>{t('strategy.perfGas')} ≈ {stableAmount(performance.summary.gasCostQuoteRaw, performance)} ({quoteAmount(performance.summary.gasCostQuoteRaw, performance)})</span>
                  <span>{t('strategy.perfBaseline')} ≈ {stableAmount(performance.summary.baselineValueQuoteRaw, performance)} ({quoteAmount(performance.summary.baselineValueQuoteRaw, performance)})</span>
                  <span>{t('strategy.perfProfitReserve')} ≈ {stableAmount(performance.summary.profitReserveQuoteRaw, performance)} ({quoteAmount(performance.summary.profitReserveQuoteRaw, performance)})</span>
                  <span>{t('strategy.perfProfitWithdrawn')} ≈ {usdgAmount(performance.summary.withdrawnProfitUsdgRaw)} ({quoteAmount(performance.summary.withdrawnProfitQuoteRaw, performance)})</span>
                  <span>{t('strategy.perfUncollectedLp')} ≈ {stableAmount(performance.summary.currentUncollectedFeesQuoteRaw, performance)} ({quoteAmount(performance.summary.currentUncollectedFeesQuoteRaw, performance)})</span>
                  {performance.unclaimedReward ? (
                    <span>{t('strategy.perfUnclaimedReward')} {tokenAmount(performance.unclaimedReward.raw, performance.unclaimedReward.decimals, performance.unclaimedReward.symbol)} · ≈ {stableAmount(performance.unclaimedReward.quoteRaw, performance)} ({quoteAmount(performance.unclaimedReward.quoteRaw, performance)})</span>
                  ) : null}
                  {performance.feeTokens?.length ? (
                    <span>{t('strategy.perfFeeBreakdown')} {performance.feeTokens.map((token) => tokenAmount(token.grossRaw, token.decimals, token.symbol)).join(' + ')}</span>
                  ) : null}
                </div>
                <div className="profit-withdrawal-panel">
                  <div>
                    <strong>{t('strategy.profitWithdrawTitle')}</strong>
                    <span className="dim mono-sm">{t('strategy.profitWithdrawHint')}</span>
                    {Object.entries(withdrawalTotals).length > 0 ? <span className="mono-sm">
                      {t('strategy.profitWithdrawSettled')} {Object.entries(withdrawalTotals).map(([target, raw]) => tokenAmount(raw.toString(), target === 'USDG' ? 6 : 18, target)).join(' + ')}
                    </span> : null}
                  </div>
                  <div className="profit-withdrawal-actions">
                    <select
                      className="input"
                      aria-label={t('strategy.profitWithdrawTarget')}
                      value={profitTargets[strategy.id] ?? 'WETH'}
                      onChange={(event) => setProfitTargets((current) => ({ ...current, [strategy.id]: event.target.value as 'USDG' | 'WETH' | 'ETH' }))}
                      disabled={!canManage || executorBusy}
                    >
                      <option value="USDG">{CHAIN.stable.symbol}</option>
                      <option value="WETH">{CHAIN.wrappedSymbol}</option>
                      <option value="ETH">{CHAIN.nativeCurrency.symbol}</option>
                    </select>
                    <Btn
                      onClick={() => withdrawProfit(strategy, performance)}
                      busy={executorBusy}
                      disabled={!canManage || executorPaused || profitWithdrawalBlocked}
                    >
                      {t('strategy.profitWithdrawAll')}
                    </Btn>
                  </div>
                </div>
                {performance.profitWithdrawals?.length ? <details className="profit-withdrawal-history">
                  <summary>{t('strategy.profitWithdrawHistory', { n: performance.profitWithdrawals.length })}</summary>
                  {performance.profitWithdrawals.map((withdrawal) => <div className="profit-withdrawal-row mono-sm" key={withdrawal.id}>
                    <span>{withdrawal.withdrawnAt ? new Date(withdrawal.withdrawnAt * 1000).toLocaleString() : '—'}</span>
                    <strong>{tokenAmount(withdrawal.amountRaw, withdrawal.decimals, withdrawal.target)}</strong>
                    <span>≈ {usdgAmount(withdrawal.usdgValueRaw)}</span>
                    <span>{withdrawal.txHashes.at(-1) ? <a href={`${CHAIN.explorer.url}/tx/${withdrawal.txHashes.at(-1)}`} target="_blank" rel="noreferrer">↗</a> : t('strategy.profitWithdrawNoTx')}</span>
                  </div>)}
                </details> : null}
                {performance.quote.address.toLowerCase() !== ADDR.STABLE.toLowerCase() && (
                  <div className="dim mono-sm">
                    {performanceQuotePrice?.priceUsd
                      ? t('strategy.perfStableRate', { symbol: performance.quote.symbol, price: new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(performanceQuotePrice.priceUsd), time: new Date((performanceQuotePrice.updatedAt ?? Math.floor(performanceQuotePrices.dataUpdatedAt / 1000)) * 1000).toLocaleTimeString() })
                      : t('strategy.perfStableLoading', { symbol: performance.quote.symbol })}
                  </div>
                )}
                {performance.error && <div className="amber mono-sm">{t('strategy.perfLiveError', { message: performance.error })}</div>}
                {performance.rewardValuationError && <div className="amber mono-sm">{t('strategy.perfRewardValuationError', { message: performance.rewardValuationError })}</div>}
                {performance.stableValuationError && <div className="amber mono-sm">{t('strategy.perfStablePnlUnavailable')}</div>}
                {performance.stable?.baselineSource && <div className="dim mono-sm">{t(performance.stable.baselineSource === 'recorded_at_start' ? 'strategy.perfStableBasisRecorded' : 'strategy.perfStableBasisHistorical')}</div>}
                {performance.warnings?.includes('gas_quote_unavailable') && <div className="amber mono-sm">{t('strategy.perfGasQuoteUnavailable', { symbol: performance.quote?.symbol ?? '' })}</div>}
                {performance.warnings?.includes('gas_quote_current_price') && <div className="dim mono-sm">{t('strategy.perfGasCurrentQuoteNote', { symbol: performance.quote?.symbol ?? '' })}</div>}
                {performance.baseline && <div className="dim mono-sm">
                  {t(performance.baseline.kind === 'strategy_start' ? 'strategy.perfBasisStartNote' : performance.baseline.kind === 'original_mint' ? 'strategy.perfBasisMintNote' : 'strategy.perfBasisNote', { tokenId: performance.baseline.tokenId ?? '—', date: new Date(performance.baseline.at * 1000).toLocaleString(), tick: performance.baseline.tick })}
                  {performance.baseline.txHash ? <>{' '}<a href={`https://robinhoodchain.blockscout.com/tx/${performance.baseline.txHash}`} target="_blank" rel="noreferrer">↗</a></> : null}
                </div>}
                {performance.warnings?.includes('pnl_baseline_historical_trigger_snapshot') && <div className="amber mono-sm">{t('strategy.perfBasisHistoricalNote')}</div>}
                {performance.warnings?.includes('protocol_fee_reconstructed') && <div className="dim mono-sm">{t('strategy.perfFeeEstimateNote')}</div>}
                {performance.cycles?.length ? (
                  <details className="performance-history">
                    <summary>{t('strategy.perfHistory', { n: performance.cycles.length })}</summary>
                    <div className="performance-cycle-head mono-sm">
                      <span>{t('strategy.perfTime')}</span><span>{t('strategy.perfPositionRange')}</span><span>{t('strategy.perfNetFees')}</span><span>{t('strategy.perfExecutionCost')}</span><span>{t('strategy.perfGas')}</span>
                    </div>
                    {performance.cycles.map((cycle, index) => {
                      const previousCycle = performance.cycles?.[index + 1]
                      const positionAgeMinutes = previousCycle?.completedAt == null
                        ? null
                        : Math.max(0, (cycle.startedAt - previousCycle.completedAt) / 60)
                      const expanded = cycle.rangeScale > 1.000001
                      const widenedQuickly = positionAgeMinutes != null && positionAgeMinutes < strategy.adaptiveRange.targetMinutes
                      return <div className="performance-cycle mono-sm" key={cycle.id}>
                        <span>{cycle.completedAt ? new Date(cycle.completedAt * 1000).toLocaleString() : '—'}</span>
                        <span>
                          #{cycle.oldTokenId ?? '—'} → #{cycle.newTokenId ?? '—'} · {cycle.riskDirection === 'up'
                            ? t('strategy.perfRiskUp', { symbol: performance.risk?.symbol ?? '' })
                            : cycle.riskDirection === 'down'
                              ? t('strategy.perfRiskDown', { symbol: performance.risk?.symbol ?? '' })
                              : cycle.triggerSide === 'adaptive_contraction'
                                ? t('strategy.perfAdaptiveContraction')
                                : cycle.triggerSide === 'lower' ? t('strategy.perfLower') : t('strategy.perfUpper')}
                          {expanded && <small className="strategy-range-cycle-note">{widenedQuickly
                            ? t('strategy.perfRangeExpanded', { minutes: compactNumber(positionAgeMinutes!), scale: compactNumber(cycle.rangeScale) })
                            : positionAgeMinutes == null
                              ? t('strategy.perfRangeScale', { scale: compactNumber(cycle.rangeScale) })
                              : t('strategy.perfRangeRecovered', { minutes: compactNumber(positionAgeMinutes), scale: compactNumber(cycle.rangeScale) })}</small>}
                        </span>
                        <span className="green">+≈ {stableAmount(cycle.netFeesQuoteRaw, performance)} <span className="dim">({quoteAmount(cycle.netFeesQuoteRaw, performance)})</span></span>
                        <span className="red">≈ {stableAmount((-BigInt(cycle.executionCostQuoteRaw)).toString(), performance, true)}{cycle.maxExecutionImpactBps == null ? null : <span className="dim"> ({executionImpact(cycle.maxExecutionImpactBps)})</span>}</span>
                        <span>≈ {stableAmount(cycle.gasCostQuoteRaw, performance)} <span className="dim">({quoteAmount(cycle.gasCostQuoteRaw, performance)})</span> {cycle.txHashes[0] ? <a href={`https://robinhoodchain.blockscout.com/tx/${cycle.txHashes[0]}`} target="_blank" rel="noreferrer">↗</a> : null}</span>
                      </div>
                    })}
                  </details>
                ) : null}
              </div>
            )}
            {performance && !performance.summary && <div className="amber mono-sm">{t('strategy.perfLiveError', { message: performance.error ?? t('strategy.perfUnavailable') })}</div>}
            {remote?.state === 'executing' && job && <progress max={Math.max(job.totalSteps, 1)} value={job.confirmedSteps} style={{ width: '100%', marginTop: 10 }} />}
            {job?.txHashes.length ? (
              <details className="strategy-tx-history mono-sm">
                <summary>{t('strategy.perfLatestTxs', { n: job.txHashes.length })}</summary>
                <div className="kv">
                  {job.txHashes.map((hash, index) => <a key={hash} href={`https://robinhoodchain.blockscout.com/tx/${hash}`} target="_blank" rel="noreferrer">TX {index + 1} ↗</a>)}
                </div>
              </details>
            ) : null}
            {job?.result?.newTokenId ? (
              <a className="mono-sm" href={`https://robinhoodchain.blockscout.com/token/${strategy.positionManager}/instance/${String(job.result.newTokenId)}`} target="_blank" rel="noreferrer">
                {t('strategy.simpleViewPosition', { tokenId: String(job.result.newTokenId) })} ↗
              </a>
            ) : null}
          </div>
        )
      })}

      {executorOnline && connectedRecoveryJobs.length > 0 && (
        <>
          <div className="section-title">{t('strategy.recoveryTitle')}</div>
          {connectedRecoveryJobs.map((job) => {
            const strategy = executorStrategyList.find((item) => item.config.id === job.strategyId)
            const quarantined = job.recoveryQuarantinedAt !== undefined
            return <div className="card" key={job.id}>
              <div className="card-head">
                <span className="card-title">{t('strategy.simpleInterrupted')}</span>
                <Badge tone={quarantined ? 'red' : 'amber'}>{quarantined ? t('strategy.simpleRecoveryQuarantined') : job.state}</Badge>
              </div>
              <div className="dim mono-sm">
                {job.strategyId} · {job.transactions.length} tx · {t('strategy.simpleRecoveryAttempts', { n: job.recoveryAttempts })}
                {job.recoveryLastError ? ` · ${job.recoveryLastError}` : ''}
              </div>
              <div className="dim mono-sm" style={{ marginTop: 6 }}>
                {quarantined ? t('strategy.simpleRecoveryQuarantinedDetail') : t('strategy.simpleNeedsAttentionDetail')}
              </div>
              <div className="form-row" style={{ marginTop: 10 }}>
                <Btn onClick={() => retryRecovery(job)} busy={executorBusy} disabled={!accessToken}>{t('strategy.simpleResume')}</Btn>
                {strategy && canManage && <Btn tone="danger" onClick={() => remove(strategy.config)} busy={executorBusy}>{t('strategy.delete')}</Btn>}
              </div>
            </div>
          })}
        </>
      )}

      <details className="card" style={{ marginTop: 18 }}>
        <summary className="card-title" style={{ cursor: 'pointer' }}>{t('strategy.simpleAdvanced')}</summary>
        <div className="dim mono-sm" style={{ marginTop: 10 }}>{t('strategy.simpleAdvancedHint')}</div>
        {authRole !== 'admin' && (
          <div className="form-row">
            <span className="lbl">{t('strategy.adminToken')}</span>
            <input className="input" type="password" autoComplete="off" value={adminToken} onChange={(event) => setAdminToken(event.target.value)} />
            <Btn onClick={() => connectExecutor(adminToken)} busy={executorBusy}>{t('strategy.connectExecutor')}</Btn>
          </div>
        )}
        {canManage && (
          <>
            <div className="form-row">
              <span className="lbl">{t('strategy.executorWallet')}</span>
              <select className="input" value={selectedWalletId} onChange={(event) => setSelectedWalletId(event.target.value)}>
                {connectedExecutorWallets.map((wallet) => <option value={wallet.id} key={wallet.id}>{walletTitle(wallet)}</option>)}
              </select>
            </div>
            <div className="form-row">
              <span className="lbl">{t('strategy.liveConfirm')}</span>
              <input className="input" autoComplete="off" value={liveConfirm} onChange={(event) => setLiveConfirm(event.target.value)} placeholder="LIVE 34711" />
            </div>
          </>
        )}
        <div className="section-title">{t('strategy.simTitle')}</div>
        <div className="kv">
          <span>{t('strategy.endMove')}</span><NumInput value={endMove} onChange={setEndMove} width={90} signed />
          <span>{t('strategy.apr')}</span><NumInput value={apr} onChange={setApr} width={90} />
          <span>{t('strategy.lower')}</span><NumInput value={lower} onChange={setLower} width={80} />
          <span>{t('strategy.upper')}</span><NumInput value={upper} onChange={setUpper} width={80} />
        </div>
        <div className="kv mono-sm">
          <span>{t('strategy.simLp')} <b>{sim.endingLpValue.toFixed(2)}</b></span>
          <span>{t('strategy.simFees')} <b className="green">+{sim.feesQuote.toFixed(2)}</b></span>
          <span>{t('strategy.simRebalances')} <b>{sim.rebalances}</b></span>
          <span>{t('strategy.simPnl')} <b className={sim.pnlPct >= 0 ? 'green' : 'red'}>{sim.pnlPct >= 0 ? '+' : ''}{sim.pnlPct.toFixed(2)}%</b></span>
        </div>
        {displayedStrategies.map((strategy) => editingStrategyId === strategy.id ? (
          <StrategyEditor key={strategy.id} strategy={strategy} onSave={saveEditedStrategy} onCancel={() => setEditingStrategyId(null)} />
        ) : (
          <div className="card inset-card" key={strategy.id}>
            <div className="card-head">
              <span className="card-title">{displayStrategyName(strategy, executorPerformanceList.find((row) => row.strategyId === strategy.id))}</span>
              <div className="card-actions">
                <Btn onClick={() => setEditingStrategyId(strategy.id)}>{t('strategy.edit')}</Btn>
                <Btn onClick={() => toggle(strategy)}>{strategy.enabled ? t('strategy.pause') : t('strategy.enable')}</Btn>
                <Btn onClick={() => createPlan(strategy)}>{t('strategy.plan')}</Btn>
                {canManage && <Btn onClick={() => submitExecutorStrategy(strategy, true)} busy={executorBusy}>{t('strategy.executorDryRun')}</Btn>}
                {canManage && <Btn tone="danger" onClick={() => submitExecutorStrategy(strategy, false)} busy={executorBusy}>{t('strategy.executorLive')}</Btn>}
                {canManage && executorStrategyList.some((item) => item.config.id === strategy.id) && <Btn onClick={() => manualExecutorAction(strategy, false)} busy={executorBusy}>{t('strategy.executorPreflight')}</Btn>}
                {canManage && executorStrategyList.some((item) => item.config.id === strategy.id) && <Btn tone="danger" onClick={() => manualExecutorAction(strategy, true)} busy={executorBusy}>{t('strategy.executorTrigger')}</Btn>}
                <Btn tone="danger" onClick={() => remove(strategy)} busy={executorBusy} disabled={executorStrategyList.some((item) => item.config.id === strategy.id) && !canManage}>{t('strategy.delete')}</Btn>
              </div>
            </div>
          </div>
        ))}
        {planError && <div className="dim red">{t('strategy.planError', { message: planError })}</div>}
        {plan && <div className="dim mono-sm">{t('strategy.planRange')} {plan.nextRange.tickLower} / {plan.nextRange.tickUpper} · {plan.hash.slice(0, 18)}…</div>}
        {executorPreflight && <div className="dim mono-sm">{t('strategy.preflightBlock')} {executorPreflight.blockNumber} · {t('strategy.preflightSide')} {executorPreflight.position.observedSide}</div>}
      </details>
    </div>
  )

}
