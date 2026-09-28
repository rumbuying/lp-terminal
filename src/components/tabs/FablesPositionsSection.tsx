import { useState } from 'react'
import { formatUnits, zeroAddress, type Address, type Hex } from 'viem'
import { EXPLORER } from '../../config/addresses'
import { CHAIN } from '../../config/chains'
import { robinhoodConfig } from '../../config/chains/robinhood'
import { PairAddrs } from '../PairAddrs'
import { RangeBar } from '../RangeBar'
import { Badge } from '../ui'
import type { TokenInfo } from '../../types'
import { useTokenUsd } from '../../hooks/useTokenUsd'
import { useFablesPositions, type FablesManualRef, type FablesToken } from '../../hooks/useFablesPositions'
import { useFablesManualRefs } from '../../hooks/useFablesManualRefs'
import { fablesRangeId, readFablesPools, readFablesPosition, type FablesPosition } from '../../lib/fables'
import { fmtAmount, fmtUsd, shortAddr } from '../../lib/format'
import { publicRpcClient } from '../../lib/publicRpcClient'
import { PCell, priceAtTick, quantity, shortRangeId } from './fablesUi'

function asTokenInfo(token: FablesToken | undefined): TokenInfo {
  const address = token?.address ?? zeroAddress
  return {
    address,
    symbol: token?.symbol ?? shortAddr(address),
    decimals: token?.decimals ?? 18,
    native: address.toLowerCase() === zeroAddress,
  }
}

function FablesPositionCard({ position, tokens }: {
  position: FablesPosition
  tokens: Record<string, FablesToken>
}) {
  const token0 = tokens[position.pool.key.currency0.toLowerCase()]
  const token1 = tokens[position.pool.key.currency1.toLowerCase()]
  const label0 = token0?.symbol ?? shortAddr(position.pool.key.currency0)
  const label1 = token1?.symbol ?? shortAddr(position.pool.key.currency1)
  const dec0 = token0?.decimals ?? 18
  const dec1 = token1?.decimals ?? 18
  // Same USD anchor the other position cards use: dexscreener's most-liquid
  // pair per token, with the pool's own price as the cross for the second leg.
  const usd0 = useTokenUsd(asTokenInfo(token0)).data
  const usd1 = useTokenUsd(asTokenInfo(token1)).data
  const unit0 = Number(formatUnits(position.amount0, dec0))
  const unit1 = Number(formatUnits(position.amount1, dec1))
  const fee0 = Number(formatUnits(position.claimable0, dec0))
  const fee1 = Number(formatUnits(position.claimable1, dec1))
  const valueUsd = usd0 != null && usd1 != null ? unit0 * usd0 + unit1 * usd1 : null
  const feesUsd = usd0 != null && usd1 != null ? fee0 * usd0 + fee1 * usd1 : null
  const hasClaimable = position.claimable0 > 0n || position.claimable1 > 0n
  return <div className="card">
    <div className="card-head">
      <PairAddrs className="card-title" sym0={label0} sym1={label1}
        token0={position.pool.key.currency0} token1={position.pool.key.currency1}
        pool={robinhoodConfig.uniV4!.POOL_MANAGER}
        poolId={position.pool.id} hooks={position.pool.key.hooks} />
      <Badge tone="cyan">Fables 份额</Badge>
      <Badge tone={position.inRange ? 'green' : 'red'}>{position.inRange ? '区间内' : '已离开区间'}</Badge>
      {position.staked > 0n && <Badge tone="amber">已质押</Badge>}
      {position.claimPaused && <Badge tone="amber">领取暂停</Badge>}
      <a className="dim mono-sm" href={`${EXPLORER}/address/${position.pool.key.hooks}`}
        target="_blank" rel="noreferrer" title={position.pool.key.hooks}>
        Hook {shortAddr(position.pool.key.hooks)}↗
      </a>
    </div>
    <div className="pmetrics mono-sm">
      <PCell k="仓位价值"
        v={valueUsd != null ? <b>≈ {fmtUsd(valueUsd)}</b> : <span className="dim">暂无美元锚</span>}
        subs={[
          `本金 ${quantity(position.amount0, token0)} ${label0} + ${quantity(position.amount1, token1)} ${label1}`,
          `份额 ${fmtAmount(position.shares, 18)} · 区间全部 ${position.totalShares.toString()}`,
        ]} />
      <PCell k="待领净费用"
        v={hasClaimable
          ? <span className="amber">{quantity(position.claimable0, token0)} {label0} + {quantity(position.claimable1, token1)} {label1}</span>
          : <span className="dim">—</span>}
        subs={(hasClaimable && feesUsd != null ? [`≈ ${fmtUsd(feesUsd)}`] : [])
          .concat(position.claimFeeBps > 0 ? [`领取费率上限 ${position.claimFeeBps} bps`] : [])} />
      <PCell k="区间"
        v={`${priceAtTick(position.tickLower, token0, token1)} – ${priceAtTick(position.tickUpper, token0, token1)} ${label1}/${label0}`}
        subs={[`当前 ${priceAtTick(position.tick, token0, token1)} ${label1}/${label0} · tick ${position.tick}`]} />
    </div>
    <RangeBar tickLower={position.tickLower} tickUpper={position.tickUpper} tick={position.tick}
      sqrtPriceX96={position.sqrtPriceX96} dec0={dec0} dec1={dec1} sym0={label0} sym1={label1} />
    <div className="dim mono-sm">
      链上区块 {position.observedBlock.toString()} · 池 {shortAddr(position.pool.id)} · 区间 ID {shortRangeId(position.rangeId)}
    </div>
  </div>
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
    {query.data?.positions.map(position =>
      <FablesPositionCard key={`${position.pool.id}:${position.rangeId}`}
        position={position} tokens={query.data.tokens} />)}
    <details className="card" style={{ marginTop: 10 }}>
      <summary className="card-title" style={{ cursor: 'pointer' }}>手动导入 Fables 区间（池 ID、下 tick、上 tick）</summary>
      <div className="row gap-sm" style={{ marginTop: 10 }}>
        <input aria-label="Fables 池 ID" placeholder="0x… PoolId" value={poolId} onChange={event => setPoolId(event.target.value.trim())} />
        <input aria-label="下 tick" placeholder="下 tick" value={lower} onChange={event => setLower(event.target.value)} />
        <input aria-label="上 tick" placeholder="上 tick" value={upper} onChange={event => setUpper(event.target.value)} />
        <button disabled={importBusy} onClick={() => void importPosition()}>{importBusy ? '核对中…' : '导入'}</button>
      </div>
      {importError && <div className="red mono-sm">{importError}</div>}
    </details>
  </section>
}
