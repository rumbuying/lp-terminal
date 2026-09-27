import { useEffect, useState } from 'react'
import { formatUnits, zeroAddress, type Address } from 'viem'
import type { FablesStrategyConfig } from '../../../shared/strategy/types'
import { robinhoodConfig } from '../../config/chains/robinhood'
import { FABLES_AUTO_POOL_IDS } from '../../config/fables'
import { useFablesPositions } from '../../hooks/useFablesPositions'
import { executorFablesJobs, executorFablesStrategies, executorWallets,
  planExecutorFablesStrategy, resumeExecutorFablesJob, saveExecutorFablesStrategy,
  type ExecutorFablesJob, type ExecutorFablesPlan, type ExecutorFablesStrategy,
  type ExecutorWallet } from '../../lib/executorClient'
import { shortAddr } from '../../lib/format'

const strategyStateLabel: Record<string, string> = {
  monitoring: '区间内监控', confirming: '越界确认中', dry_run_ready: '越界待执行',
  awaiting_manual: '越界待手动处理', executing: '执行中', recovery: '待恢复',
  paused: '暂停', read_error: '读取异常', disabled: '已停用',
}
const assetLocationLabel: Record<string, string> = {
  old_lp_or_wallet: '旧 LP 或钱包', wallet_and_possible_old_fees: '钱包及旧区间待领费用',
  new_lp_pending_verification: '新 LP 待核实',
}

export function FablesStrategySection({ owner, accessToken, canManage }: {
  owner: Address; accessToken: string; canManage: boolean
}) {
  const positions = useFablesPositions(owner, [])
  const [strategies, setStrategies] = useState<ExecutorFablesStrategy[]>([])
  const [jobs, setJobs] = useState<ExecutorFablesJob[]>([])
  const [wallets, setWallets] = useState<ExecutorWallet[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [lowerPct, setLowerPct] = useState('5')
  const [upperPct, setUpperPct] = useState('5')
  const [confirmation, setConfirmation] = useState('300')
  const [claimFeeBps, setClaimFeeBps] = useState('1000')
  const [feeHandling, setFeeHandling] = useState<FablesStrategyConfig['fees']['handling']>('reinvest')
  const [executionMode, setExecutionMode] = useState<'notify_only' | 'executor_auto'>('notify_only')
  const [walletId, setWalletId] = useState('')
  const [dailyTurnover, setDailyTurnover] = useState('1000')
  const [legacyConsent, setLegacyConsent] = useState(false)
  const [quoteToken, setQuoteToken] = useState<Record<string, Address>>({})
  const [plan, setPlan] = useState<ExecutorFablesPlan | null>(null)
  const refresh = async () => {
    if (!accessToken) return
    try {
      const [strategiesResult, jobsResult, walletsResult] = await Promise.all([
        executorFablesStrategies(accessToken), executorFablesJobs(accessToken), executorWallets(accessToken),
      ])
      setStrategies(strategiesResult.strategies)
      setJobs(jobsResult.jobs)
      setWallets(walletsResult.wallets)
      setError(null)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 15_000)
    return () => clearInterval(timer)
  }, [accessToken])

  const save = async (position: NonNullable<typeof positions.data>['positions'][number]) => {
    if (!accessToken || !canManage) return
    setBusy(true); setError(null)
    try {
      const lower = Number(lowerPct)
      const upper = Number(upperPct)
      const confirmSeconds = Number(confirmation)
      const maxClaim = Number(claimFeeBps)
      if (!(lower > 0 && lower < 100 && upper > 0 && upper <= 500)
        || !Number.isInteger(confirmSeconds) || confirmSeconds < 0 || confirmSeconds > 3600
        || !Number.isInteger(maxClaim) || maxClaim < 0 || maxClaim > 10_000)
        throw new Error('请检查区间宽度、确认时间和领取费率上限')
      const currency0 = position.pool.key.currency0
      const currency1 = position.pool.key.currency1
      const selectedQuote = quoteToken[position.rangeId.toString()] ?? currency1
      const riskToken = selectedQuote.toLowerCase() === currency0.toLowerCase() ? currency1 : currency0
      const auto = executionMode === 'executor_auto'
      const selectedWallet = wallets.find(wallet => wallet.id === walletId && wallet.address.toLowerCase() === owner.toLowerCase())
      if (auto && (!FABLES_AUTO_POOL_IDS.has(position.pool.id.toLowerCase()) || !selectedWallet
        || !/^\d+$/.test(dailyTurnover) || BigInt(dailyTurnover) <= 0n))
        throw new Error('自动执行需要已批准的池、当前所有者的钱包和正数每日换币上限')
      const now = Math.floor(Date.now() / 1000)
      const config: FablesStrategyConfig = {
        version: 2, protocol: 'fables', chainId: 4663,
        id: `fables-${crypto.randomUUID()}`,
        name: `Fables ${positions.data?.tokens[currency0.toLowerCase()]?.symbol ?? shortAddr(currency0)}/${positions.data?.tokens[currency1.toLowerCase()]?.symbol ?? shortAddr(currency1)}`,
        enabled: true, owner, poolManager: robinhoodConfig.uniV4!.POOL_MANAGER,
        positionRef: { kind: 'fables_range', poolId: position.pool.id,
          hook: position.pool.key.hooks, rangeId: position.rangeId.toString(),
          tickLower: position.tickLower, tickUpper: position.tickUpper },
        riskToken, quoteToken: selectedQuote,
        range: { lowerPct: lower, upperPct: upper },
        trigger: { pollSeconds: 4, confirmationSeconds: confirmSeconds, cooldownMinutes: 5 },
        fees: { handling: feeHandling },
        safeguards: { maxSlippageBps: 100, maxSwapImpactBps: 150,
          maxRebalancesPerDay: 6, maxPlanAgeSeconds: 60, maxClaimFeeBps: maxClaim,
          allowLegacyUnboundedFeeExit: legacyConsent,
          minNativeGasReserveWei: '10000000000000000' },
        execution: auto
          ? { mode: 'executor_auto', walletId: selectedWallet!.id,
              signerAddress: selectedWallet!.address, dryRun: false,
              maxDailyTurnoverQuote: dailyTurnover }
          : { mode: 'notify_only', dryRun: false },
        revision: 1, createdAt: now, updatedAt: now,
      }
      await saveExecutorFablesStrategy(accessToken, config)
      await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const preview = async (id: string) => {
    setBusy(true); setError(null); setPlan(null)
    try { setPlan((await planExecutorFablesStrategy(accessToken, id)).plan) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const resume = async (id: string) => {
    setBusy(true); setError(null)
    try { await resumeExecutorFablesJob(accessToken, id); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  return <section className="card" style={{ marginTop: 18 }}>
    <div className="section-title">Fables LP 策略</div>
    {!accessToken && <div className="dim">连接策略执行器后可查看 Fables 策略。</div>}
    {error && <div className="red mono-sm">{error}</div>}
    {strategies.map(row => <div className="card inset-card" key={row.config.id}>
      <b>{row.config.name}</b> · {strategyStateLabel[row.state] ?? row.state}
      <div className="mono-sm dim">池 {shortAddr(row.config.positionRef.poolId)} · 区间 {row.config.positionRef.tickLower}–{row.config.positionRef.tickUpper} · 份额区间 ID {row.config.positionRef.rangeId}</div>
      {row.monitor?.lastTick !== undefined && <div className="mono-sm">当前 tick {row.monitor.lastTick}{row.monitor.outSide ? ` · ${row.monitor.outSide === 'lower' ? '低于' : '高于'}区间` : ''}</div>}
      {row.monitor?.error && <div className="red mono-sm">{row.monitor.error}</div>}
      {row.recentLedger?.filter(entry => entry.kind === 'fees_claimed').slice(0, 4).map((entry, index) => {
        const token = entry.token?.toLowerCase()
        const meta = token ? positions.data?.tokens[token] : undefined
        const decimals = token === zeroAddress ? 18 : meta?.decimals
        return <div className="mono-sm" key={`${entry.jobId}:${entry.txHash}:${token}:${index}`}>
          已领取手续费 {entry.amount && decimals != null ? formatUnits(BigInt(entry.amount), decimals) : entry.amount}
          {' '}{token === zeroAddress ? 'ETH' : meta?.symbol ?? (token ? shortAddr(token) : '')}
          {entry.txHash && ` · ${shortAddr(entry.txHash)}`}
        </div>
      })}
      {jobs.filter(job => job.strategyId === row.config.id).slice(0, 2).map(job =>
        <div className="mono-sm" key={job.id}>
          作业 {job.state} · {job.stage} · 资产位置 {assetLocationLabel[job.assetLocation] ?? job.assetLocation}
          {job.errorCode && <span className="red"> · {job.errorCode}</span>}
          {job.transactions.map(tx => <div key={tx.hash}>
            {tx.stage} {tx.state} · {tx.hash}
          </div>)}
          {canManage && job.state === 'recovery'
            && job.transactions.every(tx => tx.state !== 'sending' && tx.state !== 'sent')
            && <button disabled={busy} onClick={() => void resume(job.id)}>核对链上状态后重试</button>}
        </div>)}
      <button disabled={!accessToken || busy} onClick={() => void preview(row.config.id)}>查看只读执行预览</button>
    </div>)}
    {plan && <div className="card inset-card mono-sm">
      <b>执行预览 · 区块 {plan.observedBlock}</b>
      <div>旧区间 {plan.old.tickLower}–{plan.old.tickUpper} · {plan.old.shares} 份额</div>
      <div>退出：{plan.exit.method} · 本金 {plan.exit.principal0}/{plan.exit.principal1}（最少到账 {plan.exit.amount0Min}/{plan.exit.amount1Min}）</div>
      <div>当前待领费用 {plan.exit.claimable0}/{plan.exit.claimable1} · 领取费率上限 {plan.exit.claimFeeBps} bps</div>
      <div>按当前价格的参考新区间 {plan.indicativeRecenter.tickLower}–{plan.indicativeRecenter.tickUpper}</div>
      <div className="dim">实际新区间和换币数量将在退出到账后重新计算。</div>
    </div>}
    {canManage && <>
      <div className="dim">选择已有份额区间创建监控策略。</div>
      <div className="row gap-sm">
        <label>执行方式 <select value={executionMode} onChange={event => setExecutionMode(event.target.value as 'notify_only' | 'executor_auto')}>
          <option value="notify_only">仅监控通知</option>
          <option value="executor_auto" disabled={FABLES_AUTO_POOL_IDS.size === 0}>自动退出并重开</option>
        </select></label>
        {executionMode === 'executor_auto' && <>
          <label>签名钱包 <select value={walletId} onChange={event => setWalletId(event.target.value)}>
            <option value="">选择钱包</option>
            {wallets.filter(wallet => wallet.address.toLowerCase() === owner.toLowerCase()).map(wallet =>
              <option value={wallet.id} key={wallet.id}>{wallet.label}</option>)}
          </select></label>
          <label>每日换币上限（计价币） <input value={dailyTurnover} onChange={event => setDailyTurnover(event.target.value)} /></label>
        </>}
      </div>
      <div className="row gap-sm">
        <label>下侧宽度 % <input value={lowerPct} onChange={event => setLowerPct(event.target.value)} /></label>
        <label>上侧宽度 % <input value={upperPct} onChange={event => setUpperPct(event.target.value)} /></label>
        <label>越界确认秒数 <input value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
        <label>领取费率上限 bps <input value={claimFeeBps} onChange={event => setClaimFeeBps(event.target.value)} /></label>
        <label>已领手续费 <select value={feeHandling} onChange={event => setFeeHandling(event.target.value as FablesStrategyConfig['fees']['handling'])}>
          <option value="reinvest">计入新 LP</option>
          <option value="hold_tokens">留在钱包</option>
          <option value="convert_to_quote">换成计价币留在钱包</option>
        </select></label>
      </div>
      <label><input type="checkbox" checked={legacyConsent} onChange={event => setLegacyConsent(event.target.checked)} /> 允许旧版池使用无领取费率上限的退出调用</label>
      {positions.data?.positions.filter(position => position.shares > 0n && position.staked === 0n).map(position => {
        const key = position.rangeId.toString()
        const currency0 = position.pool.key.currency0
        const currency1 = position.pool.key.currency1
        const existing = strategies.some(row => row.config.enabled && row.config.positionRef.rangeId === key
          && row.config.positionRef.poolId.toLowerCase() === position.pool.id.toLowerCase())
        return <div className="card inset-card" key={`${position.pool.id}:${key}`}>
          <div className="mono-sm">{shortAddr(position.pool.id)} · ticks {position.tickLower}–{position.tickUpper}</div>
          <label>计价币 <select value={quoteToken[key] ?? currency1} onChange={event => setQuoteToken(values => ({ ...values, [key]: event.target.value as Address }))}>
            <option value={currency0}>{positions.data?.tokens[currency0.toLowerCase()]?.symbol ?? shortAddr(currency0)}</option>
            <option value={currency1}>{positions.data?.tokens[currency1.toLowerCase()]?.symbol ?? shortAddr(currency1)}</option>
          </select></label>
          <button disabled={busy || existing || (executionMode === 'executor_auto' && !FABLES_AUTO_POOL_IDS.has(position.pool.id.toLowerCase()))}
            onClick={() => void save(position)}>{existing ? '已有策略' : executionMode === 'executor_auto' ? '创建自动策略' : '创建监控策略'}</button>
        </div>
      })}
    </>}
  </section>
}
