import type { Address, Hex } from 'viem'
import type { StrategyChainId, StrategyLpProtocol } from '../../src/config/networks'

export type StrategyPreset = 'original' | 'fee_guarded' | 'defensive' | 'custom'
export type StrategyExecutionMode = 'notify_only' | 'wallet_confirm' | 'executor_auto'
export type BoundaryAction = 'recenter' | 'skew_recenter' | 'hold_quote' | 'pause'
export type StrategyPlanAction = BoundaryAction | 'collect_fees'
export type BoundaryCondition = 'always' | 'fee_break_even' | 'manual_confirm'
export type FeeHandling = 'convert_to_quote' | 'reinvest' | 'hold_tokens'
export type TriggerSource = 'spot' | 'sampled_twap'

export type BoundaryPolicy = {
  condition: BoundaryCondition
  action: BoundaryAction
}

export type StrategyRange = {
  mode: 'symmetric' | 'asymmetric' | 'fixed_ticks'
  lowerPct: number
  upperPct: number
  tickLower?: number
  tickUpper?: number
  defensiveLowerPct?: number
  defensiveUpperPct?: number
}

export type StrategyConfig = {
  version: 1
  id: string
  name: string
  preset: StrategyPreset
  sourcePreset: StrategyPreset
  enabled: boolean
  chainId: StrategyChainId
  owner: Address
  protocol: StrategyLpProtocol
  pool: Address
  /** v4 pool identity; `pool` is the singleton shared by every v4 market. */
  poolId?: Hex
  /** v4 hook address, including zeroAddress for a hookless pool. */
  hooks?: Address
  positionManager: Address
  activeTokenId: string | null
  riskToken: Address
  quoteToken: Address
  staking?: {
    enabled: boolean
    gauge?: Address
    rewardToken?: Address
    rewardQuoteToken?: Address
    rewardHandling?: 'convert_to_quote_hold'
  }
  range: StrategyRange
  trigger: {
    source: TriggerSource
    pollSeconds: number
    confirmationSeconds: number
    cooldownMinutes: number
  }
  boundary: {
    lower: BoundaryPolicy
    upper: BoundaryPolicy
  }
  fees: {
    handling: FeeHandling
    timing: 'on_rebalance' | 'threshold' | 'interval'
    thresholdQuote?: string
    intervalMinutes?: number
  }
  capitalProtection: {
    /** Never deploy more than the immutable strategy-start value after a harvest. */
    enabled: boolean
    /** Harvest when deployable profit reaches this executable USDG value. */
    profitThresholdUsdg: string
  }
  adaptiveRange: {
    enabled: boolean
    /** Desired minimum lifetime before a fast boundary crossing can widen the next range. */
    targetMinutes: number
    /** Hard ceiling for the cumulative square-root widening multiplier. */
    maxMultiplier: number
    /** Fraction of excess width retained after a position survives the target. */
    recoveryDecay: number
    /** An expanded in-range position is eligible for an economically-gated contraction review after this time. */
    contractionReviewMinutes: number
    /** Complete recent price-sample window required before contraction. */
    contractionStabilityMinutes: number
    /** Maximum sampled peak-to-trough movement allowed during the stability window. */
    contractionMaxVolatilityBps: number
    /** Current uncollected fees must cover this multiple of the prior execution cost before a timed contraction. */
    contractionFeeCoverage: number
  }
  safeguards: {
    enabled: boolean
    minCrossingMinutes?: number
    minNetAprPct?: number
    /** Defer a boundary recenter while collectable fees are below this multiple of the last cycle's cost. 0/undefined disables the gate. */
    minCycleFeeCoverage?: number
    /** Maximum seconds a gated recenter may keep waiting before the escape executes it anyway. */
    economicsHoldMinutes?: number
    maxRebalancesPerDay?: number
    maxConsecutiveLowerBreaks?: number
    maxRiskAssetPct?: number
    maxSwapImpactBps?: number
    /** Rolling tick-sample window used by unattended market-quality guards. */
    volatilityWindowSeconds?: number
    /** Maximum high-to-low movement inside the rolling window. */
    maxVolatilityBps?: number
    /** Maximum absolute difference between the latest spot tick and sampled TWAP. */
    maxSpotTwapDeviationBps?: number
    /** A tripped market-quality guard must remain healthy this long before resuming. */
    stableMarketSeconds?: number
    /** Rolling window used to detect repeated eligible rebalance triggers. */
    burstWindowMinutes?: number
    /** The Nth eligible trigger inside the burst window waits before execution. */
    burstTriggerCount?: number
    /** Automatic wait applied when the burst trigger threshold is reached. */
    burstCooldownMinutes?: number
    maxSlippageBps: number
    maxPlanAgeSeconds: number
  }
  execution: {
    mode: StrategyExecutionMode
    executorId?: string
    walletId?: string
    signerAddress?: Address
    dryRun: boolean
    maxGasPriceWei?: string
    maxGasQuotePerTx?: string
    maxDailyTurnoverQuote?: string
    gasReserveMultiplier: number
    /** Bundle LP exit calls and retain persistent ERC-20/ERC-721 approvals. */
    lowTransactionMode: boolean
  }
  revision: number
  createdAt: number
  updatedAt: number
}

export type TriggerSide = 'lower' | 'upper' | 'manual' | 'adaptive_contraction'

export type TriggerDecision =
  | { kind: 'none'; reason: 'in_range' | 'confirming' | 'cooldown' | 'guard_not_met' }
  | { kind: 'pause'; code: string; detail?: Record<string, string> }
  | { kind: 'execute'; side: TriggerSide; action: BoundaryAction; observedAt: number }

export type SimPath = 'linear'

export type SimulatorInput = {
  initialValue: number
  startPrice: number
  endPrice: number
  durationDays: number
  aprPct: number
  lowerPct: number
  upperPct: number
  lowerAction: BoundaryAction
  upperAction: BoundaryAction
  feeHandling: FeeHandling
  steps?: number
}

export type SimulatorCycle = {
  side: 'lower' | 'upper'
  price: number
  atDays: number
  valueBeforeRecenter: number
}

export type SimulatorResult = {
  endingLpValue: number
  feesQuote: number
  endingValue: number
  pnlPct: number
  rebalances: number
  cycles: SimulatorCycle[]
}

/** A chain-derived fact set. Amounts are decimal strings so plans remain JSON-safe. */
export type StrategyPositionSnapshot = {
  chainId: StrategyChainId
  observedAt: number
  blockNumber: string
  owner: Address
  protocol: StrategyLpProtocol
  pool: Address
  poolId?: Hex
  hooks?: Address
  positionManager: Address
  tokenId: string
  token0: Address
  token1: Address
  token0Decimals: number
  token1Decimals: number
  tickSpacing: number
  feePpm: number
  unstakedFeePpm: number
  tick: number
  sqrtPriceX96: string
  tickLower: number
  tickUpper: number
  liquidity: string
  tokensOwed0: string
  tokensOwed1: string
  /** Economic custody remains with `owner`; the ERC-721 itself is held by the gauge while staked. */
  staked?: boolean
  gauge?: Address
  nftOwner?: Address
  rewardOwed?: string
  /** Best-effort dashboard reads may preserve position valuation when the gauge reward view temporarily reverts. */
  rewardReadError?: string
}

export type StrategyPlanStepKind =
  | 'precheck'
  | 'decrease'
  | 'collect'
  | 'burn'
  | 'approve_swap'
  | 'swap'
  | 'approve0'
  | 'approve1'
  | 'mint'
  | 'revoke0'
  | 'revoke1'
  | 'commit'
  | 'unstake'
  | 'approve_reward'
  | 'swap_reward'
  | 'approve_nft'
  | 'stake'

export type StrategyPlanStep = {
  index: number
  kind: StrategyPlanStepKind
  /** Human/audit intent; this is deliberately not pre-signed calldata. */
  intent: Record<string, string | number | boolean>
}

export type StrategyExecutionPlan = {
  version: 1
  id: string
  hash: `0x${string}`
  strategyId: string
  strategyRevision: number
  createdAt: number
  expiresAt: number
  triggerSide: TriggerSide
  action: StrategyPlanAction
  snapshot: StrategyPositionSnapshot
  nextRange: { tickLower: number; tickUpper: number }
  /** Frozen for deterministic execution/recovery; 1 means the configured base range. */
  rangeScale: number
  steps: StrategyPlanStep[]
  safeguards: { maxSlippageBps: number; maxPlanAgeSeconds: number; dryRun: boolean }
}

export type StrategyCycleRecord = {
  cycleId: string
  strategyId: string
  oldTokenId: string | null
  newTokenId: string | null
  startedAt: number
  triggeredAt?: number
  completedAt?: number
  triggerSide?: TriggerSide
  startPriceQuotePerRisk: string
  triggerPriceQuotePerRisk?: string
  startValueQuote: string
  endValueQuote?: string
  collectedFeeQuote: string
  rewardQuote: string
  swapCostQuote: string
  gasCostQuote: string
  walletFlowsQuote: string
  txHashes: string[]
  status: 'active' | 'completed' | 'paused' | 'recovery'
}

export type LedgerEntryKind =
  | 'deposit'
  | 'withdrawal'
  | 'principal_exit'
  | 'fee_gross'
  | 'protocol_fee'
  | 'income_tax'
  | 'swap_in'
  | 'swap_out'
  | 'swap_cost'
  | 'gas'
  | 'mint_principal'
  | 'profit_harvest'
  | 'profit_withdrawal_swap_in'
  | 'profit_withdrawal_swap_out'
  | 'profit_withdrawal'
  | 'external_collect'
  | 'staking_reward'
  | 'adjustment'

export type LedgerEntry = {
  id: string
  strategyId: string
  cycleId?: string
  jobId?: string
  ts: number
  blockNumber?: string
  txHash?: string
  kind: LedgerEntryKind
  token?: Address
  amount?: string
  quoteValue?: string
  /** true means calculated from a levy snapshot, not an observed transfer. */
  estimated?: boolean
  meta?: Record<string, unknown>
}
