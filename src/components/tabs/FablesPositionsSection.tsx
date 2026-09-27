import { useState } from 'react'
import type { Address, Hex } from 'viem'
import { CHAIN } from '../../config/chains'
import { useFablesPositions, type FablesManualRef, type FablesToken } from '../../hooks/useFablesPositions'
import { useFablesManualRefs } from '../../hooks/useFablesManualRefs'
import { fablesRangeId, readFablesPools, readFablesPosition } from '../../lib/fables'
import { fmtAmount, shortAddr } from '../../lib/format'
import { publicRpcClient } from '../../lib/publicRpcClient'

function quantity(raw: bigint, token: FablesToken | undefined): string {
  return token?.decimals === null || token?.decimals === undefined
    ? `${raw} raw units`
    : fmtAmount(raw, token.decimals)
}

function priceAtTick(tick: number, token0: FablesToken | undefined, token1: FablesToken | undefined): string {
  if (token0?.decimals === null || token0?.decimals === undefined
    || token1?.decimals === null || token1?.decimals === undefined) return `tick ${tick}`
  const price = Math.pow(1.0001, tick) * Math.pow(10, token0.decimals - token1.decimals)
  return Number.isFinite(price) && price > 0 ? price.toPrecision(6) : `tick ${tick}`
}

export function FablesPositionsSection({ owner }: { owner: Address }) {
  const { manualRefs, saveManualRefs } = useFablesManualRefs(owner)
  const [poolId, setPoolId] = useState('')
  const [lower, setLower] = useState('')
  const [upper, setUpper] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const query = useFablesPositions(owner, manualRefs)
  if (CHAIN.id !== 4663) return null
  const importPosition = async () => {
    setImportBusy(true)
    setImportError(null)
    try {
      if (!/^0x[0-9a-fA-F]{64}$/.test(poolId)) throw new Error('池 ID 必须为 bytes32')
      const tickLower = Number(lower)
      const tickUpper = Number(upper)
      if (!Number.isInteger(tickLower) || !Number.isInteger(tickUpper) || tickLower >= tickUpper)
        throw new Error('tick 区间无效')
      const pools = await readFablesPools(publicRpcClient)
      const pool = pools.find(row => row.id.toLowerCase() === poolId.toLowerCase())
      if (!pool?.active || !pool.reviewed) throw new Error('池未通过 Fables 身份校验')
      if (tickLower % pool.key.tickSpacing !== 0 || tickUpper % pool.key.tickSpacing !== 0)
        throw new Error('tick 未按池的 tickSpacing 对齐')
      const ref: FablesManualRef = { poolId: pool.id as Hex, tickLower, tickUpper }
      await readFablesPosition(publicRpcClient, {
        owner, hook: pool.key.hooks, rangeId: fablesRangeId(pool.id, tickLower, tickUpper), pools,
      })
      const next = [...manualRefs.filter(item =>
        item.poolId.toLowerCase() !== ref.poolId.toLowerCase()
        || item.tickLower !== ref.tickLower || item.tickUpper !== ref.tickUpper), ref]
      saveManualRefs(next)
      setPoolId(''); setLower(''); setUpper('')
    } catch (error) { setImportError(String(error)) }
    finally { setImportBusy(false) }
  }
  return <section>
    <div className="section-title">Fables LP · {query.data?.positions.length ?? '…'}</div>
    {query.isPending && <div className="dim">正在核对 Fables 份额和区间…</div>}
    {query.isError && <div className="red">Fables 仓位读取失败：{String(query.error)}</div>}
    {query.data?.indexError && <div className="amber">事件索引暂不可用；仅显示已手动导入的仓位。{query.data.indexError}</div>}
    {query.data?.positions.length === 0 && <div className="dim">未发现 Fables 份额仓位。</div>}
    {query.data?.positions.map(position => {
      const token0 = query.data.tokens[position.pool.key.currency0.toLowerCase()]
      const token1 = query.data.tokens[position.pool.key.currency1.toLowerCase()]
      const label0 = token0?.symbol ?? shortAddr(position.pool.key.currency0)
      const label1 = token1?.symbol ?? shortAddr(position.pool.key.currency1)
      return <div className="card" key={`${position.pool.id}:${position.rangeId}`}>
        <div className="mono-sm"><b>{label0}/{label1}</b> · Fables · 池 {shortAddr(position.pool.id)}</div>
        <div className="mono-sm dim">Hook {shortAddr(position.pool.key.hooks)} · 区间 ID {position.rangeId.toString()}</div>
        <div className="mono-sm">
          当前价格 {priceAtTick(position.tick, token0, token1)} {label1}/{label0} · 区间
          {' '}{priceAtTick(position.tickLower, token0, token1)}–{priceAtTick(position.tickUpper, token0, token1)}
          {' '}({position.tickLower}–{position.tickUpper} ticks)
        </div>
        <div className={position.inRange ? 'green' : 'red'}>{position.inRange ? '区间内' : '已离开区间'}</div>
        <div className="mono-sm">份额 {position.shares.toString()} · 本金 {quantity(position.amount0, token0)} {label0} + {quantity(position.amount1, token1)} {label1}</div>
        <div className="mono-sm">待领净费用 {quantity(position.claimable0, token0)} {label0} + {quantity(position.claimable1, token1)} {label1}</div>
        {position.staked > 0n && <div className="amber">此仓位已质押，自动再平衡暂不支持。</div>}
        {position.claimPaused && <div className="amber">费用领取已暂停。</div>}
        <div className="dim mono-sm">链上区块 {position.observedBlock.toString()}</div>
      </div>
    })}
    <div className="mono-sm" style={{ marginTop: 10 }}>手动导入 Fables 区间（池 ID、下 tick、上 tick）</div>
    <div className="row gap-sm">
      <input aria-label="Fables 池 ID" placeholder="0x… PoolId" value={poolId} onChange={event => setPoolId(event.target.value.trim())} />
      <input aria-label="下 tick" placeholder="下 tick" value={lower} onChange={event => setLower(event.target.value)} />
      <input aria-label="上 tick" placeholder="上 tick" value={upper} onChange={event => setUpper(event.target.value)} />
      <button disabled={importBusy} onClick={() => void importPosition()}>{importBusy ? '核对中…' : '导入'}</button>
    </div>
    {importError && <div className="red mono-sm">{importError}</div>}
  </section>
}
