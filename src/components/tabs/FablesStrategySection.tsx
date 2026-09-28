import { useEffect, useState } from 'react'
import { formatUnits, parseUnits, zeroAddress, type Address } from 'viem'
import { EXPLORER } from '../../config/addresses'
import { fmtNum } from '../../lib/format'
import type { FablesStrategyConfig } from '../../../shared/strategy/types'
import { robinhoodConfig } from '../../config/chains/robinhood'
import { FABLES_AUTO_POOL_IDS } from '../../config/fables'
import { useFablesPositions } from '../../hooks/useFablesPositions'
import { useFablesManualRefs } from '../../hooks/useFablesManualRefs'
import { executorFablesJobs, executorFablesStrategies, executorWallets,
  planExecutorFablesStrategy, rebroadcastExecutorFablesTx, resumeExecutorFablesJob, saveExecutorFablesStrategy,
  type ExecutorFablesJob, type ExecutorFablesPlan, type ExecutorFablesStrategy,
  type ExecutorWallet } from '../../lib/executorClient'
import { shortAddr, fmtUsd } from '../../lib/format'
import { Badge, Btn } from '../ui'
import { asTokenInfo, assetLocationLabel, feeHandlingLabel, fablesStrategyState, jobStateLabel,
  PCell, TxLink, shortRangeId } from './fablesUi'
import { useTokenUsd } from '../../hooks/useTokenUsd'

const preferredQuoteToken = (currency0: Address, currency1: Address): Address => {
  const stable = robinhoodConfig.addr.STABLE.toLowerCase()
  if (currency0.toLowerCase() === stable || currency1.toLowerCase() === stable)
    return robinhoodConfig.addr.STABLE
  if (currency0.toLowerCase() === zeroAddress || currency1.toLowerCase() === zeroAddress)
    return zeroAddress
  return currency1
}

export function FablesStrategySection({ owner, accessToken, canManage }: {
  owner: Address; accessToken: string; canManage: boolean
}) {
  const { manualRefs } = useFablesManualRefs(owner)
  const positions = useFablesPositions(owner, manualRefs)
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
  const [dailyTurnover, setDailyTurnover] = useState<Record<string, string>>({})
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

  // USD anchor for the position metrics — the same dexscreener prices the
  // position tab values with, keyed off the pool currencies of any live read.
  const firstRead = positions.data?.positions[0]
  const riskMeta = firstRead ? positions.data?.tokens[firstRead.pool.key.currency1.toLowerCase()] : undefined
  const usdNative = useTokenUsd(asTokenInfo(firstRead
    ? { address: firstRead.pool.key.currency0, symbol: 'ETH', decimals: 18 } : undefined)).data
  const usdRisk = useTokenUsd(asTokenInfo(firstRead
    ? { address: firstRead.pool.key.currency1,
        symbol: riskMeta?.symbol ?? '',
        decimals: riskMeta?.decimals ?? 18 }
    : undefined)).data

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
      const positionKey = position.rangeId.toString()
      const selectedQuote = quoteToken[positionKey] ?? preferredQuoteToken(currency0, currency1)
      const riskToken = selectedQuote.toLowerCase() === currency0.toLowerCase() ? currency1 : currency0
      const auto = executionMode === 'executor_auto'
      const selectedWallet = wallets.find(wallet => wallet.id === walletId && wallet.address.toLowerCase() === owner.toLowerCase())
      const turnoverLimit = dailyTurnover[positionKey]?.trim() ?? ''
      if (auto) {
        if (!FABLES_AUTO_POOL_IDS.has(position.pool.id.toLowerCase()) || !selectedWallet)
          throw new Error('自动执行需要已批准的池和当前所有者的钱包')
        const decimals = selectedQuote.toLowerCase() === zeroAddress
          ? 18 : positions.data?.tokens[selectedQuote.toLowerCase()]?.decimals
        if (decimals == null || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(turnoverLimit))
          throw new Error('请填写此仓位计价币的正数每日换币上限')
        try {
          if (parseUnits(turnoverLimit, decimals) <= 0n) throw new Error('zero turnover')
        } catch { throw new Error('每日换币上限必须为正数，且小数位不能超过计价币精度') }
      }
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
              maxDailyTurnoverQuote: turnoverLimit }
          : { mode: 'notify_only', dryRun: false },
        revision: 1, createdAt: now, updatedAt: now,
      }
      await saveExecutorFablesStrategy(accessToken, config)
      await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const preview = async (id: string) => {
    setBusy(true); setError(null)
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
  const rebroadcast = async (id: string, ordinal: number) => {
    setBusy(true); setError(null)
    try { await rebroadcastExecutorFablesTx(accessToken, id, ordinal); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const tokenLabel = (address: Address) => address.toLowerCase() === zeroAddress
    ? 'ETH' : positions.data?.tokens[address.toLowerCase()]?.symbol ?? shortAddr(address)

  return <section>
    <div className="section-title">Fables LP 策略</div>
    {!accessToken && <div className="dim">连接策略执行器后可查看 Fables 策略。</div>}
    {error && <div className="red mono-sm">{error}</div>}
    {strategies.map(row => {
      const state = fablesStrategyState(row.state)
      const ref = row.config.positionRef
      const jobRows = jobs.filter(job => job.strategyId === row.config.id)
      const feeClaims = row.recentLedger?.filter(entry => entry.kind === 'fees_claimed').slice(0, 4) ?? []
      const quote = row.config.quoteToken
      // 同一套累计口径（最近 100 条账本 / 最近 50 个作业），换币与 gas 均按币种分开计
      const ledger = row.recentLedger ?? []
      const sumFor = (kind: string, native: boolean) => ledger
        .filter(entry => entry.kind === kind
          && (native ? (entry.token?.toLowerCase() ?? zeroAddress) === zeroAddress
            : !!entry.token && entry.token.toLowerCase() !== zeroAddress))
        .reduce((sum, entry) => sum + BigInt(entry.amount ?? '0'), 0n)
      const feeEth = sumFor('fees_claimed', true)
      const feeToken = sumFor('fees_claimed', false)
      const gasEth = sumFor('gas', true)
      const netEth = feeEth - gasEth
      const fmt18 = (value: bigint) => fmtNum(Number(formatUnits(value, 18)), 6)
      const completed = jobRows.filter(job => job.state === 'completed').length
      // UP33 卡只展示最近一次执行；未完成的作业优先且最多两条，避免把恢复中的事藏起来
      const openJobs = jobRows.filter(job => ['recovery', 'running', 'planned'].includes(job.state))
      const displayJobs = openJobs.length > 0 ? openJobs.slice(0, 2) : jobRows.slice(0, 1)
      const livePosition = positions.data?.positions.find(position =>
        position.pool.id.toLowerCase() === ref.poolId.toLowerCase()
        && position.rangeId.toString() === ref.rangeId)
      return <div className="card" key={row.config.id}>
        <div className="card-head">
          <span className="card-title">{row.config.name}</span>
          <Badge tone={state.tone}>{state.label}</Badge>
          {row.config.execution.dryRun && <Badge tone="amber">dry run</Badge>}
          <Badge tone="dim">{row.config.execution.mode === 'executor_auto' ? '自动退出并重开' : '仅监控'}</Badge>
          <Badge tone="dim">±{row.config.range.lowerPct}/{row.config.range.upperPct}%</Badge>
          <div className="card-actions">
            <Btn busy={busy} disabled={!accessToken} onClick={() => void preview(row.config.id)}>只读执行预览</Btn>
          </div>
        </div>
        <div className="performance-grid">
          <div className="performance-metric">
            <span>累计重开</span>
            <strong>{completed}</strong>
            <small>已完成的再平衡周期</small>
          </div>
          <div className="performance-metric">
            <span>累计手续费</span>
            <strong className="green">{fmt18(feeEth)} ETH</strong>
            <small>+ {fmt18(feeToken)} PONS</small>
          </div>
          <div className="performance-metric">
            <span>累计 gas</span>
            <strong>{fmt18(gasEth)} ETH</strong>
            <small>净手续费 ≈ <span className={netEth >= 0n ? 'green' : 'red'}>{fmt18(netEth)} ETH</span> + {fmt18(feeToken)} PONS</small>
          </div>
          <div className="performance-metric">
            <span>当前仓位</span>
            <strong>{livePosition ? fmtNum(Number(formatUnits(livePosition.shares, 18)), 5) : '—'}</strong>
            <small>{livePosition
              ? `本金 ${fmt18(livePosition.amount0)} ETH + ${fmt18(livePosition.amount1)} PONS`
              : '与链上区间核对中'}</small>
            {livePosition && usdNative != null && usdRisk != null && (() => {
              const posUsd = Number(formatUnits(livePosition.amount0, 18)) * usdNative
                + Number(formatUnits(livePosition.amount1, 18)) * usdRisk
              return Number.isFinite(posUsd) && posUsd > 0
                ? <small>≈ <b>{fmtUsd(posUsd)}</b></small>
                : null
            })()}
          </div>
        </div>
        <div className="kv mono-sm">
          <span>池 {shortAddr(ref.poolId)}</span>
          <span>Hook {shortAddr(ref.hook)}</span>
          <span>区间 {ref.tickLower}–{ref.tickUpper} ticks</span>
          <span title={ref.rangeId}>份额区间 ID {shortRangeId(BigInt(ref.rangeId))}</span>
          {row.monitor?.lastTick !== undefined && (
            <span>当前 tick {row.monitor.lastTick}
              {row.monitor.outSide ? `（${row.monitor.outSide === 'lower' ? '低于' : '高于'}区间）` : '（区间内）'}
            </span>
          )}
        </div>
        <div className={row.monitor?.error ? 'red mono-sm' : 'green mono-sm'}>
          {row.monitor?.error
            ?? `监控正常${row.monitor?.lastBlock ? ` · 区块 ${row.monitor.lastBlock}` : ''}`}
        </div>
        <div className="strategy-performance">
          <div className="performance-foot mono-sm">
            <span>区间宽度 ±{row.config.range.lowerPct}/{row.config.range.upperPct}%</span>
            <span>越界确认 {row.config.trigger.confirmationSeconds}s</span>
            <span>冷却 {row.config.trigger.cooldownMinutes}min</span>
            <span>轮询 {row.config.trigger.pollSeconds}s</span>
            {row.config.execution.maxDailyTurnoverQuote
              && <span>日换币上限 {row.config.execution.maxDailyTurnoverQuote} {tokenLabel(quote)}</span>}
            <span>已领手续费 {feeHandlingLabel[row.config.fees.handling] ?? row.config.fees.handling}</span>
          </div>
        </div>
        {feeClaims.length > 0 && (() => {
          const claimText = (entry: NonNullable<ExecutorFablesStrategy['recentLedger']>[number]) => {
            const token = entry.token?.toLowerCase()
            const decimals = token === zeroAddress ? 18 : positions.data?.tokens[token ?? '']?.decimals
            return `${entry.amount && decimals != null ? formatUnits(BigInt(entry.amount), decimals) : entry.amount} ${token === zeroAddress ? 'ETH' : token ? positions.data?.tokens[token]?.symbol ?? shortAddr(token) : ''}`
          }
          return <div className="pmetrics compact mono-sm">
            <PCell k="已领取手续费" v={claimText(feeClaims[0])}
              subs={feeClaims.slice(1).map((entry, index) => <span key={`${entry.jobId}:${index}`}>
                {claimText(entry)}{entry.txHash ? ' · ' : ''}
                {entry.txHash && <TxLink hash={entry.txHash} />}
              </span>)} />
          </div>
        })()}
        {displayJobs.map(job =>
          <div className="mono-sm" key={job.id} style={{ marginTop: 8 }}>
            <div>
              作业 {jobStateLabel[job.state] ?? job.state} · {job.stage} · 资产位置 {assetLocationLabel[job.assetLocation] ?? job.assetLocation}
              {job.errorCode && job.state !== 'cancelled' && <span className="red"> · {job.errorCode}</span>}
            </div>
            {job.transactions.length > 0 && (
              <details className="strategy-tx-history mono-sm" open={job.state === 'recovery'}>
                <summary>查看最近一次执行的 {job.transactions.length} 笔交易</summary>
                <div className="kv">
                  {job.transactions.map(tx => (
                    <a key={tx.hash} href={`${EXPLORER}/tx/${tx.hash}`} target="_blank" rel="noreferrer"
                      title={tx.hash}>
                      {tx.stage} {tx.state} ↗
                      {tx.blockNumber ? ` · 区块 ${tx.blockNumber}` : ''}
                    </a>
                  ))}
                </div>
                {canManage && job.state === 'recovery' && (
                  <div className="row gap-sm">
                    {job.transactions.filter(tx => tx.canRebroadcast).map(tx => (
                      <button key={tx.ordinal} disabled={busy} onClick={() => void rebroadcast(job.id, tx.ordinal)}>
                        重播同一笔已签名交易（{tx.stage}）
                      </button>
                    ))}
                    {job.transactions.every(tx => tx.state !== 'sending' && tx.state !== 'sent')
                      && <button disabled={busy} onClick={() => void resume(job.id)}>核对链上状态后重试</button>}
                  </div>
                )}
              </details>
            )}
          </div>)}
        {plan && plan.strategyId === row.config.id && <div className="card inset-card mono-sm">
          <b>执行预览 · 区块 {plan.observedBlock}</b>
          <div>旧区间 {plan.old.tickLower}–{plan.old.tickUpper} · {plan.old.shares} 份额</div>
          <div>退出：{plan.exit.method} · 本金 {plan.exit.principal0}/{plan.exit.principal1}（最少到账 {plan.exit.amount0Min}/{plan.exit.amount1Min}）</div>
          <div>当前待领费用 {plan.exit.claimable0}/{plan.exit.claimable1} · 需允许的领取费率 {plan.exit.claimFeeBps} bps（策略上限 {plan.constraints.maxClaimFeeBps} bps）</div>
          <div>按当前价格的参考新区间 {plan.indicativeRecenter.tickLower}–{plan.indicativeRecenter.tickUpper}</div>
          <div>参考目标价值占比：{tokenLabel(plan.indicativeRecenter.currency0)} {(plan.indicativeRecenter.targetValueBps0 / 100).toFixed(2)}% · {tokenLabel(plan.indicativeRecenter.currency1)} {(plan.indicativeRecenter.targetValueBps1 / 100).toFixed(2)}%</div>
          <div>交易约束：最大滑点 {plan.constraints.maxSlippageBps} bps · 最大换币价格冲击 {plan.constraints.maxSwapImpactBps} bps · 计划有效期 {plan.constraints.maxPlanAgeSeconds} 秒</div>
          <div>原生币 gas 预留至少 {formatUnits(BigInt(plan.constraints.minNativeGasReserveWei), 18)} ETH
            {plan.constraints.maxGasPriceWei && ` · gas 单价上限 ${formatUnits(BigInt(plan.constraints.maxGasPriceWei), 9)} gwei`}</div>
          {plan.constraints.maxDailyTurnoverQuote && <div>每日换币上限 {plan.constraints.maxDailyTurnoverQuote} {tokenLabel(plan.constraints.quoteToken)}</div>}
          {plan.exit.method === 'withdraw' && <div>旧版池无领取费率上限退出：{plan.constraints.allowLegacyUnboundedFeeExit ? '已授权' : '未授权'}</div>}
          <div className="dim">价值占比按当前池价估算；实际新区间、资产比例和换币数量将在退出到账后重新计算。</div>
        </div>}
      </div>
    })}
    {canManage && <details className="card" style={{ marginTop: 12 }} open={strategies.length === 0}>
      <summary className="card-title" style={{ cursor: 'pointer' }}>从已有份额区间创建策略</summary>
      <div className="dim" style={{ marginTop: 10 }}>选择已有份额区间创建监控策略。</div>
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
        const selectedQuote = quoteToken[key] ?? preferredQuoteToken(currency0, currency1)
        const existing = strategies.some(row => row.config.enabled && row.config.positionRef.rangeId === key
          && row.config.positionRef.poolId.toLowerCase() === position.pool.id.toLowerCase())
        return <div className="card inset-card" key={`${position.pool.id}:${key}`}>
          <div className="mono-sm">{shortAddr(position.pool.id)} · ticks {position.tickLower}–{position.tickUpper}</div>
          <label>计价币 <select value={selectedQuote} onChange={event => {
            setQuoteToken(values => ({ ...values, [key]: event.target.value as Address }))
            setDailyTurnover(values => { const next = { ...values }; delete next[key]; return next })
          }}>
            <option value={currency0}>{tokenLabel(currency0)}</option>
            <option value={currency1}>{tokenLabel(currency1)}</option>
          </select></label>
          {executionMode === 'executor_auto' && <label>每日换币上限（{tokenLabel(selectedQuote)}）
            <input value={dailyTurnover[key] ?? ''} placeholder="请输入正数，可含小数"
              onChange={event => setDailyTurnover(values => ({ ...values, [key]: event.target.value }))} />
          </label>}
          <button disabled={busy || existing || (executionMode === 'executor_auto' && !FABLES_AUTO_POOL_IDS.has(position.pool.id.toLowerCase()))}
            onClick={() => void save(position)}>{existing ? '已有策略' : executionMode === 'executor_auto' ? '创建自动策略' : '创建监控策略'}</button>
        </div>
      })}
    </details>}
  </section>
}
