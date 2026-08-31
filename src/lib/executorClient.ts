import type { StrategyConfig } from '../../shared/strategy/types'
import type { RecommendationMode, RecommendationResponse, RecommendationRisk } from '../../shared/recommendation/types'
import { ACTIVE_IS_BUILD, CHAIN, CHAIN_GATEWAY } from '../config/chains'
import { executorApiPath } from '../config/chains/routes'

export type ExecutorWallet = { id: string; label: string; address: `0x${string}`; createdAt: number; updatedAt: number }
export type LatestJobSummary = {
  id: string
  state: string
  createdAt: number
  updatedAt: number
  confirmedSteps: number
  totalSteps: number
  transactionCount: number
  txHashes: string[]
  errorCode?: string
  result?: Record<string, unknown>
  dryRun: boolean
  recoveryAttempts: number
  recoveryErrorStreak: number
  recoveryLastError?: string
  recoveryNextAt?: number
  recoveryQuarantinedAt?: number
}
export type ExecutorStrategy = { config: StrategyConfig; state: string; updatedAt: number; latestJob?: LatestJobSummary }
export type RecoveryJob = {
  id: string; strategyId: string; state: string; createdAt: number; updatedAt: number
  recoveryAttempts: number; recoveryErrorStreak: number; recoveryLastError?: string; recoveryNextAt?: number; recoveryQuarantinedAt?: number
  steps: Record<string, unknown>[]; transactions: Record<string, unknown>[]
}
export type ExecutorHistoryStrategy = { config: StrategyConfig; archivedAt: number; assetLocation: string; performance: ExecutorPerformance }
export type ExecutorCalendarRow = {
  strategyId: string; name: string; protocol: string; state: string; day: number; date: string; firstObservedAt: number; lastObservedAt: number
  quote: { address: string; symbol: string; decimals: number }; pnlRaw: string | null; feesRaw: string; gasRaw: string; executionRaw: string
  pnlUsdgRaw: string | null
  closingPnlRaw: string | null; closingPnlUsdgRaw: string | null
  openingAssetsRaw: string | null; closingAssetsRaw: string | null; reopens: number
}
export type ExecutorPnlCurvePoint = {
  strategyId: string; bucketAt: number; observedAt: number
  quote: { address: string; symbol: string; decimals: number }
  pnlRaw: string | null; pnlUsdgRaw: string | null
}
export type ExecutorPerformanceCycle = {
  id: string
  oldTokenId: string | null
  newTokenId: string | null
  startedAt: number
  completedAt: number | null
  triggerSide: string | null
  grossFeesQuoteRaw: string
  protocolFeesQuoteRaw: string
  incomeTaxQuoteRaw: string
  netFeesQuoteRaw: string
  gasCostQuoteRaw: string
  executionCostQuoteRaw: string
  maxExecutionImpactBps: number | null
  riskDirection: 'up' | 'down' | null
  rangeScale: number
  txHashes: string[]
}
export type ExecutorPerformance = {
  strategyId: string
  calculatedAt?: number
  state: string
  quote?: { address: string; symbol: string; decimals: number }
  stable?: { address: string; symbol: string; decimals: number; baselineSource?: 'recorded_at_start' | 'historical_weth_usdg' }
  risk?: { address: string; symbol: string }
  price?: { startQuotePerRisk: number | null; currentQuotePerRisk: number | null }
  summary?: {
    reopens: number
    grossFeesQuoteRaw: string
    protocolFeesQuoteRaw: string
    incomeTaxQuoteRaw: string
    netFeesQuoteRaw: string
    gasCostQuoteRaw: string
    openingGasCostQuoteRaw: string
    executionCostQuoteRaw: string
    marketAndLpQuoteRaw: string | null
    currentValueQuoteRaw: string | null
    profitReserveQuoteRaw: string | null
    withdrawnProfitQuoteRaw: string
    withdrawnProfitUsdgRaw: string
    currentUncollectedFeesQuoteRaw: string | null
    currentUnclaimedRewardsQuoteRaw: string | null
    currentUnclaimedTotalQuoteRaw: string | null
    baselineValueQuoteRaw: string | null
    pnlQuoteRaw: string | null
    pnlPct: number | null
    currentValueUsdgRaw: string | null
    baselineValueUsdgRaw: string | null
    gasCostUsdgRaw: string | null
    pnlUsdgRaw: string | null
    pnlUsdgPct: number | null
  }
  baseline?: {
    kind: 'strategy_start' | 'original_mint' | 'first_automated_exit'
    at: number
    tokenId: string | null
    priceSource: 'strategy_start_snapshot' | 'mint_block' | 'pre_decrease_snapshot' | 'trigger_snapshot'
    blockNumber: string
    tick: number
    txHash?: string
  } | null
  currentPosition?: { tokenId: string | null; tick: number | null; tickLower: number | null; tickUpper: number | null }
  unclaimedReward?: { address: string; symbol: string; decimals: number; raw: string; quoteRaw: string | null } | null
  feeTokens?: { address: string; symbol: string; decimals: number; grossRaw: string; protocolRaw: string; netRaw: string }[]
  profitWithdrawals?: {
    id: string
    target: 'USDG' | 'WETH' | 'ETH'
    amountRaw: string
    decimals: number
    quoteValueRaw: string
    usdgValueRaw: string
    gasWei: string
    withdrawnAt: number
    txHashes: string[]
  }[]
  cycles?: ExecutorPerformanceCycle[]
  warnings?: string[]
  error?: string
  rewardValuationError?: string
  stableValuationError?: string
}
export type ExecutorPreflight = {
  ready: boolean
  checkedAt: number
  blockNumber: string
  position: { tokenId: string; owner: string; liquidity: string; observedSide: string }
  range: { tickLower: number; tickUpper: number }
  gas: { gasPriceWei: string; nativeBalanceWei: string; requiredReserveWei: string; decreaseEstimate: string; collectEstimate: string }
  expected: { projectedTurnoverQuoteRaw: string; projectedTurnoverWithHeadroomQuoteRaw: string; positionValueQuoteRaw: string; quoteDecimals: number }
  routes: { source: 'kyber' | 'up33_cl'; tokenIn: string; tokenOut: string; amountIn: string; quotedOut: string; minOut: string; impactBps: string }[]
  limitations: string[]
}

const endpoint = (path: string) => {
  const resolved = executorApiPath(path, CHAIN.key, CHAIN_GATEWAY, ACTIVE_IS_BUILD)
  if (!resolved) throw new Error(`strategy executor is unavailable for ${CHAIN.name} on this host`)
  return resolved
}

export const executorAdminTokenStorageKey = (chainKey = CHAIN.key) =>
  `lp-terminal:executor:${chainKey}:admin-token:v2`

export const executorWalletSessionStorageKey = (address: string, chainKey = CHAIN.key) =>
  `lp-terminal:executor:${chainKey}:wallet-session:v2:${address.toLowerCase()}`

async function request<T>(path: string, token?: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (token) headers.set('authorization', `Bearer ${token}`)
  if (init.body) headers.set('content-type', 'application/json')
  const response = await fetch(endpoint(path), { ...init, headers, cache: 'no-store' })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  const servedChainId = Number(response.headers.get('x-lp-chain-id'))
  if (servedChainId !== CHAIN.id)
    throw new Error(`strategy executor chain mismatch: expected ${CHAIN.id}, received ${Number.isFinite(servedChainId) ? servedChainId : 'unknown'}`)
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `executor request failed (${response.status})`)
  return body as T
}

export type ExecutorWalletChallenge = { id: string; address: `0x${string}`; message: string; expiresAt: number }
export type ExecutorWalletSession = { token: string; address: `0x${string}`; expiresAt: number }

export const executorWalletChallenge = (address: string) =>
  request<ExecutorWalletChallenge>('/auth/challenge', undefined, { method: 'POST', body: JSON.stringify({ address }) })

export const executorWalletVerify = (challengeId: string, address: string, signature: string) =>
  request<ExecutorWalletSession>('/auth/verify', undefined, { method: 'POST', body: JSON.stringify({ challengeId, address, signature }) })

export const executorHealth = () => request<{ ok: boolean; service: string; vaultReady: boolean; signerReady?: boolean; rpcSource?: 'env' | 'file' | 'default'; apiAuthReady: boolean; paused: boolean }>('/health')
export const executorWallets = (token: string) => request<{ wallets: ExecutorWallet[] }>('/v1/wallets', token)
export const executorStrategies = (token: string) => request<{ strategies: ExecutorStrategy[]; archivedStrategyIds?: string[] }>('/v1/strategies', token)
export const executorPerformance = (token: string) => request<{ strategies: ExecutorPerformance[] }>('/v1/performance', token)
export const executorHistory = (token: string) => request<{ strategies: ExecutorHistoryStrategy[] }>('/v1/history', token)
export const executorPnlCalendar = (token: string, from?: number, to?: number) => request<{ timezone: 'Asia/Shanghai'; rows: ExecutorCalendarRow[] }>(
  `/v1/pnl-calendar${from === undefined ? '' : `?from=${from}&to=${to ?? from}`}`, token,
)
export const executorPnlCurve = (token: string, from?: number, to?: number) => request<{ intervalSeconds: 300; points: ExecutorPnlCurvePoint[] }>(
  `/v1/pnl-curve${from === undefined ? '' : `?from=${from}&to=${to ?? Math.floor(Date.now() / 1000)}`}`, token,
)
export const executorRecovery = (token: string) => request<{ jobs: RecoveryJob[] }>('/v1/recovery', token)
export const executorRecommendations = (token: string, args: { capitalUsd: number; mode: RecommendationMode; risk: RecommendationRisk; limit?: number }) => {
  const params = new URLSearchParams({
    capitalUsd: String(args.capitalUsd), mode: args.mode, risk: args.risk, limit: String(args.limit ?? 3),
  })
  return request<RecommendationResponse>(`/v1/recommendations?${params}`, token)
}

/** Reuse an existing strategy-page login without prompting from POOLS. */
export function savedExecutorAccessToken(address?: string): string {
  try {
    const admin = localStorage.getItem(executorAdminTokenStorageKey())?.trim()
    if (admin) return admin
    if (!address) return ''
    const raw = sessionStorage.getItem(executorWalletSessionStorageKey(address))
    const session = raw ? JSON.parse(raw) as { token?: string; expiresAt?: number } : null
    return session?.token && (session.expiresAt ?? 0) > Math.floor(Date.now() / 1000) + 30 ? session.token : ''
  } catch { return '' }
}
export const setExecutorEmergencyPause = (token: string, paused: boolean) =>
  request<{ paused: boolean }>('/v1/pause-all', token, { method: 'POST', body: JSON.stringify({ paused }) })

export const importExecutorWallet = (token: string, label: string, privateKey: string, expectedAddress?: string) =>
  request<{ wallet: ExecutorWallet }>('/v1/wallets/import', token, { method: 'POST', body: JSON.stringify({ label, privateKey, expectedAddress }) })

export const renameExecutorWallet = (token: string, walletId: string, label: string) =>
  request<{ wallet: ExecutorWallet }>(`/v1/wallets/${encodeURIComponent(walletId)}`, token, { method: 'PATCH', body: JSON.stringify({ label }) })

export const saveExecutorStrategy = (token: string, config: StrategyConfig) =>
  request<{ strategy: { id: string; revision: number } }>(`/v1/strategies/${encodeURIComponent(config.id)}`, token, { method: 'PUT', body: JSON.stringify(config) })

export const deleteExecutorStrategy = (token: string, strategyId: string) =>
  request<{ archived: true; chainTransactions: 0; assetLocation: 'position' | 'position_owed' | 'wallet' | 'unchanged' | 'recovery_interrupted' }>(
    `/v1/strategies/${encodeURIComponent(strategyId)}`,
    token,
    { method: 'DELETE' },
  )

export const planExecutorStrategy = (token: string, strategyId: string) =>
  request<{ plan: Record<string, unknown>; preflight: ExecutorPreflight }>(`/v1/strategies/${encodeURIComponent(strategyId)}/plan`, token, { method: 'POST' })

export const executeExecutorStrategy = (token: string, strategyId: string) =>
  request<{ job: { id: string; dryRun: boolean } }>(`/v1/strategies/${encodeURIComponent(strategyId)}/execute`, token, { method: 'POST' })

export const resumeExecutorMonitoring = (token: string, strategyId: string) =>
  request<{ state: 'monitoring'; preflight: ExecutorPreflight }>(`/v1/strategies/${encodeURIComponent(strategyId)}/resume-monitoring`, token, { method: 'POST' })

export type ExecutorProfitWithdrawal = {
  id: string
  strategyId: string
  target: 'USDG' | 'WETH' | 'ETH'
  amountRaw: string
  decimals: number
  quoteValueRaw: string
  usdgValueRaw: string
  gasWei: string
  txHashes: string[]
  withdrawnAt: number
}

export const withdrawExecutorProfit = (token: string, strategyId: string, target: ExecutorProfitWithdrawal['target']) =>
  request<{ withdrawal: ExecutorProfitWithdrawal }>(`/v1/strategies/${encodeURIComponent(strategyId)}/withdraw-profit`, token, {
    method: 'POST', body: JSON.stringify({ target }),
  })

export const startSimpleExecutorStrategy = (token: string, config: StrategyConfig, walletId: string) =>
  request<{ config: StrategyConfig; job: { id: string; dryRun: false } | null; preflight: ExecutorPreflight; appliedDefaults: { maxGasPriceWei: string; maxDailyTurnoverQuote: string } }>(
    `/v1/simple/strategies/${encodeURIComponent(config.id)}/start`,
    token,
    { method: 'POST', body: JSON.stringify({ config, walletId }) },
  )

export const inspectExecutorRecovery = (token: string, jobId: string) =>
  request<{ recovery: Record<string, unknown> }>(`/v1/jobs/${encodeURIComponent(jobId)}/recover`, token, { method: 'POST' })

export const resumeExecutorRecovery = (token: string, jobId: string) =>
  request<{ recovery: Record<string, unknown> }>(`/v1/jobs/${encodeURIComponent(jobId)}/resume`, token, { method: 'POST' })
