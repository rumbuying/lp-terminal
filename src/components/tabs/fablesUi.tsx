import type { ReactNode } from 'react'
import { EXPLORER } from '../../config/addresses'
import type { FablesToken } from '../../hooks/useFablesPositions'
import { fmtAmount, shortAddr } from '../../lib/format'

/** Same cell vocabulary as the position cards' PCell — label over value with
 *  dim sub-lines, so a Fables card reads exactly like every other card. */
export function PCell(props: { k: ReactNode; tip?: string; v: ReactNode; subs?: ReactNode[] }) {
  return (
    <div className="pcell">
      <span className="k" title={props.tip}>{props.k}</span>
      <span className="v">{props.v}</span>
      {props.subs?.map((s, i) => <span key={i} className="sub">{s}</span>)}
    </div>
  )
}

export function quantity(raw: bigint, token: FablesToken | undefined): string {
  return token?.decimals === null || token?.decimals === undefined
    ? `${raw} raw units`
    : fmtAmount(raw, token.decimals)
}

export function priceAtTick(tick: number, token0: FablesToken | undefined, token1: FablesToken | undefined): string {
  if (token0?.decimals === null || token0?.decimals === undefined
    || token1?.decimals === null || token1?.decimals === undefined) return `tick ${tick}`
  const price = Math.pow(1.0001, tick) * Math.pow(10, token0.decimals - token1.decimals)
  return Number.isFinite(price) && price > 0 ? price.toPrecision(6) : `tick ${tick}`
}

/** The share-range ID is a 76-digit uint — show the tail, keep the full value
 *  one hover away. */
export function shortRangeId(rangeId: bigint): string {
  const raw = rangeId.toString()
  return raw.length > 14 ? `…${raw.slice(-10)}` : raw
}

export type FablesStateTone = 'green' | 'amber' | 'red' | 'cyan' | 'dim'

const strategyStates: Record<string, { label: string; tone: FablesStateTone }> = {
  monitoring: { label: '区间内监控', tone: 'green' },
  confirming: { label: '越界确认中', tone: 'amber' },
  dry_run_ready: { label: '越界待执行', tone: 'amber' },
  awaiting_manual: { label: '越界待手动处理', tone: 'amber' },
  executing: { label: '执行中', tone: 'cyan' },
  recovery: { label: '待恢复', tone: 'red' },
  paused: { label: '暂停', tone: 'amber' },
  read_error: { label: '读取异常', tone: 'red' },
  disabled: { label: '已停用', tone: 'dim' },
}

export function fablesStrategyState(state: string): { label: string; tone: FablesStateTone } {
  return strategyStates[state] ?? { label: state, tone: 'dim' }
}

export const jobStateLabel: Record<string, string> = {
  planned: '已排队', running: '执行中', recovery: '待恢复',
  completed: '已完成', failed: '失败', cancelled: '已取消：价格回到区间',
}

export const assetLocationLabel: Record<string, string> = {
  old_lp_or_wallet: '旧 LP 或钱包',
  wallet_and_possible_old_fees: '钱包及旧区间待领费用',
  new_lp_pending_verification: '新 LP 待核实',
}

export const feeHandlingLabel: Record<string, string> = {
  reinvest: '计入新 LP',
  hold_tokens: '留在钱包',
  convert_to_quote: '换成计价币留在钱包',
}

export function TxLink({ hash }: { hash: string }) {
  return (
    <a className="dim mono-sm" href={`${EXPLORER}/tx/${hash}`} target="_blank" rel="noreferrer"
      title={hash}>{shortAddr(hash)}↗</a>
  )
}

export function AddrLink({ address, label }: { address: string; label?: string }) {
  return (
    <a className="dim mono-sm" href={`${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer"
      title={address}>{label ?? shortAddr(address)}↗</a>
  )
}
