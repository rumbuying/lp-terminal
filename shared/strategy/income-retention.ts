/** Portion of realized strategy income parked outside the next LP deployment. */
export const INCOME_RETENTION_BPS = 1_000
/** Retention starts only when combined income is strictly greater than $1. */
export const INCOME_RETENTION_THRESHOLD_USD = 1
export const INCOME_RETENTION_CUSTODY = 'owner_wallet' as const
