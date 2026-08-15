export const STRATEGY_ERROR = {
  CONFIG: 'E_CONFIG',
  CHAIN: 'E_CHAIN',
  OWNER: 'E_OWNER',
  POOL_IDENTITY: 'E_POOL_IDENTITY',
  POSITION_CHANGED: 'E_POSITION_CHANGED',
  APR_UNAVAILABLE: 'E_APR_UNAVAILABLE',
  PLAN_STALE: 'E_PLAN_STALE',
  SLIPPAGE: 'E_SLIPPAGE',
  DAILY_LIMIT: 'E_DAILY_LIMIT',
  VAULT_LOCKED: 'E_VAULT_LOCKED',
} as const

export type StrategyErrorCode = (typeof STRATEGY_ERROR)[keyof typeof STRATEGY_ERROR]

export class StrategyError extends Error {
  constructor(
    readonly code: StrategyErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'StrategyError'
  }
}
